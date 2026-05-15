import type { PanelState, RunStatusResponse } from "./types";
import { formatTime, getRunPillClass, getRunPillText } from "./utils";

type ActionsTabProps = {
  panelState: PanelState;
  activeCooldown: RunStatusResponse["cooldown"] | null;
  canStartScan: boolean;
  spotifyConnection: RunStatusResponse["spotifyConnection"] | null;
  isRunning: boolean;
  isSmoking: boolean;
  isStartingSample: boolean;
  isRefreshingStatus: boolean;
  onStartScan: () => void;
  onSmokeTest: () => void;
  onSampleStart: () => void;
  onRefreshStatus: () => void;
};

export function ActionsTab({
  panelState,
  activeCooldown,
  canStartScan,
  spotifyConnection,
  isRunning,
  isSmoking,
  isStartingSample,
  isRefreshingStatus,
  onStartScan,
  onSmokeTest,
  onSampleStart,
  onRefreshStatus,
}: ActionsTabProps) {
  return (
    <section className="status-box operations-card">
      <div className="section-heading section-heading-compact">
        <div>
          <p className="eyebrow">Handlinger</p>
          <h3>Scan og helbredstjek</h3>
        </div>
        {activeCooldown ? (
          <span className="pill pill-warning">
            Cooldown til {formatTime(activeCooldown.until)}
          </span>
        ) : (
          <span className={getRunPillClass(panelState)}>{getRunPillText(panelState)}</span>
        )}
      </div>

      <p className="helper-text">
        Brug fuldt scan til daglig drift, health check som billig statuskontrol og kort testscan til
        at validere parsing på få playlister.
      </p>

      <div className="action-grid">
        <button
          type="button"
          className="toolbar-primary action-card-button action-card-primary"
          disabled={!canStartScan}
          onClick={onStartScan}
        >
          <span>Start scan</span>
          <small>Scanner næste batch efter checkpoint-strategien.</small>
        </button>

        <button
          type="button"
          className="secondary-button action-card-button"
          onClick={onSmokeTest}
          disabled={
            !spotifyConnection?.connected || isRunning || isSmoking || isStartingSample || Boolean(activeCooldown)
          }
        >
          <span>{isSmoking ? "Tester..." : "Health check"}</span>
          <small>Bekræfter Spotify-forbindelsen uden tung scanning.</small>
        </button>

        <button
          type="button"
          className="secondary-button action-card-button"
          onClick={onSampleStart}
          disabled={
            !spotifyConnection?.connected || isRunning || isStartingSample || Boolean(activeCooldown)
          }
        >
          <span>{isStartingSample ? "Starter testscan..." : "Kort testscan"}</span>
          <small>Scanner kun de første 5 playlister.</small>
        </button>

        <button
          type="button"
          className="secondary-button action-card-button"
          onClick={onRefreshStatus}
          disabled={isRefreshingStatus}
        >
          <span>{isRefreshingStatus ? "Opdaterer..." : "Opdater status"}</span>
          <small>Henter frisk jobstatus og fund fra databasen.</small>
        </button>
      </div>
    </section>
  );
}
