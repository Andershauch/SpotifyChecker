import { getLatestRun } from "@/lib/checker";

function formatDate(dateString: string) {
  return new Intl.DateTimeFormat("da-DK", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(dateString));
}

export default async function Home() {
  const latestRun = await getLatestRun();

  return (
    <main className="container">
      <section className="card">
        <h1>SpotifyCheck</h1>
        <p>
          Daglig overvågning af dine offentlige Spotify-playlister for tracks,
          der ikke er tilgængelige i din region.
        </p>
      </section>

      <section className="card">
        <h2>Seneste kørsel</h2>
        {latestRun ? (
          <dl className="stats">
            <div>
              <dt>Tidspunkt</dt>
              <dd>{formatDate(latestRun.run_at)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{latestRun.status === "ok" ? "OK" : "Fejl"}</dd>
            </div>
            <div>
              <dt>Playlister tjekket</dt>
              <dd>{latestRun.payload?.checkedPlaylists ?? 0}</dd>
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
    </main>
  );
}
