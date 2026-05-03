# SpotifyCheck User Guide

## What The App Does

SpotifyCheck monitors one Spotify user's own public playlists and looks for tracks
 that are unavailable in the configured market. When it finds newly unavailable
 tracks, it sends an email notification.

The app is intentionally narrow:

- one Spotify account
- that user's own public playlists
- one configured market, for example `DK`
- email alerts only for newly unavailable tracks

## Daily Workflow

Most days the app should run without any manual work.

1. Vercel cron calls `/api/cron/daily`
2. The app queues a check job
3. SpotifyCheck loads the connected user's public playlists
4. Unchanged playlists are skipped by snapshot checkpoint
5. Changed playlists are scanned for unavailable tracks
6. New findings are written to the database
7. A notification email is sent if new unavailable tracks were found

## First-Time Setup

### 1. Configure Spotify

In Spotify Developer Dashboard:

- create or open the Spotify app
- set redirect URI to `http://127.0.0.1:3000/api/spotify/callback` for local development
- use an HTTPS redirect URI in production

### 2. Configure Environment Variables

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

### 3. Start The App

```bash
npm install
npm run dev -- --hostname 127.0.0.1
```

Then open `http://127.0.0.1:3000`.

### 4. Connect Spotify

Use the `Forbind Spotify` button in the control panel.

After login succeeds:

- the app stores Spotify access and refresh tokens server-side
- the browser receives an `httpOnly` admin session cookie
- the control panel can be used without manually entering a secret
- the app does not immediately sync playlists during login

## Control Panel

### Forbind Spotify

Starts the Spotify OAuth flow for the single supported user.

### Afbryd Spotify

Removes the stored Spotify session and clears the admin browser session.

### Spotify smoke test

Performs a low-risk metadata check. It confirms that:

- Spotify login still works
- the app can load the user's public playlists
- playlist metadata can be read

It does not scan tracks and does not send email.

### Start check

Queues the full monitor process and then lets the panel follow its progress.

Expected behavior:

- the request returns quickly
- the job soon changes from queued to running
- unchanged playlists are skipped
- changed playlists are scanned
- live progress updates appear in the panel

### Nulstil checkpoints

Deletes playlist snapshot checkpoints.

Use this when you want the next run to perform a full track scan even if playlists
have not changed.

### Stop job

Requests a safe stop. The current run stops at the next checkpoint.

### Nød-frigiv lås

Only use this if a run is stuck and the lock did not clear normally.

## Database Behavior

The database stores operational state, not a full Spotify mirror.

Main stored data:

- current Spotify OAuth session
- admin runtime state, such as cooldowns
- monitored playlist catalog
- playlist checkpoints
- unavailable-track records
- job and run history

For unavailable tracks the app stores only the minimal data needed for alerts and
deduplication:

- playlist id
- playlist name
- track id
- track name
- track duration
- availability state and timestamps

## Rate Limit Behavior

SpotifyCheck is designed to be defensive with rate limits.

It does all of the following:

- throttles outgoing Spotify requests
- retries with exponential backoff
- respects the `Retry-After` header
- stops early on very long rate limits
- stores a cooldown in the database
- resumes from the interrupted playlist on the next run
- uses a daily scan budget for expensive item-level scans
- rechecks unchanged playlists only when their availability data has gone stale

This means a large first scan may stop, but the next run should continue from where
it left off instead of starting over.

The app now also tries to avoid long open HTTP requests by queueing the job
first and then running it in the background in the current process.

## Notifications

An email is only sent when a track becomes newly unavailable in a playlist.

The email currently contains:

- playlist name
- track name
- track duration

If a track remains unavailable across multiple runs, it should not generate a new
email every time.

## Troubleshooting

### Spotify is connected but checks do nothing

This often means all playlists were unchanged and their availability scans were
still considered fresh, so they were skipped safely.

Use `Nulstil checkpoints` and then run `Start check` again if you want a full scan.

### The panel says Spotify cooldown is active

Spotify returned a strong rate-limit response. Wait until the cooldown expires
before running another scan.

### I do not receive email

Check:

- `RESEND_API_KEY`
- `ALERT_EMAIL_TO`
- `ALERT_EMAIL_FROM`
- whether the run actually found newly unavailable tracks

### The app asks to reconnect Spotify

This usually means:

- the Spotify server-side session was cleared
- the admin browser cookie expired
- or the connected Spotify user changed

Reconnect with `Forbind Spotify`.

## Suggested Operator Routine

For normal use:

1. Keep cron enabled
2. Use smoke test only when you need a safe health check
3. Use full scans when needed
4. Avoid resetting checkpoints unless you intentionally want a more expensive run
5. Expect normal runs to spread expensive scans over multiple days instead of trying
   to scan every playlist every time
