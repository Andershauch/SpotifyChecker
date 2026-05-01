import {
  acquireCheckRunLock,
  ensureSchema,
  forceReleaseCheckRunLock,
  getCheckRunLock,
  getSql,
  releaseCheckRunLock,
} from "@/lib/db";
import { sendUnavailableTracksAlert } from "@/lib/mailer";
import {
  fetchOwnPublicPlaylists,
  fetchUnavailableTracksForPlaylist,
  type TrackAvailability,
} from "@/lib/spotify";

export const CHECK_RUN_LOCK_NAME = "daily-spotify-check";
const CHECK_RUN_LOCK_TTL_SECONDS = 15 * 60;

export type CheckSummary = {
  status: "ok" | "error" | "skipped";
  checkedTracks: number;
  unavailableCount: number;
  newUnavailableCount: number;
  checkedPlaylists: number;
  errorMessage: string | null;
};

export type CheckRunStatus = {
  running: boolean;
  lock: {
    ownerId: string;
    startedAt: string;
    lockedUntil: string;
    expiresInSeconds: number;
  } | null;
};

type ExistingUnavailableRow = {
  currently_unavailable: boolean;
  first_seen_at: string;
};

type LatestRunRow = {
  run_at: string;
  status: "ok" | "error" | "skipped";
  checked_tracks: number;
  unavailable_count: number;
  error_message: string | null;
  payload: {
    checkedPlaylists?: number;
  };
};

export async function runDailyCheck(): Promise<CheckSummary> {
  await ensureSchema();
  const lockOwnerId = await acquireCheckRunLock(
    CHECK_RUN_LOCK_NAME,
    CHECK_RUN_LOCK_TTL_SECONDS,
  );

  if (!lockOwnerId) {
    const summary: CheckSummary = {
      status: "skipped",
      checkedTracks: 0,
      unavailableCount: 0,
      newUnavailableCount: 0,
      checkedPlaylists: 0,
      errorMessage: "Et andet check kører allerede, så denne trigger blev sprunget over.",
    };

    await saveRun(summary, []);
    return summary;
  }

  let checkedTracks = 0;
  let checkedPlaylists = 0;
  const unavailableTracks: TrackAvailability[] = [];

  try {
    const { accessToken, playlists } = await fetchOwnPublicPlaylists();

    for (const playlist of playlists) {
      const result = await fetchUnavailableTracksForPlaylist(
        playlist.id,
        playlist.name,
        accessToken,
      );
      checkedTracks += result.checked;
      unavailableTracks.push(...result.unavailable);
      checkedPlaylists += 1;
    }

    const newUnavailableTracks = await persistUnavailableTracks(unavailableTracks);
    await sendUnavailableTracksAlert(newUnavailableTracks);

    const summary: CheckSummary = {
      status: "ok",
      checkedTracks,
      unavailableCount: unavailableTracks.length,
      newUnavailableCount: newUnavailableTracks.length,
      checkedPlaylists,
      errorMessage: null,
    };

    await saveRun(summary, unavailableTracks);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    const summary: CheckSummary = {
      status: "error",
      checkedTracks,
      unavailableCount: unavailableTracks.length,
      newUnavailableCount: 0,
      checkedPlaylists,
      errorMessage: message,
    };

    await saveRun(summary, unavailableTracks);
    return summary;
  } finally {
    await releaseCheckRunLock(CHECK_RUN_LOCK_NAME, lockOwnerId);
  }
}

async function persistUnavailableTracks(unavailableTracks: TrackAvailability[]) {
  const sql = getSql();
  await sql`UPDATE unavailable_tracks SET currently_unavailable = FALSE`;

  const newUnavailableTracks: TrackAvailability[] = [];

  for (const track of unavailableTracks) {
    const existingRows = (await sql`
      SELECT currently_unavailable, first_seen_at
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
    ORDER BY run_at DESC
    LIMIT 1
  `) as LatestRunRow[];

  return rows[0] ?? null;
}

export async function getCurrentCheckRunStatus(): Promise<CheckRunStatus> {
  await ensureSchema();
  const lock = await getCheckRunLock(CHECK_RUN_LOCK_NAME);

  if (!lock) {
    return { running: false, lock: null };
  }

  const lockedUntilTime = new Date(lock.locked_until).getTime();
  const expiresInSeconds = Math.max(
    0,
    Math.ceil((lockedUntilTime - Date.now()) / 1000),
  );

  if (expiresInSeconds === 0) {
    return { running: false, lock: null };
  }

  return {
    running: true,
    lock: {
      ownerId: lock.owner_id,
      startedAt: lock.started_at,
      lockedUntil: lock.locked_until,
      expiresInSeconds,
    },
  };
}

export async function forceUnlockCurrentCheckRun() {
  await ensureSchema();
  const released = await forceReleaseCheckRunLock(CHECK_RUN_LOCK_NAME);
  return { released: Boolean(released) };
}
