import type { JobSnapshot, PanelState, PrimaryStat, RunStatusResponse, TimingStat } from "./types";
import { formatDateTime, formatSeconds, getPanelSummary } from "./utils";

type OverviewTabProps = {
  panelState: PanelState;
  activeCooldown: RunStatusResponse["cooldown"] | null;
  primaryStats: PrimaryStat[];
  timingStats: TimingStat[];
  spotifyConnection: RunStatusResponse["spotifyConnection"] | null;
  activeJob: JobSnapshot | null;
  runStatus: RunStatusResponse | null;
  latestRateLimitEvent: { message: string | null; at: string | null } | null;
  queuedJobMatchesCurrent: boolean;
  queuedJobNotice: { jobId: string; label: string } | null;
  statusMessage: string | null;
};

export function OverviewTab({
  panelState,
  activeCooldown,
  primaryStats,
  timingStats,
  spotifyConnection,
  activeJob,
  runStatus,
  latestRateLimitEvent,
  queuedJobMatchesCurrent,
  queuedJobNotice,
  statusMessage,
}: OverviewTabProps) {
  return (
    <div className="control-grid">
      <div className="operations-main">
        <section className="status-box operations-card">
          <div className="operations-header">
            <div>
              <p className="eyebrow">Aktuel drift</p>
              <h3>Live-overblik</h3>
            </div>
            <p className="panel-summary">{getPanelSummary(panelState, activeCooldown)}</p>
          </div>

          {activeCooldown ? (
            <div className="run-message run-message-muted">
              <strong>Næste sikre forsøg</strong>
              <p>
                Vent til {formatDateTime(activeCooldown.until)} før du prøver igen. Panelet blokerer
                nu også health check under aktiv cooldown.
              </p>
            </div>
          ) : null}

          {!activeCooldown ? (
            <div className="run-message run-message-muted">
              <strong>Cron-status</strong>
              <p>
                Vercel Cron er sat til dagligt 07:00 UTC. I dansk sommertid svarer det til 09:00, og
                i vintertid til 08:00.
              </p>
            </div>
          ) : null}

          <div className="metrics-board">
            {primaryStats.length > 0 ? (
              primaryStats.map((stat) => (
                <article
                  key={stat.label}
                  className={`metric-tile ${
                    stat.tone === "hero"
                      ? "metric-tile-hero"
                      : stat.tone === "danger"
                        ? "metric-tile-danger"
                        : ""
                  }`}
                >
                  <span>{stat.label}</span>
                  <strong>{stat.value}</strong>
                </article>
              ))
            ) : (
              <>
                <article className="metric-tile metric-tile-wide">
                  <span>Status</span>
                  <strong>Ingen kørsel endnu</strong>
                </article>
                <article className="metric-tile metric-tile-wide">
                  <span>Næste skridt</span>
                  <strong>
                    {spotifyConnection?.connected
                      ? "Kør smoke test eller start check"
                      : "Forbind Spotify"}
                  </strong>
                </article>
              </>
            )}
          </div>

          <div className="spotlight-grid">
            <article className="spotlight-card">
              <span className="spotlight-label">Aktuel playlist</span>
              <strong className="spotlight-title">
                {activeJob?.currentPlaylistName ?? "Ingen aktiv playlist"}
              </strong>
              <p className="spotlight-meta">
                {activeJob?.currentStage
                  ? `Fase: ${activeJob.currentStage}`
                  : "Panelet følger automatisk med, når et job er i gang."}
              </p>
            </article>

            <article className="spotlight-card">
              <span className="spotlight-label">Tid og lås</span>
              {timingStats.length > 0 ? (
                <dl className="spotlight-list">
                  {timingStats.map((stat) => (
                    <div key={stat.label}>
                      <dt>{stat.label}</dt>
                      <dd>{stat.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>Ingen aktiv joblås. Næste check kan sættes i kø fra toolbaren.</p>
              )}

              {runStatus?.lock ? (
                <p className="helper-text">
                  Låsen udløber om {formatSeconds(runStatus.lock.expiresInSeconds)}.
                </p>
              ) : null}
            </article>
          </div>

          {queuedJobMatchesCurrent && activeJob?.status === "queued" ? (
            <p className="helper-text">
              Seneste handling: {queuedJobNotice?.label} er sendt til kø og afventer næste
              statusopdatering.
            </p>
          ) : null}

          {latestRateLimitEvent ? (
            <div className="run-message run-message-muted">
              <strong>Seneste rate-limit-hændelse</strong>
              <p>
                {latestRateLimitEvent.message}
                {latestRateLimitEvent.at
                  ? ` Jobbet sluttede ${formatDateTime(latestRateLimitEvent.at)}.`
                  : ""}
              </p>
              <p>
                Der er ikke registreret en aktiv cooldown lige nu, så dette er historik og ikke en
                nuværende blokering.
              </p>
            </div>
          ) : null}

          {statusMessage ? <p className="run-message">{statusMessage}</p> : null}
          {activeJob?.errorMessage && !latestRateLimitEvent ? (
            <p className="run-message">{activeJob.errorMessage}</p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
