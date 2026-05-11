import { Resend } from "resend";
import { getEnv } from "@/lib/env";
import type { TrackAvailability } from "@/lib/spotify";

const resend = new Resend(getEnv().RESEND_API_KEY);

export type DurationChangeAlert = {
  playlistId: string;
  playlistName: string;
  trackId: string;
  trackName: string;
  previousDurationMs: number;
  currentDurationMs: number;
};

export async function sendPlaylistChangesAlert(input: {
  newUnavailableTracks: TrackAvailability[];
  durationChanges: DurationChangeAlert[];
}) {
  const { newUnavailableTracks, durationChanges } = input;

  if (newUnavailableTracks.length === 0 && durationChanges.length === 0) {
    return;
  }

  const groupedByPlaylist = new Map<
    string,
    {
      playlistId: string;
      playlistName: string;
      unavailableTracks: TrackAvailability[];
      durationChanges: DurationChangeAlert[];
    }
  >();

  for (const track of newUnavailableTracks) {
    const key = `${track.playlistId}::${track.playlistName}`;
    const existing = groupedByPlaylist.get(key) ?? {
      playlistId: track.playlistId,
      playlistName: track.playlistName,
      unavailableTracks: [],
      durationChanges: [],
    };
    existing.unavailableTracks.push(track);
    groupedByPlaylist.set(key, existing);
  }

  for (const change of durationChanges) {
    const key = `${change.playlistId}::${change.playlistName}`;
    const existing = groupedByPlaylist.get(key) ?? {
      playlistId: change.playlistId,
      playlistName: change.playlistName,
      unavailableTracks: [],
      durationChanges: [],
    };
    existing.durationChanges.push(change);
    groupedByPlaylist.set(key, existing);
  }

  const sections: string[] = [];

  for (const playlistChanges of groupedByPlaylist.values()) {
    const playlistParts: string[] = [
      `<h3><a href="${escapeAttribute(buildSpotifyPlaylistUrl(playlistChanges.playlistId))}">${escapeHtml(
        playlistChanges.playlistName,
      )}</a></h3>`,
    ];

    if (playlistChanges.unavailableTracks.length > 0) {
      playlistParts.push("<p><strong>Manglende tracks</strong></p><ul>");

      for (const track of playlistChanges.unavailableTracks) {
        const durationText = formatShortDuration(track.durationMs);
        const trackText = durationText
          ? `${track.trackName} (${durationText})`
          : track.trackName;
        playlistParts.push(`<li>${escapeHtml(trackText)}</li>`);
      }

      playlistParts.push("</ul>");
    }

    if (playlistChanges.durationChanges.length > 0) {
      playlistParts.push("<p><strong>Laengdeaendringer</strong></p><ul>");

      for (const change of playlistChanges.durationChanges) {
        playlistParts.push(
          `<li>${escapeHtml(change.trackName)}: ${escapeHtml(
            formatPreciseDuration(change.previousDurationMs),
          )} -> ${escapeHtml(formatPreciseDuration(change.currentDurationMs))}</li>`,
        );
      }

      playlistParts.push("</ul>");
    }

    sections.push(playlistParts.join("\n"));
  }

  const changedPlaylistCount = groupedByPlaylist.size;
  const html = `
    <div>
      <p>Følgende ændringer blev fundet i dine overvågede playlister for ${escapeHtml(
        getEnv().SPOTIFY_MARKET,
      )}:</p>
      ${sections.join("\n")}
    </div>
  `;

  await resend.emails.send({
    from: getEnv().ALERT_EMAIL_FROM,
    to: getEnv().ALERT_EMAIL_TO,
    subject:
      `[SpotifyCheck] ${changedPlaylistCount} playlister med ændringer ` +
      `(${newUnavailableTracks.length} manglende, ${durationChanges.length} laengdeaendringer)`,
    html,
  });
}

function formatShortDuration(durationMs: number | null) {
  if (durationMs === null || durationMs < 0) {
    return null;
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatPreciseDuration(durationMs: number) {
  const normalized = Math.max(0, durationMs);
  const totalSeconds = Math.floor(normalized / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = normalized % 1000;
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${milliseconds
    .toString()
    .padStart(3, "0")} (${normalized} ms)`;
}

function buildSpotifyPlaylistUrl(playlistId: string) {
  return `https://open.spotify.com/playlist/${playlistId}`;
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(input: string) {
  return escapeHtml(input);
}
