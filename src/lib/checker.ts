import {
  acquireCheckRunLock,
  clearSpotifyCooldownState,
  clearPlaylistCheckpoints,
  createCheckJob,
  ensureSchema,
  forceReleaseCheckRunLock,
  getCheckJob,
  getCheckRunLock,
  getLatestCheckJob,
  getPlaylistCheckpoints,
  getSpotifyCooldownState,
  getSql,
  heartbeatCheckRunLock,
  releaseCheckRunLock,
  reconcilePlaylistCheckpointUnavailableCounts,
  setSpotifyCooldownState,
  updateCheckJob,
  upsertPlaylistCheckpoints,
  type CheckJobRow,
  type PlaylistCheckpointRow,
} from "@/lib/db";
import { sendUnavailableTracksAlert } from "@/lib/mailer";
import {
  fetchOwnPublicPlaylists,
  fetchUnavailableTracksForPlaylist,
  getSpotifyConnectionStatus,
  getSpotifyCooldownFromError,
  type PlaylistSummary,
  type SpotifyExecutionContext,
  type TrackAvailability,
} from "@/lib/spotify";

export const CHECK_RUN_LOCK_NAME = "daily-spotify-check";
const CHECK_RUN_LOCK_TTL_SECONDS = 45;
const CHECKPOINT_FLUSH_BATCH_SIZE = 25;
const DEFAULT_PLAYLIST_SCAN_BUDGET = 100;
const STALE_RECHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const UNAVAILABLE_RECHECK_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;

export type CheckTriggerSource = "manual" | "cron";

export type CheckSummary = {
  status: "ok" | "error" | "skipped" | "cancelled";
  checkedTracks: number;
  unavailableCount: number;
  newUnavailableCount: number;
  checkedPlaylists: number;
  skippedPlaylists: number;
  deferredPlaylists: number;
  errorMessage: string | null;
};

export type CheckRequestSummary = {
  accepted: boolean;
  jobId: string | null;
  status: "queued" | "already_running";
  errorMessage: string | null;
};

export type CheckRunOptions = {
  playlistLimit?: number;
  ignoreCheckpoints?: boolean;
  scanBudget?: number;
};

export type SmokeCheckSummary = {
  status: "ok" | "error" | "skipped";
  playlistId: string | null;
  playlistName: string | null;
  snapshotId: string | null;
  source: "database" | null;
  errorMessage: string | null;
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
    deferredPlaylists?: number;
  };
};

type CheckJobProgressPayload = {
  currentPlaylistName?: string;
  currentStage?: string;
  resumePlaylistId?: string | null;
  resumePlaylistName?: string | null;
  resumedFromPlaylistId?: string | null;
  deferredPlaylists?: number;
  scanBudget?: number;
};

export type CheckRunStatus = {
  running: boolean;
  spotifyConnection: {
    connected: boolean;
    spotifyUserId: string | null;
    displayName: string | null;
    connectedAt: string | null;
    expiresAt: string | null;
  };
  cooldown: {
    active: boolean;
    until: string;
    expiresInSeconds: number;
    message: string;
  } | null;
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
  triggerSource: CheckTriggerSource = "manual",
): Promise<CheckSummary> {
  await ensureSchema();
  const job = await createCheckJob(triggerSource);
  return executeCheckJob(job.id);
}

export async function requestCheckRun(
  triggerSource: CheckTriggerSource = "manual",
): Promise<CheckRequestSummary> {
  await ensureSchema();
  const currentLock = await getCheckRunLock(CHECK_RUN_LOCK_NAME);

  if (currentLock) {
    return {
      accepted: false,
      jobId: currentLock.job_id ?? null,
      status: "already_running",
      errorMessage: "Et andet check kører allerede.",
    };
  }

  const job = await createCheckJob(triggerSource);

  return {
    accepted: true,
    jobId: job.id,
    status: "queued",
    errorMessage: null,
  };
}

export async function executeCheckJob(
  jobId: string,
  options?: CheckRunOptions,
): Promise<CheckSummary> {
  const cooldown = await getActiveSpotifyCooldown();

  if (cooldown) {
    const summary = buildCooldownSummary(cooldown);

    await updateCheckJob(jobId, {
      status: "skipped",
      errorMessage: summary.errorMessage,
      payload: {
        currentPlaylistName: null,
        currentStage: "Springes over pga. aktiv Spotify cooldown",
      },
      finished: true,
    });
    await saveRun(summary);
    return summary;
  }

  const lock = await acquireCheckRunLock(
    CHECK_RUN_LOCK_NAME,
    CHECK_RUN_LOCK_TTL_SECONDS,
    jobId,
  );

  if (!lock) {
    const summary: CheckSummary = {
      status: "skipped",
      checkedTracks: 0,
      unavailableCount: 0,
      newUnavailableCount: 0,
      checkedPlaylists: 0,
      skippedPlaylists: 0,
      deferredPlaylists: 0,
      errorMessage: "Et andet check kører allerede, så denne trigger blev sprunget over.",
    };

    await updateCheckJob(jobId, {
      status: "skipped",
      errorMessage: summary.errorMessage,
      finished: true,
    });
    await saveRun(summary);
    return summary;
  }

  const lockOwnerId = lock.owner_id;

  await updateCheckJob(jobId, {
    status: "running",
    started: true,
    heartbeat: true,
      payload: { currentPlaylistName: null, currentStage: "Forbereder check" },
  });

  let checkedTracks = 0;
  let checkedPlaylists = 0;
  let skippedPlaylists = 0;
  let deferredPlaylists = 0;
  const scannedPlaylistIds = new Set<string>();
  const unavailableTracks: TrackAvailability[] = [];
  const pendingCheckpointWrites: Array<{
    playlistId: string;
    playlistName: string;
    snapshotId: string | null;
    trackTotal: number | null;
    lastAvailabilityScanAt?: string | null;
    currentUnavailableCount?: number | null;
    lastRunJobId: string;
  }> = [];
  let lastControlSyncAt = 0;
  let currentPlaylistContext: { id: string; name: string } | null = null;
  let activeScanBudget = options?.scanBudget ?? DEFAULT_PLAYLIST_SCAN_BUDGET;

  async function checkpoint(force = false) {
    const now = Date.now();
    if (!force && now - lastControlSyncAt < 1_500) {
      return;
    }

    await syncJobControl(jobId, lockOwnerId);
    lastControlSyncAt = now;
  }

  const executionContext: SpotifyExecutionContext = {
    onCheckpoint: async () => {
      await checkpoint(false);
    },
    onTrackScanProgress: async () => {},
  };

  async function flushPendingCheckpoints(force = false) {
    if (pendingCheckpointWrites.length === 0) {
      return;
    }

    if (!force && pendingCheckpointWrites.length < CHECKPOINT_FLUSH_BATCH_SIZE) {
      return;
    }

    const nextBatch = pendingCheckpointWrites.splice(0, pendingCheckpointWrites.length);
    await upsertPlaylistCheckpoints(nextBatch);
  }

  try {
    await checkpoint(true);
    await updateCheckJob(jobId, {
      heartbeat: true,
      payload: {
        currentPlaylistName: null,
        currentStage: "Henter egne public playlister fra Spotify",
      },
    });

    const fallbackResult = await fetchOwnPublicPlaylists(executionContext);
    const accessToken = fallbackResult.accessToken;
    const checkpointRows = await getPlaylistCheckpoints(
      fallbackResult.playlists.map((playlist) => playlist.id),
    );
    const checkpointMap = new Map<string, PlaylistCheckpointRow>(
      checkpointRows.map((row) => [row.playlist_id, row]),
    );
    const resumePlaylistId = await getResumePlaylistId();
    // If the previous run stopped on a Spotify rate limit, continue from the
    // last in-progress playlist instead of re-walking already completed ones.
    const sourcePlaylists = options?.playlistLimit
      ? fallbackResult.playlists.slice(0, options.playlistLimit)
      : applyResumePoint(
          fallbackResult.playlists,
          resumePlaylistId,
        );
    const scanBudget = options?.ignoreCheckpoints
      ? options?.playlistLimit ?? options?.scanBudget ?? sourcePlaylists.length
      : options?.scanBudget ?? DEFAULT_PLAYLIST_SCAN_BUDGET;
    activeScanBudget = scanBudget;
    const playlists = options?.ignoreCheckpoints
      ? sourcePlaylists
      : prioritizePlaylistsForScan(sourcePlaylists, checkpointMap);
    const resumedFromPlaylistId = resumePlaylistId && playlists[0]?.id === resumePlaylistId
      ? resumePlaylistId
      : null;
    let remainingScanBudget = scanBudget;

    for (const playlist of playlists) {
      currentPlaylistContext = { id: playlist.id, name: playlist.name };
      const playlistCheckpoint = checkpointMap.get(playlist.id);
      const scanDecision = options?.ignoreCheckpoints
        ? { shouldScan: true, reason: "forced" as const, priority: -1 }
        : getPlaylistScanDecision(playlist, playlistCheckpoint);

      await updateCheckJob(jobId, {
        heartbeat: true,
        checkedTracks,
        checkedPlaylists,
        skippedPlaylists,
        unavailableCount: unavailableTracks.length,
        payload: {
          deferredPlaylists,
          scanBudget,
          resumedFromPlaylistId,
          resumePlaylistId: playlist.id,
          resumePlaylistName: playlist.name,
          currentPlaylistName: playlist.name,
          currentStage: `Forbereder playlist: ${playlist.name}`,
        },
      });

      await checkpoint(true);

      if (!scanDecision.shouldScan) {
        skippedPlaylists += 1;
        const checkpointInput = {
          playlistId: playlist.id,
          playlistName: playlist.name,
          snapshotId: playlist.snapshotId,
          trackTotal: playlist.trackTotal,
          lastRunJobId: jobId,
        };
        checkpointMap.set(playlist.id, {
          playlist_id: checkpointInput.playlistId,
          playlist_name: checkpointInput.playlistName,
          snapshot_id: checkpointInput.snapshotId,
          track_total: checkpointInput.trackTotal,
          last_checked_at: new Date().toISOString(),
          last_availability_scan_at: playlistCheckpoint?.last_availability_scan_at ?? null,
          current_unavailable_count: playlistCheckpoint?.current_unavailable_count ?? null,
          last_run_job_id: checkpointInput.lastRunJobId,
        });
        pendingCheckpointWrites.push(checkpointInput);
        await flushPendingCheckpoints(false);
        await updateCheckJob(jobId, {
          heartbeat: true,
          checkedTracks,
          checkedPlaylists,
          skippedPlaylists,
          unavailableCount: unavailableTracks.length,
          payload: {
            deferredPlaylists,
            scanBudget,
            resumedFromPlaylistId,
            resumePlaylistId: null,
            resumePlaylistName: null,
            currentPlaylistName: null,
            currentStage: describeSkipStage(playlist.name, scanDecision.reason),
          },
        });
        continue;
      }

      if (!options?.ignoreCheckpoints && remainingScanBudget <= 0) {
        deferredPlaylists += 1;
        await updateCheckJob(jobId, {
          heartbeat: true,
          checkedTracks,
          checkedPlaylists,
          skippedPlaylists,
          unavailableCount: unavailableTracks.length,
          payload: {
            deferredPlaylists,
            scanBudget,
            resumedFromPlaylistId,
            resumePlaylistId: playlist.id,
            resumePlaylistName: playlist.name,
            currentPlaylistName: null,
            currentStage:
              `Dagens scan-budget er brugt op. Playlist udskudt: ${playlist.name}`,
          },
        });
        currentPlaylistContext = null;
        continue;
      }

      if (!options?.ignoreCheckpoints) {
        remainingScanBudget -= 1;
      }

      await updateCheckJob(jobId, {
        heartbeat: true,
        payload: {
          deferredPlaylists,
          scanBudget,
          currentPlaylistName: playlist.name,
          currentStage:
            `Tjekker tracks i playlist: ${playlist.name} (${scanDecision.reason})`,
        },
      });

      const baseCheckedTracks = checkedTracks;
      const baseUnavailableCount = unavailableTracks.length;
      let lastPlaylistProgressSyncAt = 0;

      executionContext.onTrackScanProgress = async (progress) => {
        const now = Date.now();
        if (now - lastPlaylistProgressSyncAt < 1_500) {
          return;
        }

        lastPlaylistProgressSyncAt = now;

        await updateCheckJob(jobId, {
          heartbeat: true,
          checkedTracks: baseCheckedTracks + progress.checkedInPlaylist,
          checkedPlaylists,
          skippedPlaylists,
          unavailableCount: baseUnavailableCount + progress.unavailableInPlaylist,
          payload: {
            deferredPlaylists,
            scanBudget,
            resumedFromPlaylistId,
            resumePlaylistId: playlist.id,
            resumePlaylistName: playlist.name,
            currentPlaylistName: playlist.name,
            currentStage:
              `Tjekker tracks i playlist: ${playlist.name} ` +
              `(${progress.checkedInPlaylist} tracks, ${progress.unavailableInPlaylist} utilgængelige fundet indtil nu)`,
          },
        });
      };

      const result = await fetchUnavailableTracksForPlaylist(
        playlist.id,
        playlist.name,
        accessToken,
        executionContext,
      );

      executionContext.onTrackScanProgress = async () => {};

      checkedTracks += result.checked;
      checkedPlaylists += 1;
      scannedPlaylistIds.add(playlist.id);
      unavailableTracks.push(...result.unavailable);
      currentPlaylistContext = null;

      const checkpointInput = {
        playlistId: playlist.id,
        playlistName: playlist.name,
        snapshotId: playlist.snapshotId,
        trackTotal: playlist.trackTotal,
        lastAvailabilityScanAt: new Date().toISOString(),
        currentUnavailableCount: result.unavailable.length,
        lastRunJobId: jobId,
      };
      checkpointMap.set(playlist.id, {
        playlist_id: checkpointInput.playlistId,
        playlist_name: checkpointInput.playlistName,
        snapshot_id: checkpointInput.snapshotId,
        track_total: checkpointInput.trackTotal,
        last_checked_at: new Date().toISOString(),
        last_availability_scan_at: checkpointInput.lastAvailabilityScanAt,
        current_unavailable_count: checkpointInput.currentUnavailableCount,
        last_run_job_id: checkpointInput.lastRunJobId,
      });
      pendingCheckpointWrites.push(checkpointInput);
      await flushPendingCheckpoints(false);

      await updateCheckJob(jobId, {
        heartbeat: true,
        checkedTracks,
        checkedPlaylists,
        skippedPlaylists,
        unavailableCount: unavailableTracks.length,
        payload: {
          deferredPlaylists,
          scanBudget,
          resumedFromPlaylistId,
          resumePlaylistId: null,
          resumePlaylistName: null,
          currentPlaylistName: null,
          currentStage: `Færdig med playlist: ${playlist.name}`,
        },
      });
    }

    await updateCheckJob(jobId, {
      heartbeat: true,
      payload: {
        deferredPlaylists,
        scanBudget,
        resumedFromPlaylistId,
        resumePlaylistId: null,
        resumePlaylistName: null,
        currentPlaylistName: null,
        currentStage: "Gemmer resultater og sender eventuel mail",
      },
    });

    await flushPendingCheckpoints(true);
    const newUnavailableTracks = await persistUnavailableTracks(
      unavailableTracks,
      [...scannedPlaylistIds],
    );
    await reconcilePlaylistCheckpointUnavailableCounts([...scannedPlaylistIds]);
    await sendUnavailableTracksAlert(newUnavailableTracks);
    await clearSpotifyCooldownState();

    const summary: CheckSummary = {
      status: "ok",
      checkedTracks,
      unavailableCount: unavailableTracks.length,
      newUnavailableCount: newUnavailableTracks.length,
      checkedPlaylists,
      skippedPlaylists,
      deferredPlaylists,
      errorMessage: null,
    };

    await updateCheckJob(jobId, {
      status: "ok",
      checkedTracks,
      checkedPlaylists,
      skippedPlaylists,
      unavailableCount: unavailableTracks.length,
      newUnavailableCount: newUnavailableTracks.length,
      payload: {
        deferredPlaylists,
        scanBudget,
        resumedFromPlaylistId,
        resumePlaylistId: null,
        resumePlaylistName: null,
        currentPlaylistName: null,
        currentStage:
          deferredPlaylists > 0
            ? `Færdig. ${deferredPlaylists} playlister blev udskudt til senere for at skåne Spotify.`
            : "Færdig",
      },
      finished: true,
    });
    await saveRun(summary);
    return summary;
  } catch (error) {
    const spotifyCooldown = getSpotifyCooldownFromError(error);
    if (spotifyCooldown) {
      await setSpotifyCooldownState(spotifyCooldown);
    }

    await flushPendingCheckpoints(true);

    const summary = buildErrorSummary(
      error,
      checkedTracks,
      checkedPlaylists,
      skippedPlaylists,
      deferredPlaylists,
      unavailableTracks.length,
    );

    await updateCheckJob(jobId, {
      status: summary.status,
      checkedTracks,
      checkedPlaylists,
      skippedPlaylists,
      unavailableCount: unavailableTracks.length,
      errorMessage: summary.errorMessage,
      payload: {
        deferredPlaylists,
        scanBudget: activeScanBudget,
        resumedFromPlaylistId: null,
        resumePlaylistId: currentPlaylistContext?.id ?? null,
        resumePlaylistName: currentPlaylistContext?.name ?? null,
        currentPlaylistName: null,
        currentStage: describeFailureStage(error),
      },
      finished: true,
    });
    await saveRun(summary);
    return summary;
  } finally {
    await releaseCheckRunLock(CHECK_RUN_LOCK_NAME, lockOwnerId);
  }
}

export async function runSpotifySmokeCheck(): Promise<SmokeCheckSummary> {
  await ensureSchema();

  const cooldown = await getActiveSpotifyCooldown();
  if (cooldown) {
    return {
      status: "skipped",
      playlistId: null,
      playlistName: null,
      snapshotId: null,
      source: null,
      errorMessage:
        `${cooldown.message} Smoke test springes over indtil ${formatDateForMessage(cooldown.until)}.`,
    };
  }

  try {
    const { playlists } = await fetchOwnPublicPlaylists();
    const selectedPlaylist = playlists[0] ?? null;
    if (!selectedPlaylist) {
      return {
        status: "skipped",
        playlistId: null,
        playlistName: null,
        snapshotId: null,
        source: "database",
        errorMessage:
          "Spotify-forbindelsen virker, men der blev ikke fundet nogen public playlister ejet af den tilsluttede bruger.",
      };
    }

    return {
      status: "ok",
      playlistId: selectedPlaylist.id,
      playlistName: selectedPlaylist.name,
      snapshotId: selectedPlaylist.snapshotId,
      source: "database",
      errorMessage: null,
    };
  } catch (error) {
    const spotifyCooldown = getSpotifyCooldownFromError(error);
    if (spotifyCooldown) {
      await setSpotifyCooldownState(spotifyCooldown);
    }

    return {
      status: "error",
      playlistId: null,
      playlistName: null,
      snapshotId: null,
      source: null,
      errorMessage:
        error instanceof Error ? error.message : "Smoke test mod Spotify fejlede.",
    };
  }
}

function buildErrorSummary(
  error: unknown,
  checkedTracks: number,
  checkedPlaylists: number,
  skippedPlaylists: number,
  deferredPlaylists: number,
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
    deferredPlaylists,
    errorMessage: message,
  };
}

async function getResumePlaylistId() {
  const latestJob = await getLatestCheckJob();
  if (!latestJob || latestJob.status !== "error") {
    return null;
  }

  if (!latestJob.error_message?.includes("Spotify rate limit")) {
    return null;
  }

  const payload = latestJob.payload as CheckJobProgressPayload | null;
  return typeof payload?.resumePlaylistId === "string" ? payload.resumePlaylistId : null;
}

function applyResumePoint(playlists: PlaylistSummary[], resumePlaylistId: string | null) {
  if (!resumePlaylistId) {
    return playlists;
  }

  const resumeIndex = playlists.findIndex((playlist) => playlist.id === resumePlaylistId);
  if (resumeIndex < 0) {
    return playlists;
  }

  return playlists.slice(resumeIndex);
}

function prioritizePlaylistsForScan(
  playlists: PlaylistSummary[],
  checkpointMap: Map<string, PlaylistCheckpointRow>,
) {
  return [...playlists].sort((left, right) => {
    const leftDecision = getPlaylistScanDecision(left, checkpointMap.get(left.id));
    const rightDecision = getPlaylistScanDecision(right, checkpointMap.get(right.id));

    if (leftDecision.priority !== rightDecision.priority) {
      return leftDecision.priority - rightDecision.priority;
    }

    const leftTime = getScanSortTime(checkpointMap.get(left.id));
    const rightTime = getScanSortTime(checkpointMap.get(right.id));

    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.name.localeCompare(right.name, "da");
  });
}

function getPlaylistScanDecision(
  playlist: PlaylistSummary,
  checkpoint: PlaylistCheckpointRow | undefined,
) {
  if (!checkpoint || !checkpoint.last_availability_scan_at) {
    return { shouldScan: true, reason: "aldrig availability-scannet", priority: 1 as const };
  }

  if (
    playlist.snapshotId &&
    checkpoint.snapshot_id &&
    checkpoint.snapshot_id !== playlist.snapshotId
  ) {
    return { shouldScan: true, reason: "snapshot ændret", priority: 0 as const };
  }

  if (playlist.snapshotId && !checkpoint.snapshot_id) {
    return { shouldScan: true, reason: "snapshot mangler lokalt", priority: 0 as const };
  }

  const lastAvailabilityScanAt = new Date(checkpoint.last_availability_scan_at).getTime();
  const ageMs = Date.now() - lastAvailabilityScanAt;
  const currentUnavailableCount = checkpoint.current_unavailable_count ?? 0;

  if (currentUnavailableCount > 0 && ageMs >= UNAVAILABLE_RECHECK_INTERVAL_MS) {
    return {
      shouldScan: true,
      reason: "tidligere utilgængelige tracks skal genbekræftes",
      priority: 2 as const,
    };
  }

  if (ageMs >= STALE_RECHECK_INTERVAL_MS) {
    return {
      shouldScan: true,
      reason: "availability-scan er blevet gammel",
      priority: 3 as const,
    };
  }

  return { shouldScan: false, reason: "uændret snapshot og frisk availability-scan", priority: 4 as const };
}

function getScanSortTime(checkpoint: PlaylistCheckpointRow | undefined) {
  if (!checkpoint?.last_availability_scan_at) {
    return 0;
  }

  return new Date(checkpoint.last_availability_scan_at).getTime();
}

function describeSkipStage(playlistName: string, reason: string) {
  if (reason === "uændret snapshot og frisk availability-scan") {
    return `Springer playlist over: ${playlistName} (${reason})`;
  }

  return `Playlist blev ikke scannet: ${playlistName} (${reason})`;
}

function describeFailureStage(error: unknown) {
  const message = error instanceof Error ? error.message : "";

  if (message.includes("Spotify rate limit")) {
    return "Spotify rate limit ramte appen";
  }

  if (message.includes("timed out")) {
    return "Spotify svarede ikke i tide";
  }

  return "Afsluttet med fejl";
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

async function persistUnavailableTracks(
  unavailableTracks: TrackAvailability[],
  scannedPlaylistIds: string[],
) {
  if (scannedPlaylistIds.length === 0) {
    return [];
  }

  const sql = getSql();
  const scannedPlaylistPayload = JSON.stringify(scannedPlaylistIds);
  const uniqueUnavailableTracks = [
    ...new Map(
      unavailableTracks.map((track) => [`${track.playlistId}::${track.trackId}`, track]),
    ).values(),
  ];
  const payload = uniqueUnavailableTracks.map((track) => ({
    track_id: track.trackId,
    playlist_id: track.playlistId,
    playlist_name: track.playlistName,
    track_name: track.trackName,
    duration_ms: track.durationMs,
  }));

  const [newUnavailableRows] = await sql.transaction([
    sql`
      WITH incoming AS (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS value(
          track_id TEXT,
          playlist_id TEXT,
          playlist_name TEXT,
          track_name TEXT,
          duration_ms INTEGER
        )
      )
      SELECT
        incoming.track_id,
        incoming.playlist_id,
        incoming.playlist_name,
        incoming.track_name,
        incoming.duration_ms
      FROM incoming
      LEFT JOIN unavailable_tracks existing
        ON existing.track_id = incoming.track_id
       AND existing.playlist_id = incoming.playlist_id
      WHERE existing.track_id IS NULL
         OR existing.currently_unavailable = FALSE
    `,
    sql`
      WITH scanned_playlists AS (
        SELECT value AS playlist_id
        FROM jsonb_array_elements_text(${scannedPlaylistPayload}::jsonb) AS value
      ),
      incoming AS (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS value(
          track_id TEXT,
          playlist_id TEXT,
          playlist_name TEXT,
          track_name TEXT,
          duration_ms INTEGER
        )
      )
      UPDATE unavailable_tracks AS target
      SET currently_unavailable = FALSE
      WHERE target.currently_unavailable = TRUE
        AND target.playlist_id IN (
          SELECT playlist_id
          FROM scanned_playlists
        )
        AND NOT EXISTS (
          SELECT 1
          FROM incoming
          WHERE incoming.track_id = target.track_id
            AND incoming.playlist_id = target.playlist_id
        )
    `,
    payload.length === 0
      ? sql`SELECT 1 WHERE FALSE`
      : sql`
          WITH incoming AS (
            SELECT *
            FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS value(
              track_id TEXT,
              playlist_id TEXT,
              playlist_name TEXT,
              track_name TEXT,
              duration_ms INTEGER
            )
          )
          INSERT INTO unavailable_tracks (
            track_id,
            playlist_id,
            playlist_name,
            track_name,
            duration_ms,
            currently_unavailable,
            first_seen_at,
            last_seen_at
          )
          SELECT
            track_id,
            playlist_id,
            playlist_name,
            track_name,
            duration_ms,
            TRUE,
            NOW(),
            NOW()
          FROM incoming
          ON CONFLICT (track_id, playlist_id)
          DO UPDATE SET
            playlist_name = EXCLUDED.playlist_name,
            track_name = EXCLUDED.track_name,
            duration_ms = EXCLUDED.duration_ms,
            currently_unavailable = TRUE,
            last_seen_at = NOW()
        `,
  ]);

  return (newUnavailableRows as Array<{
    track_id: string;
    playlist_id: string;
    playlist_name: string;
    track_name: string;
    duration_ms: number | null;
  }>).map((row) => ({
    trackId: row.track_id,
    playlistId: row.playlist_id,
    playlistName: row.playlist_name,
    trackName: row.track_name,
    durationMs: row.duration_ms,
    unavailableReason: "market",
  }));
}

async function saveRun(summary: CheckSummary) {
  const sql = getSql();
  const payload = {
    checkedPlaylists: summary.checkedPlaylists,
    skippedPlaylists: summary.skippedPlaylists,
    deferredPlaylists: summary.deferredPlaylists,
    newUnavailableCount: summary.newUnavailableCount,
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
  const spotifyConnection = await getSpotifyConnectionStatus();
  const cooldown = await getActiveSpotifyCooldown();
  const lock = await getCheckRunLock(CHECK_RUN_LOCK_NAME);

  if (!lock) {
    return { running: false, spotifyConnection, cooldown, lock: null, job: null };
  }

  const lockedUntilTime = new Date(lock.locked_until).getTime();
  const expiresInSeconds = Math.max(
    0,
    Math.ceil((lockedUntilTime - Date.now()) / 1000),
  );

  if (expiresInSeconds === 0) {
    return { running: false, spotifyConnection, cooldown, lock: null, job: null };
  }

  const job = lock.job_id ? await getCheckJob(lock.job_id) : null;

  return {
    running: true,
    spotifyConnection,
    cooldown,
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

async function getActiveSpotifyCooldown() {
  const cooldown = await getSpotifyCooldownState();

  if (!cooldown) {
    return null;
  }

  const expiresInSeconds = Math.ceil(
    (new Date(cooldown.until).getTime() - Date.now()) / 1000,
  );

  if (expiresInSeconds <= 0) {
    await clearSpotifyCooldownState();
    return null;
  }

  return {
    active: true,
    until: cooldown.until,
    expiresInSeconds,
    message: cooldown.message,
  } satisfies NonNullable<CheckRunStatus["cooldown"]>;
}

function buildCooldownSummary(cooldown: NonNullable<CheckRunStatus["cooldown"]>): CheckSummary {
  return {
    status: "skipped",
    checkedTracks: 0,
    unavailableCount: 0,
    newUnavailableCount: 0,
    checkedPlaylists: 0,
    skippedPlaylists: 0,
    deferredPlaylists: 0,
    errorMessage:
      `${cooldown.message} Nyt check springes over indtil ${formatDateForMessage(cooldown.until)}.`,
  };
}

function formatDateForMessage(value: string) {
  return new Date(value).toISOString();
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

export async function resetPlaylistCheckpoints() {
  await ensureSchema();
  return clearPlaylistCheckpoints();
}
