import { ensureSchema, getSql } from "@/lib/db";
import { sendUnavailableTracksAlert } from "@/lib/mailer";
import {
  fetchOwnPublicPlaylists,
  fetchUnavailableTracksForPlaylist,
  type TrackAvailability,
} from "@/lib/spotify";

export type CheckSummary = {
  status: "ok" | "error";
  checkedTracks: number;
  unavailableCount: number;
  newUnavailableCount: number;
  checkedPlaylists: number;
  errorMessage: string | null;
};

export async function runDailyCheck(): Promise<CheckSummary> {
  await ensureSchema();

  try {
    const { accessToken, playlists } = await fetchOwnPublicPlaylists();
    let checkedTracks = 0;
    const unavailableTracks: TrackAvailability[] = [];

    for (const playlist of playlists) {
      const result = await fetchUnavailableTracksForPlaylist(
        playlist.id,
        playlist.name,
        accessToken,
      );
      checkedTracks += result.checked;
      unavailableTracks.push(...result.unavailable);
    }

    const newUnavailableTracks = await persistUnavailableTracks(unavailableTracks);
    await sendUnavailableTracksAlert(newUnavailableTracks);

    const summary: CheckSummary = {
      status: "ok",
      checkedTracks,
      unavailableCount: unavailableTracks.length,
      newUnavailableCount: newUnavailableTracks.length,
      checkedPlaylists: playlists.length,
      errorMessage: null,
    };

    await saveRun(summary, unavailableTracks);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    const summary: CheckSummary = {
      status: "error",
      checkedTracks: 0,
      unavailableCount: 0,
      newUnavailableCount: 0,
      checkedPlaylists: 0,
      errorMessage: message,
    };

    await saveRun(summary, []);
    return summary;
  }
}

async function persistUnavailableTracks(unavailableTracks: TrackAvailability[]) {
  const sql = getSql();
  await sql`UPDATE unavailable_tracks SET currently_unavailable = FALSE`;

  const newUnavailableTracks: TrackAvailability[] = [];

  for (const track of unavailableTracks) {
    const existingRows = await sql<
      Array<{ currently_unavailable: boolean; first_seen_at: string }>
    >`
      SELECT currently_unavailable, first_seen_at
      FROM unavailable_tracks
      WHERE track_id = ${track.trackId}
        AND playlist_id = ${track.playlistId}
      LIMIT 1
    `;

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

  const rows = await sql<
    Array<{
      run_at: string;
      status: "ok" | "error";
      checked_tracks: number;
      unavailable_count: number;
      error_message: string | null;
      payload: {
        checkedPlaylists?: number;
      };
    }>
  >`
    SELECT run_at, status, checked_tracks, unavailable_count, error_message, payload
    FROM check_runs
    ORDER BY run_at DESC
    LIMIT 1
  `;

  return rows[0] ?? null;
}
