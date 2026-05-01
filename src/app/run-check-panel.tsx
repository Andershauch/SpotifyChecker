"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type CheckResponse = {
  status: "ok" | "error" | "skipped" | "cancelled";
  checkedTracks: number;
  unavailableCount: number;
  newUnavailableCount: number;
  checkedPlaylists: number;
  skippedPlaylists: number;
  errorMessage: string | null;
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

export function RunCheckPanel() {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatusResponse | null>(null);
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);

  useEffect(() => {
    if (!secret.trim()) {
      return;
    }

    let cancelled = false;

    async function refreshStatus(showErrors: boolean) {
      setIsRefreshingStatus(true);

      try {
        const response = await fetch("/api/check/status", {
          headers: {
            Authorization: `Bearer ${secret}`,
          },
        });

        let payload: RunStatusResponse | { error?: string } | null = null;

        try {
          payload = (await response.json()) as RunStatusResponse | { error?: string };
        } catch {
          payload = null;
        }

        if (!response.ok) {
          if (!cancelled && showErrors) {
            setStatusMessage(getApiError(payload, response.status, "Kunne ikke hente status"));
          }
          return;
        }

        if (!cancelled) {
          setRunStatus(payload as RunStatusResponse);
          setStatusMessage(null);
        }
      } finally {
        if (!cancelled) {
          setIsRefreshingStatus(false);
        }
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
  }, [secret]);

  const activeJob = runStatus?.running ? runStatus.job : runStatus?.latestJob ?? null;
  const isRunning = runStatus?.running ?? false;

  async function refreshStatusNow() {
    if (!secret.trim()) {
      return;
    }

    setIsRefreshingStatus(true);

    try {
      const response = await fetch("/api/check/status", {
        headers: {
          Authorization: `Bearer ${secret}`,
        },
      });

      let payload: RunStatusResponse | { error?: string } | null = null;

      try {
        payload = (await response.json()) as RunStatusResponse | { error?: string };
      } catch {
        payload = null;
      }

      if (!response.ok) {
        setStatusMessage(getApiError(payload, response.status, "Kunne ikke hente status"));
        return;
      }

      setRunStatus(payload as RunStatusResponse);
      setStatusMessage(null);
    } finally {
      setIsRefreshingStatus(false);
    }
  }

  async function handleStart(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setIsStarting(true);

    try {
      const response = await fetch("/api/check", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
        },
      });

      let payload: CheckResponse | { error?: string } | null = null;

      try {
        payload = (await response.json()) as CheckResponse | { error?: string };
      } catch {
        payload = null;
      }

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Kørslen fejlede"));
        return;
      }

      const result = payload as CheckResponse;
      setMessage(getSummaryMessage(result));
      await refreshStatusNow();
      router.refresh();
    } finally {
      setIsStarting(false);
    }
  }

  async function handleCancel() {
    setMessage(null);
    setIsCancelling(true);

    try {
      const response = await fetch("/api/check/cancel", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
        },
      });

      let payload: { requested?: boolean; error?: string } | null = null;

      try {
        payload = (await response.json()) as { requested?: boolean; error?: string };
      } catch {
        payload = null;
      }

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Kunne ikke sende stop-signal"));
        return;
      }

      setMessage(
        payload?.requested
          ? "Stop er anmodet. Den aktive kørsel stopper ved næste sikre checkpoint."
          : "Der er ingen aktiv kørsel at stoppe.",
      );
      await refreshStatusNow();
    } finally {
      setIsCancelling(false);
    }
  }

  async function handleUnlock() {
    setMessage(null);
    setIsUnlocking(true);

    try {
      const response = await fetch("/api/check/unlock", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
        },
      });

      let payload: { released?: boolean; error?: string } | null = null;

      try {
        payload = (await response.json()) as { released?: boolean; error?: string };
      } catch {
        payload = null;
      }

      if (!response.ok) {
        setMessage(getApiError(payload, response.status, "Kunne ikke frigive låsen"));
        return;
      }

      setMessage(
        payload?.released
          ? "Låsen er frigivet manuelt. Brug kun dette, hvis et job er fastlåst."
          : "Der var ingen aktiv lås at frigive.",
      );
      await refreshStatusNow();
      router.refresh();
    } finally {
      setIsUnlocking(false);
    }
  }

  return (
    <section className="card">
      <h2>Kontrolpanel</h2>
      <p>
        Start et check, se live progress og stop en aktiv kørsel uden at skulle
        vente på en lang timeout.
      </p>

      <form className="run-form" onSubmit={handleStart}>
        <label className="field">
          <span>CRON_SECRET</span>
          <input
            type="password"
            value={secret}
            onChange={(event) => {
              const nextValue = event.target.value;
              setSecret(nextValue);

              if (!nextValue.trim()) {
                setRunStatus(null);
                setStatusMessage(null);
                setMessage(null);
              }
            }}
            placeholder="Indsæt secret"
            autoComplete="current-password"
            required
          />
        </label>

        <div className="control-grid">
          <div className="status-box">
            <div className="status-line">
              <span className={isRunning ? "pill pill-running" : "pill pill-idle"}>
                {isRunning ? "Aktivt job kører" : "Ingen aktiv kørsel"}
              </span>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void refreshStatusNow();
                }}
                disabled={!secret.trim() || isRefreshingStatus}
              >
                {isRefreshingStatus ? "Opdaterer..." : "Opdater status"}
              </button>
            </div>

            {activeJob ? (
              <div className="status-stack">
                <dl className="live-stats">
                  <div>
                    <dt>Jobstatus</dt>
                    <dd>{formatJobStatus(activeJob.status)}</dd>
                  </div>
                  <div>
                    <dt>Trigger</dt>
                    <dd>{activeJob.triggerSource === "cron" ? "Cron" : "Manuel"}</dd>
                  </div>
                  <div>
                    <dt>Playlister tjekket</dt>
                    <dd>{activeJob.checkedPlaylists}</dd>
                  </div>
                  <div>
                    <dt>Playlister sprunget over</dt>
                    <dd>{activeJob.skippedPlaylists}</dd>
                  </div>
                  <div>
                    <dt>Tracks tjekket</dt>
                    <dd>{activeJob.checkedTracks}</dd>
                  </div>
                  <div>
                    <dt>Utilgængelige fundet</dt>
                    <dd>{activeJob.unavailableCount}</dd>
                  </div>
                </dl>

                <dl className="live-stats">
                  <div>
                    <dt>Startet</dt>
                    <dd>{activeJob.startedAt ? formatDateTime(activeJob.startedAt) : "-"}</dd>
                  </div>
                  <div>
                    <dt>Sidste heartbeat</dt>
                    <dd>{activeJob.heartbeatAt ? formatDateTime(activeJob.heartbeatAt) : "-"}</dd>
                  </div>
                  <div>
                    <dt>Stop ønsket</dt>
                    <dd>{activeJob.cancelRequested ? "Ja" : "Nej"}</dd>
                  </div>
                  <div>
                    <dt>Aktuel playlist</dt>
                    <dd>{activeJob.currentPlaylistName ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>Aktuel fase</dt>
                    <dd>{activeJob.currentStage ?? "-"}</dd>
                  </div>
                </dl>

                {runStatus?.lock ? (
                  <p className="helper-text">
                    Låsen udløber om {formatSeconds(runStatus.lock.expiresInSeconds)}.
                  </p>
                ) : null}

                {activeJob.errorMessage ? (
                  <p className="run-message">{activeJob.errorMessage}</p>
                ) : null}
              </div>
            ) : (
              <p className="helper-text">
                Indtast secret for at hente live-status. Panelet opdaterer automatisk
                hvert 2. sekund, når der er kontakt.
              </p>
            )}

            {statusMessage ? <p className="run-message">{statusMessage}</p> : null}
          </div>

          <div className="actions">
            <button
              type="submit"
              disabled={!secret.trim() || isRunning || isStarting}
            >
              {isStarting ? "Starter..." : isRunning ? "Job kører allerede" : "Start check"}
            </button>

            <button
              type="button"
              className="danger-button"
              onClick={() => {
                void handleCancel();
              }}
              disabled={!secret.trim() || !isRunning || isCancelling}
            >
              {isCancelling ? "Stopper..." : "Stop job"}
            </button>

            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void handleUnlock();
              }}
              disabled={!secret.trim() || !isRunning || isUnlocking}
            >
              {isUnlocking ? "Frigiver..." : "Nød-frigiv lås"}
            </button>

            <p className="helper-text">
              “Stop job” sender et cancel-signal, som processen tjekker mellem
              Spotify-kald. “Nød-frigiv lås” er kun til fastlåste jobs.
            </p>
          </div>
        </div>
      </form>

      {message ? <p className="run-message">{message}</p> : null}
    </section>
  );
}

function getApiError(
  payload: { error?: string } | RunStatusResponse | CheckResponse | null,
  status: number,
  fallback: string,
) {
  return payload && "error" in payload && payload.error
    ? payload.error
    : `${fallback} (${status}).`;
}

function getSummaryMessage(result: CheckResponse) {
  if (result.status === "ok") {
    return `Check færdigt: ${result.checkedPlaylists} playlister tjekket, ${result.skippedPlaylists} sprunget over og ${result.checkedTracks} tracks gennemgået.`;
  }

  if (result.status === "cancelled") {
    return result.errorMessage ?? "Kørslen blev stoppet manuelt.";
  }

  if (result.status === "skipped") {
    return result.errorMessage ?? "Kørslen blev sprunget over.";
  }

  return result.errorMessage ?? "Spotify-check fejlede.";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("da-DK", {
    dateStyle: "medium",
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
