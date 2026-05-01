"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type CheckResponse = {
  status: "ok" | "error" | "skipped";
  checkedTracks: number;
  unavailableCount: number;
  newUnavailableCount: number;
  checkedPlaylists: number;
  errorMessage: string | null;
};

export function RunCheckPanel() {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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

    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <section className="card">
      <h2>Kør Nu</h2>
      <p>
        Start et manuelt Spotify-check direkte herfra. Indsæt samme
        `CRON_SECRET`, som appen bruger til API-kald.
      </p>

      <form className="run-form" onSubmit={handleSubmit}>
        <label className="field">
          <span>CRON_SECRET</span>
          <input
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder="Indsæt secret"
            autoComplete="current-password"
            required
          />
        </label>

        <button type="submit" disabled={isPending || secret.trim().length === 0}>
          {isPending ? "Opdaterer..." : "Kør check nu"}
        </button>
      </form>

      {message ? <p className="run-message">{message}</p> : null}
    </section>
  );
}
