import { neon } from "@neondatabase/serverless";
import { getEnv } from "@/lib/env";

type CheckRunLockRow = {
  owner_id: string;
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
}

export async function acquireCheckRunLock(lockName: string, ttlSeconds: number) {
  const sql = getSql();
  const ownerId = crypto.randomUUID();

  const rows = (await sql`
    INSERT INTO check_run_lock (lock_name, owner_id, started_at, locked_until)
    VALUES (
      ${lockName},
      ${ownerId},
      NOW(),
      NOW() + (${ttlSeconds} * INTERVAL '1 second')
    )
    ON CONFLICT (lock_name)
    DO UPDATE SET
      owner_id = EXCLUDED.owner_id,
      started_at = NOW(),
      locked_until = EXCLUDED.locked_until
    WHERE check_run_lock.locked_until < NOW()
    RETURNING owner_id
  `) as CheckRunLockRow[];

  const acquired = rows[0]?.owner_id === ownerId;
  return acquired ? ownerId : null;
}

export async function releaseCheckRunLock(lockName: string, ownerId: string) {
  const sql = getSql();
  await sql`
    DELETE FROM check_run_lock
    WHERE lock_name = ${lockName}
      AND owner_id = ${ownerId}
  `;
}
