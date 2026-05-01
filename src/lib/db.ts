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
  last_run_job_id: string | null;
};

export function getSql() {
  return neon(getEnv().DATABASE_URL);
}

export async function ensureSchema() {
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
      artists TEXT NOT NULL,
      track_url TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      currently_unavailable BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (track_id, playlist_id)
    );
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
      last_run_job_id TEXT
    );
  `;
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
    SELECT playlist_id, playlist_name, snapshot_id, track_total, last_checked_at, last_run_job_id
    FROM playlist_checkpoints
    WHERE playlist_id = ${playlistId}
    LIMIT 1
  `) as PlaylistCheckpointRow[];

  return rows[0] ?? null;
}

export async function upsertPlaylistCheckpoint(input: {
  playlistId: string;
  playlistName: string;
  snapshotId: string | null;
  trackTotal: number | null;
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
      last_run_job_id
    )
    VALUES (
      ${input.playlistId},
      ${input.playlistName},
      ${input.snapshotId},
      ${input.trackTotal},
      NOW(),
      ${input.lastRunJobId}
    )
    ON CONFLICT (playlist_id)
    DO UPDATE SET
      playlist_name = EXCLUDED.playlist_name,
      snapshot_id = EXCLUDED.snapshot_id,
      track_total = EXCLUDED.track_total,
      last_checked_at = NOW(),
      last_run_job_id = EXCLUDED.last_run_job_id
    RETURNING playlist_id, playlist_name, snapshot_id, track_total, last_checked_at, last_run_job_id
  `) as PlaylistCheckpointRow[];

  return rows[0] ?? null;
}
