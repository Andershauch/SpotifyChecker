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
  const payload = inputs.map((input) => ({
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
