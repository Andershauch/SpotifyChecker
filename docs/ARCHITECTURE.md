# SpotifyCheck Architecture

## Purpose

SpotifyCheck is a narrow operational app that monitors one Spotify user's own
public playlists and sends an email when a track becomes unavailable in one
configured market.

The app is intentionally optimized for:

- one connected Spotify account
- minimal stored Spotify data
- low-risk operations under Spotify rate limits
- safe manual control through a small admin panel
- unattended daily execution through Vercel Cron and Vercel Workflow

---

## High-level system

Main building blocks:

- Next.js App Router on Vercel
- Neon Postgres for operational state
- Spotify Web API for user playlists and playlist items
- OpenAI API (optional) for AI-powered replacement suggestions
- Resend for notification email
- Vercel Cron for the daily trigger
- Vercel Workflow for durable background execution

At runtime the app has two main modes:

1. **Operator mode** — the connected user opens the control panel, connects
   Spotify, runs smoke tests, starts manual scans, or resets checkpoints
2. **Scheduled mode** — Vercel Cron calls the daily route, which queues the
   same check engine via a durable Workflow run

---

## Core design principles

### Single-user model

This is not a public multi-user product. The app supports one Spotify user and
rejects attempts to reconnect to a different Spotify account while a session
already exists.

### Backend-owned Spotify auth

Spotify access tokens and refresh tokens are stored server-side only. The
browser never receives Spotify tokens or the Spotify client secret.

### Minimal Spotify data retention

The database stores only the data needed to operate the checker and deduplicate
notifications. It is not a general Spotify mirror.

### Rate-limit-aware execution

The checker prefers to skip unnecessary work, persist cooldowns, and resume
where it left off after a rate-limit interruption.

---

## Request flows

### Spotify connect flow

Relevant files:

- [src/app/api/spotify/connect/route.ts](../src/app/api/spotify/connect/route.ts)
- [src/app/api/spotify/callback/route.ts](../src/app/api/spotify/callback/route.ts)
- [src/lib/spotify.ts](../src/lib/spotify.ts)
- [src/lib/auth.ts](../src/lib/auth.ts)

Flow:

1. The operator clicks **Forbind Spotify**
2. `/api/spotify/connect` creates a Spotify auth URL with a stored CSRF `state`
3. Spotify redirects back to `/api/spotify/callback`
4. The callback exchanges the code for access and refresh tokens
5. The app reads the current Spotify user profile from `/me`
6. The app stores the Spotify session in Postgres
7. The callback sets a signed `httpOnly` admin cookie tied to the Spotify user

Important constraints:

- local development uses `http://127.0.0.1:3000/api/spotify/callback`
- production must use an HTTPS redirect URI
- only the scopes needed for playlist reading are requested
- playlist sync is deferred until a smoke test or real check needs it

### Admin session flow

Relevant files:

- [src/lib/auth.ts](../src/lib/auth.ts)

The control panel is protected by a signed cookie, not a manually entered
secret.

How it works:

- the cookie payload contains `spotifyUserId` and an expiry (7 days)
- the cookie is signed with HMAC using `CRON_SECRET`
- every protected API endpoint verifies both the cookie signature and expiry,
  and that the `spotifyUserId` in the cookie matches the currently stored
  Spotify backend session

### Cron flow

Relevant file:

- [src/app/api/cron/daily/route.ts](../src/app/api/cron/daily/route.ts)

Flow:

1. Vercel Cron calls `/api/cron/daily` at 07:00 UTC
2. The route validates `Authorization: Bearer <CRON_SECRET>`
3. The route creates a `check_jobs` row and starts a Vercel Workflow run
4. The route returns quickly with queue status

### Manual scan request flow

Relevant files:

- [src/app/api/check/route.ts](../src/app/api/check/route.ts)
- [src/lib/checker.ts](../src/lib/checker.ts)

Flow:

1. The operator clicks **Start scan**
2. `/api/check` validates the admin cookie
3. The route calls `requestCheckRun("manual")`
4. A queued `check_jobs` row is created and a Workflow run is started
5. The route returns `202 Accepted` immediately
6. The panel polls status until the queued job becomes running

---

## Background execution model

Relevant files:

- [src/workflows/spotify-check.ts](../src/workflows/spotify-check.ts)
- [src/lib/checker.ts](../src/lib/checker.ts)

The check engine runs inside a Vercel Workflow, which provides durable
execution outside of the normal serverless request lifecycle.

The workflow is deliberately thin — a single `"use workflow"` entry point
wrapping a single `"use step"` that calls the core `executeCheckJob` function.
All business logic stays in `checker.ts`.

This means:

- HTTP requests are not held open for the full Spotify scan
- UI and cron get a fast acknowledgment path
- the workflow survives Vercel function timeouts that would kill a plain
  serverless request

---

## Check execution flow

Relevant file:

- [src/lib/checker.ts](../src/lib/checker.ts)

Main steps:

1. Ensure the database schema exists
2. Acquire the global run lock
3. Stop early if a persisted Spotify cooldown is still active
4. Load the current user's own public playlists from Spotify
5. Apply resume logic if the previous run stopped on a Spotify rate limit
6. Load playlist checkpoints in one batch
7. For each playlist:
   - prioritize changed or stale playlists first
   - skip unchanged playlists when their availability scan is still fresh
   - enforce a per-run budget for expensive item-level scans
   - scan playlist items for unavailable tracks
   - update live job progress as tracks are processed
   - buffer checkpoint updates and flush them in batches
8. Persist unavailable-track state through bulk reconciliation SQL
9. Send notification email for newly unavailable tracks only
10. Save a run summary and release the lock

The checker also supports:

- safe cancellation
- force-unlock for operator recovery
- low-cost Spotify smoke testing
- checkpoint reset for intentionally expensive rescans

---

## Spotify API interaction model

Relevant file:

- [src/lib/spotify.ts](../src/lib/spotify.ts)

Endpoints currently used:

- `GET /me` — user identity at connect time
- `GET /me/playlists` — owned public playlists
- `GET /playlists/{id}/items` — track availability scanning
- `GET /tracks` — primary artist backfill (batch, up to 50 per request)
- `GET /audio-features` — BPM estimation (batch, up to 100 per request)
- `GET /search` — Spotify-side search for AI replacement suggestions
- `POST /api/token` — authorization-code and refresh-token exchange

### Playlist discovery

The app loads the connected user's playlists through `/me/playlists` and
filters to playlists owned by the connected user where `public === true`.

### Track availability scan

For each playlist scan the app checks `is_playable` and
`restrictions.reason === "market"` to identify unavailable tracks. Full item
payloads are fetched (Spotify's nested field filtering was found to be too
aggressive and could collapse real items).

### Retry and throttling behavior

- minimum delay between outgoing Spotify requests
- request timeout (15 seconds)
- exponential backoff on failures
- `Retry-After` header support
- early abort when Spotify requests a very long wait
- long `429` responses are treated as a reason to stop the job and persist a
  cooldown rather than blocking in a long sleep

---

## AI replacement suggestions

Relevant file:

- [src/lib/replacements.ts](../src/lib/replacements.ts)

When the operator clicks **Find 2 alternatives** for an unavailable track, the
app:

1. Calls the OpenAI Responses API (`/v1/responses`) with the track name, artist,
   duration, and BPM to get candidate suggestions
2. Validates each suggestion against Spotify Search using a scoring function
   that weighs title match, artist match, and duration proximity
3. Filters out candidates outside a duration tolerance window
4. Stores the final suggestions in the database

This feature is optional. It requires `OPENAI_API_KEY`.

---

## Database model

Relevant file:

- [src/lib/db.ts](../src/lib/db.ts)

The schema is created lazily at runtime by `ensureSchema()`. The result is
memoized per process so hot paths do not repeatedly run DDL.

### `app_runtime_state`

General key-value table for singleton operational state:

- Spotify OAuth CSRF state (during connect flow)
- Spotify session (access token, refresh token, expiry, user identity)
- Spotify cooldown state (when rate-limited)
- RapidAPI BPM daily usage counter

### `monitored_playlists`

Catalog of playlists the checker should consider. Refreshed from the connected
user's own public playlists at the start of each scan.

### `playlist_checkpoints`

Per-playlist scan state used to skip unnecessary rescans:

- last known Spotify `snapshot_id`
- last known track total
- last checked and last availability-scanned timestamps
- current unavailable track count
- last job that touched the checkpoint

### `unavailable_tracks`

Minimal durable record of unavailable findings:

- `track_id`, `playlist_id`, `playlist_name`, `track_name`
- `duration_ms`, `primary_artist_name`, `primary_estimated_bpm`
- `first_seen_at`, `last_seen_at`
- `currently_unavailable` — set to `false` when a subsequent scan finds the
  track is available again

### `track_replacements`

AI-generated replacement suggestions linked to a specific unavailable track.

### `check_jobs`

Primary live job-tracking table for the UI and runtime control flow. Stores:

- lifecycle status (`queued`, `running`, `ok`, `error`, `cancelled`, `skipped`)
- request, start, and finish timestamps
- heartbeat timestamp
- cancellation flag
- checked track and playlist counters
- current payload state (current playlist, resume point, workflow run ID)

### `check_runs`

Historical summary table for completed runs. Lighter-weight than `check_jobs`
and used as an audit log.

### `check_run_lock`

Singleton lock row that prevents concurrent full checks. The checker heartbeats
the lock while running. If a run gets stuck, the operator can force-release it
from the control panel.

---

## Rate-limit strategy

Spotify availability scanning is quota-sensitive. The app uses six layers of
protection.

### Layer 1 — Request throttling

Every Spotify request goes through a minimum request interval and a retry
wrapper with exponential backoff.

### Layer 2 — Snapshot skipping and stale rechecks

If a playlist's `snapshot_id` is unchanged, the checker skips that playlist.
But to catch market-only availability changes (which do not always change the
snapshot), the checker also forces periodic rechecks:

- playlists with no previously unavailable tracks: recheck after 7 days
- playlists that had unavailable tracks in the last scan: recheck after 2 days

### Layer 3 — Per-run scan budget

Item-level track scans are the expensive operations. The checker limits full
scans to 100 playlists per run, spending the budget in priority order:

1. Changed snapshots (highest priority)
2. Never-scanned playlists
3. Playlists with previously unavailable tracks that are due for a recheck
4. Playlists whose availability scan has gone stale

### Layer 4 — Persisted cooldown

If Spotify returns a strong `429` with a long `Retry-After`, the app stores a
cooldown in the database. New runs are skipped until it expires.

### Layer 5 — Resume after interruption

If a run stops on a rate limit, the job payload stores the resume point. The
next run slices the playlist list so already-completed playlists are not
processed again.

### Layer 6 — Bulk unavailable-track reconciliation

When a run completes, unavailable-track state is updated through set-based SQL
rather than per-track `SELECT` + `INSERT` loops. This scales well for large
playlist catalogs.

### Key tradeoff: snapshot vs. availability

A changed `snapshot_id` is a strong signal that playlist content changed, but
it does not guarantee that every market availability change is reflected in it.
The app reduces this risk with periodic stale rechecks but does not guarantee
immediate detection of every market-only change.

---

## Notifications

Relevant file:

- [src/lib/mailer.ts](../src/lib/mailer.ts)

An email is sent only for newly unavailable tracks (tracks not previously
flagged in the database). Tracks that remain unavailable across multiple runs do
not generate repeated emails.

The current email payload: playlist name, track name, track duration.

---

## UI architecture

Relevant files:

- [src/app/run-check-panel/](../src/app/run-check-panel/)

The control panel is a thin operator UI built around a single `useDashboard`
hook in `use-dashboard.ts`. Files:

- `index.tsx` — shell with `"use client"` and tab routing
- `use-dashboard.ts` — all state and API handlers
- `overview-tab.tsx` — run status and counters
- `actions-tab.tsx` — scan controls
- `findings-tab.tsx` — unavailable tracks and AI suggestions
- `settings-tab.tsx` — Spotify connection and advanced recovery
- `types.ts` — shared TypeScript types
- `utils.ts` — pure formatting helpers

---

## Test coverage

Relevant files:

- [src/lib/spotify.test.ts](../src/lib/spotify.test.ts)
- [src/lib/checker.test.ts](../src/lib/checker.test.ts)
- [src/lib/replacements.test.ts](../src/lib/replacements.test.ts)

The test suite covers core business logic that does not require a live Spotify
connection or database:

- search normalization and matching (`spotify.test.ts`, 47 tests)
- playlist scan priority and resume logic (`checker.test.ts`, 15 tests)
- AI suggestion duration tolerance and URL extraction (`replacements.test.ts`,
  12 tests)

Run with `npm test`. No database or Spotify credentials needed.

---

## Environment model

Relevant file:

- [src/lib/env.ts](../src/lib/env.ts)

Required variables: `DATABASE_URL`, `SPOTIFY_CLIENT_ID`,
`SPOTIFY_CLIENT_SECRET`, `SPOTIFY_MARKET`, `RESEND_API_KEY`, `ALERT_EMAIL_TO`,
`ALERT_EMAIL_FROM`, `CRON_SECRET`.

`CRON_SECRET` serves two roles: bearer secret for `/api/cron/daily` and HMAC
signing key for the admin browser cookie.

Optional: `SPOTIFY_REDIRECT_URI` (defaults to localhost callback),
`OPENAI_API_KEY`, `OPENAI_SUGGESTION_MODEL`.
