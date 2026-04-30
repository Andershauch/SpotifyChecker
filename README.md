# SpotifyCheck

Simpel webapp der en gang i døgnet tjekker dine **offentlige** Spotify-playlister og sender e-mail, hvis et track ikke er tilgængeligt i din region.

## Stack

- Next.js (App Router) on Vercel
- Neon Postgres
- Spotify Web API
- Resend e-mail
- Vercel Cron

## 1) Opret integrationer

1. Spotify Developer App
   - Opret app på https://developer.spotify.com/dashboard
   - Kopier `SPOTIFY_CLIENT_ID` og `SPOTIFY_CLIENT_SECRET`
2. Neon database
   - Opret projekt og kopiér connection string til `DATABASE_URL`
3. Resend
   - Opret API key (`RESEND_API_KEY`)
   - Verificér dit afsenderdomæne og sæt `ALERT_EMAIL_FROM`

## 2) Miljøvariabler

Kopiér `.env.example` til `.env.local` og udfyld:

- `DATABASE_URL`
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_USER_ID` (dit Spotify user id)
- `SPOTIFY_MARKET` (ISO-landekode, fx `DK`)
- `RESEND_API_KEY`
- `ALERT_EMAIL_TO`
- `ALERT_EMAIL_FROM`
- `CRON_SECRET` (minimum 24 tegn)

## 3) Lokal kørsel

```bash
npm install
npm run dev
```

Åbn `http://localhost:3000`.

## 4) Manuelt check

```bash
curl -X POST http://localhost:3000/api/check \
  -H "Authorization: Bearer <CRON_SECRET>"
```

## 5) Daglig cron på Vercel

`vercel.json` er sat til at køre én gang dagligt kl. 07:00 UTC via `/api/cron/daily`.

På Vercel:

1. Sæt alle miljøvariabler
2. Deploy
3. Bekræft cron-kørsel i Vercel dashboard

## Sikkerhed

- Cron- og manuel check-endpoint er beskyttet af `Authorization: Bearer <CRON_SECRET>`.
- Ingen secrets returneres i UI.
- Database oprettes automatisk med minimale tabeller ved første kørsel.
