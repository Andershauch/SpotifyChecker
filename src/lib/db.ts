import { neon } from "@neondatabase/serverless";
import { getEnv } from "@/lib/env";

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
}
