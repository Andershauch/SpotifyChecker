export type CheckRequestResponse = {
  accepted: boolean;
  jobId: string | null;
  status: "queued" | "already_running";
  errorMessage: string | null;
};

export type SmokeCheckResponse = {
  status: "ok" | "error" | "skipped";
  playlistId: string | null;
  playlistName: string | null;
  snapshotId: string | null;
  source: "database" | null;
  errorMessage: string | null;
};

export type ArtistBackfillResponse = {
  updatedFromReplacements: number;
  spotifyBatchSize: number;
  updatedFromSpotify: number;
  remainingMissingArtists: number;
  skippedSpotifyDueToCooldown: boolean;
  message: string;
};

export type JobSnapshot = {
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

export type RunStatusResponse = {
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

export type UnavailablePlaylistGroup = {
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

export type UnavailableResponse = {
  playlists: UnavailablePlaylistGroup[];
  totalPlaylists: number;
  totalTracks: number;
};

export type DashboardTab = "overview" | "findings" | "actions" | "settings";

export type PanelState = "disconnected" | "cooldown" | "running" | "ready";

export type PrimaryStat = {
  label: string;
  value: string;
  tone: "hero" | "danger" | "default";
};

export type TimingStat = {
  label: string;
  value: string;
};
