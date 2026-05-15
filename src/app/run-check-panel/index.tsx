"use client";

import { useDashboard } from "./use-dashboard";
import { getRunPillClass, getRunPillText, getTabLabel } from "./utils";
import type { DashboardTab } from "./types";
import { OverviewTab } from "./overview-tab";
import { FindingsTab } from "./findings-tab";
import { ActionsTab } from "./actions-tab";
import { SettingsTab } from "./settings-tab";

export function RunCheckPanel() {
  const dashboard = useDashboard();

  const {
    activeTab,
    setActiveTab,
    message,
    statusMessage,
    queuedJobStatusMessage,
    runStatus,
    unavailableData,
    isRefreshingStatus,
    isConnectingSpotify,
    isDisconnectingSpotify,
    isStartingSample,
    isSmoking,
    isResettingCheckpoints,
    isBackfillingArtists,
    isCancelling,
    isUnlocking,
    generatingSuggestionsFor,
    activeJob,
    isRunning,
    activeCooldown,
    spotifyConnection,
    panelState,
    queuedJobMatchesCurrent,
    queuedJobNotice,
    primaryStats,
    timingStats,
    latestRateLimitEvent,
    unavailablePlaylists,
    unavailableTrackRows,
    unavailableMessage,
    tracksWithSuggestions,
    currentUnavailableTracks,
    canStartScan,
    startCheck,
    refreshStatusNow,
    handleConnectSpotify,
    handleDisconnectSpotify,
    handleResetCheckpoints,
    handleBackfillArtists,
    handleCancel,
    handleSmokeTest,
    handleUnlock,
    handleSampleStart,
    handleGenerateSuggestions,
  } = dashboard;

  return (
    <section className="card control-shell app-shell">
      <header className="app-header">
        <div className="app-title-block">
          <p className="eyebrow">Operationspanel</p>
          <h1>SpotifyCheck</h1>
          <p>
            Daglig overvågning af dine offentlige Spotify-playlister for tracks, der ikke er
            tilgængelige i din region.
          </p>
        </div>
      </header>

      <details className="app-menu" open>
        <summary>
          <span>Menu</span>
          <strong>{getTabLabel(activeTab)}</strong>
        </summary>

        <div className="app-menu-bar">
          <nav className="app-tabs" aria-label="Hovedmenu">
            {(
              [
                { id: "overview", label: "Overblik" },
                { id: "findings", label: "Fund" },
                { id: "actions", label: "Handlinger" },
                { id: "settings", label: "Indstillinger" },
              ] satisfies Array<{ id: DashboardTab; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`app-tab ${activeTab === tab.id ? "app-tab-active" : ""}`}
                onClick={() => {
                  setActiveTab(tab.id);
                }}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="app-status-board" aria-label="Aktuel status">
            <article className="app-status-card">
              <span>Spotify</span>
              <strong>{spotifyConnection?.connected ? "Forbundet" : "Ikke forbundet"}</strong>
            </article>
            {canStartScan ? (
              <button
                type="button"
                className="app-status-card app-status-action"
                onClick={() => {
                  void startCheck();
                }}
              >
                <span>Drift</span>
                <strong>Start scan</strong>
              </button>
            ) : (
              <article className="app-status-card">
                <span>Drift</span>
                <strong>{getRunPillText(panelState)}</strong>
              </article>
            )}
            <article
              className={
                currentUnavailableTracks > 0
                  ? "app-status-card app-status-alert"
                  : "app-status-card"
              }
            >
              <span>Aktuelle fund</span>
              <strong>{currentUnavailableTracks}</strong>
            </article>
          </div>
        </div>
      </details>

      {activeTab === "overview" ? (
        <OverviewTab
          panelState={panelState}
          activeCooldown={activeCooldown}
          primaryStats={primaryStats}
          timingStats={timingStats}
          spotifyConnection={spotifyConnection}
          activeJob={activeJob}
          runStatus={runStatus}
          latestRateLimitEvent={latestRateLimitEvent}
          queuedJobMatchesCurrent={queuedJobMatchesCurrent}
          queuedJobNotice={queuedJobNotice}
          statusMessage={statusMessage}
        />
      ) : null}

      {activeTab === "actions" ? (
        <ActionsTab
          panelState={panelState}
          activeCooldown={activeCooldown}
          canStartScan={canStartScan}
          spotifyConnection={spotifyConnection}
          isRunning={isRunning}
          isSmoking={isSmoking}
          isStartingSample={isStartingSample}
          isRefreshingStatus={isRefreshingStatus}
          onStartScan={() => {
            void startCheck();
          }}
          onSmokeTest={() => {
            void handleSmokeTest();
          }}
          onSampleStart={() => {
            void handleSampleStart();
          }}
          onRefreshStatus={() => {
            void refreshStatusNow();
          }}
        />
      ) : null}

      {activeTab === "findings" ? (
        <FindingsTab
          unavailableData={unavailableData}
          unavailablePlaylists={unavailablePlaylists}
          unavailableTrackRows={unavailableTrackRows}
          tracksWithSuggestions={tracksWithSuggestions}
          unavailableMessage={unavailableMessage}
          generatingSuggestionsFor={generatingSuggestionsFor}
          onGenerateSuggestions={(playlistId, trackId) => {
            void handleGenerateSuggestions(playlistId, trackId);
          }}
        />
      ) : null}

      {activeTab === "settings" ? (
        <SettingsTab
          spotifyConnection={spotifyConnection}
          primaryStats={primaryStats}
          activeJob={activeJob}
          runStatus={runStatus}
          isConnectingSpotify={isConnectingSpotify}
          isDisconnectingSpotify={isDisconnectingSpotify}
          isRunning={isRunning}
          isBackfillingArtists={isBackfillingArtists}
          isResettingCheckpoints={isResettingCheckpoints}
          isCancelling={isCancelling}
          isUnlocking={isUnlocking}
          onConnectSpotify={() => {
            void handleConnectSpotify();
          }}
          onDisconnectSpotify={() => {
            void handleDisconnectSpotify();
          }}
          onBackfillArtists={() => {
            void handleBackfillArtists();
          }}
          onResetCheckpoints={() => {
            void handleResetCheckpoints();
          }}
          onCancel={() => {
            void handleCancel();
          }}
          onUnlock={() => {
            void handleUnlock();
          }}
        />
      ) : null}

      {queuedJobStatusMessage ? (
        <p className="run-message">{queuedJobStatusMessage}</p>
      ) : message ? (
        <p className="run-message">{message}</p>
      ) : null}
    </section>
  );
}
