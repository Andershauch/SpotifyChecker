import {
  acquireCheckRunLock,
  createCheckJob,
  ensureSchema,
  forceReleaseCheckRunLock,
  getCheckJob,
  getCheckRunLock,
  getActiveMonitoredPlaylistIds,
  getLatestCheckJob,
  getPlaylistCheckpoint,
  getSql,
  heartbeatCheckRunLock,
  releaseCheckRunLock,
  syncEnvPlaylistsToDatabase,
  updateCheckJob,
  upsertPlaylistCheckpoint,
  type CheckJobRow,
} from "@/lib/db";
import { sendUnavailableTracksAlert } from "@/lib/mailer";
import {
  fetchPlaylistsByIds,
  fetchOwnPublicPlaylists,
  fetchUnavailableTracksForPlaylist,
  getPlaylistIdsFromEnv,
  getSpotifyAccessToken,
  type SpotifyExecutionContext,
  type TrackAvailability,
} from "@/lib/spotify";

export const CHECK_RUN_LOCK_NAME = "daily-spotify-check";
const CHECK_RUN_LOCK_TTL_SECONDS = 45;

export type CheckSummary = {
  status: "ok" | "error" | "skipped" | "cancelled";
  checkedTracks: number;
  unavailableCount: number;
  newUnavailableCount: number;
  checkedPlaylists: number;
  skippedPlaylists: number;
  errorMessage: string | null;
};

type ExistingUnavailableRow = {
  currently_unavailable: boolean;
};

type LatestRunRow = {
  run_at: string;
  status: "ok" | "error" | "skipped" | "cancelled";
  checked_tracks: number;
  unavailable_count: number;
  error_message: string | null;
  payload: {
    checkedPlaylists?: number;
    skippedPlaylists?: number;
  };
};

export type CheckRunStatus = {
  running: boolean;
  lock: {
    ownerId: string;
    jobId: string | null;
    startedAt: string;
    lockedUntil: string;
    expiresInSeconds: number;
  } | null;
  job: {
    id: string;
    status: string;
    triggerSource: string;
    requestedAt: string;
    startedAt: string | null;
    heartbeatAt: string | null;
    checkedTracks: number;
    checkedPlaylists: number;
    skippedPlaylists: number;
    unavailableCount: number;
    newUnavailableCount: number;
    cancelRequested: boolean;
    errorMessage: string | null;
    currentPlaylistName: string | null;
    currentStage: string | null;
  } | null;
};

class CancelledCheckError extends Error {
  constructor(message = "Kørslen blev stoppet manuelt.") {
    super(message);
    this.name = "CancelledCheckError";
  }
}

export async function runDailyCheck(
  triggerSource: "manual" | "cron" = "manual",
): Promise<CheckSummary> {
  await ensureSchema();
  await syncEnvPlaylistsToDatabase(getPlaylistIdsFromEnv());
  const job = await createCheckJob(triggerSource);
  const lock = await acquireCheckRunLock(
    CHECK_RUN_LOCK_NAME,
    CHECK_RUN_LOCK_TTL_SECONDS,
    job.id,
  );

  if (!lock) {
    const summary: CheckSummary = {
      status: "skipped",
      checkedTracks: 0,
      unavailableCount: 0,
      newUnavailableCount: 0,
      checkedPlaylists: 0,
      skippedPlaylists: 0,
      errorMessage: "Et andet check kører allerede, så denne trigger blev sprunget over.",
    };

    await updateCheckJob(job.id, {
      status: "skipped",
      errorMessage: summary.errorMessage,
      finished: true,
    });
    await saveRun(summary, []);
    return summary;
  }

  const lockOwnerId = lock.owner_id;

  await updateCheckJob(job.id, {
    status: "running",
    started: true,
    heartbeat: true,
    payload: { currentPlaylistName: null, currentStage: "Forbereder check" },
  });

  let checkedTracks = 0;
  let checkedPlaylists = 0;
  let skippedPlaylists = 0;
  const unavailableTracks: TrackAvailability[] = [];
  let lastControlSyncAt = 0;

  async function checkpoint(force = false) {
    const now = Date.now();
    if (!force && now - lastControlSyncAt < 1_500) {
      return;
    }

    await syncJobControl(job.id, lockOwnerId);
    lastControlSyncAt = now;
  }

  const executionContext: SpotifyExecutionContext = {
    onCheckpoint: async () => {
      await checkpoint(false);
    },
  };

  try {
    await checkpoint(true);
    await updateCheckJob(job.id, {
      heartbeat: true,
      payload: {
        currentPlaylistName: null,
        currentStage: "Henter playlister fra Spotify",
      },
    });

    const monitoredPlaylists = await getActiveMonitoredPlaylistIds();
    let playlists;
    let accessToken: string;

    if (monitoredPlaylists.length > 0) {
      await updateCheckJob(job.id, {
        heartbeat: true,
        payload: {
          currentPlaylistName: null,
          currentStage: "Henter playlister fra database-kataloget",
        },
      });

      accessToken = await getSpotifyAccessToken();
      playlists = await fetchPlaylistsByIds(
        monitoredPlaylists.map((playlist) => playlist.playlist_id),
        accessToken,
        executionContext,
      );
    } else {
      const fallbackResult = await fetchOwnPublicPlaylists(executionContext);
      accessToken = fallbackResult.accessToken;
      playlists = fallbackResult.playlists;
    }

    for (const playlist of playlists) {
      await updateCheckJob(job.id, {
        heartbeat: true,
        checkedTracks,
        checkedPlaylists,
        skippedPlaylists,
        unavailableCount: unavailableTracks.length,
        payload: {
          currentPlaylistName: playlist.name,
          currentStage: `Forbereder playlist: ${playlist.name}`,
        },
      });

      await checkpoint(true);

      const playlistCheckpoint = await getPlaylistCheckpoint(playlist.id);
      const hasUnchangedSnapshot =
        Boolean(playlist.snapshotId) &&
        playlistCheckpoint?.snapshot_id === playlist.snapshotId;

      if (hasUnchangedSnapshot) {
        skippedPlaylists += 1;
        await upsertPlaylistCheckpoint({
          playlistId: playlist.id,
          playlistName: playlist.name,
          snapshotId: playlist.snapshotId,
          trackTotal: playlist.trackTotal,
          lastRunJobId: job.id,
        });
        await updateCheckJob(job.id, {
          heartbeat: true,
          checkedTracks,
          checkedPlaylists,
          skippedPlaylists,
          unavailableCount: unavailableTracks.length,
          payload: {
            currentPlaylistName: null,
            currentStage: `Springer uændret playlist over: ${playlist.name}`,
          },
        });
        continue;
      }

      await updateCheckJob(job.id, {
        heartbeat: true,
        payload: {
          currentPlaylistName: playlist.name,
          currentStage: `Tjekker tracks i playlist: ${playlist.name}`,
        },
      });

      const result = await fetchUnavailableTracksForPlaylist(
        playlist.id,
        playlist.name,
        accessToken,
        executionContext,
      );

      checkedTracks += result.checked;
      checkedPlaylists += 1;
      unavailableTracks.push(...result.unavailable);

      await upsertPlaylistCheckpoint({
        playlistId: playlist.id,
        playlistName: playlist.name,
        snapshotId: playlist.snapshotId,
        trackTotal: playlist.trackTotal,
        lastRunJobId: job.id,
      });

      await updateCheckJob(job.id, {
        heartbeat: true,
        checkedTracks,
        checkedPlaylists,
        skippedPlaylists,
        unavailableCount: unavailableTracks.length,
        payload: {
          currentPlaylistName: null,
          currentStage: `Færdig med playlist: ${playlist.name}`,
        },
      });
    }

    await updateCheckJob(job.id, {
      heartbeat: true,
      payload: {
        currentPlaylistName: null,
        currentStage: "Gemmer resultater og sender eventuel mail",
      },
    });

    const newUnavailableTracks = await persistUnavailableTracks(unavailableTracks);
    await sendUnavailableTracksAlert(newUnavailableTracks);

    const summary: CheckSummary = {
      status: "ok",
      checkedTracks,
      unavailableCount: unavailableTracks.length,
      newUnavailableCount: newUnavailableTracks.length,
      checkedPlaylists,
      skippedPlaylists,
      errorMessage: null,
    };

    await updateCheckJob(job.id, {
      status: "ok",
      checkedTracks,
      checkedPlaylists,
      skippedPlaylists,
      unavailableCount: unavailableTracks.length,
      newUnavailableCount: newUnavailableTracks.length,
      payload: { currentPlaylistName: null, currentStage: "Færdig" },
      finished: true,
    });
    await saveRun(summary, unavailableTracks);
    return summary;
  } catch (error) {
    const summary = buildErrorSummary(
      error,
      checkedTracks,
      checkedPlaylists,
      skippedPlaylists,
      unavailableTracks.length,
    );

    await updateCheckJob(job.id, {
      status: summary.status,
      checkedTracks,
      checkedPlaylists,
      skippedPlaylists,
      unavailableCount: unavailableTracks.length,
      errorMessage: summary.errorMessage,
      payload: { currentPlaylistName: null, currentStage: "Afsluttet med fejl" },
      finished: true,
    });
    await saveRun(summary, unavailableTracks);
    return summary;
  } finally {
    await releaseCheckRunLock(CHECK_RUN_LOCK_NAME, lockOwnerId);
  }
}

function buildErrorSummary(
  error: unknown,
  checkedTracks: number,
  checkedPlaylists: number,
  skippedPlaylists: number,
  unavailableCount: number,
): CheckSummary {
  const message = error instanceof Error ? error.message : "Unknown error";

  return {
    status: error instanceof CancelledCheckError ? "cancelled" : "error",
    checkedTracks,
    unavailableCount,
    newUnavailableCount: 0,
    checkedPlaylists,
    skippedPlaylists,
    errorMessage: message,
  };
}

async function syncJobControl(jobId: string, ownerId: string) {
  const lock = await heartbeatCheckRunLock(
    CHECK_RUN_LOCK_NAME,
    ownerId,
    CHECK_RUN_LOCK_TTL_SECONDS,
  );

  if (!lock) {
    throw new CancelledCheckError();
  }

  const job = await updateCheckJob(jobId, { heartbeat: true });
  if (!job) {
    throw new CancelledCheckError();
  }

  if (job.cancel_requested || job.status === "cancel_requested") {
    throw new CancelledCheckError();
  }

  return job;
}

async function persistUnavailableTracks(unavailableTracks: TrackAvailability[]) {
  const sql = getSql();
  await sql`UPDATE unavailable_tracks SET currently_unavailable = FALSE`;

  const newUnavailableTracks: TrackAvailability[] = [];

  for (const track of unavailableTracks) {
    const existingRows = (await sql`
      SELECT currently_unavailable
      FROM unavailable_tracks
      WHERE track_id = ${track.trackId}
        AND playlist_id = ${track.playlistId}
      LIMIT 1
    `) as ExistingUnavailableRow[];

    const existing = existingRows[0];
    if (!existing || !existing.currently_unavailable) {
      newUnavailableTracks.push(track);
    }

    await sql`
      INSERT INTO unavailable_tracks (
        track_id,
        playlist_id,
        playlist_name,
        track_name,
        artists,
        track_url,
        currently_unavailable,
        first_seen_at,
        last_seen_at
      )
      VALUES (
        ${track.trackId},
        ${track.playlistId},
        ${track.playlistName},
        ${track.trackName},
        ${track.artists},
        ${track.trackUrl},
        TRUE,
        NOW(),
        NOW()
      )
      ON CONFLICT (track_id, playlist_id)
      DO UPDATE SET
        playlist_name = EXCLUDED.playlist_name,
        track_name = EXCLUDED.track_name,
        artists = EXCLUDED.artists,
        track_url = EXCLUDED.track_url,
        currently_unavailable = TRUE,
        last_seen_at = NOW()
    `;
  }

  return newUnavailableTracks;
}

async function saveRun(summary: CheckSummary, unavailableTracks: TrackAvailability[]) {
  const sql = getSql();
  const payload = {
    checkedPlaylists: summary.checkedPlaylists,
    skippedPlaylists: summary.skippedPlaylists,
    unavailableTracks,
  };

  await sql`
    INSERT INTO check_runs (
      status,
      checked_tracks,
      unavailable_count,
      error_message,
      payload
    )
    VALUES (
      ${summary.status},
      ${summary.checkedTracks},
      ${summary.unavailableCount},
      ${summary.errorMessage},
      ${JSON.stringify(payload)}::jsonb
    )
  `;
}

export async function getLatestRun() {
  await ensureSchema();
  const sql = getSql();

  const rows = (await sql`
    SELECT run_at, status, checked_tracks, unavailable_count, error_message, payload
    FROM check_runs
    WHERE status <> 'skipped'
    ORDER BY run_at DESC
    LIMIT 1
  `) as LatestRunRow[];

  return rows[0] ?? null;
}

export async function getCurrentCheckRunStatus(): Promise<CheckRunStatus> {
  await ensureSchema();
  const lock = await getCheckRunLock(CHECK_RUN_LOCK_NAME);

  if (!lock) {
    return { running: false, lock: null, job: null };
  }

  const lockedUntilTime = new Date(lock.locked_until).getTime();
  const expiresInSeconds = Math.max(
    0,
    Math.ceil((lockedUntilTime - Date.now()) / 1000),
  );

  if (expiresInSeconds === 0) {
    return { running: false, lock: null, job: null };
  }

  const job = lock.job_id ? await getCheckJob(lock.job_id) : null;

  return {
    running: true,
    lock: {
      ownerId: lock.owner_id,
      jobId: lock.job_id,
      startedAt: lock.started_at,
      lockedUntil: lock.locked_until,
      expiresInSeconds,
    },
    job: mapCheckJob(job),
  };
}

export async function getLatestJobSnapshot() {
  await ensureSchema();
  const job = await getLatestCheckJob();
  return mapCheckJob(job);
}

function mapCheckJob(job: CheckJobRow | null) {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    status: job.status,
    triggerSource: job.trigger_source,
    requestedAt: job.requested_at,
    startedAt: job.started_at,
    heartbeatAt: job.heartbeat_at,
    checkedTracks: job.checked_tracks,
    checkedPlaylists: job.checked_playlists,
    skippedPlaylists: job.skipped_playlists,
    unavailableCount: job.unavailable_count,
    newUnavailableCount: job.new_unavailable_count,
    cancelRequested: job.cancel_requested,
    errorMessage: job.error_message,
    currentPlaylistName:
      typeof job.payload?.currentPlaylistName === "string"
        ? job.payload.currentPlaylistName
        : null,
    currentStage:
      typeof job.payload?.currentStage === "string"
        ? job.payload.currentStage
        : null,
  };
}

export async function requestCancelCurrentCheckRun() {
  await ensureSchema();
  const lock = await getCheckRunLock(CHECK_RUN_LOCK_NAME);

  if (!lock?.job_id) {
    return { requested: false };
  }

  const job = await updateCheckJob(lock.job_id, {
    status: "cancel_requested",
    cancelRequested: true,
  });

  return { requested: Boolean(job), jobId: lock.job_id };
}

export async function forceUnlockCurrentCheckRun() {
  await ensureSchema();
  const released = await forceReleaseCheckRunLock(CHECK_RUN_LOCK_NAME);

  if (released?.job_id) {
    await updateCheckJob(released.job_id, {
      status: "cancelled",
      cancelRequested: true,
      errorMessage: "Kørslen blev frigivet manuelt fra kontrolpanelet.",
      finished: true,
    });
  }

  return { released: Boolean(released) };
}
