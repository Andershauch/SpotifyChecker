import type { JobSnapshot, PrimaryStat, RunStatusResponse } from "./types";
import { formatDateTime, formatSeconds } from "./utils";

type SettingsTabProps = {
  spotifyConnection: RunStatusResponse["spotifyConnection"] | null;
  primaryStats: PrimaryStat[];
  activeJob: JobSnapshot | null;
  runStatus: RunStatusResponse | null;
  isConnectingSpotify: boolean;
  isDisconnectingSpotify: boolean;
  isRunning: boolean;
  isBackfillingArtists: boolean;
  isResettingCheckpoints: boolean;
  isCancelling: boolean;
  isUnlocking: boolean;
  onConnectSpotify: () => void;
  onDisconnectSpotify: () => void;
  onBackfillArtists: () => void;
  onResetCheckpoints: () => void;
  onCancel: () => void;
  onUnlock: () => void;
};

export function SettingsTab({
  spotifyConnection,
  primaryStats,
  activeJob,
  runStatus,
  isConnectingSpotify,
  isDisconnectingSpotify,
  isRunning,
  isBackfillingArtists,
  isResettingCheckpoints,
  isCancelling,
  isUnlocking,
  onConnectSpotify,
  onDisconnectSpotify,
  onBackfillArtists,
  onResetCheckpoints,
  onCancel,
  onUnlock,
}: SettingsTabProps) {
  return (
    <section className="settings-view">
      <div className="status-box connection-card">
        <div className="section-heading section-heading-compact">
          <div>
            <p className="eyebrow">Nuværende Spotify-session</p>
            <h3>Forbindelse</h3>
          </div>
        </div>

        <p className="helper-text">
          OAuth-sessionen ligger server-side. Appen kan derfor køre cron uden at browseren står åben,
          så længe token kan refreshes.
        </p>

        <dl className="session-stats">
          <div>
            <dt>Bruger</dt>
            <dd>
              {spotifyConnection?.displayName ?? spotifyConnection?.spotifyUserId ?? "-"}
            </dd>
          </div>
          <div>
            <dt>Forbundet</dt>
            <dd>
              {spotifyConnection?.connectedAt
                ? formatDateTime(spotifyConnection.connectedAt)
                : "-"}
            </dd>
          </div>
          <div>
            <dt>Token udløber</dt>
            <dd>
              {spotifyConnection?.expiresAt ? formatDateTime(spotifyConnection.expiresAt) : "-"}
            </dd>
          </div>
        </dl>

        <div className="toolbar-actions toolbar-actions-stacked">
          <button
            type="button"
            className="secondary-button"
            onClick={onConnectSpotify}
            disabled={isConnectingSpotify || Boolean(spotifyConnection?.connected)}
          >
            {isConnectingSpotify
              ? "Sender videre..."
              : spotifyConnection?.connected
                ? "Spotify er forbundet"
                : "Forbind Spotify"}
          </button>

          <button
            type="button"
            className="secondary-button"
            onClick={onDisconnectSpotify}
            disabled={!spotifyConnection?.connected || isDisconnectingSpotify}
          >
            {isDisconnectingSpotify ? "Afbryder..." : "Afbryd Spotify"}
          </button>
        </div>
      </div>

      <div className="status-box operations-card">
        <div className="section-heading section-heading-compact">
          <div>
            <p className="eyebrow">Historik og drift</p>
            <h3>Seneste kørsel</h3>
          </div>
        </div>

        <div className="metrics-board">
          {primaryStats.length > 0 ? (
            primaryStats.map((stat) => (
              <article key={stat.label} className="metric-tile">
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
              </article>
            ))
          ) : (
            <article className="metric-tile metric-tile-wide">
              <span>Status</span>
              <strong>Ingen kørsel endnu</strong>
            </article>
          )}
        </div>

        {activeJob?.errorMessage ? (
          <p className="run-message">{activeJob.errorMessage}</p>
        ) : null}
      </div>

      <details className="status-box recovery-drawer" open>
        <summary>
          <span>
            <span className="eyebrow">Recovery og checkpoints</span>
            <strong>Avancerede handlinger</strong>
          </span>
        </summary>

        <div className="actions settings-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onBackfillArtists}
            disabled={isRunning || isBackfillingArtists || !spotifyConnection?.connected}
          >
            {isBackfillingArtists ? "Backfiller..." : "Backfill kunstnere"}
          </button>

          <button
            type="button"
            className="secondary-button"
            onClick={onResetCheckpoints}
            disabled={isRunning || isResettingCheckpoints}
          >
            {isResettingCheckpoints ? "Nulstiller..." : "Nulstil checkpoints"}
          </button>

          <button
            type="button"
            className="danger-button"
            onClick={onCancel}
            disabled={!isRunning || isCancelling}
          >
            {isCancelling ? "Stopper..." : "Stop job"}
          </button>

          <button
            type="button"
            className="secondary-button"
            onClick={onUnlock}
            disabled={!isRunning || isUnlocking}
          >
            {isUnlocking ? "Frigiver..." : "Nød-frigiv lås"}
          </button>
        </div>

        <div className="recovery-copy">
          <p className="helper-text">
            Nulstil checkpoints bør kun bruges, når vi aktivt vil gennemtvinge en tungere
            genopbygning. Normal drift bør lade checkpoint-modellen fordele Spotify-kald over flere
            små kørsler.
          </p>
          <p className="helper-text">
            Kunstner-backfill bruger først eksisterende data og derefter højst en lille Spotify-batch
            for fund, der stadig mangler kunstnernavn.
          </p>
          {runStatus?.lock ? (
            <p className="helper-text">
              Aktuel lås udløber om {formatSeconds(runStatus.lock.expiresInSeconds)}.
            </p>
          ) : null}
        </div>
      </details>
    </section>
  );
}
