import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ArtistBackfillResponse,
  CheckRequestResponse,
  DashboardTab,
  JobSnapshot,
  PanelState,
  PrimaryStat,
  RunStatusResponse,
  SmokeCheckResponse,
  TimingStat,
  UnavailablePlaylistGroup,
  UnavailableResponse,
} from "./types";
import {
  formatDateTime,
  formatJobStatus,
  getApiError,
  getPanelState,
  getQueueSummaryMessage,
  getSmokeSummaryMessage,
  requestApi,
} from "./utils";

const STATUS_POLL_INTERVAL_MS = 2_000;
const UNAVAILABLE_POLL_INTERVAL_MS = 10_000;

export function useDashboard() {
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
    }, STATUS_POLL_INTERVAL_MS);

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
    }, UNAVAILABLE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  // Derived state
  const activeJob: JobSnapshot | null = runStatus?.running
    ? runStatus.job
    : (runStatus?.latestJob ?? null);
  const isRunning = runStatus?.running ?? false;
  const activeCooldown = runStatus?.cooldown?.active ? runStatus.cooldown : null;
  const spotifyConnection = runStatus?.spotifyConnection ?? null;
  const currentJobId = runStatus?.job?.id ?? runStatus?.latestJob?.id ?? null;
  const panelState: PanelState = getPanelState({
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
  const primaryStats: PrimaryStat[] = activeJob
    ? [
        { label: "Tracks tjekket", value: String(activeJob.checkedTracks), tone: "hero" },
        {
          label: "Utilgængelige fundet",
          value: String(activeJob.unavailableCount),
          tone: activeJob.unavailableCount > 0 ? "danger" : "hero",
        },
        {
          label: "Playlister tjekket",
          value: String(activeJob.checkedPlaylists),
          tone: "hero",
        },
        {
          label: "Jobstatus",
          value: formatJobStatus(activeJob.status),
          tone: "default",
        },
        {
          label: "Playlister sprunget over",
          value: String(activeJob.skippedPlaylists),
          tone: "default",
        },
        {
          label: "Trigger",
          value: activeJob.triggerSource === "cron" ? "Cron" : "Manuel",
          tone: "default",
        },
      ]
    : [];
  const timingStats: TimingStat[] = activeJob
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
  const unavailablePlaylists: UnavailablePlaylistGroup[] = unavailableData?.playlists ?? [];
  const unavailableTrackRows = unavailablePlaylists.flatMap((playlist) =>
    playlist.tracks.map((track) => ({ playlist, track })),
  );
  const tracksWithSuggestions = unavailableTrackRows.filter(
    ({ track }) => track.suggestions.length > 0,
  ).length;
  const currentUnavailableTracks = unavailableData?.totalTracks ?? unavailableTrackRows.length;
  const canStartScan =
    Boolean(spotifyConnection?.connected) && !isRunning && !isStarting && !activeCooldown;

  // Handlers
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
        { method: "POST" },
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
        { method: "POST" },
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
        { method: "POST" },
      );

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Kunne ikke backfille kunstnernavne"));
        return;
      }

      setMessage((payload as ArtistBackfillResponse).message);
      await refreshUnavailableNow();
    } finally {
      setIsBackfillingArtists(false);
    }
  }

  async function handleCancel() {
    setMessage(null);
    setIsCancelling(true);

    try {
      const { response, payload } = await requestApi<{ requested?: boolean }>(
        "/api/check/cancel",
        { method: "POST" },
      );

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
      const { response, payload } = await requestApi<{ released?: boolean }>(
        "/api/check/unlock",
        { method: "POST" },
      );

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
          headers: { "Content-Type": "application/json" },
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

  return {
    activeTab,
    setActiveTab,
    message,
    statusMessage,
    unavailableMessage,
    queuedJobStatusMessage,
    runStatus,
    unavailableData,
    isRefreshingStatus,
    isConnectingSpotify,
    isDisconnectingSpotify,
    isStarting,
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
  };
}
