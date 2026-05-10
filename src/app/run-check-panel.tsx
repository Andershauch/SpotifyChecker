"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type CheckRequestResponse = {
  accepted: boolean;
  jobId: string | null;
  status: "queued" | "already_running";
  errorMessage: string | null;
};

type SmokeCheckResponse = {
  status: "ok" | "error" | "skipped";
  playlistId: string | null;
  playlistName: string | null;
  snapshotId: string | null;
  source: "database" | null;
  errorMessage: string | null;
};

type ArtistBackfillResponse = {
  updatedFromReplacements: number;
  spotifyBatchSize: number;
  updatedFromSpotify: number;
  remainingMissingArtists: number;
  skippedSpotifyDueToCooldown: boolean;
  message: string;
};

type JobSnapshot = {
  id: string;
  status: string;
  triggerSource: string;
  requestedAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  checkedTracks: number;
  checkedPlaylists: number;
  skippedPlaylists: number;
  unavailableCount: number;
  newUnavailableCount: number;
  cancelRequested: boolean;
  errorMessage: string | null;
  currentPlaylistName: string | null;
  currentStage: string | null;
};

type RunStatusResponse = {
  running: boolean;
  spotifyConnection: {
    connected: boolean;
    spotifyUserId: string | null;
    displayName: string | null;
    connectedAt: string | null;
    expiresAt: string | null;
  };
  cooldown: {
    active: boolean;
    until: string;
    expiresInSeconds: number;
    message: string;
  } | null;
  lock: {
    ownerId: string;
    jobId: string | null;
    startedAt: string;
    lockedUntil: string;
    expiresInSeconds: number;
  } | null;
  job: JobSnapshot | null;
  latestJob: JobSnapshot | null;
};

type UnavailablePlaylistGroup = {
  playlistId: string;
  playlistName: string;
  playlistUrl: string;
  trackCount: number;
  tracks: Array<{
    trackId: string;
    trackName: string;
    trackUrl: string;
    durationMs: number | null;
    firstSeenAt: string;
    lastSeenAt: string;
    currentlyUnavailable: boolean;
    primaryArtistName: string | null;
    referenceArtistName: string | null;
    referenceEstimatedBpm: number | null;
    suggestions: Array<{
      suggestionIndex: number;
      suggestedTrackName: string;
      suggestedArtistName: string;
      suggestedSpotifyUrl: string | null;
      suggestedSpotifyTrackId: string | null;
      durationMs: number | null;
      estimatedBpm: number | null;
      reasoningSummary: string;
      generatedAt: string;
    }>;
  }>;
};

type UnavailableResponse = {
  playlists: UnavailablePlaylistGroup[];
  totalPlaylists: number;
  totalTracks: number;
  currentTracks: number;
  historicalTracks: number;
};

type DashboardTab = "overview" | "findings" | "actions" | "settings";

export function RunCheckPanel() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");
  const [message, setMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [queuedJobNotice, setQueuedJobNotice] = useState<{
    jobId: string;
    label: string;
  } | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatusResponse | null>(null);
  const [unavailableData, setUnavailableData] = useState<UnavailableResponse | null>(null);
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);
  const [isConnectingSpotify, setIsConnectingSpotify] = useState(false);
  const [isDisconnectingSpotify, setIsDisconnectingSpotify] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStartingSample, setIsStartingSample] = useState(false);
  const [isSmoking, setIsSmoking] = useState(false);
  const [isResettingCheckpoints, setIsResettingCheckpoints] = useState(false);
  const [isBackfillingArtists, setIsBackfillingArtists] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [unavailableMessage, setUnavailableMessage] = useState<string | null>(null);
  const [generatingSuggestionsFor, setGeneratingSuggestionsFor] = useState<string | null>(null);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const spotifyStatus = searchParams.get("spotify");
    const spotifyMessage = searchParams.get("message");

    let nextMessage: string | null = null;

    if (spotifyStatus === "connected") {
      nextMessage = "Spotify er nu forbundet. Du kan hente status eller starte et check.";
    } else if (spotifyStatus === "error" && spotifyMessage) {
      nextMessage = spotifyMessage;
    }

    if (spotifyStatus === "connected" || spotifyStatus === "error") {
      if (nextMessage) {
        window.setTimeout(() => {
          setMessage(nextMessage);
        }, 0);
      }
      router.replace("/");
    }
  }, [router]);

  useEffect(() => {
    let cancelled = false;

    async function refreshStatus(showErrors: boolean) {
      const { response, payload } = await requestApi<RunStatusResponse>("/api/check/status");

      if (!response.ok) {
        if (!cancelled && showErrors && response.status !== 401) {
          setStatusMessage(getApiError(payload, response.status, "Kunne ikke hente status"));
        }
        if (!cancelled && response.status === 401) {
          setRunStatus(null);
          setStatusMessage(null);
        }
        return;
      }

      if (!cancelled) {
        setRunStatus(payload as RunStatusResponse);
        setStatusMessage(null);
      }
    }

    void refreshStatus(true);

    const intervalId = window.setInterval(() => {
      void refreshStatus(false);
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refreshUnavailable(showErrors: boolean) {
      const { response, payload } = await requestApi<UnavailableResponse>("/api/unavailable");

      if (!response.ok) {
        if (!cancelled && showErrors && response.status !== 401) {
          setUnavailableMessage(
            getApiError(payload, response.status, "Kunne ikke hente utilgængelige tracks"),
          );
        }
        if (!cancelled && response.status === 401) {
          setUnavailableData(null);
          setUnavailableMessage(null);
        }
        return;
      }

      if (!cancelled) {
        setUnavailableData(payload as UnavailableResponse);
        setUnavailableMessage(null);
      }
    }

    void refreshUnavailable(true);

    const intervalId = window.setInterval(() => {
      void refreshUnavailable(false);
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const activeJob = runStatus?.running ? runStatus.job : runStatus?.latestJob ?? null;
  const isRunning = runStatus?.running ?? false;
  const activeCooldown = runStatus?.cooldown?.active ? runStatus.cooldown : null;
  const spotifyConnection = runStatus?.spotifyConnection ?? null;
  const currentJobId = runStatus?.job?.id ?? runStatus?.latestJob?.id ?? null;
  const panelState = getPanelState({
    spotifyConnected: Boolean(spotifyConnection?.connected),
    isRunning,
    hasCooldown: Boolean(activeCooldown),
  });
  const queuedJobMatchesCurrent = Boolean(
    queuedJobNotice && currentJobId && currentJobId === queuedJobNotice.jobId,
  );
  const queuedJobStatusMessage =
    queuedJobMatchesCurrent && activeJob?.status === "running"
      ? `${queuedJobNotice?.label} kører nu.`
      : null;
  const primaryStats = activeJob
    ? [
        {
          label: "Tracks tjekket",
          value: String(activeJob.checkedTracks),
          tone: "hero" as const,
        },
        {
          label: "Utilgængelige fundet",
          value: String(activeJob.unavailableCount),
          tone: activeJob.unavailableCount > 0 ? ("danger" as const) : ("hero" as const),
        },
        {
          label: "Playlister tjekket",
          value: String(activeJob.checkedPlaylists),
          tone: "hero" as const,
        },
        {
          label: "Jobstatus",
          value: formatJobStatus(activeJob.status),
          tone: "default" as const,
        },
        {
          label: "Playlister sprunget over",
          value: String(activeJob.skippedPlaylists),
          tone: "default" as const,
        },
        {
          label: "Trigger",
          value: activeJob.triggerSource === "cron" ? "Cron" : "Manuel",
          tone: "default" as const,
        },
      ]
    : [];
  const timingStats = activeJob
    ? [
        {
          label: "Startet",
          value: activeJob.startedAt ? formatDateTime(activeJob.startedAt) : "-",
        },
        {
          label: "Sidste heartbeat",
          value: activeJob.heartbeatAt ? formatDateTime(activeJob.heartbeatAt) : "-",
        },
        { label: "Stop ønsket", value: activeJob.cancelRequested ? "Ja" : "Nej" },
      ]
    : [];
  const latestRateLimitEvent =
    !activeCooldown &&
    activeJob?.status === "error" &&
    activeJob.errorMessage?.includes("Spotify rate limit")
      ? {
          message: activeJob.errorMessage,
          at: activeJob.heartbeatAt ?? activeJob.startedAt ?? activeJob.requestedAt,
        }
      : null;
  const unavailablePlaylists = unavailableData?.playlists ?? [];
  const unavailableTrackRows = unavailablePlaylists.flatMap((playlist) =>
    playlist.tracks.map((track) => ({ playlist, track })),
  );
  const tracksWithSuggestions = unavailableTrackRows.filter(
    ({ track }) => track.suggestions.length > 0,
  ).length;
  const currentUnavailableTracks =
    unavailableData?.currentTracks ??
    unavailableTrackRows.filter(({ track }) => track.currentlyUnavailable).length;
  const canStartScan =
    Boolean(spotifyConnection?.connected) && !isRunning && !isStarting && !activeCooldown;

  async function refreshStatusNow() {
    setIsRefreshingStatus(true);

    try {
      const { response, payload } = await requestApi<RunStatusResponse>("/api/check/status");

      if (!response.ok) {
        if (response.status === 401) {
          setRunStatus(null);
          setStatusMessage(null);
          return;
        }
        setStatusMessage(getApiError(payload, response.status, "Kunne ikke hente status"));
        return;
      }

      setRunStatus(payload as RunStatusResponse);
      setStatusMessage(null);
      await refreshUnavailableNow();
    } finally {
      setIsRefreshingStatus(false);
    }
  }

  async function refreshUnavailableNow() {
    const { response, payload } = await requestApi<UnavailableResponse>("/api/unavailable");

    if (!response.ok) {
      if (response.status === 401) {
        setUnavailableData(null);
        setUnavailableMessage(null);
        return;
      }
      setUnavailableMessage(
        getApiError(payload, response.status, "Kunne ikke hente utilgængelige tracks"),
      );
      return;
    }

    setUnavailableData(payload as UnavailableResponse);
    setUnavailableMessage(null);
  }

  async function startCheck() {
    setMessage(null);
    setIsStarting(true);

    try {
      const { response, payload } = await requestApi<CheckRequestResponse>("/api/check", {
        method: "POST",
      });

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Kørslen fejlede"));
        return;
      }

      const result = payload as CheckRequestResponse;
      setMessage(getQueueSummaryMessage(result));
      if (result.accepted && result.jobId) {
        setQueuedJobNotice({ jobId: result.jobId, label: "Check" });
      }
      await refreshStatusNow();
      router.refresh();
    } finally {
      setIsStarting(false);
    }
  }

  async function handleStart(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await startCheck();
  }

  async function handleConnectSpotify() {
    setMessage(null);
    setIsConnectingSpotify(true);

    try {
      const { response, payload } = await requestApi<{ url?: string }>("/api/spotify/connect", {
        method: "POST",
      });

      if (!response.ok || !payload || !("url" in payload) || !payload.url) {
        setMessage(getApiError(payload, response.status, "Kunne ikke starte Spotify-login"));
        return;
      }

      window.location.href = payload.url;
    } finally {
      setIsConnectingSpotify(false);
    }
  }

  async function handleDisconnectSpotify() {
    setMessage(null);
    setIsDisconnectingSpotify(true);

    try {
      const { response, payload } = await requestApi<{ disconnected?: boolean }>(
        "/api/spotify/disconnect",
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Kunne ikke afbryde Spotify"));
        return;
      }

      setMessage("Spotify-forbindelsen er afbrudt.");
      await refreshStatusNow();
      await refreshUnavailableNow();
    } finally {
      setIsDisconnectingSpotify(false);
    }
  }

  async function handleResetCheckpoints() {
    setMessage(null);
    setIsResettingCheckpoints(true);

    try {
      const { response, payload } = await requestApi<{ deletedCount?: number }>(
        "/api/check/reset-checkpoints",
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Kunne ikke nulstille checkpoints"));
        return;
      }

      const deletedCount =
        payload && "deletedCount" in payload && typeof payload.deletedCount === "number"
          ? payload.deletedCount
          : 0;

      setMessage(
        `Checkpoints nulstillet. ${deletedCount} playlist-checkpoints blev fjernet, så næste check laver et fuldt scan.`,
      );
      await refreshStatusNow();
      await refreshUnavailableNow();
      router.refresh();
    } finally {
      setIsResettingCheckpoints(false);
    }
  }

  async function handleBackfillArtists() {
    setMessage(null);
    setIsBackfillingArtists(true);

    try {
      const { response, payload } = await requestApi<ArtistBackfillResponse>(
        "/api/check/backfill-artists",
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Kunne ikke backfille kunstnernavne"));
        return;
      }

      const result = payload as ArtistBackfillResponse;
      setMessage(result.message);
      await refreshUnavailableNow();
    } finally {
      setIsBackfillingArtists(false);
    }
  }

  async function handleCancel() {
    setMessage(null);
    setIsCancelling(true);

    try {
      const { response, payload } = await requestApi<{ requested?: boolean }>("/api/check/cancel", {
        method: "POST",
      });

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Kunne ikke sende stop-signal"));
        return;
      }

      const requested =
        payload && "requested" in payload && typeof payload.requested === "boolean"
          ? payload.requested
          : false;

      setMessage(
        requested
          ? "Stop er anmodet. Den aktive kørsel stopper ved næste sikre checkpoint."
          : "Der er ingen aktiv kørsel at stoppe.",
      );
      await refreshStatusNow();
    } finally {
      setIsCancelling(false);
    }
  }

  async function handleSmokeTest() {
    setMessage(null);
    setIsSmoking(true);

    try {
      const { response, payload } = await requestApi<SmokeCheckResponse>("/api/check/smoke", {
        method: "POST",
      });

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Smoke test fejlede"));
        return;
      }

      setMessage(getSmokeSummaryMessage(payload as SmokeCheckResponse));
      await refreshStatusNow();
    } finally {
      setIsSmoking(false);
    }
  }

  async function handleUnlock() {
    setMessage(null);
    setIsUnlocking(true);

    try {
      const { response, payload } = await requestApi<{ released?: boolean }>("/api/check/unlock", {
        method: "POST",
      });

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Kunne ikke frigive låsen"));
        return;
      }

      const released =
        payload && "released" in payload && typeof payload.released === "boolean"
          ? payload.released
          : false;

      setMessage(
        released
          ? "Låsen er frigivet manuelt. Brug kun dette, hvis et job er fastlåst."
          : "Der var ingen aktiv lås at frigive.",
      );
      await refreshStatusNow();
      await refreshUnavailableNow();
      router.refresh();
    } finally {
      setIsUnlocking(false);
    }
  }

  async function handleSampleStart() {
    setMessage(null);
    setIsStartingSample(true);

    try {
      const { response, payload } = await requestApi<CheckRequestResponse>("/api/check/sample", {
        method: "POST",
      });

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Testscan fejlede"));
        return;
      }

      const result = payload as CheckRequestResponse;
      setMessage(getQueueSummaryMessage(result, "Testscan af de første 5 playlister"));
      if (result.accepted && result.jobId) {
        setQueuedJobNotice({
          jobId: result.jobId,
          label: "Testscan af de første 5 playlister",
        });
      }
      await refreshStatusNow();
      router.refresh();
    } finally {
      setIsStartingSample(false);
    }
  }

  async function handleGenerateSuggestions(playlistId: string, trackId: string) {
    const requestKey = `${playlistId}::${trackId}`;
    setMessage(null);
    setGeneratingSuggestionsFor(requestKey);

    try {
      const { response, payload } = await requestApi<{ suggestions?: unknown[] }>(
        "/api/replacements/generate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ playlistId, trackId }),
        },
      );

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Kunne ikke finde alternativer"));
        return;
      }

      setMessage("Der er nu hentet 2 alternativer til tracket.");
      await refreshUnavailableNow();
    } finally {
      setGeneratingSuggestionsFor(null);
    }
  }

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
            {[
              { id: "overview", label: "Overblik" },
              { id: "findings", label: "Fund" },
              { id: "actions", label: "Handlinger" },
              { id: "settings", label: "Indstillinger" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`app-tab ${activeTab === tab.id ? "app-tab-active" : ""}`}
                onClick={() => {
                  setActiveTab(tab.id as DashboardTab);
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

      <form className="run-form" onSubmit={handleStart}>
        {activeTab === "overview" ? (
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
                    Vent til {formatDateTime(activeCooldown.until)} før du prøver igen. Panelet blokerer nu også health check under aktiv cooldown.
                  </p>
                </div>
              ) : null}

              {!activeCooldown ? (
                <div className="run-message run-message-muted">
                  <strong>Cron-status</strong>
                  <p>
                    Vercel Cron er sat til dagligt 07:00 UTC. I dansk sommertid svarer det til
                    09:00, og i vintertid til 08:00.
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
                        {spotifyConnection?.connected ? "Kør smoke test eller start check" : "Forbind Spotify"}
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
                  Seneste handling: {queuedJobNotice?.label} er sendt til kø og afventer næste statusopdatering.
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
                    Der er ikke registreret en aktiv cooldown lige nu, så dette er historik og ikke en nuværende blokering.
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
        ) : null}

        {activeTab === "actions" ? (
          <section className="status-box operations-card">
            <div className="section-heading section-heading-compact">
              <div>
                <p className="eyebrow">Handlinger</p>
                <h3>Scan og helbredstjek</h3>
              </div>
              {activeCooldown ? (
                <span className="pill pill-warning">Cooldown til {formatTime(activeCooldown.until)}</span>
              ) : (
                <span className={getRunPillClass(panelState)}>{getRunPillText(panelState)}</span>
              )}
            </div>

            <p className="helper-text">
              Brug fuldt scan til daglig drift, health check som billig statuskontrol og kort
              testscan til at validere parsing på få playlister.
            </p>

            <div className="action-grid">
              <button
                type="submit"
                className="toolbar-primary action-card-button action-card-primary"
                disabled={
                  !canStartScan
                }
              >
                <span>Start scan</span>
                <small>Scanner næste batch efter checkpoint-strategien.</small>
              </button>

              <button
                type="button"
                className="secondary-button action-card-button"
                onClick={() => {
                  void handleSmokeTest();
                }}
                disabled={
                  !spotifyConnection?.connected ||
                  isRunning ||
                  isSmoking ||
                  isStartingSample ||
                  Boolean(activeCooldown)
                }
              >
                <span>{isSmoking ? "Tester..." : "Health check"}</span>
                <small>Bekræfter Spotify-forbindelsen uden tung scanning.</small>
              </button>

              <button
                type="button"
                className="secondary-button action-card-button"
                onClick={() => {
                  void handleSampleStart();
                }}
                disabled={
                  !spotifyConnection?.connected ||
                  isRunning ||
                  isStartingSample ||
                  Boolean(activeCooldown)
                }
              >
                <span>{isStartingSample ? "Starter testscan..." : "Kort testscan"}</span>
                <small>Scanner kun de første 5 playlister.</small>
              </button>

              <button
                type="button"
                className="secondary-button action-card-button"
                onClick={() => {
                  void refreshStatusNow();
                }}
                disabled={isRefreshingStatus}
              >
                <span>{isRefreshingStatus ? "Opdaterer..." : "Opdater status"}</span>
                <small>Henter frisk jobstatus og fund fra databasen.</small>
              </button>
            </div>
          </section>
        ) : null}

        {activeTab === "findings" ? (
        <section className="status-box unavailable-card">
          <div className="section-heading section-heading-compact">
            <div>
              <p className="eyebrow">Fund og alternativer</p>
              <h3>Playlister med utilgængelige tracks</h3>
            </div>
            {unavailableData ? (
              <p className="section-note">
                {unavailableData.currentTracks} aktuelle og {unavailableData.historicalTracks} historiske fund fordelt på{" "}
                {unavailableData.totalPlaylists} playliste
                {unavailableData.totalPlaylists === 1 ? "" : "r"}. {tracksWithSuggestions} af{" "}
                {unavailableTrackRows.length} tracks har forslag.
              </p>
            ) : null}
          </div>

          {unavailableMessage ? <p className="run-message">{unavailableMessage}</p> : null}

          {!unavailableMessage && unavailablePlaylists.length === 0 ? (
            <p className="helper-text">
              Ingen aktuelle utilgængelige tracks er registreret lige nu.
            </p>
          ) : null}
          {!unavailableMessage &&
          unavailablePlaylists.length > 0 &&
          currentUnavailableTracks === 0 ? (
            <p className="helper-text">
              Der er ingen aktuelle fund lige nu. Listen nedenfor viser kun historik fra tidligere
              scans.
            </p>
          ) : null}

          <div className="playlist-findings">
            {unavailablePlaylists.map((playlist, index) => (
              <details
                key={playlist.playlistId}
                className="playlist-finding"
                open={index === 0}
              >
                <summary>
                  <span className="playlist-finding-head">
                    <span className="playlist-finding-copy">
                      <strong>
                        <a
                          href={playlist.playlistUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="spotify-link"
                          onClick={(event) => {
                            event.stopPropagation();
                          }}
                        >
                          {playlist.playlistName}
                        </a>
                      </strong>
                      <small>
                        {formatPlaylistTrackSummary(playlist)}
                      </small>
                    </span>
                    <span className="playlist-finding-meta">
                      <span className="playlist-count-badge">{playlist.trackCount}</span>
                      <span className="playlist-chevron" aria-hidden="true">
                        ▾
                      </span>
                    </span>
                  </span>
                </summary>

                <ul className="track-list">
                  {playlist.tracks.map((track) => (
                    <li key={`${playlist.playlistId}-${track.trackId}`}>
                      <div>
                        <strong>
                          <a
                            href={track.trackUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="spotify-link"
                          >
                            {track.trackName}
                          </a>
                        </strong>
                        {track.durationMs ? <span>{formatDuration(track.durationMs)}</span> : null}
                      </div>
                      <small>
                        <span
                          className={
                            track.currentlyUnavailable
                              ? "track-status track-status-current"
                              : "track-status track-status-historical"
                          }
                        >
                          {track.currentlyUnavailable ? "Aktuel" : "Historisk"}
                        </span>{" "}
                        Senest set {formatDateTime(track.lastSeenAt)}{" "}
                        {" • "}
                        {track.primaryArtistName ?? "ukendt kunstner"}
                      </small>

                      <div className="track-actions">
                        <button
                          type="button"
                          className="secondary-button suggestion-button"
                          onClick={() => {
                            void handleGenerateSuggestions(playlist.playlistId, track.trackId);
                          }}
                          disabled={
                            generatingSuggestionsFor === `${playlist.playlistId}::${track.trackId}`
                          }
                        >
                          {generatingSuggestionsFor === `${playlist.playlistId}::${track.trackId}`
                            ? "Finder alternativer..."
                            : track.suggestions.length > 0
                              ? "Opdatér alternativer"
                              : "Find 2 alternativer"}
                        </button>
                      </div>

                      {track.suggestions.length > 0 ? (
                        <div className="suggestion-list">
                          <p className="suggestion-intro">
                            Alternativer til &quot;{track.trackName}&quot; af{" "}
                            {track.referenceArtistName ?? track.primaryArtistName ?? "ukendt kunstner"} —{" "}
                            {track.durationMs ? formatDuration(track.durationMs) : "ukendt længde"}
                            {" / "}
                            {track.referenceEstimatedBpm
                              ? `estimeret ${track.referenceEstimatedBpm} BPM`
                              : "ukendt estimeret BPM"}
                            :
                          </p>

                          {track.suggestions.map((suggestion) => (
                            <article
                              key={`${track.trackId}-${suggestion.suggestionIndex}`}
                              className="suggestion-card"
                            >
                              {suggestion.reasoningSummary === "spotify-title-duration-match" ? (
                                <span className="suggestion-label">Direkte titelmatch</span>
                              ) : null}
                              <p className="suggestion-line">
                                {suggestion.suggestedSpotifyUrl ? (
                                  <a
                                    href={suggestion.suggestedSpotifyUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="spotify-link"
                                  >
                                    {suggestion.suggestedTrackName}
                                  </a>
                                ) : (
                                  suggestion.suggestedTrackName
                                )}{" "}
                                — {suggestion.suggestedArtistName} —{" "}
                                {suggestion.durationMs
                                  ? formatDuration(suggestion.durationMs)
                                  : "ukendt længde"}
                                {" / "}
                                {suggestion.estimatedBpm
                                  ? `estimeret ${suggestion.estimatedBpm} BPM`
                                  : "ukendt estimeret BPM"}
                              </p>
                            </article>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </section>
        ) : null}

        {activeTab === "settings" ? (
          <section className="settings-view">
            <div className="status-box connection-card">
              <div className="section-heading section-heading-compact">
                <div>
                  <p className="eyebrow">Nuværende Spotify-session</p>
                  <h3>Forbindelse</h3>
                </div>
              </div>

              <p className="helper-text">
                OAuth-sessionen ligger server-side. Appen kan derfor køre cron uden at browseren
                står åben, så længe token kan refreshes.
              </p>

              <dl className="session-stats">
                <div>
                  <dt>Bruger</dt>
                  <dd>{spotifyConnection?.displayName ?? spotifyConnection?.spotifyUserId ?? "-"}</dd>
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
                    {spotifyConnection?.expiresAt
                      ? formatDateTime(spotifyConnection.expiresAt)
                      : "-"}
                  </dd>
                </div>
              </dl>

              <div className="toolbar-actions toolbar-actions-stacked">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    void handleConnectSpotify();
                  }}
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
                  onClick={() => {
                    void handleDisconnectSpotify();
                  }}
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
                  onClick={() => {
                    void handleBackfillArtists();
                  }}
                  disabled={
                    isRunning ||
                    isBackfillingArtists ||
                    !spotifyConnection?.connected
                  }
                >
                  {isBackfillingArtists ? "Backfiller..." : "Backfill kunstnere"}
                </button>

                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    void handleResetCheckpoints();
                  }}
                  disabled={isRunning || isResettingCheckpoints}
                >
                  {isResettingCheckpoints ? "Nulstiller..." : "Nulstil checkpoints"}
                </button>

                <button
                  type="button"
                  className="danger-button"
                  onClick={() => {
                    void handleCancel();
                  }}
                  disabled={!isRunning || isCancelling}
                >
                  {isCancelling ? "Stopper..." : "Stop job"}
                </button>

                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    void handleUnlock();
                  }}
                  disabled={!isRunning || isUnlocking}
                >
                  {isUnlocking ? "Frigiver..." : "Nød-frigiv lås"}
                </button>
              </div>

              <div className="recovery-copy">
                <p className="helper-text">
                  Nulstil checkpoints bør kun bruges, når vi aktivt vil gennemtvinge en tungere
                  genopbygning. Normal drift bør lade checkpoint-modellen fordele Spotify-kald over
                  flere små kørsler.
                </p>
                <p className="helper-text">
                  Kunstner-backfill bruger først eksisterende data og derefter højst en lille
                  Spotify-batch for fund, der stadig mangler kunstnernavn.
                </p>
                {runStatus?.lock ? (
                  <p className="helper-text">
                    Aktuel lås udløber om {formatSeconds(runStatus.lock.expiresInSeconds)}.
                  </p>
                ) : null}
              </div>
            </details>
          </section>
        ) : null}
      </form>

      {queuedJobStatusMessage ? (
        <p className="run-message">{queuedJobStatusMessage}</p>
      ) : message ? (
        <p className="run-message">{message}</p>
      ) : null}
    </section>
  );
}

function getApiError(payload: unknown, status: number, fallback: string) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    return (payload as { error: string }).error;
  }

  return `${fallback} (${status}).`;
}

async function requestApi<T>(input: string, init?: RequestInit) {
  const response = await fetch(input, init);
  let payload: T | { error?: string } | null = null;

  try {
    payload = (await response.json()) as T | { error?: string };
  } catch {
    payload = null;
  }

  return { response, payload };
}

function getQueueSummaryMessage(
  result: CheckRequestResponse,
  label = "Check",
) {
  if (result.status === "queued") {
    return result.jobId
      ? `${label} sat i kø som job ${result.jobId}. Panelet opdaterer status automatisk.`
      : `${label} sat i kø. Panelet opdaterer status automatisk.`;
  }

  return result.errorMessage ?? "Et andet check kører allerede.";
}

function getPanelState(input: {
  spotifyConnected: boolean;
  isRunning: boolean;
  hasCooldown: boolean;
}) {
  if (!input.spotifyConnected) {
    return "disconnected" as const;
  }

  if (input.hasCooldown) {
    return "cooldown" as const;
  }

  if (input.isRunning) {
    return "running" as const;
  }

  return "ready" as const;
}

function getTabLabel(tab: DashboardTab) {
  switch (tab) {
    case "overview":
      return "Overblik";
    case "findings":
      return "Fund";
    case "actions":
      return "Handlinger";
    case "settings":
      return "Indstillinger";
  }
}

function getPanelSummary(
  panelState: ReturnType<typeof getPanelState>,
  cooldown: RunStatusResponse["cooldown"],
) {
  switch (panelState) {
    case "disconnected":
      return "Forbind Spotify først. Når sessionen er aktiv, kan du bruge smoke test eller starte et check.";
    case "cooldown":
      return cooldown
        ? `Spotify bad om pause indtil ${formatDateTime(cooldown.until)}. Brug ventetiden på smoke test eller UI-kontrol.`
        : "Spotify cooldown er aktiv.";
    case "running":
      return "Et job kører nu. Panelet opdaterer status automatisk, så du kan følge playlist og fase live.";
    case "ready":
      return "Panelet er klar. Brug smoke test til et billigt helbredstjek eller testscan for at validere track-parsing på få playlister.";
  }
}

function getRunPillClass(panelState: ReturnType<typeof getPanelState>) {
  switch (panelState) {
    case "running":
      return "pill pill-running";
    case "cooldown":
      return "pill pill-warning";
    case "ready":
      return "pill pill-ready";
    case "disconnected":
    default:
      return "pill pill-idle";
  }
}

function getRunPillText(panelState: ReturnType<typeof getPanelState>) {
  switch (panelState) {
    case "running":
      return "Aktivt job kører";
    case "cooldown":
      return "Spotify cooldown aktiv";
    case "ready":
      return "Klar til ny kørsel";
    case "disconnected":
    default:
      return "Ingen aktiv kørsel";
  }
}

function getSmokeSummaryMessage(result: SmokeCheckResponse) {
  if (result.status === "ok") {
    return `Smoke test OK: playlisten "${result.playlistName ?? result.playlistId}" svarede fra database-kataloget${result.snapshotId ? ` med snapshot ${result.snapshotId}` : ""}.`;
  }

  if (result.status === "skipped") {
    return result.errorMessage ?? "Smoke testen blev sprunget over.";
  }

  return result.errorMessage ?? "Spotify smoke test fejlede.";
}

function formatPlaylistTrackSummary(playlist: UnavailablePlaylistGroup) {
  const currentCount = playlist.tracks.filter((track) => track.currentlyUnavailable).length;
  const historicalCount = playlist.trackCount - currentCount;
  const segments = [];

  if (currentCount > 0) {
    segments.push(
      `${currentCount} aktuelt utilgængelige track${currentCount === 1 ? "" : "s"}`,
    );
  }

  if (historicalCount > 0) {
    segments.push(`${historicalCount} historiske`);
  }

  if (segments.length === 0) {
    return "Ingen registrerede fund";
  }

  return segments.join(" • ");
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("da-DK", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("da-DK", {
    timeStyle: "short",
  }).format(new Date(value));
}

function formatSeconds(value: number) {
  if (value < 60) {
    return `${value} sek`;
  }

  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes}m ${seconds}s`;
}

function formatJobStatus(status: string) {
  switch (status) {
    case "queued":
      return "I kø";
    case "running":
      return "Kører";
    case "cancel_requested":
      return "Stop ønsket";
    case "cancelled":
      return "Stoppet";
    case "ok":
      return "Færdig";
    case "skipped":
      return "Sprunget over";
    case "error":
      return "Fejl";
    default:
      return status;
  }
}

function formatDuration(durationMs: number | null) {
  if (!durationMs || durationMs < 0) {
    return null;
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
