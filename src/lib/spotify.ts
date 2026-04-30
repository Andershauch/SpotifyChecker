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
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Spotify API request failed: ${response.status} (${url})`);
  }

  return (await response.json()) as T;
}

export async function fetchOwnPublicPlaylists() {
  const accessToken = await getAccessToken();
  const playlistMap = new Map<string, PlaylistItem>();
  let url = `https://api.spotify.com/v1/users/${encodeURIComponent(getEnv().SPOTIFY_USER_ID)}/playlists?limit=50`;

  while (url) {
    const page = await spotifyGet<SpotifyPaging<PlaylistItem>>(url, accessToken);

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
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&market=${getEnv().SPOTIFY_MARKET}`;
  const unavailable: TrackAvailability[] = [];
  let checked = 0;

  while (url) {
    const page = await spotifyGet<SpotifyPaging<TrackEntry>>(url, accessToken);

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
