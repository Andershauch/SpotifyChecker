# SpotifyCheck User Guide

## What the app does

SpotifyCheck monitors one Spotify user's own public playlists and looks for
tracks that are unavailable in the configured market. When it finds newly
unavailable tracks, it sends an email notification.

The app is intentionally narrow:

- one Spotify account
- that user's own public playlists only
- one configured market, for example `DK`
- email alerts only for newly unavailable tracks (not repeated on every run)

---

## Daily workflow

Most days the app runs without any manual work.

1. Vercel Cron triggers a daily check at 07:00 UTC
2. The app loads the connected user's public playlists from Spotify
3. Playlists whose content has not changed are skipped
4. Changed or stale playlists are scanned for unavailable tracks
5. New findings are written to the database
6. A notification email is sent if new unavailable tracks were found

---

## Control panel overview

The control panel has four tabs.

### Overview tab

Shows the current run status and key counters: how many playlists were checked,
how many tracks were found unavailable, and when the last successful run
completed.

### Findings tab

Lists all playlists that currently have unavailable tracks. Each playlist is
expandable and shows:

- the track name and duration, as a link that opens the track directly in the
  Spotify app
- when the track was last seen as unavailable
- the primary artist name
- any AI-generated replacement suggestions

Only tracks that are currently unavailable are shown. Once a track has been
fixed in Spotify and a new scan has run, it disappears from this list.

### Actions tab

Contains the manual controls described below.

### Settings tab

Shows the connected Spotify account and provides advanced recovery actions.

---

## Actions

### Spotify smoke test

Performs a low-cost metadata check. It confirms that:

- the Spotify login still works
- the app can load the user's public playlists
- playlist metadata can be read

It does not scan individual tracks and does not send email. Use this when you
want a quick sanity check without triggering a full scan.

### Start scan

Queues the full monitor process and shows live progress in the panel.

Expected behavior:

- the request returns immediately
- the job moves from queued to running within a few seconds
- unchanged playlists are skipped automatically
- changed or stale playlists are scanned track by track
- live progress updates appear while the scan runs

### Test scan (5 playlists)

Runs a limited scan on the next 5 playlists in the queue. Useful for verifying
behavior after a configuration change without running the full catalog.

### Stop job

Requests a safe cancellation. The current run stops at its next internal
checkpoint and writes a partial result.

### Reset checkpoints

Deletes the saved per-playlist scan state.

Use this only when you want the next run to perform a full re-scan of every
playlist even if nothing has changed. This is more expensive and will take
longer. Under normal operation, checkpoints should be left alone.

### Force-release lock (advanced)

Only use this if a run is stuck and its lock has not cleared on its own. Under
normal operation this should never be needed.

---

## Finding and fixing unavailable tracks

### How to respond to an alert email

1. Open the **Findings** tab in the control panel
2. Each unavailable track shows as a link — click it to open the track in the
   Spotify app
3. Find a replacement track and update the playlist in Spotify

### Generating AI replacement suggestions

For each unavailable track, click **Find 2 alternatives**. The app queries
OpenAI and searches Spotify to find two tracks that are:

- similar in title or artist
- close in duration
- available in the configured market

Results appear directly below the track. Click a suggestion to open it in
Spotify. You can re-run suggestions with **Update alternatives** to get a fresh
set.

This feature requires `OPENAI_API_KEY` to be configured.

### After fixing a track in Spotify

When you replace an unavailable track with an available one in Spotify, the
playlist's version identifier changes automatically. The next scan detects this
change, gives that playlist highest priority, and removes the finding from the
app once the scan completes.

You do not need to do anything else in the app — just start a scan after making
the change in Spotify.

---

## Rate limit behavior

SpotifyCheck is designed to be defensive with Spotify's API rate limits.

It does all of the following:

- throttles outgoing Spotify requests to a safe interval
- retries with exponential backoff on temporary failures
- respects the `Retry-After` header from Spotify
- stops early when Spotify requests a very long wait
- stores a cooldown in the database so later runs know to wait
- resumes from the interrupted playlist on the next run rather than starting over
- uses a daily budget cap for expensive track-level scans (100 playlists per run)

A large first scan may stop partway through, but the next run continues from
where the previous one left off.

---

## Notifications

An email is sent only when a track becomes **newly** unavailable.

- if a track was already flagged in a previous run, no new email is sent
- if a track is fixed and later becomes unavailable again, a new email is sent
  at that point

The email contains the playlist name, track name, and duration.

---

## Troubleshooting

### Scan runs but finds nothing

This usually means all playlists were unchanged and their availability scans
were still considered fresh, so they were skipped. This is expected behavior.

Use **Reset checkpoints** and then **Start scan** if you want to force a full
re-scan.

### The panel shows a Spotify cooldown

Spotify returned a strong rate-limit response. Wait until the cooldown expires
before starting another scan — the panel shows when it clears.

### No alert emails are arriving

Check:

- `RESEND_API_KEY` is valid and the domain is verified in Resend
- `ALERT_EMAIL_TO` and `ALERT_EMAIL_FROM` are correct
- check whether the run log shows that new unavailable tracks were actually found

### The panel asks to reconnect Spotify

This usually means:

- the Spotify server-side session was cleared manually
- the admin browser cookie has expired (it lasts 7 days)
- the connected Spotify user changed

Reconnect using **Forbind Spotify** in the Settings tab.

### A job is stuck in "running" state

Use **Force-release lock** in the Settings tab to clear the stale lock and
allow a new scan to start.

---

## Suggested operator routine

For normal steady-state operation:

1. Leave the daily cron enabled and let it run automatically
2. Check the Findings tab when you receive an alert email
3. Fix unavailable tracks in Spotify, then start a manual scan to confirm
4. Use **Spotify smoke test** when you want a cheap health check after a
   configuration change
5. Avoid resetting checkpoints unless you specifically want a full re-scan —
   checkpoints are what keep the app efficient
