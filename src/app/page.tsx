import { getLatestRun } from "@/lib/checker";
import { RunCheckPanel } from "@/app/run-check-panel";

function formatDate(dateString: string) {
  return new Intl.DateTimeFormat("da-DK", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(dateString));
}

export default async function Home() {
  const latestRun = await getLatestRun();
  const latestStatusLabel = latestRun
    ? latestRun.status === "ok"
      ? "OK"
      : latestRun.status === "cancelled"
        ? "Stoppet"
        : latestRun.status === "skipped"
          ? "Sprunget over"
          : "Fejl"
    : null;

  return (
    <main className="container">
      <section className="card hero-card">
        <div className="hero-copy">
          <p className="eyebrow">Operationspanel</p>
          <h1>SpotifyCheck</h1>
          <p>
            Daglig overvågning af dine offentlige Spotify-playlister for tracks,
            der ikke er tilgængelige i din region.
          </p>
        </div>

        <div className="hero-badges">
          <span className="hero-badge">Single-user Spotify OAuth</span>
          <span className="hero-badge">Quota-aware checks</span>
          <span className="hero-badge">Track availability alerts</span>
        </div>
      </section>

      <section className="card run-overview">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Seneste afsluttede kørsel</p>
            <h2>Sidste kendte resultat</h2>
          </div>
          {latestStatusLabel ? (
            <span
              className={`pill ${
                latestRun?.status === "ok"
                  ? "pill-ready"
                  : latestRun?.status === "error"
                    ? "pill-danger"
                    : "pill-idle"
              }`}
            >
              {latestStatusLabel}
            </span>
          ) : null}
        </div>

        {latestRun ? (
          <dl className="stats stats-compact">
            <div>
              <dt>Tidspunkt</dt>
              <dd>{formatDate(latestRun.run_at)}</dd>
            </div>
            <div>
              <dt>Playlister tjekket</dt>
              <dd>{latestRun.payload?.checkedPlaylists ?? 0}</dd>
            </div>
            <div>
              <dt>Playlister sprunget over</dt>
              <dd>{latestRun.payload?.skippedPlaylists ?? 0}</dd>
            </div>
            <div>
              <dt>Tracks tjekket</dt>
              <dd>{latestRun.checked_tracks}</dd>
            </div>
            <div>
              <dt>Utilgængelige tracks</dt>
              <dd>{latestRun.unavailable_count}</dd>
            </div>
            {latestRun.error_message ? (
              <div>
                <dt>Fejl</dt>
                <dd>{latestRun.error_message}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p>Ingen kørsel endnu. Trigger cron eller kald `/api/check` manuelt.</p>
        )}
      </section>

      <RunCheckPanel />
    </main>
  );
}
