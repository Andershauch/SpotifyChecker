import type {
  CheckRequestResponse,
  DashboardTab,
  PanelState,
  RunStatusResponse,
  SmokeCheckResponse,
  UnavailablePlaylistGroup,
} from "./types";

export function getApiError(payload: unknown, status: number, fallback: string): string {
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

export async function requestApi<T>(input: string, init?: RequestInit) {
  const response = await fetch(input, init);
  let payload: T | { error?: string } | null = null;

  try {
    payload = (await response.json()) as T | { error?: string };
  } catch {
    payload = null;
  }

  return { response, payload };
}

export function getQueueSummaryMessage(result: CheckRequestResponse, label = "Check"): string {
  if (result.status === "queued") {
    return result.jobId
      ? `${label} sat i kø som job ${result.jobId}. Panelet opdaterer status automatisk.`
      : `${label} sat i kø. Panelet opdaterer status automatisk.`;
  }

  return result.errorMessage ?? "Et andet check kører allerede.";
}

export function getPanelState(input: {
  spotifyConnected: boolean;
  isRunning: boolean;
  hasCooldown: boolean;
}): PanelState {
  if (!input.spotifyConnected) return "disconnected";
  if (input.hasCooldown) return "cooldown";
  if (input.isRunning) return "running";
  return "ready";
}

export function getTabLabel(tab: DashboardTab): string {
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

export function getPanelSummary(
  panelState: PanelState,
  cooldown: RunStatusResponse["cooldown"],
): string {
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

export function getRunPillClass(panelState: PanelState): string {
  switch (panelState) {
    case "running":
      return "pill pill-running";
    case "cooldown":
      return "pill pill-warning";
    case "ready":
      return "pill pill-ready";
    default:
      return "pill pill-idle";
  }
}

export function getRunPillText(panelState: PanelState): string {
  switch (panelState) {
    case "running":
      return "Aktivt job kører";
    case "cooldown":
      return "Spotify cooldown aktiv";
    case "ready":
      return "Klar til ny kørsel";
    default:
      return "Ingen aktiv kørsel";
  }
}

export function getSmokeSummaryMessage(result: SmokeCheckResponse): string {
  if (result.status === "ok") {
    return `Smoke test OK: playlisten "${result.playlistName ?? result.playlistId}" svarede fra database-kataloget${result.snapshotId ? ` med snapshot ${result.snapshotId}` : ""}.`;
  }

  if (result.status === "skipped") {
    return result.errorMessage ?? "Smoke testen blev sprunget over.";
  }

  return result.errorMessage ?? "Spotify smoke test fejlede.";
}

export function formatPlaylistTrackSummary(playlist: UnavailablePlaylistGroup): string {
  const count = playlist.trackCount;
  if (count === 0) return "Ingen utilgængelige tracks";
  return `${count} utilgængeligt track${count === 1 ? "" : "s"}`;
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("da-DK", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("da-DK", {
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatSeconds(value: number): string {
  if (value < 60) return `${value} sek`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes}m ${seconds}s`;
}

export function formatJobStatus(status: string): string {
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

export function formatDuration(durationMs: number | null): string | null {
  if (!durationMs || durationMs < 0) return null;
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
