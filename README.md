# SpotifyCheck

A focused web app that monitors one Spotify user's own public playlists and sends an email when a track becomes unavailable in the configured market.

See also:

- Practical usage guide: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- Technical architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Stack

- Next.js (App Router) on Vercel
- Neon Postgres
- Spotify Web API
- OpenAI API (optional — for AI-powered replacement suggestions)
- Resend for email alerts
- Vercel Cron + Vercel Workflow for scheduled and durable execution

## Setup

### 1. Create integrations

#### Spotify Developer App

1. Create or open an app at <https://developer.spotify.com/dashboard>
2. Copy `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`
3. Add redirect URI: `http://127.0.0.1:3000/api/spotify/callback` for local development
4. Use an HTTPS redirect URI in production

#### Neon database

1. Create a project and copy the connection string to `DATABASE_URL`

#### Resend

1. Create an API key (`RESEND_API_KEY`)
2. Verify your sender domain and set `ALERT_EMAIL_FROM`

### 2. Configure environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Neon Postgres connection string |
| `SPOTIFY_CLIENT_ID` | Yes | From Spotify Developer Dashboard |
| `SPOTIFY_CLIENT_SECRET` | Yes | From Spotify Developer Dashboard |
| `SPOTIFY_MARKET` | Yes | ISO country code, e.g. `DK` |
| `RESEND_API_KEY` | Yes | Resend API key |
| `ALERT_EMAIL_TO` | Yes | Email address to receive alerts |
| `ALERT_EMAIL_FROM` | Yes | Verified sender address |
| `CRON_SECRET` | Yes | Random secret, minimum 24 characters |
| `SPOTIFY_REDIRECT_URI` | No | Defaults to `http://127.0.0.1:3000/api/spotify/callback` |
| `OPENAI_API_KEY` | No | Enables AI-powered replacement suggestions |
| `OPENAI_SUGGESTION_MODEL` | No | Defaults to `gpt-4o-mini` |

### 3. Run locally

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:3000`.

### 4. Connect Spotify

Click **Forbind Spotify** in the control panel. The app stores Spotify tokens server-side and sets a signed admin session cookie in the browser. No Spotify secrets are exposed to the browser.

### 5. Deploy to Vercel

1. Set all environment variables in the Vercel project settings
2. Deploy
3. Confirm cron execution in the Vercel dashboard (`vercel.json` runs daily at 07:00 UTC)

## Running tests

```bash
npm test
```

## Security model

- `/api/cron/daily` is protected by `Authorization: Bearer <CRON_SECRET>`
- The control panel API uses a signed `httpOnly` admin cookie set at Spotify login
- Spotify access and refresh tokens are stored server-side only
- The database is created automatically with the required tables on first run
