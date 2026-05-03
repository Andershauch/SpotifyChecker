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
- unattended daily execution through Vercel Cron

## High-Level System

Main building blocks:

- Next.js App Router app
- Neon Postgres for operational state
- Spotify Web API for user playlists and playlist items
- Resend for notification email
- Vercel Cron for scheduled execution

At runtime the app has two main modes:

1. Operator mode
   The connected user opens the control panel, connects Spotify, runs smoke
   tests, starts manual checks, or resets checkpoints.
2. Scheduled mode
   Vercel Cron calls the daily route, which queues the same core check engine
   without the browser UI.

## Core Design Principles

### 1. Single-user model

This is not a public multi-user product. The app supports one Spotify user and
 rejects attempts to reconnect the backend to a different Spotify account while
 a session already exists.

### 2. Backend-owned Spotify auth

Spotify access tokens and refresh tokens are stored server-side only. The
browser never receives Spotify tokens or the Spotify client secret.

### 3. Minimal Spotify data retention

The database stores only the data needed to operate the checker and deduplicate
notifications. It is not intended to be a general Spotify mirror.

### 4. Rate-limit-aware execution

The checker prefers to skip unnecessary work, persist cooldowns, and resume
where it left off after a rate-limit interruption.

## Request Flows

## Spotify connect flow

Relevant files:

- [src/app/api/spotify/connect/route.ts](/home/devops/projects/SpotifyCheck/src/app/api/spotify/connect/route.ts)
- [src/app/api/spotify/callback/route.ts](/home/devops/projects/SpotifyCheck/src/app/api/spotify/callback/route.ts)
- [src/lib/spotify.ts](/home/devops/projects/SpotifyCheck/src/lib/spotify.ts)
- [src/lib/auth.ts](/home/devops/projects/SpotifyCheck/src/lib/auth.ts)

Flow:

1. The operator clicks `Forbind Spotify`.
2. `/api/spotify/connect` creates a Spotify auth URL with a stored `state`.
3. Spotify redirects back to `/api/spotify/callback`.
4. The callback exchanges the code for access and refresh tokens.
5. The app reads the current Spotify user profile from `/me`.
6. The app stores the Spotify session in Postgres.
7. The callback sets a signed `httpOnly` admin cookie tied to the Spotify user.
8. Playlist sync is deferred until a smoke test or a real check needs it.

Important constraints:

- local development uses `http://127.0.0.1:3000/api/spotify/callback`
- production should use an HTTPS redirect URI
- only the scopes needed for playlist reading are requested
- the callback intentionally avoids playlist sync so reconnecting Spotify is as
  cheap and rate-limit-safe as possible

## Admin session flow

Relevant files:

- [src/lib/auth.ts](/home/devops/projects/SpotifyCheck/src/lib/auth.ts)
- [src/app/api/check/status/route.ts](/home/devops/projects/SpotifyCheck/src/app/api/check/status/route.ts)

The control panel is protected by a signed cookie, not by manually entering
`CRON_SECRET`.

How it works:

- the cookie payload contains `spotifyUserId` and an expiry
- the cookie is signed with HMAC using `CRON_SECRET`
- every protected UI endpoint verifies both:
  - the cookie signature and expiry
  - that the cookie's `spotifyUserId` matches the currently stored Spotify
    backend session

This means the browser session is only valid as long as the connected Spotify
session still belongs to the same user.

## Cron flow

Relevant file:

- [src/app/api/cron/daily/route.ts](/home/devops/projects/SpotifyCheck/src/app/api/cron/daily/route.ts)

Flow:

1. Vercel Cron calls `/api/cron/daily`
2. The route validates `Authorization: Bearer <CRON_SECRET>`
3. The route calls `requestCheckRun("cron")`
4. A `check_jobs` row is created
5. The route returns quickly with queue status
6. The in-process job runner starts the actual check work shortly after

This keeps scheduled and manual behavior aligned while still separating browser
auth from cron auth.

## Manual check request flow

Relevant files:

- [src/app/api/check/route.ts](/home/devops/projects/SpotifyCheck/src/app/api/check/route.ts)
- [src/lib/checker.ts](/home/devops/projects/SpotifyCheck/src/lib/checker.ts)

Flow:

1. The operator clicks `Start check`
2. `/api/check` validates the admin cookie
3. The route calls `requestCheckRun("manual")`
4. If no other run is active, a queued job is created
5. The route returns immediately with `202 Accepted`
6. The panel continues polling status until the queued job becomes running

## Check execution flow

Relevant file:

- [src/lib/checker.ts](/home/devops/projects/SpotifyCheck/src/lib/checker.ts)

The checker now has two layers:

- `requestCheckRun()` for fast request/queue behavior
- `runCheckJob()` for the actual check execution

`runDailyCheck()` still exists as a convenience wrapper, but the normal UI and
cron paths now go through the queue-oriented entry point.

Main steps:

1. Ensure the schema exists
2. Create a `check_jobs` record
3. Stop early if a persisted Spotify cooldown is still active
4. Acquire the global run lock
5. Load the current user's own public playlists from Spotify
6. Apply resume logic if the previous run stopped on a Spotify rate limit
7. Load playlist checkpoints in one batch
8. For each playlist:
   - prioritize changed or stale playlists first
   - skip unchanged playlists when their availability scan is still fresh
   - enforce a per-run budget for expensive item-level scans
   - otherwise scan playlist items for unavailable tracks
   - update live job progress as tracks are processed
   - buffer checkpoint updates and flush them in batches
9. Persist unavailable-track state through bulk reconciliation SQL
10. Send notification email for newly unavailable tracks only
11. Save a run summary and release the lock

The checker also supports:

- safe cancellation
- force-unlock for operator recovery
- low-cost Spotify smoke testing
- checkpoint reset for intentionally expensive rescans

## Background execution model

Relevant file:

- [src/lib/checker.ts](/home/devops/projects/SpotifyCheck/src/lib/checker.ts)

The app now separates "accepting a job request" from "doing the work", but it
does not yet have a dedicated external worker.

Current model:

- API route creates a queued job
- the same Node.js process starts the job via `setTimeout(..., 0)`
- status is then tracked through `check_jobs` and `check_run_lock`

Why this is better than before:

- HTTP requests no longer stay open for the full Spotify scan
- UI and cron get a fast acknowledgment path
- the code is structurally closer to a real job/worker architecture

Current limitation:

- this is still an in-process background runner
- if the process dies after queueing but before completing the work, there is no
  separate worker to recover that job automatically

That makes this a transition architecture, not the final production design for a
strictly serverless environment.

## Spotify API interaction model

Relevant file:

- [src/lib/spotify.ts](/home/devops/projects/SpotifyCheck/src/lib/spotify.ts)

The Spotify layer is intentionally narrow.

Endpoints currently used:

- `GET /me`
- `GET /me/playlists`
- `GET /playlists/{id}/items`
- `POST /api/token` for authorization-code and refresh-token exchange

### Playlist discovery

The app loads the connected user's playlists through `/me/playlists`, then
filters down to:

- playlists owned by the connected user
- playlists where `public === true`

This matches the product goal and Spotify's current development-mode direction.

### Track availability scan

For each playlist scan, the app requests only the fields needed to decide
availability and build a minimal notification payload:

- `track.id`
- `track.name`
- `track.duration_ms`
- `track.is_playable`
- `track.restrictions.reason`

### Retry and throttling behavior

Spotify requests are deliberately conservative:

- minimum delay between requests
- request timeout
- exponential backoff
- `Retry-After` support
- early abort when Spotify asks for a very long wait

Long `429` responses are treated as a reason to stop the job and persist a
cooldown instead of sitting in a long blocking sleep.

## Database model

Relevant file:

- [src/lib/db.ts](/home/devops/projects/SpotifyCheck/src/lib/db.ts)

The schema is created lazily at runtime by `ensureSchema()`, but the result is
memoized per process so hot paths do not repeatedly run DDL statements.

## `app_runtime_state`

General key-value table for operational state.

Currently used for:

- Spotify OAuth state during connect flow
- Spotify session state
- Spotify cooldown state

This table keeps the operational state small and flexible without introducing a
new table for every singleton concern.

## `monitored_playlists`

Catalog of playlists that should be considered by the checker.

In the current architecture this is refreshed from the connected user's own
public playlists and acts as an operational catalog, not a content cache.

## `playlist_checkpoints`

Per-playlist checkpoint information used to skip unnecessary rescans.

Stored fields include:

- playlist id
- playlist name
- last known `snapshot_id`
- last known track total
- last checked timestamp
- last job that touched the checkpoint

This table is the main rate-limit optimization layer.

## `unavailable_tracks`

Minimal durable record of unavailable findings.

Stored fields:

- `track_id`
- `playlist_id`
- `playlist_name`
- `track_name`
- `duration_ms`
- `first_seen_at`
- `last_seen_at`
- `currently_unavailable`

This table is used for:

- deduplicating notifications
- tracking whether an unavailable track is still currently unavailable
- generating minimal alert content

## `check_jobs`

Primary live job-tracking table for the UI and runtime control flow.

It stores:

- lifecycle status
- request/start/finish timestamps
- heartbeat
- cancellation flag
- checked track and playlist counters
- unavailable counters
- current payload state such as current playlist or resume point

The admin panel reads from this table to display live status.

The table now also acts as the handoff point between:

- fast request acceptance
- background execution in the current process

## `check_run_lock`

Singleton lock table that prevents concurrent full checks.

The lock stores:

- lock name
- owner id
- job id
- start time
- expiry time

The checker heartbeats the lock while running. If a run gets stuck, the
operator can force-release it from the control panel.

## `check_runs`

Historical summary table for completed runs.

This is lighter-weight than `check_jobs` and is used as an audit-style run log.
It stores the final summary payload only, not the full unavailable-track list
for each run.

## Rate-limit strategy

Spotify availability scanning is quota-sensitive, so the app uses several
layers of protection.

### Layer 1: request throttling

Every Spotify request goes through a small request window and a retry wrapper.

### Layer 2: snapshot skipping plus stale rechecks

If a playlist's `snapshot_id` is unchanged, the checker usually skips that
playlist instead of scanning all items again.

But snapshot skipping is no longer the only rule. The checker now also forces
periodic availability rescans for unchanged playlists:

- normal playlists: stale recheck after 7 days
- playlists that still had unavailable tracks in the last scan: recheck after 2 days

Checkpoint reads are now prefetched in one batch and writes are flushed in
batches instead of one DB round trip per playlist.

### Layer 3: per-run scan budget

Item-level track scans are the expensive part, so the checker uses a daily scan
budget for normal runs.

Current default:

- up to 25 playlists with full item scanning per run

The budget is spent in priority order:

- changed snapshots
- playlists that have never had an availability scan
- playlists that still show unavailable tracks from the previous scan
- playlists whose availability scan is stale

### Layer 4: persisted cooldown

If Spotify returns a strong `429` with a long `Retry-After`, the app stores a
cooldown in the database. New runs are skipped until that cooldown expires.

### Layer 5: resume after interruption

If a run stops on a rate limit while processing a playlist list, the job payload
stores the resume point. The next run slices the playlist list so already
completed playlists are not walked again first.

### Layer 6: bulk unavailable-track reconciliation

When a run completes its playlist scan, the app updates `unavailable_tracks`
through set-based SQL rather than per-track `SELECT` + `INSERT` loops.

This reduces DB round trips and makes the result persistence step scale much
better for large playlist catalogs.

## Important tradeoff: snapshot versus availability

A playlist snapshot changing is a strong signal that the playlist content
changed, but it is not a guarantee that availability changes will always be
reflected in the snapshot.

That means the current architecture optimizes heavily for quota safety, but it
can theoretically miss a case where:

- playlist content did not change
- track availability in the configured market changed anyway

This is still the main architectural tradeoff in the current version. The app
now reduces that risk with periodic stale rechecks, but it still does not
guarantee immediate detection of every market-only availability change.

## Notifications

Relevant file:

- [src/lib/mailer.ts](/home/devops/projects/SpotifyCheck/src/lib/mailer.ts)

An email is sent only for newly unavailable tracks.

The current email payload includes:

- playlist name
- track name
- track duration

No artist metadata, deep content cache, or unnecessary Spotify profile data is
used for notifications.

## Environment model

Relevant file:

- [src/lib/env.ts](/home/devops/projects/SpotifyCheck/src/lib/env.ts)

Required env vars:

- `DATABASE_URL`
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_MARKET`
- `RESEND_API_KEY`
- `ALERT_EMAIL_TO`
- `ALERT_EMAIL_FROM`
- `CRON_SECRET`

Optional locally:

- `SPOTIFY_REDIRECT_URI`

`CRON_SECRET` has two separate roles:

- bearer secret for `/api/cron/daily`
- HMAC signing key for the admin browser cookie

## UI architecture

Relevant file:

- [src/app/run-check-panel.tsx](/home/devops/projects/SpotifyCheck/src/app/run-check-panel.tsx)

The control panel is a thin operator UI over the backend state.

Main responsibilities:

- show Spotify connection state
- show cooldown state
- show live job progress
- trigger smoke test, full check, cancellation, unlock, and checkpoint reset

The panel does not own business logic. It mainly reflects server state from the
protected check endpoints.

## Operational guidance

### What to use for safe health checks

Use `Spotify smoke test` when you want to verify:

- Spotify auth still works
- playlist discovery still works
- metadata can be read

without forcing a full track scan.

### When to reset checkpoints

Only reset checkpoints when you intentionally want the next run to be expensive.
The normal steady state should preserve checkpoints to reduce Spotify load.

### When to use force unlock

Only use force unlock when a previous run is clearly stuck and its lock did not
expire or clear normally.

## Future improvement areas

Likely next technical improvements:

- periodic stale availability rechecks even when snapshots do not change
- more explicit reporting of resume-from-playlist state in the UI
- replace in-process background execution with a true worker/queue model
- dedicated developer troubleshooting notes for production and Vercel
- optional automated test coverage around checkpoint and resume logic
