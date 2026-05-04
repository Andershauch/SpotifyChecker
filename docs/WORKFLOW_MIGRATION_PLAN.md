# SpotifyCheck Workflow Migration Plan

## Formål

Denne plan beskriver, hvordan SpotifyCheck flyttes fra den nuværende
in-process baggrundsmodel til en holdbar workflow-baseret eksekveringsmodel på
Vercel.

Målet er at løse det konkrete problem, vi nu har set i produktion:

- Vercel Cron kan godt ramme `/api/cron/daily`
- route'en kan godt oprette et `check_jobs`-job
- men det efterfølgende arbejde kan blive stående som `queued`, fordi den
  nuværende `setTimeout(..., 0)`-worker ikke er driftssikker i en serverless
  runtime

## Nuværende problem

Den nuværende model ser sådan ud:

1. `/api/check` eller `/api/cron/daily` kalder `requestCheckRun(...)`
2. appen opretter en række i `check_jobs`
3. samme proces forsøger bagefter at starte arbejdet via `setTimeout(..., 0)`

Det virker lokalt, men er ikke en stabil produktionsarkitektur på Vercel.

Konkret produktionssymptom:

- cron-jobbet bliver registreret som `queued`
- men får aldrig `started_at`
- og workflowet bliver derfor aldrig reelt kørt

## Målarkitektur

Den langsigtede model skal være:

1. manuelle og cron-baserede triggers starter en durable workflow-run
2. workflowen ejer hele check-kørslen fra start til slut
3. workflowen kan overleve:
   - deployment
   - processtop
   - transient fejl
   - rate-limits
4. UI'et bruger fortsat `check_jobs` som sit driftslag, men det er workflowen
   der opdaterer jobstatus

## Teknologiretning

Vi vil bygge dette på Vercel Workflow / Workflow DevKit.

Relevante officielle kilder:

- https://vercel.com/docs/workflow
- https://vercel.com/workflows

Den centrale idé er:

- `'use workflow'` til den durable orkestrering
- `'use step'` til små, retry-sikre arbejdsstykker

## Arkitekturprincipper

### 1. Behold database-modellen

Vi skal ikke starte med at opfinde en helt ny persistence-model.

Det vi allerede har, er værdifuldt og bør genbruges:

- `check_jobs`
- `check_runs`
- `playlist_checkpoints`
- `unavailable_tracks`
- `app_runtime_state`

Workflowen skal bruge disse tabeller, ikke erstatte dem i første omgang.

### 2. Skift eksekveringsmotor først

Første gevinst kommer ikke fra at redesigne hele scanlogikken.

Første gevinst kommer fra at flytte eksekveringen ud af den skrøbelige
serverless request-proces og over i en durable workflow-run.

### 3. Bevar operatør-UI'et

Kontrolpanelet skal fortsat være det samme fra brugerens perspektiv:

- `Start check`
- `Smoke test`
- `Testscan: 5 playlister`
- `Stop job`
- `Nulstil checkpoints`

Den store ændring er, hvad der sker bag kulissen.

### 4. Små steps frem for én stor kørsel

Workflowen må ikke blive én gigantisk step med hele Spotify-scannet indeni.

Vi vil hellere have:

- `prepare`
- `sync playlists`
- `scan playlist batch`
- `finalize`

Det giver bedre retry, bedre observability og mindre risiko ved fejl.

## Foreslået workflow-model

## Input til workflowen

Workflowen bør starte med et lille, eksplicit input:

```ts
type SpotifyCheckWorkflowInput = {
  jobId: string;
  triggerSource: "manual" | "cron";
  playlistLimit?: number;
  ignoreCheckpoints?: boolean;
  scanBudget?: number;
};
```

`jobId` forbliver den primære nøgle mellem workflow og UI.

## Workflow-faser

### Fase A: Prepare

Ansvar:

- verificer at schema findes
- check aktiv Spotify cooldown
- markér job som `running`
- load Spotify-session
- load checkpoints

Hvis aktiv cooldown findes:

- markér job som `skipped`
- afslut workflow tidligt

### Fase B: Sync playlist catalog

Ansvar:

- hent brugerens egne public playlister
- opdater `monitored_playlists`
- beregn prioriteret scanplan

Denne fase må gerne være en separat step, så fejl i playlist-sync ikke
forveksles med selve track-scannet.

### Fase C: Scan batches

Ansvar:

- vælg næste batch af playlister
- scan hver playlist
- opdater checkpoints
- opdater `check_jobs`

Anbefalet batch-størrelse i første version:

- 5 playlister pr. workflow-step

Hvorfor:

- matcher jeres eksisterende testscan-mentalitet
- gør rate-limit- og retry-adfærd nemmere at forstå
- reducerer risikoen ved step-fejl

### Fase D: Finalize

Ansvar:

- flush eventuelle checkpoint-opdateringer
- persist unavailable-track state
- send mail for nye unavailable tracks
- clear cooldown hvis relevant
- markér job som `ok`, `error`, `cancelled` eller `skipped`
- skriv `check_runs`

## Foreslåede nye metadata

For at binde workflow og app sammen anbefales det at udvide `check_jobs.payload`
med:

- `workflowRunId`
- `workflowStatus`
- `batchIndex`
- `batchCount`

Det gør det senere muligt at vise mere ærlig workflow-status i UI'et uden at
fjerne det eksisterende `check_jobs`-lag.

## Migrationsfaser

## Fase 1: Introducer Workflow uden stor forretningsændring

Mål:

- få cron og manuelle checks til at starte en workflow-run
- få workflowen til at kalde de eksisterende kernestykker
- fjern afhængigheden af `setTimeout(..., 0)` i produktion

Konkrete skridt:

1. installér workflow-pakken
2. opret workflow-fil, fx `src/lib/workflow/spotify-check-workflow.ts`
3. flyt kernekaldet fra in-process runner til workflow-kickoff
4. lad `/api/check` og `/api/cron/daily` starte workflowen
5. gem workflow-run-id i job-payload

Exit-kriterium:

- et cron-job på Vercel går ikke længere i stå som `queued`

## Fase 2: Split execution i durable steps

Mål:

- gøre selve scannet mere robust og observerbart

Konkrete skridt:

1. lav `prepare` step
2. lav `syncPlaylistCatalog` step
3. lav `scanPlaylistBatch` step
4. lav `finalize` step

Exit-kriterium:

- workflowen kan overleve deploys og mid-run fejl uden at miste sit sted

## Fase 3: UI-observability

Mål:

- gøre workflowstatus synlig i kontrolpanelet

Konkrete skridt:

1. vis `workflowRunId`
2. vis om jobbet er i:
   - queued
   - running
   - waiting
   - retrying
   - finished
3. skeln mellem app-status og workflow-status

Exit-kriterium:

- operatøren kan se forskellen på:
  - "job oprettet"
  - "workflow i gang"
  - "workflow venter"
  - "workflow fejlede"

## Fase 4: Oprydning

Når workflow-modellen er stabil, fjernes den gamle overgangsløsning:

- `activeJobProcessors`
- `setTimeout(..., 0)` worker
- gammel antagelse om langlivet proces

## Konkrete kodeændringer

## Nye filer

Forventede nye eller sandsynlige filer:

- `src/lib/workflow/spotify-check-workflow.ts`
- evt. `src/lib/workflow/steps/*.ts`
- evt. `src/lib/workflow/types.ts`

## Eksisterende filer der skal ændres

- `src/lib/checker.ts`
- `src/app/api/check/route.ts`
- `src/app/api/cron/daily/route.ts`
- `src/app/api/check/sample/route.ts`
- evt. `src/app/run-check-panel.tsx`
- `docs/ARCHITECTURE.md`

## Risici

### 1. For grov step-granularitet

Hvis vi lægger for meget arbejde i ét step, får vi stadig dårlig
genstartsevne.

### 2. For fin step-granularitet

Hvis vi laver ét workflow-step pr. track, bliver systemet unødigt komplekst og
dyrt.

### 3. Dobbeltkørsel

Vi skal bevare check-låsen og job-id-beskyttelsen, så en manuel kørsel og cron
ikke starter samme arbejde parallelt.

### 4. Statusdrift mellem workflow og app

Hvis workflow-run og `check_jobs` ikke opdateres konsistent, bliver UI'et
forvirrende.

## Anbefalet implementeringsrækkefølge

1. læg workflow-pakken ind
2. opret migrationsskelettet
3. få cron til at starte en workflow-run
4. få manuel `Start check` til at starte samme workflow-run
5. behold den eksisterende scanlogik mest muligt i første version
6. split derefter i mindre steps
7. opdater UI-observability
8. fjern gammel in-process worker

## Definition of done

Vi er først “færdige”, når alle disse punkter er opfyldt:

- Vercel cron skaber ikke længere jobs, der bliver stående som `queued`
- workflowen kan ses som aktiv execution bag et `check_job`
- manuelle og cron-baserede runs bruger samme durable motor
- rate-limit, cooldown og resume virker stadig
- kontrolpanelet viser driftstilstanden ærligt
- den gamle `setTimeout(..., 0)`-worker er fjernet
