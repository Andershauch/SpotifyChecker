import {
  clearSpotifyAuthState,
  clearSpotifySessionState,
  getSpotifyAuthState,
  getSpotifySessionState,
  replaceOwnedPublicPlaylists,
  setSpotifyAuthState,
  setSpotifySessionState,
  type SpotifySessionState,
} from "@/lib/db";
import { getEnv } from "@/lib/env";

type SpotifyTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
};

type SpotifyPaging<T> = {
  items: T[];
  next: string | null;
};

type PlaylistItem = {
  id: string;
  name: string;
  owner: {
    id: string;
  };
  public: boolean | null;
  snapshot_id?: string;
  tracks?: {
    total?: number;
  };
};

type TrackEntry = {
  item: {
    id: string | null;
    name: string;
    artists?: Array<{
      name?: string;
    }>;
    duration_ms?: number;
    is_playable?: boolean;
    type?: string;
    restrictions?: {
      reason?: string;
    };
  } | null;
};

type TrackDetails = {
  id: string;
  name: string;
  duration_ms?: number;
  artists?: Array<{
    name?: string;
  }>;
  external_urls?: {
    spotify?: string;
  };
};

type SpotifySearchResponse = {
  tracks?: {
    items?: Array<{
      id: string;
      name: string;
      duration_ms?: number;
      external_urls?: {
        spotify?: string;
      };
      artists?: Array<{
        name?: string;
      }>;
    }>;
  };
};

type SpotifyTracksResponse = {
  tracks?: Array<
    | {
        id: string;
        artists?: Array<{
          name?: string;
        }>;
      }
    | null
  >;
};

type SpotifyAudioFeaturesResponse = {
  audio_features?: Array<
    | {
        id: string;
        tempo?: number | null;
      }
    | null
  >;
};

type SpotifyAudioFeature = {
  id: string;
  tempo?: number | null;
};

type CurrentSpotifyUserProfile = {
  id: string;
  display_name?: string | null;
};

export type SpotifyExecutionContext = {
  onCheckpoint?: () => Promise<void>;
  onTrackScanProgress?: (progress: {
    checkedInPlaylist: number;
    unavailableInPlaylist: number;
  }) => Promise<void>;
};

export type PlaylistSummary = {
  id: string;
  name: string;
  snapshotId: string | null;
  trackTotal: number | null;
};

export type TrackAvailability = {
  playlistId: string;
  playlistName: string;
  trackId: string;
  trackName: string;
  artistNames: string[];
  estimatedBpm: number | null;
  durationMs: number | null;
  unavailableReason: string;
};

export type PlaylistTrackSnapshot = {
  playlistId: string;
  playlistName: string;
  trackId: string;
  trackName: string;
  durationMs: number | null;
};

export type TrackSuggestionContext = {
  trackId: string;
  trackName: string;
  artistNames: string[];
  durationMs: number | null;
  spotifyUrl: string | null;
};

export type SpotifyTrackSearchMatch = {
  trackId: string;
  trackName: string;
  artistName: string | null;
  spotifyUrl: string | null;
  durationMs: number | null;
};

export type SpotifyConnectionStatus = {
  connected: boolean;
  spotifyUserId: string | null;
  displayName: string | null;
  connectedAt: string | null;
  expiresAt: string | null;
};

type SpotifyRequestError = Error & {
  status?: number;
  retryAfterSeconds?: number;
  url?: string;
  spotifyRateLimitUntil?: string;
};

const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000;
const SPOTIFY_MIN_REQUEST_INTERVAL_MS = 300;
const SPOTIFY_FETCH_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_SECONDS = 120;
const SPOTIFY_SCOPES = ["playlist-read-private", "playlist-read-collaborative"];

let inFlightAccessTokenPromise: Promise<string> | null = null;
let nextSpotifyRequestAt = 0;
let spotifyRequestThrottleQueue = Promise.resolve();

/** Returns whether a Spotify account is connected and the basic session metadata (user ID, name, token expiry). */
export async function getSpotifyConnectionStatus(): Promise<SpotifyConnectionStatus> {
  const session = await getSpotifySessionState();

  return {
    connected: Boolean(session),
    spotifyUserId: session?.spotifyUserId ?? null,
    displayName: session?.displayName ?? null,
    connectedAt: session?.connectedAt ?? null,
    expiresAt: session?.expiresAt ?? null,
  };
}

/** Generates a Spotify OAuth authorization URL and stores a CSRF state token in the database. Redirect the user to the returned URL to begin the login flow. */
export async function createSpotifyAuthorizationUrl() {
  const state = crypto.randomUUID();
  await setSpotifyAuthState({
    state,
    createdAt: new Date().toISOString(),
  });

  const params = new URLSearchParams({
    client_id: getEnv().SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: getEnv().SPOTIFY_REDIRECT_URI,
    state,
    scope: SPOTIFY_SCOPES.join(" "),
  });

  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

/** Validates the OAuth callback, exchanges the code for tokens, and persists the session. Throws if the CSRF state is invalid or the account belongs to a different Spotify user. */
export async function completeSpotifyAuthorization(input: {
  code: string;
  state: string;
}) {
  const savedState = await getSpotifyAuthState();
  if (!savedState || savedState.state !== input.state) {
    throw new Error("Spotify OAuth state mismatch. Please try connecting the account again.");
  }

  const tokenResponse = await requestSpotifyToken({
    grantType: "authorization_code",
    params: {
      code: input.code,
      redirect_uri: getEnv().SPOTIFY_REDIRECT_URI,
    },
  });

  const accessToken = tokenResponse.access_token;
  const refreshToken = tokenResponse.refresh_token;

  if (!refreshToken) {
    throw new Error("Spotify did not return a refresh token.");
  }

  const profile = await fetchCurrentSpotifyUserProfile(accessToken);
  const existingSession = await getSpotifySessionState();
  if (existingSession && existingSession.spotifyUserId !== profile.id) {
    throw new Error("This app is already connected to a different Spotify account.");
  }
  const session = buildSpotifySessionState(tokenResponse, refreshToken, profile);
  await setSpotifySessionState(session);
  await clearSpotifyAuthState();

  return {
    spotifyUserId: profile.id,
    displayName: profile.display_name ?? null,
  };
}

/** Deactivates all OAuth-managed playlists and removes the stored Spotify session, effectively disconnecting the account. */
export async function disconnectSpotifySession() {
  await replaceOwnedPublicPlaylists([]);
  await clearSpotifyAuthState();
  await clearSpotifySessionState();
}

async function getAccessToken() {
  if (inFlightAccessTokenPromise) {
    return inFlightAccessTokenPromise;
  }

  inFlightAccessTokenPromise = getValidSpotifyUserAccessToken();

  try {
    return await inFlightAccessTokenPromise;
  } finally {
    inFlightAccessTokenPromise = null;
  }
}

/** Returns a valid Spotify access token, automatically refreshing it if it is within 60 seconds of expiry. Concurrent callers share one in-flight refresh. */
export async function getSpotifyAccessToken() {
  return getAccessToken();
}

/** Fetches all public playlists owned by the connected Spotify user, syncs them to the database, and returns the list together with a fresh access token. */
export async function fetchOwnPublicPlaylists(context?: SpotifyExecutionContext) {
  const session = await getRequiredSpotifySession();
  const accessToken = await getAccessToken();
  const playlists = await fetchCurrentUserPublicPlaylists(
    accessToken,
    session.spotifyUserId,
    context,
  );

  // The database copy is intentionally minimal and acts as an operational
  // catalog for checkpoints/resume logic rather than a full Spotify cache.
  await replaceOwnedPublicPlaylists(
    playlists.map((playlist) => ({ playlistId: playlist.id })),
  );

  return { accessToken, playlists };
}

/** Paginates through all tracks in a playlist and returns those that are unavailable in the configured market, along with the total checked count and a snapshot of every track. */
export async function fetchUnavailableTracksForPlaylist(
  playlistId: string,
  playlistName: string,
  accessToken: string,
  context?: SpotifyExecutionContext,
): Promise<{
  unavailable: TrackAvailability[];
  checked: number;
  tracks: PlaylistTrackSnapshot[];
}> {
  // Spotify's nested `fields` filtering for playlist items has proven too
  // aggressive here and can collapse real items into `{}` objects. We therefore
  // fetch the normal item payload and only keep the minimal fields in memory.
  let url: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/items` +
    `?limit=100&market=${getEnv().SPOTIFY_MARKET}`;

  const unavailable: TrackAvailability[] = [];
  const tracks: PlaylistTrackSnapshot[] = [];
  let checked = 0;

  while (url) {
    const page: SpotifyPaging<TrackEntry> = await spotifyGet(url, accessToken, context);

    for (const item of page.items) {
      await context?.onCheckpoint?.();

      const track = item.item;
      if (!track?.id) {
        continue;
      }

      if (track.type !== "track") {
        continue;
      }

      checked += 1;
      tracks.push({
        playlistId,
        playlistName,
        trackId: track.id,
        trackName: track.name,
        durationMs: typeof track.duration_ms === "number" ? track.duration_ms : null,
      });

      const isUnavailableByPlayableFlag = track.is_playable === false;
      const isUnavailableByRestriction = track.restrictions?.reason === "market";

      if (!isUnavailableByPlayableFlag && !isUnavailableByRestriction) {
        continue;
      }

      unavailable.push({
        playlistId,
        playlistName,
        trackId: track.id,
        trackName: track.name,
        artistNames: (track.artists ?? [])
          .map((artist) => artist.name?.trim())
          .filter((value): value is string => Boolean(value)),
        estimatedBpm: null,
        durationMs: typeof track.duration_ms === "number" ? track.duration_ms : null,
        unavailableReason: track.restrictions?.reason ?? "not_playable",
      });
    }

    await context?.onTrackScanProgress?.({
      checkedInPlaylist: checked,
      unavailableInPlaylist: unavailable.length,
    });

    url = page.next;
  }

  return { unavailable, checked, tracks };
}

/** Fetches the full track details for a single Spotify track ID and returns the minimal context needed to generate a replacement suggestion. */
export async function fetchTrackSuggestionContext(
  trackId: string,
  context?: SpotifyExecutionContext,
): Promise<TrackSuggestionContext> {
  const accessToken = await getAccessToken();
  const details = await spotifyGet<TrackDetails>(
    `https://api.spotify.com/v1/tracks/${trackId}?market=${getEnv().SPOTIFY_MARKET}`,
    accessToken,
    context,
  );

  return {
    trackId: details.id,
    trackName: details.name,
    artistNames: (details.artists ?? [])
      .map((artist) => artist.name?.trim())
      .filter((value): value is string => Boolean(value)),
    durationMs: typeof details.duration_ms === "number" ? details.duration_ms : null,
    spotifyUrl: details.external_urls?.spotify ?? null,
  };
}

/** Searches Spotify for a track using one or more query strategies and returns the best-scoring match, or null if no acceptable result is found. */
export async function searchTrackOnSpotify(input: {
  trackName: string;
  artistName?: string | null;
  durationMs?: number | null;
  excludeTrackId?: string | null;
  requireExactTitle?: boolean;
  requireArtistMatch?: boolean;
  allowVersionTitleMatch?: boolean;
  maxDurationDifferenceMs?: number | null;
  limit?: number;
  useBroadFallback?: boolean;
  context?: SpotifyExecutionContext;
}): Promise<SpotifyTrackSearchMatch | null> {
  const accessToken = await getAccessToken();
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
  const queries = buildTrackSearchQueries(input);

  for (const query of queries) {
    const url =
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}` +
      `&type=track&limit=${limit}&market=${getEnv().SPOTIFY_MARKET}`;

    const response = await spotifyGet<SpotifySearchResponse>(url, accessToken, input.context);
    const items = (response.tracks?.items ?? []).filter((item) => isAcceptableTrackSearchMatch(item, input));
    if (items.length === 0) {
      continue;
    }

    const best = [...items].sort((left, right) => {
      const leftScore = getSearchMatchScore(left, input);
      const rightScore = getSearchMatchScore(right, input);
      return rightScore - leftScore;
    })[0];

    return {
      trackId: best.id,
      trackName: best.name,
      artistName: best.artists?.[0]?.name?.trim() ?? null,
      spotifyUrl: best.external_urls?.spotify ?? null,
      durationMs: typeof best.duration_ms === "number" ? best.duration_ms : null,
    };
  }

  return null;
}

/** Fetches the primary artist name for each supplied track ID (max 50) and returns a map of trackId → artistName. Automatically splits batches on 403 errors. */
export async function fetchTrackPrimaryArtists(
  trackIds: string[],
  context?: SpotifyExecutionContext,
) {
  const uniqueTrackIds = [...new Set(trackIds.filter(Boolean))].slice(0, 50);
  if (uniqueTrackIds.length === 0) {
    return new Map<string, string>();
  }

  const artistMap = new Map<string, string>();
  const accessToken = await getAccessToken();
  await collectTrackPrimaryArtists(uniqueTrackIds, accessToken, artistMap, context);
  return artistMap;
}

/** Fetches audio-features BPM values for the supplied track IDs in batches of 100 and returns a map of trackId → rounded BPM. Automatically splits batches on 403 errors. */
export async function fetchTrackEstimatedBpms(
  trackIds: string[],
  context?: SpotifyExecutionContext,
) {
  const uniqueTrackIds = [...new Set(trackIds.filter(Boolean))];
  if (uniqueTrackIds.length === 0) {
    return new Map<string, number>();
  }

  const bpmMap = new Map<string, number>();
  const accessToken = await getAccessToken();
  for (let index = 0; index < uniqueTrackIds.length; index += 100) {
    await collectTrackEstimatedBpms(
      uniqueTrackIds.slice(index, index + 100),
      accessToken,
      bpmMap,
      context,
    );
  }
  return bpmMap;
}

async function collectTrackPrimaryArtists(
  trackIds: string[],
  accessToken: string,
  artistMap: Map<string, string>,
  context?: SpotifyExecutionContext,
): Promise<void> {
  if (trackIds.length === 0) {
    return;
  }

  try {
    const response = await spotifyGet<SpotifyTracksResponse>(
      `https://api.spotify.com/v1/tracks?ids=${encodeURIComponent(trackIds.join(","))}` +
        `&market=${getEnv().SPOTIFY_MARKET}`,
      accessToken,
      context,
    );

    for (const track of response.tracks ?? []) {
      const primaryArtistName = track?.artists?.[0]?.name?.trim();
      if (!track?.id || !primaryArtistName) {
        continue;
      }

      artistMap.set(track.id, primaryArtistName);
    }
  } catch (error) {
    const status = getStatusFromError(error);
    if (status !== 403) {
      throw error;
    }

    if (trackIds.length === 1) {
      await collectSingleTrackPrimaryArtist(trackIds[0], accessToken, artistMap, context);
      return;
    }

    const midpoint = Math.ceil(trackIds.length / 2);
    await collectTrackPrimaryArtists(trackIds.slice(0, midpoint), accessToken, artistMap, context);
    await collectTrackPrimaryArtists(trackIds.slice(midpoint), accessToken, artistMap, context);
  }
}

async function collectTrackEstimatedBpms(
  trackIds: string[],
  accessToken: string,
  bpmMap: Map<string, number>,
  context?: SpotifyExecutionContext,
): Promise<void> {
  if (trackIds.length === 0) {
    return;
  }

  try {
    const response = await spotifyGet<SpotifyAudioFeaturesResponse>(
      `https://api.spotify.com/v1/audio-features?ids=${encodeURIComponent(trackIds.join(","))}`,
      accessToken,
      context,
    );

    for (const track of response.audio_features ?? []) {
      const normalizedTempo = normalizeSpotifyTempo(track?.tempo);
      if (!track?.id || normalizedTempo === null) {
        continue;
      }

      bpmMap.set(track.id, normalizedTempo);
    }
  } catch (error) {
    const status = getStatusFromError(error);
    if (status !== 403) {
      throw error;
    }

    if (trackIds.length === 1) {
      await collectSingleTrackEstimatedBpm(trackIds[0], accessToken, bpmMap, context);
      return;
    }

    const midpoint = Math.ceil(trackIds.length / 2);
    await collectTrackEstimatedBpms(trackIds.slice(0, midpoint), accessToken, bpmMap, context);
    await collectTrackEstimatedBpms(trackIds.slice(midpoint), accessToken, bpmMap, context);
  }
}

async function collectSingleTrackEstimatedBpm(
  trackId: string,
  accessToken: string,
  bpmMap: Map<string, number>,
  context?: SpotifyExecutionContext,
) {
  try {
    const track = await spotifyGet<SpotifyAudioFeature>(
      `https://api.spotify.com/v1/audio-features/${trackId}`,
      accessToken,
      context,
    );
    const normalizedTempo = normalizeSpotifyTempo(track.tempo);
    if (normalizedTempo !== null) {
      bpmMap.set(track.id, normalizedTempo);
    }
  } catch (error) {
    console.warn(
      `[Spotify] Skipping BPM lookup for track ${trackId} after single-track fallback error: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}

function normalizeSpotifyTempo(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value);
}

async function collectSingleTrackPrimaryArtist(
  trackId: string,
  accessToken: string,
  artistMap: Map<string, string>,
  context?: SpotifyExecutionContext,
) {
  try {
    const track = await spotifyGet<TrackDetails>(
      `https://api.spotify.com/v1/tracks/${trackId}?market=${getEnv().SPOTIFY_MARKET}`,
      accessToken,
      context,
    );
    const primaryArtistName = track.artists?.[0]?.name?.trim();
    if (primaryArtistName) {
      artistMap.set(track.id, primaryArtistName);
    }
  } catch (error) {
    console.warn(
      `[Spotify] Skipping artist backfill for track ${trackId} after single-track fallback error: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}

async function getRequiredSpotifySession() {
  const session = await getSpotifySessionState();

  if (!session) {
    throw new Error("Spotify is not connected. Please log in with Spotify first.");
  }

  return session;
}

async function getValidSpotifyUserAccessToken() {
  const session = await getRequiredSpotifySession();
  const expiresAt = new Date(session.expiresAt).getTime();

  if (expiresAt - ACCESS_TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    return session.accessToken;
  }

  // Access tokens are refreshed server-side so the UI never needs the client
  // secret or raw refresh token.
  const tokenResponse = await requestSpotifyToken({
    grantType: "refresh_token",
    params: {
      refresh_token: session.refreshToken,
    },
  });

  const nextSession: SpotifySessionState = {
    ...session,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? session.refreshToken,
    expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString(),
    scope: tokenResponse.scope ?? session.scope,
  };

  await setSpotifySessionState(nextSession);
  return nextSession.accessToken;
}

async function requestSpotifyToken(input: {
  grantType: "authorization_code" | "refresh_token";
  params: Record<string, string>;
}) {
  const encodedCredentials = Buffer.from(
    `${getEnv().SPOTIFY_CLIENT_ID}:${getEnv().SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");

  const body = new URLSearchParams({
    grant_type: input.grantType,
    ...input.params,
  });

  const response = await fetchWithTimeout("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodedCredentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorDetails = await readSpotifyErrorDetails(response);
    throw new Error(
      `Spotify token request failed: ${response.status}${errorDetails ? ` ${errorDetails}` : ""}`,
    );
  }

  return (await response.json()) as SpotifyTokenResponse;
}

async function fetchCurrentSpotifyUserProfile(accessToken: string) {
  return spotifyGet<CurrentSpotifyUserProfile>(
    "https://api.spotify.com/v1/me?fields=id,display_name",
    accessToken,
  );
}

async function fetchCurrentUserPublicPlaylists(
  accessToken: string,
  spotifyUserId: string,
  context?: SpotifyExecutionContext,
) {
  const playlistMap = new Map<string, PlaylistSummary>();
  // /me/playlists is the user-safe replacement for older user-playlist lookup
  // flows and keeps us inside Spotify's current development-mode constraints.
  let url: string | null =
    "https://api.spotify.com/v1/me/playlists?limit=50&fields=items(id,name,owner(id),public,snapshot_id,tracks(total)),next";

  while (url) {
    const page: SpotifyPaging<PlaylistItem> = await spotifyGet(url, accessToken, context);

    for (const playlist of page.items) {
      if (playlist.owner.id !== spotifyUserId || playlist.public !== true) {
        continue;
      }

      playlistMap.set(playlist.id, {
        id: playlist.id,
        name: playlist.name,
        snapshotId: playlist.snapshot_id ?? null,
        trackTotal: playlist.tracks?.total ?? null,
      });
    }

    url = page.next;
  }

  return [...playlistMap.values()];
}

function buildSpotifySessionState(
  tokenResponse: SpotifyTokenResponse,
  refreshToken: string,
  profile: CurrentSpotifyUserProfile,
): SpotifySessionState {
  return {
    accessToken: tokenResponse.access_token,
    refreshToken,
    expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString(),
    scope: tokenResponse.scope ?? "",
    spotifyUserId: profile.id,
    displayName: profile.display_name ?? null,
    connectedAt: new Date().toISOString(),
  };
}

async function spotifyGet<T>(
  url: string,
  accessToken: string,
  context?: SpotifyExecutionContext,
): Promise<T> {
  return withRetry(
    async () => {
      await context?.onCheckpoint?.();
      await waitForSpotifyRequestWindow(context);

      const response = await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        cache: "no-store",
      });

      if (!response.ok) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "0");
        const error = new Error(
          formatSpotifyErrorMessage(response.status, url, retryAfter),
        ) as SpotifyRequestError;
        error.status = response.status;
        error.retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : 0;
        error.url = url;
        if (response.status === 429 && error.retryAfterSeconds > 0) {
          error.spotifyRateLimitUntil = new Date(
            Date.now() + error.retryAfterSeconds * 1000,
          ).toISOString();
        }
        throw error;
      }

      return (await response.json()) as T;
    },
    context,
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  context?: SpotifyExecutionContext,
  attempts = 4,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = getStatusFromError(error);
      const shouldRetry =
        attempt < attempts && (status === 429 || (status !== null && status >= 500));

      if (!shouldRetry) {
        throw error;
      }

      const retryAfterSeconds = getRetryAfterSecondsFromError(error);
      if (status === 429 && retryAfterSeconds > MAX_RETRY_AFTER_SECONDS) {
        const rateLimitError = new Error(
          `Spotify rate limit is active for ${retryAfterSeconds} seconds. Stopping the job rather than waiting that long.`,
        ) as SpotifyRequestError;
        rateLimitError.status = 429;
        rateLimitError.retryAfterSeconds = retryAfterSeconds;
        rateLimitError.url = getUrlFromError(error);
        rateLimitError.spotifyRateLimitUntil = new Date(
          Date.now() + retryAfterSeconds * 1000,
        ).toISOString();
        throw rateLimitError;
      }

      const exponentialBackoffMs = 750 * 2 ** (attempt - 1);
      const retryAfterMs = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
      const jitterMs = Math.floor(Math.random() * 250);
      const delayMs = Math.max(exponentialBackoffMs, retryAfterMs) + jitterMs;

      console.warn(
        `[Spotify] Request failed with status ${status} on attempt ${attempt}/${attempts}. Retrying in ${delayMs}ms.${formatRetryLogSuffix(error, retryAfterSeconds)}`,
      );

      await wait(delayMs, context);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Spotify retry failed");
}

function getStatusFromError(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return null;
}

function getRetryAfterSecondsFromError(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "retryAfterSeconds" in error &&
    typeof (error as { retryAfterSeconds?: unknown }).retryAfterSeconds === "number"
  ) {
    return (error as { retryAfterSeconds: number }).retryAfterSeconds;
  }
  return 0;
}

function getUrlFromError(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "url" in error &&
    typeof (error as { url?: unknown }).url === "string"
  ) {
    return (error as { url: string }).url;
  }

  return undefined;
}

/** Extracts a structured cooldown descriptor from a Spotify 429 error. Returns null for any other error type. */
export function getSpotifyCooldownFromError(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 429 &&
    "retryAfterSeconds" in error &&
    typeof (error as { retryAfterSeconds?: unknown }).retryAfterSeconds === "number" &&
    "spotifyRateLimitUntil" in error &&
    typeof (error as { spotifyRateLimitUntil?: unknown }).spotifyRateLimitUntil === "string"
  ) {
    return {
      retryAfterSeconds: (error as SpotifyRequestError).retryAfterSeconds ?? 0,
      until: (error as SpotifyRequestError).spotifyRateLimitUntil ?? "",
      message: error instanceof Error ? error.message : "Spotify rate limit",
    };
  }

  return null;
}

function formatSpotifyErrorMessage(status: number, url: string, retryAfterSeconds: number) {
  if (status === 429 && retryAfterSeconds > 0) {
    return `Spotify API request failed: ${status} (${url}) retry-after=${retryAfterSeconds}s`;
  }

  return `Spotify API request failed: ${status} (${url})`;
}

/** Scores a Spotify search result candidate (0–220) based on track name match (0/60/100), artist match (0/40/80), and duration proximity (0–40). Higher is better. */
export function getSearchMatchScore(
  candidate: {
    name: string;
    duration_ms?: number;
    artists?: Array<{ name?: string }>;
  },
  input: {
    trackName: string;
    artistName?: string | null;
    durationMs?: number | null;
  },
) {
  let score = 0;
  const candidateName = candidate.name.toLowerCase();
  const requestedName = input.trackName.toLowerCase();

  if (candidateName === requestedName) {
    score += 100;
  } else if (candidateName.includes(requestedName) || requestedName.includes(candidateName)) {
    score += 60;
  }

  const candidateArtist = candidate.artists?.[0]?.name?.toLowerCase() ?? "";
  const requestedArtist = input.artistName?.toLowerCase() ?? "";
  if (requestedArtist && candidateArtist === requestedArtist) {
    score += 80;
  } else if (requestedArtist && candidateArtist.includes(requestedArtist)) {
    score += 40;
  }

  if (typeof input.durationMs === "number" && typeof candidate.duration_ms === "number") {
    const diff = Math.abs(candidate.duration_ms - input.durationMs);
    score += Math.max(0, 40 - Math.floor(diff / 1000));
  }

  return score;
}

/** Builds an ordered list of Spotify search query strings for a track. Starts with a precise `track:`/`artist:` field query and optionally appends broader plain-text fallbacks and base-title variants. */
export function buildTrackSearchQueries(input: {
  trackName: string;
  artistName?: string | null;
  useBroadFallback?: boolean;
  allowVersionTitleMatch?: boolean;
}) {
  const fieldQueryParts = [`track:${input.trackName}`];
  if (input.artistName) {
    fieldQueryParts.push(`artist:${input.artistName}`);
  }

  const queries = [fieldQueryParts.join(" ")];
  if (input.useBroadFallback) {
    const plainQueryParts = [input.trackName, input.artistName].filter(Boolean);
    queries.push(plainQueryParts.join(" "));
    queries.push(input.trackName);

    if (input.allowVersionTitleMatch) {
      const baseTrackName = getBaseTrackTitle(normalizeSearchText(input.trackName));
      if (baseTrackName && baseTrackName !== normalizeSearchText(input.trackName)) {
        const baseFieldQueryParts = [`track:${baseTrackName}`];
        if (input.artistName) {
          baseFieldQueryParts.push(`artist:${input.artistName}`);
        }

        const basePlainQueryParts = [baseTrackName, input.artistName].filter(Boolean);
        queries.push(baseFieldQueryParts.join(" "));
        queries.push(basePlainQueryParts.join(" "));
        queries.push(baseTrackName);
      }
    }
  }

  return [...new Set(queries.filter((query) => query.trim().length > 0))];
}

/** Returns true if a Spotify search result item passes all the supplied filter constraints (excluded ID, exact title, artist match, duration window). */
export function isAcceptableTrackSearchMatch(
  item: {
    id: string;
    name: string;
    duration_ms?: number;
    artists?: Array<{ name?: string }>;
  },
  input: {
    trackName: string;
    artistName?: string | null;
    durationMs?: number | null;
    excludeTrackId?: string | null;
    requireExactTitle?: boolean;
    requireArtistMatch?: boolean;
    allowVersionTitleMatch?: boolean;
    maxDurationDifferenceMs?: number | null;
  },
) {
  if (input.excludeTrackId && item.id === input.excludeTrackId) {
    return false;
  }

  if (
    input.requireExactTitle &&
    !isMatchingTrackTitle(item.name, input.trackName, Boolean(input.allowVersionTitleMatch))
  ) {
    return false;
  }

  if (input.requireArtistMatch && !isMatchingArtist(item.artists ?? [], input.artistName ?? null)) {
    return false;
  }

  if (
    typeof input.maxDurationDifferenceMs === "number" &&
    typeof input.durationMs === "number" &&
    typeof item.duration_ms === "number" &&
    Math.abs(item.duration_ms - input.durationMs) > input.maxDurationDifferenceMs
  ) {
    return false;
  }

  return true;
}

/** Returns true when at least one candidate artist matches the requested artist name, accounting for collaborations, featured artists, and token-split variants. Always returns true when no artist is requested. */
export function isMatchingArtist(
  candidateArtists: Array<{ name?: string }>,
  requestedArtist: string | null,
) {
  const normalizedRequested = normalizeArtistText(requestedArtist);
  if (!normalizedRequested) {
    return true;
  }

  const requestedTokens = getArtistSearchTokens(normalizedRequested);
  if (requestedTokens.length === 0) {
    return true;
  }

  return candidateArtists.some((artist) => {
    const normalizedCandidate = normalizeArtistText(artist.name);
    if (!normalizedCandidate) {
      return false;
    }

    if (
      normalizedCandidate === normalizedRequested ||
      normalizedCandidate.includes(normalizedRequested) ||
      normalizedRequested.includes(normalizedCandidate)
    ) {
      return true;
    }

    const candidateTokens = getArtistSearchTokens(normalizedCandidate);
    return requestedTokens.some((token) => candidateTokens.includes(token));
  });
}

/** Returns true if the candidate and requested titles refer to the same track. When `allowVersionMatch` is true, "Song (Radio Edit)" matches "Song (Remix)" by comparing stripped base titles. */
export function isMatchingTrackTitle(candidateTitle: string, requestedTitle: string, allowVersionMatch: boolean) {
  const normalizedCandidate = normalizeSearchText(candidateTitle);
  const normalizedRequested = normalizeSearchText(requestedTitle);
  if (normalizedCandidate === normalizedRequested) {
    return true;
  }

  if (!allowVersionMatch) {
    return false;
  }

  return getBaseTrackTitle(normalizedCandidate) === getBaseTrackTitle(normalizedRequested);
}

/** Strips common version/edition suffixes (remix, remaster, radio edit, year, deluxe, etc.) from a pre-normalized track title, leaving just the core name. */
export function getBaseTrackTitle(normalizedTitle: string) {
  return normalizedTitle
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(
      /\b(digital|remaster|remastered|remix|mix|version|edit|radio|single|album|original|mono|stereo|deluxe|expanded|anniversary|edition|explicit|clean)\b/g,
      " ",
    )
    .trim()
    .replace(/\s+/g, " ");
}

/** Lowercases, strips diacritics, removes non-alphanumeric characters, and collapses whitespace — producing a canonical form suitable for comparison and search queries. */
export function normalizeSearchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Normalizes an artist name by stripping featured-artist suffixes (feat./ft.) before applying `normalizeSearchText`. Returns an empty string for null/undefined. */
export function normalizeArtistText(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  return normalizeSearchText(value)
    .replace(/\bfeat\b.*$/g, " ")
    .replace(/\bft\b.*$/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Splits a normalized artist string on common collaboration separators (&, and, comma, x) and returns the individual artist name tokens. */
export function getArtistSearchTokens(normalizedArtist: string) {
  return normalizedArtist
    .split(/\band\b|&|,|\bx\b/gi)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function formatRetryLogSuffix(error: unknown, retryAfterSeconds: number) {
  const retryAfter =
    retryAfterSeconds > 0 ? ` Retry-After: ${retryAfterSeconds}s.` : "";
  const url =
    typeof error === "object" &&
    error !== null &&
    "url" in error &&
    typeof (error as { url?: unknown }).url === "string"
      ? ` URL: ${(error as { url: string }).url}`
      : "";

  return `${retryAfter}${url}`;
}

async function fetchWithTimeout(input: string, init: RequestInit) {
  try {
    return await fetch(input, {
      ...init,
      signal: AbortSignal.timeout(SPOTIFY_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      const timeoutError = new Error(
        `Spotify request timed out after ${SPOTIFY_FETCH_TIMEOUT_MS}ms (${input})`,
      ) as SpotifyRequestError;
      timeoutError.status = 504;
      timeoutError.retryAfterSeconds = 0;
      timeoutError.url = input;
      throw timeoutError;
    }

    throw error;
  }
}

async function readSpotifyErrorDetails(response: Response) {
  try {
    const text = await response.text();
    return text ? `(${text})` : "";
  } catch {
    return "";
  }
}

async function wait(ms: number, context?: SpotifyExecutionContext) {
  const sliceMs = 500;
  let remaining = ms;

  while (remaining > 0) {
    await context?.onCheckpoint?.();
    const currentDelay = Math.min(sliceMs, remaining);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, currentDelay);
    });
    remaining -= currentDelay;
  }
}

async function waitForSpotifyRequestWindow(context?: SpotifyExecutionContext) {
  const previous = spotifyRequestThrottleQueue;
  let releaseQueue!: () => void;

  spotifyRequestThrottleQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });

  await previous;
  await context?.onCheckpoint?.();

  const waitMs = Math.max(0, nextSpotifyRequestAt - Date.now());
  if (waitMs > 0) {
    await wait(waitMs, context);
  }

  nextSpotifyRequestAt = Date.now() + SPOTIFY_MIN_REQUEST_INTERVAL_MS;
  releaseQueue();
}
