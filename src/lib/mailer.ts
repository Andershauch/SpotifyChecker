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
      const trackText = `${track.trackName} - ${track.artists}`;
      const line = track.trackUrl
        ? `<li><a href="${track.trackUrl}">${escapeHtml(trackText)}</a></li>`
        : `<li>${escapeHtml(trackText)}</li>`;
      listItems.push(line);
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

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
