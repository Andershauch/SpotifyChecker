"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type CheckResponse = {
  status: "ok" | "error" | "skipped";
  checkedTracks: number;
  unavailableCount: number;
  newUnavailableCount: number;
  checkedPlaylists: number;
  errorMessage: string | null;
};

type RunStatusResponse = {
  running: boolean;
  lock: {
    ownerId: string;
    startedAt: string;
    lockedUntil: string;
    expiresInSeconds: number;
  } | null;
};

export function RunCheckPanel() {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatusResponse | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);
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
          if (showErrors) {
            const errorMessage =
              payload && "error" in payload && payload.error
                ? payload.error
                : `Kunne ikke hente status (${response.status}).`;
            setStatusMessage(errorMessage);
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

    refreshStatus(true);
    const intervalId = window.setInterval(() => {
      void refreshStatus(false);
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [secret]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);

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
      const errorMessage =
        payload && "error" in payload && payload.error
          ? payload.error
          : `Kørslen fejlede med status ${response.status}.`;
      setMessage(errorMessage);
      return;
    }

    const result = payload as CheckResponse;
    const details =
      result.status === "ok"
        ? `Check færdigt: ${result.checkedPlaylists} playlister og ${result.checkedTracks} tracks tjekket.`
        : result.status === "skipped"
          ? result.errorMessage ?? "Et andet check kører allerede."
          : result.errorMessage ?? "Spotify-check fejlede.";

    setMessage(details);
    await refreshStatusNow();

    startTransition(() => {
      router.refresh();
    });
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
        const errorMessage =
          payload?.error ?? `Kunne ikke frigive låsen (${response.status}).`;
        setMessage(errorMessage);
        return;
      }

      setMessage(
        payload?.released
          ? "Låsen er frigivet. Du kan nu starte et nyt check."
          : "Der var ingen aktiv lås at frigive.",
      );
      await refreshStatusNow();

      startTransition(() => {
        router.refresh();
      });
    } finally {
      setIsUnlocking(false);
    }
  }

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
        const errorMessage =
          payload && "error" in payload && payload.error
            ? payload.error
            : `Kunne ikke hente status (${response.status}).`;
        setStatusMessage(errorMessage);
        return;
      }

      setRunStatus(payload as RunStatusResponse);
      setStatusMessage(null);
    } finally {
      setIsRefreshingStatus(false);
    }
  }

  const isRunning = runStatus?.running ?? false;

  return (
    <section className="card">
      <h2>Kontrolpanel</h2>
      <p>
        Start et manuelt Spotify-check, se om der kører et aktivt run, og frigiv
        en fastlåst kørsel direkte herfra.
      </p>

      <form className="run-form" onSubmit={handleSubmit}>
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
                {isRunning ? "Kører nu" : "Ingen aktiv kørsel"}
              </span>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void refreshStatusNow();
                }}
                disabled={isRefreshingStatus || secret.trim().length === 0}
              >
                {isRefreshingStatus ? "Opdaterer..." : "Opdater status"}
              </button>
            </div>

            {runStatus?.lock ? (
              <dl className="live-stats">
                <div>
                  <dt>Startet</dt>
                  <dd>{formatDateTime(runStatus.lock.startedAt)}</dd>
                </div>
                <div>
                  <dt>Låst til</dt>
                  <dd>{formatDateTime(runStatus.lock.lockedUntil)}</dd>
                </div>
                <div>
                  <dt>Udløber om</dt>
                  <dd>{formatSeconds(runStatus.lock.expiresInSeconds)}</dd>
                </div>
              </dl>
            ) : (
              <p className="helper-text">
                Indtast secret for at hente live-status. Panelet opdaterer derefter
                automatisk hvert 5. sekund.
              </p>
            )}

            {statusMessage ? <p className="run-message">{statusMessage}</p> : null}
          </div>

          <div className="actions">
            <button
              type="submit"
              disabled={isPending || secret.trim().length === 0 || isRunning}
            >
              {isPending ? "Starter..." : isRunning ? "Check kører allerede" : "Kør check nu"}
            </button>

            <button
              type="button"
              className="danger-button"
              onClick={() => {
                void handleUnlock();
              }}
              disabled={!isRunning || isUnlocking || secret.trim().length === 0}
            >
              {isUnlocking ? "Frigiver..." : "Frigiv lås"}
            </button>

            <p className="helper-text">
              “Frigiv lås” rydder en fastlåst status, men stopper ikke nødvendigvis en
              request, der allerede kører på serveren lige nu.
            </p>
          </div>
        </div>
      </form>

      {message ? <p className="run-message">{message}</p> : null}
    </section>
  );
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
