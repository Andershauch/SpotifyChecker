import { NextResponse } from "next/server";
import { isAdminRequestAuthorized } from "@/lib/auth";
import {
  backfillUnavailableTrackArtistsFromReplacements,
  clearSpotifyCooldownState,
  ensureSchema,
  getCurrentUnavailableTracksMissingPrimaryArtist,
  getSpotifyCooldownState,
  setSpotifyCooldownState,
  updateUnavailableTrackPrimaryArtists,
} from "@/lib/db";
import { fetchTrackPrimaryArtists, getSpotifyCooldownFromError } from "@/lib/spotify";

const SPOTIFY_BACKFILL_BATCH_SIZE = 25;

export async function POST(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureSchema();

  const updatedFromReplacements = await backfillUnavailableTrackArtistsFromReplacements();
  const activeCooldown = await getActiveSpotifyCooldownForBackfill();

  if (activeCooldown) {
    const remainingMissingArtists = await countRemainingMissingArtists();
    return NextResponse.json({
      updatedFromReplacements,
      spotifyBatchSize: 0,
      updatedFromSpotify: 0,
      remainingMissingArtists,
      skippedSpotifyDueToCooldown: true,
      message:
        `Artist-backfill opdaterede ${updatedFromReplacements} fund fra eksisterende data. ` +
        `Spotify-delen blev sprunget over pga. cooldown indtil ${activeCooldown.until}.`,
    });
  }

  const missingTracks = await getCurrentUnavailableTracksMissingPrimaryArtist(
    SPOTIFY_BACKFILL_BATCH_SIZE,
  );

  if (missingTracks.length === 0) {
    return NextResponse.json({
      updatedFromReplacements,
      spotifyBatchSize: 0,
      updatedFromSpotify: 0,
      remainingMissingArtists: 0,
      skippedSpotifyDueToCooldown: false,
      message: "Alle aktuelle fund har allerede kunstnernavn.",
    });
  }

  try {
    const artistMap = await fetchTrackPrimaryArtists(
      missingTracks.map((track) => track.track_id),
    );
    const updatedFromSpotify = await updateUnavailableTrackPrimaryArtists(
      missingTracks.flatMap((track) => {
        const primaryArtistName = artistMap.get(track.track_id);
        return primaryArtistName
          ? [
              {
                playlistId: track.playlist_id,
                trackId: track.track_id,
                primaryArtistName,
              },
            ]
          : [];
      }),
    );
    const remainingMissingArtists = await countRemainingMissingArtists();

    return NextResponse.json({
      updatedFromReplacements,
      spotifyBatchSize: missingTracks.length,
      updatedFromSpotify,
      remainingMissingArtists,
      skippedSpotifyDueToCooldown: false,
      message:
        `Artist-backfill opdaterede ${updatedFromReplacements} fund fra eksisterende data og ` +
        `${updatedFromSpotify} fund via en lille Spotify-batch på ${missingTracks.length} track${missingTracks.length === 1 ? "" : "s"}.`,
    });
  } catch (error) {
    const spotifyCooldown = getSpotifyCooldownFromError(error);
    if (spotifyCooldown) {
      await setSpotifyCooldownState(spotifyCooldown);
    }

    const message =
      error instanceof Error
        ? error.message
        : "Kunne ikke backfille kunstnernavne.";

    return NextResponse.json(
      { error: message },
      { status: spotifyCooldown ? 429 : 500 },
    );
  }
}

async function getActiveSpotifyCooldownForBackfill() {
  const cooldown = await getSpotifyCooldownState();
  if (!cooldown) {
    return null;
  }

  const expiresInSeconds = Math.ceil(
    (new Date(cooldown.until).getTime() - Date.now()) / 1000,
  );

  if (expiresInSeconds <= 0) {
    await clearSpotifyCooldownState();
    return null;
  }

  return cooldown;
}

async function countRemainingMissingArtists() {
  const rows = await getCurrentUnavailableTracksMissingPrimaryArtist(10_000);
  return rows.length;
}
