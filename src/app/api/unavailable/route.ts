import { NextResponse } from "next/server";
import { isAdminRequestAuthorized } from "@/lib/auth";
import {
  getKnownUnavailableTracks,
  getTrackReplacementsForCurrentUnavailableTracks,
} from "@/lib/db";

export async function GET(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tracks = await getKnownUnavailableTracks();
  const replacements = await getTrackReplacementsForCurrentUnavailableTracks();
  const replacementMap = new Map<string, Array<{
    referenceArtistName: string | null;
    referenceEstimatedBpm: number | null;
    suggestionIndex: number;
    suggestedTrackName: string;
    suggestedArtistName: string;
    suggestedSpotifyUrl: string | null;
    suggestedSpotifyTrackId: string | null;
    durationMs: number | null;
    estimatedBpm: number | null;
    reasoningSummary: string;
    generatedAt: string;
  }>>();
  const grouped = new Map<
    string,
    {
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
        currentlyUnavailable: boolean;
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
    }
  >();

  for (const replacement of replacements) {
    const key = `${replacement.playlist_id}::${replacement.unavailable_track_id}`;
    const existing = replacementMap.get(key) ?? [];
    existing.push({
      referenceArtistName: replacement.reference_artist_name,
      referenceEstimatedBpm: replacement.reference_estimated_bpm,
      suggestionIndex: replacement.suggestion_index,
      suggestedTrackName: replacement.suggested_track_name,
      suggestedArtistName: replacement.suggested_artist_name,
      suggestedSpotifyUrl: replacement.suggested_spotify_url,
      suggestedSpotifyTrackId: replacement.suggested_spotify_track_id,
      durationMs: replacement.duration_ms,
      estimatedBpm: replacement.estimated_bpm,
      reasoningSummary: replacement.reasoning_summary,
      generatedAt: replacement.generated_at,
    });
    replacementMap.set(key, existing);
  }

  for (const track of tracks) {
    const existing = grouped.get(track.playlist_id) ?? {
      playlistId: track.playlist_id,
      playlistName: track.playlist_name,
      playlistUrl: buildSpotifyPlaylistUrl(track.playlist_id),
      trackCount: 0,
      tracks: [],
    };

    existing.tracks.push({
      trackId: track.track_id,
      trackName: track.track_name,
      trackUrl: buildSpotifyTrackUrl(track.track_id),
      durationMs: track.duration_ms,
      firstSeenAt: track.first_seen_at,
      lastSeenAt: track.last_seen_at,
      currentlyUnavailable: track.currently_unavailable,
      referenceArtistName:
        replacementMap.get(`${track.playlist_id}::${track.track_id}`)?.[0]?.referenceArtistName ??
        null,
      referenceEstimatedBpm:
        replacementMap.get(`${track.playlist_id}::${track.track_id}`)?.[0]
          ?.referenceEstimatedBpm ?? null,
      suggestions: replacementMap.get(`${track.playlist_id}::${track.track_id}`) ?? [],
    });
    existing.trackCount += 1;
    grouped.set(track.playlist_id, existing);
  }

  return NextResponse.json({
    playlists: [...grouped.values()].sort((left, right) => right.trackCount - left.trackCount),
    totalPlaylists: grouped.size,
    totalTracks: tracks.length,
    currentTracks: tracks.filter((track) => track.currently_unavailable).length,
    historicalTracks: tracks.filter((track) => !track.currently_unavailable).length,
  });
}

function buildSpotifyPlaylistUrl(playlistId: string) {
  return `https://open.spotify.com/playlist/${playlistId}`;
}

function buildSpotifyTrackUrl(trackId: string) {
  return `https://open.spotify.com/track/${trackId}`;
}
