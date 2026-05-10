import { neon } from "@neondatabase/serverless";
import { getEnv } from "@/lib/env";

export type CheckRunLockRow = {
  lock_name: string;
  owner_id: string;
  job_id: string | null;
  started_at: string;
  locked_until: string;
};

export type CheckJobRow = {
  id: string;
  trigger_source: string;
  status: string;
  requested_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  cancel_requested: boolean;
  checked_tracks: number;
  checked_playlists: number;
  skipped_playlists: number;
  unavailable_count: number;
  new_unavailable_count: number;
  error_message: string | null;
  payload: Record<string, unknown>;
};

export type PlaylistCheckpointRow = {
  playlist_id: string;
  playlist_name: string;
  snapshot_id: string | null;
  track_total: number | null;
  last_checked_at: string | null;
  last_availability_scan_at: string | null;
  current_unavailable_count: number | null;
  last_run_job_id: string | null;
};

export type MonitoredPlaylistRow = {
  playlist_id: string;
  is_active: boolean;
  source: string;
  created_at: string;
  updated_at: string;
};

export type CurrentUnavailableTrackRow = {
  playlist_id: string;
  playlist_name: string;
  track_id: string;
  track_name: string;
  primary_artist_name: string | null;
  primary_estimated_bpm: number | null;
  primary_estimated_bpm_source: string | null;
  duration_ms: number | null;
  first_seen_at: string;
  last_seen_at: string;
  currently_unavailable: boolean;
};

export type TrackReplacementRow = {
  playlist_id: string;
  unavailable_track_id: string;
  reference_artist_name: string | null;
  reference_estimated_bpm: number | null;
  suggestion_index: number;
  suggested_track_name: string;
  suggested_artist_name: string;
  suggested_spotify_url: string | null;
  suggested_spotify_track_id: string | null;
  duration_ms: number | null;
  estimated_bpm: number | null;
  reasoning_summary: string;
  source_model: string;
  generated_at: string;
};

export type UnavailableTrackArtistBackfillRow = {
  playlist_id: string;
  track_id: string;
};

export type UnavailableTrackBpmBackfillRow = {
  playlist_id: string;
  track_id: string;
  track_name: string;
  primary_artist_name: string | null;
};

type AppRuntimeStateRow = {
  state_key: string;
  state_value: Record<string, unknown>;
  updated_at: string;
};

export type SpotifyCooldownState = {
  until: string;
  retryAfterSeconds: number;
  message: string;
};

export type SpotifyAuthState = {
  state: string;
  createdAt: string;
};

export type SpotifySessionState = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
  spotifyUserId: string;
  displayName: string | null;
  connectedAt: string;
};

export type RapidApiBpmDailyUsageState = {
  date: string;
  attemptedCount: number;
  successfulCount: number;
  updatedAt: string;
};

export function getSql() {
  return neon(getEnv().DATABASE_URL);
}

let schemaReadyPromise: Promise<void> | null = null;

export async function ensureSchema() {
  if (schemaReadyPromise) {
    return schemaReadyPromise;
  }

  schemaReadyPromise = (async () => {
    const sql = getSql();

    await sql`
      CREATE TABLE IF NOT EXISTS check_runs (
        id BIGSERIAL PRIMARY KEY,
        run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL,
        checked_tracks INTEGER NOT NULL,
        unavailable_count INTEGER NOT NULL,
        error_message TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS unavailable_tracks (
        track_id TEXT NOT NULL,
        playlist_id TEXT NOT NULL,
        playlist_name TEXT NOT NULL,
        track_name TEXT NOT NULL,
        primary_artist_name TEXT,
        primary_estimated_bpm INTEGER,
        primary_estimated_bpm_source TEXT,
        duration_ms INTEGER,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        currently_unavailable BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (track_id, playlist_id)
      );
    `;

    await sql`
      ALTER TABLE unavailable_tracks
      ADD COLUMN IF NOT EXISTS duration_ms INTEGER
    `;

    await sql`
      ALTER TABLE unavailable_tracks
      ADD COLUMN IF NOT EXISTS primary_artist_name TEXT
    `;

    await sql`
      ALTER TABLE unavailable_tracks
      ADD COLUMN IF NOT EXISTS primary_estimated_bpm INTEGER
    `;

    await sql`
      ALTER TABLE unavailable_tracks
      ADD COLUMN IF NOT EXISTS primary_estimated_bpm_source TEXT
    `;

    await sql`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'unavailable_tracks'
            AND column_name = 'artists'
            AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE unavailable_tracks
          ALTER COLUMN artists DROP NOT NULL;
        END IF;
      END
      $$;
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS track_replacements (
        playlist_id TEXT NOT NULL,
        unavailable_track_id TEXT NOT NULL,
        reference_artist_name TEXT,
        reference_estimated_bpm INTEGER,
        suggestion_index INTEGER NOT NULL,
        suggested_track_name TEXT NOT NULL,
        suggested_artist_name TEXT NOT NULL,
        suggested_spotify_url TEXT,
        suggested_spotify_track_id TEXT,
        duration_ms INTEGER,
        estimated_bpm INTEGER,
        reasoning_summary TEXT NOT NULL,
        source_model TEXT NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (playlist_id, unavailable_track_id, suggestion_index)
      );
    `;

    await sql`
      ALTER TABLE track_replacements
      ADD COLUMN IF NOT EXISTS reference_artist_name TEXT
    `;

    await sql`
      ALTER TABLE track_replacements
      ADD COLUMN IF NOT EXISTS reference_estimated_bpm INTEGER
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS check_run_lock (
        lock_name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_until TIMESTAMPTZ NOT NULL
      );
    `;

    await sql`
      ALTER TABLE check_run_lock
      ADD COLUMN IF NOT EXISTS job_id TEXT
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS check_jobs (
        id TEXT PRIMARY KEY,
        trigger_source TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        heartbeat_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
        checked_tracks INTEGER NOT NULL DEFAULT 0,
        checked_playlists INTEGER NOT NULL DEFAULT 0,
        skipped_playlists INTEGER NOT NULL DEFAULT 0,
        unavailable_count INTEGER NOT NULL DEFAULT 0,
        new_unavailable_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS playlist_checkpoints (
        playlist_id TEXT PRIMARY KEY,
        playlist_name TEXT NOT NULL,
        snapshot_id TEXT,
        track_total INTEGER,
        last_checked_at TIMESTAMPTZ,
        last_availability_scan_at TIMESTAMPTZ,
        current_unavailable_count INTEGER,
        last_run_job_id TEXT
      );
    `;

    await sql`
      ALTER TABLE playlist_checkpoints
      ADD COLUMN IF NOT EXISTS last_availability_scan_at TIMESTAMPTZ
    `;

    await sql`
      ALTER TABLE playlist_checkpoints
      ADD COLUMN IF NOT EXISTS current_unavailable_count INTEGER
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS monitored_playlists (
        playlist_id TEXT PRIMARY KEY,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS app_runtime_state (
        state_key TEXT PRIMARY KEY,
        state_value JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;
  })();

  try {
    await schemaReadyPromise;
  } catch (error) {
    schemaReadyPromise = null;
    throw error;
  }
}

export async function createCheckJob(triggerSource: string) {
  const sql = getSql();
  const jobId = crypto.randomUUID();

  const rows = (await sql`
    INSERT INTO check_jobs (id, trigger_source, status)
    VALUES (${jobId}, ${triggerSource}, 'queued')
    RETURNING *
  `) as CheckJobRow[];

  return rows[0];
}

export async function getCheckJob(jobId: string) {
  const sql = getSql();
  const rows = (await sql`
    SELECT *
    FROM check_jobs
    WHERE id = ${jobId}
    LIMIT 1
  `) as CheckJobRow[];

  return rows[0] ?? null;
}

export async function getLatestCheckJob() {
  const sql = getSql();
  const rows = (await sql`
    SELECT *
    FROM check_jobs
    ORDER BY requested_at DESC
    LIMIT 1
  `) as CheckJobRow[];

  return rows[0] ?? null;
}

export async function getCurrentUnavailableTracks() {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT
      playlist_id,
      playlist_name,
      track_id,
      track_name,
      primary_artist_name,
      primary_estimated_bpm,
      primary_estimated_bpm_source,
      duration_ms,
      first_seen_at,
      last_seen_at,
      currently_unavailable
    FROM unavailable_tracks
    WHERE currently_unavailable = TRUE
    ORDER BY playlist_name ASC, track_name ASC
  `) as CurrentUnavailableTrackRow[];

  return rows;
}

export async function getKnownUnavailableTracks() {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT
      playlist_id,
      playlist_name,
      track_id,
      track_name,
      primary_artist_name,
      primary_estimated_bpm,
      primary_estimated_bpm_source,
      duration_ms,
      first_seen_at,
      last_seen_at,
      currently_unavailable
    FROM unavailable_tracks
    ORDER BY currently_unavailable DESC, playlist_name ASC, track_name ASC
  `) as CurrentUnavailableTrackRow[];

  return rows;
}

export async function getUnavailableTrack(
  playlistId: string,
  trackId: string,
) {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT
      playlist_id,
      playlist_name,
      track_id,
      track_name,
      primary_artist_name,
      primary_estimated_bpm,
      primary_estimated_bpm_source,
      duration_ms,
      first_seen_at,
      last_seen_at,
      currently_unavailable
    FROM unavailable_tracks
    WHERE playlist_id = ${playlistId}
      AND track_id = ${trackId}
    LIMIT 1
  `) as CurrentUnavailableTrackRow[];

  return rows[0] ?? null;
}

export async function getTrackReplacementsForCurrentUnavailableTracks() {
  const sql = getSql();
  const rows = (await sql`
    SELECT
      playlist_id,
      unavailable_track_id,
      reference_artist_name,
      reference_estimated_bpm,
      suggestion_index,
      suggested_track_name,
      suggested_artist_name,
      suggested_spotify_url,
      suggested_spotify_track_id,
      duration_ms,
      estimated_bpm,
      reasoning_summary,
      source_model,
      generated_at
    FROM track_replacements
    ORDER BY playlist_id ASC, unavailable_track_id ASC, suggestion_index ASC
  `) as TrackReplacementRow[];

  return rows;
}

export async function backfillUnavailableTrackArtistsFromReplacements() {
  const sql = getSql();
  const rows = await sql`
    WITH replacement_reference AS (
      SELECT
        playlist_id,
        unavailable_track_id,
        MIN(reference_artist_name) AS reference_artist_name
      FROM track_replacements
      WHERE reference_artist_name IS NOT NULL
        AND BTRIM(reference_artist_name) <> ''
      GROUP BY playlist_id, unavailable_track_id
    )
    UPDATE unavailable_tracks AS target
    SET primary_artist_name = replacement_reference.reference_artist_name
    FROM replacement_reference
    WHERE target.playlist_id = replacement_reference.playlist_id
      AND target.track_id = replacement_reference.unavailable_track_id
      AND (target.primary_artist_name IS NULL OR BTRIM(target.primary_artist_name) = '')
    RETURNING target.track_id
  `;

  return rows.length;
}

export async function getCurrentUnavailableTracksMissingPrimaryArtist(limit: number) {
  const sql = getSql();
  const rows = (await sql`
    SELECT
      playlist_id,
      track_id
    FROM unavailable_tracks
    WHERE currently_unavailable = TRUE
      AND (primary_artist_name IS NULL OR BTRIM(primary_artist_name) = '')
    ORDER BY last_seen_at DESC, playlist_name ASC, track_name ASC
    LIMIT ${limit}
  `) as UnavailableTrackArtistBackfillRow[];

  return rows;
}

export async function updateUnavailableTrackPrimaryArtists(input: Array<{
  playlistId: string;
  trackId: string;
  primaryArtistName: string;
}>) {
  const uniqueRows = [
    ...new Map(
      input.map((row) => [`${row.playlistId}::${row.trackId}`, row]),
    ).values(),
  ];

  if (uniqueRows.length === 0) {
    return 0;
  }

  const sql = getSql();
  const rows = await sql`
    WITH incoming AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        uniqueRows.map((row) => ({
          playlist_id: row.playlistId,
          track_id: row.trackId,
          primary_artist_name: row.primaryArtistName,
        })),
      )}::jsonb) AS value(
        playlist_id TEXT,
        track_id TEXT,
        primary_artist_name TEXT
      )
    )
    UPDATE unavailable_tracks AS target
    SET primary_artist_name = incoming.primary_artist_name
    FROM incoming
    WHERE target.playlist_id = incoming.playlist_id
      AND target.track_id = incoming.track_id
      AND (target.primary_artist_name IS NULL OR BTRIM(target.primary_artist_name) = '')
    RETURNING target.track_id
  `;

  return rows.length;
}

export async function getCurrentUnavailableTracksMissingPrimaryEstimatedBpm(limit: number) {
  const sql = getSql();
  const rows = (await sql`
    SELECT
      playlist_id,
      track_id,
      track_name,
      primary_artist_name
    FROM unavailable_tracks
    WHERE currently_unavailable = TRUE
      AND primary_estimated_bpm IS NULL
    ORDER BY last_seen_at DESC, playlist_name ASC, track_name ASC
    LIMIT ${limit}
  `) as UnavailableTrackBpmBackfillRow[];

  return rows;
}

export async function updateUnavailableTrackPrimaryEstimatedBpms(input: Array<{
  playlistId: string;
  trackId: string;
  primaryEstimatedBpm: number;
  source: string;
}>) {
  const uniqueRows = [
    ...new Map(
      input.map((row) => [`${row.playlistId}::${row.trackId}`, row]),
    ).values(),
  ];

  if (uniqueRows.length === 0) {
    return 0;
  }

  const sql = getSql();
  const rows = await sql`
    WITH incoming AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        uniqueRows.map((row) => ({
          playlist_id: row.playlistId,
          track_id: row.trackId,
          primary_estimated_bpm: row.primaryEstimatedBpm,
          primary_estimated_bpm_source: row.source,
        })),
      )}::jsonb) AS value(
        playlist_id TEXT,
        track_id TEXT,
        primary_estimated_bpm INTEGER,
        primary_estimated_bpm_source TEXT
      )
    )
    UPDATE unavailable_tracks AS target
    SET
      primary_estimated_bpm = incoming.primary_estimated_bpm,
      primary_estimated_bpm_source = incoming.primary_estimated_bpm_source
    FROM incoming
    WHERE target.playlist_id = incoming.playlist_id
      AND target.track_id = incoming.track_id
      AND target.primary_estimated_bpm IS NULL
    RETURNING target.track_id
  `;

  return rows.length;
}

export async function replaceTrackReplacements(input: {
  playlistId: string;
  unavailableTrackId: string;
  referenceArtistName: string | null;
  referenceEstimatedBpm: number | null;
  sourceModel: string;
  suggestions: Array<{
    suggestionIndex: number;
    suggestedTrackName: string;
    suggestedArtistName: string;
    suggestedSpotifyUrl: string | null;
    suggestedSpotifyTrackId: string | null;
    durationMs: number | null;
    estimatedBpm: number | null;
    reasoningSummary: string;
  }>;
}) {
  const sql = getSql();
  const uniqueSuggestions = [
    ...new Map(
      input.suggestions.map((suggestion) => [suggestion.suggestionIndex, suggestion]),
    ).values(),
  ];

  await sql.transaction([
    sql`
      DELETE FROM track_replacements
      WHERE playlist_id = ${input.playlistId}
        AND unavailable_track_id = ${input.unavailableTrackId}
    `,
    uniqueSuggestions.length === 0
      ? sql`SELECT 1 WHERE FALSE`
      : sql`
          WITH incoming AS (
            SELECT *
            FROM jsonb_to_recordset(${JSON.stringify(
              uniqueSuggestions.map((suggestion) => ({
                playlist_id: input.playlistId,
                unavailable_track_id: input.unavailableTrackId,
                reference_artist_name: input.referenceArtistName,
                reference_estimated_bpm: input.referenceEstimatedBpm,
                suggestion_index: suggestion.suggestionIndex,
                suggested_track_name: suggestion.suggestedTrackName,
                suggested_artist_name: suggestion.suggestedArtistName,
                suggested_spotify_url: suggestion.suggestedSpotifyUrl,
                suggested_spotify_track_id: suggestion.suggestedSpotifyTrackId,
                duration_ms: suggestion.durationMs,
                estimated_bpm: suggestion.estimatedBpm,
                reasoning_summary: suggestion.reasoningSummary,
                source_model: input.sourceModel,
              })),
            )}::jsonb) AS value(
              playlist_id TEXT,
              unavailable_track_id TEXT,
              reference_artist_name TEXT,
              reference_estimated_bpm INTEGER,
              suggestion_index INTEGER,
              suggested_track_name TEXT,
              suggested_artist_name TEXT,
              suggested_spotify_url TEXT,
              suggested_spotify_track_id TEXT,
              duration_ms INTEGER,
              estimated_bpm INTEGER,
              reasoning_summary TEXT,
              source_model TEXT
            )
          )
          INSERT INTO track_replacements (
            playlist_id,
            unavailable_track_id,
            reference_artist_name,
            reference_estimated_bpm,
            suggestion_index,
            suggested_track_name,
            suggested_artist_name,
            suggested_spotify_url,
            suggested_spotify_track_id,
            duration_ms,
            estimated_bpm,
            reasoning_summary,
            source_model,
            generated_at
          )
          SELECT
            playlist_id,
            unavailable_track_id,
            reference_artist_name,
            reference_estimated_bpm,
            suggestion_index,
            suggested_track_name,
            suggested_artist_name,
            suggested_spotify_url,
            suggested_spotify_track_id,
            duration_ms,
            estimated_bpm,
            reasoning_summary,
            source_model,
            NOW()
          FROM incoming
        `,
  ]);
}

export async function upsertTrackReplacement(input: {
  playlistId: string;
  unavailableTrackId: string;
  referenceArtistName: string | null;
  referenceEstimatedBpm: number | null;
  sourceModel: string;
  suggestionIndex: number;
  suggestedTrackName: string;
  suggestedArtistName: string;
  suggestedSpotifyUrl: string | null;
  suggestedSpotifyTrackId: string | null;
  durationMs: number | null;
  estimatedBpm: number | null;
  reasoningSummary: string;
}) {
  const sql = getSql();

  await sql`
    INSERT INTO track_replacements (
      playlist_id,
      unavailable_track_id,
      reference_artist_name,
      reference_estimated_bpm,
      suggestion_index,
      suggested_track_name,
      suggested_artist_name,
      suggested_spotify_url,
      suggested_spotify_track_id,
      duration_ms,
      estimated_bpm,
      reasoning_summary,
      source_model,
      generated_at
    )
    VALUES (
      ${input.playlistId},
      ${input.unavailableTrackId},
      ${input.referenceArtistName},
      ${input.referenceEstimatedBpm},
      ${input.suggestionIndex},
      ${input.suggestedTrackName},
      ${input.suggestedArtistName},
      ${input.suggestedSpotifyUrl},
      ${input.suggestedSpotifyTrackId},
      ${input.durationMs},
      ${input.estimatedBpm},
      ${input.reasoningSummary},
      ${input.sourceModel},
      NOW()
    )
    ON CONFLICT (playlist_id, unavailable_track_id, suggestion_index)
    DO UPDATE SET
      reference_artist_name = EXCLUDED.reference_artist_name,
      reference_estimated_bpm = EXCLUDED.reference_estimated_bpm,
      suggested_track_name = EXCLUDED.suggested_track_name,
      suggested_artist_name = EXCLUDED.suggested_artist_name,
      suggested_spotify_url = EXCLUDED.suggested_spotify_url,
      suggested_spotify_track_id = EXCLUDED.suggested_spotify_track_id,
      duration_ms = EXCLUDED.duration_ms,
      estimated_bpm = EXCLUDED.estimated_bpm,
      reasoning_summary = EXCLUDED.reasoning_summary,
      source_model = EXCLUDED.source_model,
      generated_at = NOW()
  `;
}

export async function updateCheckJob(
  jobId: string,
  patch: {
    status?: string;
    cancelRequested?: boolean;
    checkedTracks?: number;
    checkedPlaylists?: number;
    skippedPlaylists?: number;
    unavailableCount?: number;
    newUnavailableCount?: number;
    errorMessage?: string | null;
    payload?: Record<string, unknown>;
    started?: boolean;
    heartbeat?: boolean;
    finished?: boolean;
  },
) {
  const sql = getSql();
  const rows = (await sql`
    UPDATE check_jobs
    SET
      status = COALESCE(${patch.status ?? null}, status),
      cancel_requested = COALESCE(${patch.cancelRequested ?? null}, cancel_requested),
      checked_tracks = COALESCE(${patch.checkedTracks ?? null}, checked_tracks),
      checked_playlists = COALESCE(${patch.checkedPlaylists ?? null}, checked_playlists),
      skipped_playlists = COALESCE(${patch.skippedPlaylists ?? null}, skipped_playlists),
      unavailable_count = COALESCE(${patch.unavailableCount ?? null}, unavailable_count),
      new_unavailable_count = COALESCE(${patch.newUnavailableCount ?? null}, new_unavailable_count),
      error_message = COALESCE(${patch.errorMessage ?? null}, error_message),
      payload = COALESCE(${patch.payload ? JSON.stringify(patch.payload) : null}::jsonb, payload),
      started_at = CASE WHEN ${patch.started ?? false} THEN COALESCE(started_at, NOW()) ELSE started_at END,
      heartbeat_at = CASE WHEN ${patch.heartbeat ?? false} THEN NOW() ELSE heartbeat_at END,
      finished_at = CASE WHEN ${patch.finished ?? false} THEN NOW() ELSE finished_at END
    WHERE id = ${jobId}
    RETURNING *
  `) as CheckJobRow[];

  return rows[0] ?? null;
}

export async function acquireCheckRunLock(
  lockName: string,
  ttlSeconds: number,
  jobId: string,
) {
  const sql = getSql();
  const ownerId = crypto.randomUUID();

  const rows = (await sql`
    INSERT INTO check_run_lock (lock_name, owner_id, job_id, started_at, locked_until)
    VALUES (
      ${lockName},
      ${ownerId},
      ${jobId},
      NOW(),
      NOW() + (${ttlSeconds} * INTERVAL '1 second')
    )
    ON CONFLICT (lock_name)
    DO UPDATE SET
      owner_id = EXCLUDED.owner_id,
      job_id = EXCLUDED.job_id,
      started_at = NOW(),
      locked_until = EXCLUDED.locked_until
    WHERE check_run_lock.locked_until < NOW()
    RETURNING lock_name, owner_id, job_id, started_at, locked_until
  `) as CheckRunLockRow[];

  const acquired = rows[0]?.owner_id === ownerId;
  return acquired ? rows[0] : null;
}

export async function heartbeatCheckRunLock(
  lockName: string,
  ownerId: string,
  ttlSeconds: number,
) {
  const sql = getSql();
  const rows = (await sql`
    UPDATE check_run_lock
    SET locked_until = NOW() + (${ttlSeconds} * INTERVAL '1 second')
    WHERE lock_name = ${lockName}
      AND owner_id = ${ownerId}
    RETURNING lock_name, owner_id, job_id, started_at, locked_until
  `) as CheckRunLockRow[];

  return rows[0] ?? null;
}

export async function releaseCheckRunLock(lockName: string, ownerId: string) {
  const sql = getSql();
  await sql`
    DELETE FROM check_run_lock
    WHERE lock_name = ${lockName}
      AND owner_id = ${ownerId}
  `;
}

export async function getCheckRunLock(lockName: string) {
  const sql = getSql();
  const rows = (await sql`
    SELECT lock_name, owner_id, job_id, started_at, locked_until
    FROM check_run_lock
    WHERE lock_name = ${lockName}
    LIMIT 1
  `) as CheckRunLockRow[];

  return rows[0] ?? null;
}

export async function forceReleaseCheckRunLock(lockName: string) {
  const sql = getSql();
  const rows = (await sql`
    DELETE FROM check_run_lock
    WHERE lock_name = ${lockName}
    RETURNING lock_name, owner_id, job_id, started_at, locked_until
  `) as CheckRunLockRow[];

  return rows[0] ?? null;
}

export async function getPlaylistCheckpoint(playlistId: string) {
  const sql = getSql();
  const rows = (await sql`
    SELECT
      playlist_id,
      playlist_name,
      snapshot_id,
      track_total,
      last_checked_at,
      last_availability_scan_at,
      current_unavailable_count,
      last_run_job_id
    FROM playlist_checkpoints
    WHERE playlist_id = ${playlistId}
    LIMIT 1
  `) as PlaylistCheckpointRow[];

  return rows[0] ?? null;
}

export async function getPlaylistCheckpoints(playlistIds: string[]) {
  if (playlistIds.length === 0) {
    return [] as PlaylistCheckpointRow[];
  }

  const sql = getSql();
  const rows = (await sql`
    SELECT
      playlist_id,
      playlist_name,
      snapshot_id,
      track_total,
      last_checked_at,
      last_availability_scan_at,
      current_unavailable_count,
      last_run_job_id
    FROM playlist_checkpoints
    WHERE playlist_id = ANY(${playlistIds})
  `) as PlaylistCheckpointRow[];

  return rows;
}

export async function upsertPlaylistCheckpoint(input: {
  playlistId: string;
  playlistName: string;
  snapshotId: string | null;
  trackTotal: number | null;
  lastAvailabilityScanAt?: string | null;
  currentUnavailableCount?: number | null;
  lastRunJobId: string;
}) {
  const sql = getSql();
  const rows = (await sql`
    INSERT INTO playlist_checkpoints (
      playlist_id,
      playlist_name,
      snapshot_id,
      track_total,
      last_checked_at,
      last_availability_scan_at,
      current_unavailable_count,
      last_run_job_id
    )
    VALUES (
      ${input.playlistId},
      ${input.playlistName},
      ${input.snapshotId},
      ${input.trackTotal},
      NOW(),
      ${input.lastAvailabilityScanAt ?? null},
      ${input.currentUnavailableCount ?? null},
      ${input.lastRunJobId}
    )
    ON CONFLICT (playlist_id)
    DO UPDATE SET
      playlist_name = EXCLUDED.playlist_name,
      snapshot_id = EXCLUDED.snapshot_id,
      track_total = EXCLUDED.track_total,
      last_checked_at = NOW(),
      last_availability_scan_at = COALESCE(
        EXCLUDED.last_availability_scan_at,
        playlist_checkpoints.last_availability_scan_at
      ),
      current_unavailable_count = COALESCE(
        EXCLUDED.current_unavailable_count,
        playlist_checkpoints.current_unavailable_count
      ),
      last_run_job_id = EXCLUDED.last_run_job_id
    RETURNING
      playlist_id,
      playlist_name,
      snapshot_id,
      track_total,
      last_checked_at,
      last_availability_scan_at,
      current_unavailable_count,
      last_run_job_id
  `) as PlaylistCheckpointRow[];

  return rows[0] ?? null;
}

export async function upsertPlaylistCheckpoints(
  inputs: Array<{
    playlistId: string;
    playlistName: string;
    snapshotId: string | null;
    trackTotal: number | null;
    lastAvailabilityScanAt?: string | null;
    currentUnavailableCount?: number | null;
    lastRunJobId: string;
  }>,
) {
  if (inputs.length === 0) {
    return;
  }

  const sql = getSql();
  const uniqueInputs = [
    ...new Map(inputs.map((input) => [input.playlistId, input])).values(),
  ];
  const payload = uniqueInputs.map((input) => ({
    playlist_id: input.playlistId,
    playlist_name: input.playlistName,
    snapshot_id: input.snapshotId,
    track_total: input.trackTotal,
    last_availability_scan_at: input.lastAvailabilityScanAt ?? null,
    current_unavailable_count: input.currentUnavailableCount ?? null,
    last_run_job_id: input.lastRunJobId,
  }));

  await sql`
    WITH incoming AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS value(
        playlist_id TEXT,
        playlist_name TEXT,
        snapshot_id TEXT,
        track_total INTEGER,
        last_availability_scan_at TIMESTAMPTZ,
        current_unavailable_count INTEGER,
        last_run_job_id TEXT
      )
    )
    INSERT INTO playlist_checkpoints (
      playlist_id,
      playlist_name,
      snapshot_id,
      track_total,
      last_checked_at,
      last_availability_scan_at,
      current_unavailable_count,
      last_run_job_id
    )
    SELECT
      playlist_id,
      playlist_name,
      snapshot_id,
      track_total,
      NOW(),
      last_availability_scan_at,
      current_unavailable_count,
      last_run_job_id
    FROM incoming
    ON CONFLICT (playlist_id)
    DO UPDATE SET
      playlist_name = EXCLUDED.playlist_name,
      snapshot_id = EXCLUDED.snapshot_id,
      track_total = EXCLUDED.track_total,
      last_checked_at = NOW(),
      last_availability_scan_at = COALESCE(
        EXCLUDED.last_availability_scan_at,
        playlist_checkpoints.last_availability_scan_at
      ),
      current_unavailable_count = COALESCE(
        EXCLUDED.current_unavailable_count,
        playlist_checkpoints.current_unavailable_count
      ),
      last_run_job_id = EXCLUDED.last_run_job_id
  `;
}

export async function reconcilePlaylistCheckpointUnavailableCounts(playlistIds?: string[]) {
  if (playlistIds && playlistIds.length === 0) {
    return;
  }

  const sql = getSql();

  if (!playlistIds) {
    await sql`
      UPDATE playlist_checkpoints AS checkpoint
      SET current_unavailable_count = COALESCE(counts.unavailable_count, 0)
      FROM (
        SELECT
          checkpoint.playlist_id,
          COUNT(track.track_id)::INTEGER AS unavailable_count
        FROM playlist_checkpoints checkpoint
        LEFT JOIN unavailable_tracks track
          ON track.playlist_id = checkpoint.playlist_id
         AND track.currently_unavailable = TRUE
        GROUP BY checkpoint.playlist_id
      ) counts
      WHERE counts.playlist_id = checkpoint.playlist_id
    `;
    return;
  }

  await sql`
    WITH target_playlists AS (
      SELECT value AS playlist_id
      FROM jsonb_array_elements_text(${JSON.stringify(playlistIds)}::jsonb) AS value
    ),
    counts AS (
      SELECT
        target_playlists.playlist_id,
        COUNT(track.track_id)::INTEGER AS unavailable_count
      FROM target_playlists
      LEFT JOIN unavailable_tracks track
        ON track.playlist_id = target_playlists.playlist_id
       AND track.currently_unavailable = TRUE
      GROUP BY target_playlists.playlist_id
    )
    UPDATE playlist_checkpoints AS checkpoint
    SET current_unavailable_count = counts.unavailable_count
    FROM counts
    WHERE counts.playlist_id = checkpoint.playlist_id
  `;
}

export async function getActiveMonitoredPlaylistIds() {
  const sql = getSql();
  const rows = (await sql`
    SELECT playlist_id, is_active, source, created_at, updated_at
    FROM monitored_playlists
    WHERE is_active = TRUE
    ORDER BY created_at ASC
  `) as MonitoredPlaylistRow[];

  return rows;
}

export async function clearPlaylistCheckpoints() {
  const sql = getSql();
  const rows = (await sql`
    DELETE FROM playlist_checkpoints
    RETURNING playlist_id
  `) as Array<{ playlist_id: string }>;

  return { deletedCount: rows.length };
}

const SPOTIFY_COOLDOWN_STATE_KEY = "spotify_api_cooldown";
const SPOTIFY_AUTH_STATE_KEY = "spotify_oauth_state";
const SPOTIFY_SESSION_STATE_KEY = "spotify_oauth_session";
const RAPIDAPI_BPM_DAILY_USAGE_STATE_KEY = "rapidapi_bpm_daily_usage";

export async function getSpotifyCooldownState() {
  const sql = getSql();
  const rows = (await sql`
    SELECT state_key, state_value, updated_at
    FROM app_runtime_state
    WHERE state_key = ${SPOTIFY_COOLDOWN_STATE_KEY}
    LIMIT 1
  `) as AppRuntimeStateRow[];

  const row = rows[0];
  if (!row) {
    return null;
  }

  const until = row.state_value.until;
  const retryAfterSeconds = row.state_value.retryAfterSeconds;
  const message = row.state_value.message;

  if (
    typeof until !== "string" ||
    typeof retryAfterSeconds !== "number" ||
    typeof message !== "string"
  ) {
    return null;
  }

  return {
    until,
    retryAfterSeconds,
    message,
  } satisfies SpotifyCooldownState;
}

export async function setSpotifyCooldownState(input: SpotifyCooldownState) {
  const sql = getSql();
  await sql`
    INSERT INTO app_runtime_state (state_key, state_value, updated_at)
    VALUES (
      ${SPOTIFY_COOLDOWN_STATE_KEY},
      ${JSON.stringify(input)}::jsonb,
      NOW()
    )
    ON CONFLICT (state_key)
    DO UPDATE SET
      state_value = EXCLUDED.state_value,
      updated_at = NOW()
  `;
}

export async function clearSpotifyCooldownState() {
  const sql = getSql();
  await sql`
    DELETE FROM app_runtime_state
    WHERE state_key = ${SPOTIFY_COOLDOWN_STATE_KEY}
  `;
}

export async function getSpotifyAuthState() {
  const sql = getSql();
  const rows = (await sql`
    SELECT state_key, state_value, updated_at
    FROM app_runtime_state
    WHERE state_key = ${SPOTIFY_AUTH_STATE_KEY}
    LIMIT 1
  `) as AppRuntimeStateRow[];

  const row = rows[0];
  if (!row) {
    return null;
  }

  const state = row.state_value.state;
  const createdAt = row.state_value.createdAt;

  if (typeof state !== "string" || typeof createdAt !== "string") {
    return null;
  }

  return {
    state,
    createdAt,
  } satisfies SpotifyAuthState;
}

export async function setSpotifyAuthState(input: SpotifyAuthState) {
  const sql = getSql();
  await sql`
    INSERT INTO app_runtime_state (state_key, state_value, updated_at)
    VALUES (
      ${SPOTIFY_AUTH_STATE_KEY},
      ${JSON.stringify(input)}::jsonb,
      NOW()
    )
    ON CONFLICT (state_key)
    DO UPDATE SET
      state_value = EXCLUDED.state_value,
      updated_at = NOW()
  `;
}

export async function clearSpotifyAuthState() {
  const sql = getSql();
  await sql`
    DELETE FROM app_runtime_state
    WHERE state_key = ${SPOTIFY_AUTH_STATE_KEY}
  `;
}

export async function getSpotifySessionState() {
  const sql = getSql();
  const rows = (await sql`
    SELECT state_key, state_value, updated_at
    FROM app_runtime_state
    WHERE state_key = ${SPOTIFY_SESSION_STATE_KEY}
    LIMIT 1
  `) as AppRuntimeStateRow[];

  const row = rows[0];
  if (!row) {
    return null;
  }

  const {
    accessToken,
    refreshToken,
    expiresAt,
    scope,
    spotifyUserId,
    displayName,
    connectedAt,
  } = row.state_value;

  if (
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    typeof expiresAt !== "string" ||
    typeof scope !== "string" ||
    typeof spotifyUserId !== "string" ||
    (displayName !== null && typeof displayName !== "string") ||
    typeof connectedAt !== "string"
  ) {
    return null;
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scope,
    spotifyUserId,
    displayName: displayName ?? null,
    connectedAt,
  } satisfies SpotifySessionState;
}

export async function setSpotifySessionState(input: SpotifySessionState) {
  const sql = getSql();
  await sql`
    INSERT INTO app_runtime_state (state_key, state_value, updated_at)
    VALUES (
      ${SPOTIFY_SESSION_STATE_KEY},
      ${JSON.stringify(input)}::jsonb,
      NOW()
    )
    ON CONFLICT (state_key)
    DO UPDATE SET
      state_value = EXCLUDED.state_value,
      updated_at = NOW()
  `;
}

export async function clearSpotifySessionState() {
  const sql = getSql();
  await sql`
    DELETE FROM app_runtime_state
    WHERE state_key = ${SPOTIFY_SESSION_STATE_KEY}
  `;
}

export async function getRapidApiBpmDailyUsageState() {
  const sql = getSql();
  const rows = (await sql`
    SELECT state_key, state_value, updated_at
    FROM app_runtime_state
    WHERE state_key = ${RAPIDAPI_BPM_DAILY_USAGE_STATE_KEY}
    LIMIT 1
  `) as AppRuntimeStateRow[];

  const row = rows[0];
  if (!row) {
    return null;
  }

  const { date, attemptedCount, successfulCount, updatedAt } = row.state_value;
  if (
    typeof date !== "string" ||
    typeof attemptedCount !== "number" ||
    typeof successfulCount !== "number" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }

  return {
    date,
    attemptedCount,
    successfulCount,
    updatedAt,
  } satisfies RapidApiBpmDailyUsageState;
}

export async function setRapidApiBpmDailyUsageState(input: RapidApiBpmDailyUsageState) {
  const sql = getSql();
  await sql`
    INSERT INTO app_runtime_state (state_key, state_value, updated_at)
    VALUES (
      ${RAPIDAPI_BPM_DAILY_USAGE_STATE_KEY},
      ${JSON.stringify(input)}::jsonb,
      NOW()
    )
    ON CONFLICT (state_key)
    DO UPDATE SET
      state_value = EXCLUDED.state_value,
      updated_at = NOW()
  `;
}

export async function replaceOwnedPublicPlaylists(
  playlists: Array<{ playlistId: string; source?: string }>,
) {
  const sql = getSql();
  const source = "spotify_oauth";
  const playlistIds = playlists.map((playlist) => playlist.playlistId);
  const queries = playlists.map((playlist) => sql`
    INSERT INTO monitored_playlists (playlist_id, is_active, source, created_at, updated_at)
    VALUES (${playlist.playlistId}, TRUE, ${playlist.source ?? source}, NOW(), NOW())
    ON CONFLICT (playlist_id)
    DO UPDATE SET
      is_active = TRUE,
      source = EXCLUDED.source,
      updated_at = NOW()
  `);

  queries.push(
    playlistIds.length === 0
      ? sql`
          UPDATE monitored_playlists
          SET is_active = FALSE, updated_at = NOW()
          WHERE source = ${source}
        `
      : sql`
          UPDATE monitored_playlists
          SET is_active = FALSE, updated_at = NOW()
          WHERE source = ${source}
            AND NOT (playlist_id = ANY(${playlistIds}))
        `,
  );

  await sql.transaction(queries);
}
