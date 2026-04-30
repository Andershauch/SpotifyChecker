import { getEnv } from "@/lib/env";

type SpotifyAccessTokenResponse = {
  access_token: string;
  token_type: string;
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

export type TrackAvailability = {
  playlistId: string;
  playlistName: string;
  trackId: string;
  trackName: string;
  artists: string;
  trackUrl: string | null;
  unavailableReason: string;
};

function parsePlaylistIdsFromEnv() {
  return getEnv()
    .SPOTIFY_PLAYLIST_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

async function getAccessToken() {
  const encodedCredentials = Buffer.from(
    `${getEnv().SPOTIFY_CLIENT_ID}:${getEnv().SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");

  const response = await fetch("https://accounts.spotify.com/api/token", {
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
  return payload.access_token;
}

async function spotifyGet<T>(url: string, accessToken: string): Promise<T> {
  return withRetry(async () => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      const error = new Error(`Spotify API request failed: ${response.status} (${url})`) as Error & {
        status?: number;
        retryAfterSeconds?: number;
      };
      error.status = response.status;
      error.retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : 0;
      throw error;
    }

    return (await response.json()) as T;
  });
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
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

      await wait(delayMs);
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

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function fetchOwnPublicPlaylists() {
  const accessToken = await getAccessToken();
  const explicitPlaylistIds = parsePlaylistIdsFromEnv();

  if (explicitPlaylistIds.length > 0) {
    const playlists: PlaylistItem[] = [];

    for (const playlistId of explicitPlaylistIds) {
      const playlist = await spotifyGet<PlaylistItem>(
        `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`,
        accessToken,
      );
      playlists.push(playlist);
    }

    return { accessToken, playlists };
  }

  if (!getEnv().SPOTIFY_USER_ID) {
    throw new Error(
      "Set either SPOTIFY_PLAYLIST_IDS or SPOTIFY_USER_ID in environment variables.",
    );
  }

  const playlistMap = new Map<string, PlaylistItem>();
  let url: string | null = `https://api.spotify.com/v1/users/${encodeURIComponent(getEnv().SPOTIFY_USER_ID)}/playlists?limit=50`;

  while (url) {
    const page: SpotifyPaging<PlaylistItem> = await spotifyGet(url, accessToken);

    for (const playlist of page.items) {
      if (playlist.owner.id === getEnv().SPOTIFY_USER_ID && playlist.public === true) {
        playlistMap.set(playlist.id, playlist);
      }
    }

    url = page.next;
  }

  return { accessToken, playlists: [...playlistMap.values()] };
}

export async function fetchUnavailableTracksForPlaylist(
  playlistId: string,
  playlistName: string,
  accessToken: string,
): Promise<{ unavailable: TrackAvailability[]; checked: number }> {
  let url: string | null = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&market=${getEnv().SPOTIFY_MARKET}`;
  const unavailable: TrackAvailability[] = [];
  let checked = 0;

  while (url) {
    const page: SpotifyPaging<TrackEntry> = await spotifyGet(url, accessToken);

    for (const item of page.items) {
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
