# SpotifyCheck

Simpel webapp der en gang i døgnet tjekker dine egne **offentlige** Spotify-playlister og sender e-mail, hvis et track ikke er tilgængeligt i din region.

Se også:

- den praktiske brugermanual i [docs/USER_GUIDE.md](/home/devops/projects/SpotifyCheck/docs/USER_GUIDE.md)
- den udviklerrettede arkitekturdoc i [docs/ARCHITECTURE.md](/home/devops/projects/SpotifyCheck/docs/ARCHITECTURE.md)
- workflow-migrationsplanen i [docs/WORKFLOW_MIGRATION_PLAN.md](/home/devops/projects/SpotifyCheck/docs/WORKFLOW_MIGRATION_PLAN.md)

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
   - Tilføj redirect URI: `http://127.0.0.1:3000/api/spotify/callback`
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
- `SPOTIFY_REDIRECT_URI` (valgfri lokalt, default er `http://127.0.0.1:3000/api/spotify/callback`)
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

Åbn `http://127.0.0.1:3000`.

Forbind derefter Spotify-kontoen fra kontrolpanelet. Appen bruger Spotify OAuth til én bruger, gemmer tokens server-side og læser kun brugerens egne public playlister via `GET /me/playlists`.

For utilgængelige tracks gemmer appen kun den minimale driftsdata, der er nødvendig for notifikationer og deduplikering:

- playlist-id og playlist-navn
- track-id
- track-navn
- track-længde
- utilgængelig-status og timestamps

## 4) Manuelt check

Brug kontrolpanelet i UI’et efter Spotify-login:

- `Spotify smoke test` for et billigt metadata-check
- `Start check` for at sætte det rigtige scan i kø
- `Nulstil checkpoints` hvis næste check skal tvinges til et fuldt track-scan

## 5) Daglig cron på Vercel

`vercel.json` er sat til at køre én gang dagligt kl. 07:00 UTC via `/api/cron/daily`.

På Vercel:

1. Sæt alle miljøvariabler
2. Deploy
3. Bekræft cron-kørsel i Vercel dashboard

## Sikkerhed

- `/api/cron/daily` er beskyttet af `Authorization: Bearer <CRON_SECRET>`.
- Kontrolpanelets API-kald bruger en server-sat `httpOnly` admin-cookie efter Spotify-login.
- Ingen secrets returneres i UI.
- Database oprettes automatisk med minimale tabeller ved første kørsel.
- Spotify access token og refresh token gemmes server-side i databasen for den ene tilsluttede bruger.
- Trackdata minimeres til navn, længde, playlist-tilknytning og utilgængelighedsstatus.
