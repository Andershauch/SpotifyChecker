import { getEnv } from "@/lib/env";

type SpotifyAccessTokenResponse = {
  access_token: string;
  expires_in: number;
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
  track: {
    id: string | null;
    name: string;
    is_playable?: boolean;
    restrictions?: {
      reason?: string;
    };
    external_urls?: {
      spotify?: string;
    };
    artists: Array<{ name: string }>;
  } | null;
};

export type SpotifyExecutionContext = {
  onCheckpoint?: () => Promise<void>;
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
  artists: string;
  trackUrl: string | null;
  unavailableReason: string;
};

const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000;
const SPOTIFY_MIN_REQUEST_INTERVAL_MS = 300;
const SPOTIFY_FETCH_TIMEOUT_MS = 15_000;

let cachedAccessToken:
  | {
      token: string;
      expiresAt: number;
    }
  | null = null;
let inFlightAccessTokenPromise: Promise<string> | null = null;
let nextSpotifyRequestAt = 0;
let spotifyRequestThrottleQueue = Promise.resolve();

function parsePlaylistIdsFromEnv() {
  return getEnv()
    .SPOTIFY_PLAYLIST_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

async function getAccessToken() {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) {
    return cachedAccessToken.token;
  }

  if (inFlightAccessTokenPromise) {
    return inFlightAccessTokenPromise;
  }

  inFlightAccessTokenPromise = requestAccessToken();

  try {
    return await inFlightAccessTokenPromise;
  } finally {
    inFlightAccessTokenPromise = null;
  }
}

async function requestAccessToken() {
  const encodedCredentials = Buffer.from(
    `${getEnv().SPOTIFY_CLIENT_ID}:${getEnv().SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");

  const response = await fetchWithTimeout("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodedCredentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Spotify token request failed: ${response.status}`);
  }

  const payload = (await response.json()) as SpotifyAccessTokenResponse;
  cachedAccessToken = {
    token: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000 - ACCESS_TOKEN_REFRESH_BUFFER_MS,
  };

  return payload.access_token;
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
        ) as Error & {
          status?: number;
          retryAfterSeconds?: number;
          url?: string;
        };
        error.status = response.status;
        error.retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : 0;
        error.url = url;
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

function formatSpotifyErrorMessage(status: number, url: string, retryAfterSeconds: number) {
  if (status === 429 && retryAfterSeconds > 0) {
    return `Spotify API request failed: ${status} (${url}) retry-after=${retryAfterSeconds}s`;
  }

  return `Spotify API request failed: ${status} (${url})`;
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
      ) as Error & { status?: number; retryAfterSeconds?: number; url?: string };
      timeoutError.status = 504;
      timeoutError.retryAfterSeconds = 0;
      timeoutError.url = input;
      throw timeoutError;
    }

    throw error;
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

export async function fetchOwnPublicPlaylists(context?: SpotifyExecutionContext) {
  const accessToken = await getAccessToken();
  const explicitPlaylistIds = parsePlaylistIdsFromEnv();

  if (explicitPlaylistIds.length > 0) {
    const playlists: PlaylistSummary[] = [];

    for (const playlistId of explicitPlaylistIds) {
      const playlist = await spotifyGet<PlaylistItem>(
        `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}?fields=id,name,owner(id),public,snapshot_id,tracks(total)`,
        accessToken,
        context,
      );

      playlists.push({
        id: playlist.id,
        name: playlist.name,
        snapshotId: playlist.snapshot_id ?? null,
        trackTotal: playlist.tracks?.total ?? null,
      });
    }

    return { accessToken, playlists };
  }

  if (!getEnv().SPOTIFY_USER_ID) {
    throw new Error(
      "Set either SPOTIFY_PLAYLIST_IDS or SPOTIFY_USER_ID in environment variables.",
    );
  }

  const playlistMap = new Map<string, PlaylistSummary>();
  let url: string | null =
    `https://api.spotify.com/v1/users/${encodeURIComponent(getEnv().SPOTIFY_USER_ID)}/playlists` +
    "?limit=50&fields=items(id,name,owner(id),public,snapshot_id,tracks(total)),next";

  try {
    while (url) {
      const page: SpotifyPaging<PlaylistItem> = await spotifyGet(url, accessToken, context);

      for (const playlist of page.items) {
        if (playlist.owner.id === getEnv().SPOTIFY_USER_ID && playlist.public === true) {
          playlistMap.set(playlist.id, {
            id: playlist.id,
            name: playlist.name,
            snapshotId: playlist.snapshot_id ?? null,
            trackTotal: playlist.tracks?.total ?? null,
          });
        }
      }

      url = page.next;
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error as { status?: number }).status === 403
    ) {
      throw new Error(
        "Spotify afviser playlist-opslag via SPOTIFY_USER_ID. Sæt SPOTIFY_PLAYLIST_IDS med en eller flere konkrete playlist IDs i stedet.",
      );
    }

    throw error;
  }

  return { accessToken, playlists: [...playlistMap.values()] };
}

export async function fetchUnavailableTracksForPlaylist(
  playlistId: string,
  playlistName: string,
  accessToken: string,
  context?: SpotifyExecutionContext,
): Promise<{ unavailable: TrackAvailability[]; checked: number }> {
  let url: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks` +
    `?limit=100&market=${getEnv().SPOTIFY_MARKET}` +
    "&fields=items(track(id,name,is_playable,restrictions(reason),external_urls(spotify),artists(name))),next";

  const unavailable: TrackAvailability[] = [];
  let checked = 0;

  while (url) {
    const page: SpotifyPaging<TrackEntry> = await spotifyGet(url, accessToken, context);

    for (const item of page.items) {
      await context?.onCheckpoint?.();

      const track = item.track;
      if (!track?.id) {
        continue;
      }

      checked += 1;

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
        artists: track.artists.map((artist) => artist.name).join(", "),
        trackUrl: track.external_urls?.spotify ?? null,
        unavailableReason: track.restrictions?.reason ?? "not_playable",
      });
    }

    url = page.next;
  }

  return { unavailable, checked };
}
