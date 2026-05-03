import { Resend } from "resend";
import { getEnv } from "@/lib/env";
import type { TrackAvailability } from "@/lib/spotify";

const resend = new Resend(getEnv().RESEND_API_KEY);

export async function sendUnavailableTracksAlert(
  newUnavailableTracks: TrackAvailability[],
) {
  if (newUnavailableTracks.length === 0) {
    return;
  }

  const groupedByPlaylist = new Map<string, TrackAvailability[]>();

  for (const track of newUnavailableTracks) {
    const key = `${track.playlistId}::${track.playlistName}`;
    const existing = groupedByPlaylist.get(key) ?? [];
    existing.push(track);
    groupedByPlaylist.set(key, existing);
  }

  const listItems: string[] = [];

  for (const [playlistKey, tracks] of groupedByPlaylist.entries()) {
    const [, playlistName] = playlistKey.split("::");
    listItems.push(`<h3>${escapeHtml(playlistName)}</h3><ul>`);

    for (const track of tracks) {
      const durationText = formatDuration(track.durationMs);
      const trackText = durationText
        ? `${track.trackName} (${durationText})`
        : track.trackName;
      listItems.push(`<li>${escapeHtml(trackText)}</li>`);
    }

    listItems.push("</ul>");
  }

  const html = `
    <div>
      <p>Følgende tracks er ikke længere tilgængelige i ${getEnv().SPOTIFY_MARKET}:</p>
      ${listItems.join("\n")}
    </div>
  `;

  await resend.emails.send({
    from: getEnv().ALERT_EMAIL_FROM,
    to: getEnv().ALERT_EMAIL_TO,
    subject: `[SpotifyCheck] ${newUnavailableTracks.length} nye utilgængelige tracks`,
    html,
  });
}

function formatDuration(durationMs: number | null) {
  if (!durationMs || durationMs < 0) {
    return null;
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
