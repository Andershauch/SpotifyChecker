import type { UnavailablePlaylistGroup, UnavailableResponse } from "./types";
import { formatDateTime, formatDuration, formatPlaylistTrackSummary } from "./utils";

type TrackRow = {
  playlist: UnavailablePlaylistGroup;
  track: UnavailablePlaylistGroup["tracks"][number];
};

type FindingsTabProps = {
  unavailableData: UnavailableResponse | null;
  unavailablePlaylists: UnavailablePlaylistGroup[];
  unavailableTrackRows: TrackRow[];
  tracksWithSuggestions: number;
  unavailableMessage: string | null;
  generatingSuggestionsFor: string | null;
  onGenerateSuggestions: (playlistId: string, trackId: string) => void;
};

export function FindingsTab({
  unavailableData,
  unavailablePlaylists,
  unavailableTrackRows,
  tracksWithSuggestions,
  unavailableMessage,
  generatingSuggestionsFor,
  onGenerateSuggestions,
}: FindingsTabProps) {
  return (
    <section className="status-box unavailable-card">
      <div className="section-heading section-heading-compact">
        <div>
          <p className="eyebrow">Fund og alternativer</p>
          <h3>Playlister med utilgængelige tracks</h3>
        </div>
        {unavailableData ? (
          <p className="section-note">
            {unavailableData.totalTracks} utilgængelige tracks fordelt på{" "}
            {unavailableData.totalPlaylists} playliste
            {unavailableData.totalPlaylists === 1 ? "" : "r"}. {tracksWithSuggestions} af{" "}
            {unavailableTrackRows.length} har forslag.
          </p>
        ) : null}
      </div>

      {unavailableMessage ? <p className="run-message">{unavailableMessage}</p> : null}

      {!unavailableMessage && unavailablePlaylists.length === 0 ? (
        <p className="helper-text">Ingen aktuelle utilgængelige tracks er registreret lige nu.</p>
      ) : null}

<div className="playlist-findings">
        {unavailablePlaylists.map((playlist, index) => (
          <details key={playlist.playlistId} className="playlist-finding" open={index === 0}>
            <summary>
              <span className="playlist-finding-head">
                <span className="playlist-finding-copy">
                  <strong>
                    <a
                      href={playlist.playlistUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="spotify-link"
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      {playlist.playlistName}
                    </a>
                  </strong>
                  <small>{formatPlaylistTrackSummary(playlist)}</small>
                </span>
                <span className="playlist-finding-meta">
                  <span className="playlist-count-badge">{playlist.trackCount}</span>
                  <span className="playlist-chevron" aria-hidden="true">
                    ▾
                  </span>
                </span>
              </span>
            </summary>

            <ul className="track-list">
              {playlist.tracks.map((track) => (
                <li key={`${playlist.playlistId}-${track.trackId}`}>
                  <div>
                    <strong>
                      <a
                        href={track.trackUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="spotify-link"
                      >
                        {track.trackName}
                      </a>
                    </strong>
                    {track.durationMs ? <span>{formatDuration(track.durationMs)}</span> : null}
                  </div>
                  <small>
                    Senest set {formatDateTime(track.lastSeenAt)} {" • "}
                    {track.primaryArtistName ?? "ukendt kunstner"}
                  </small>

                  <div className="track-actions">
                    <button
                      type="button"
                      className="secondary-button suggestion-button"
                      onClick={() => {
                        onGenerateSuggestions(playlist.playlistId, track.trackId);
                      }}
                      disabled={
                        generatingSuggestionsFor === `${playlist.playlistId}::${track.trackId}`
                      }
                    >
                      {generatingSuggestionsFor === `${playlist.playlistId}::${track.trackId}`
                        ? "Finder alternativer..."
                        : track.suggestions.length > 0
                          ? "Opdatér alternativer"
                          : "Find 2 alternativer"}
                    </button>
                  </div>

                  {track.suggestions.length > 0 ? (
                    <div className="suggestion-list">
                      <p className="suggestion-intro">
                        Alternativer til &quot;{track.trackName}&quot; af{" "}
                        {track.referenceArtistName ??
                          track.primaryArtistName ??
                          "ukendt kunstner"}{" "}
                        — {track.durationMs ? formatDuration(track.durationMs) : "ukendt længde"}
                        {" / "}
                        {track.referenceEstimatedBpm
                          ? `estimeret ${track.referenceEstimatedBpm} BPM`
                          : "ukendt estimeret BPM"}
                        :
                      </p>

                      {track.suggestions.map((suggestion) => (
                        <article
                          key={`${track.trackId}-${suggestion.suggestionIndex}`}
                          className="suggestion-card"
                        >
                          {suggestion.reasoningSummary === "spotify-title-duration-match" ? (
                            <span className="suggestion-label">Direkte titelmatch</span>
                          ) : null}
                          <p className="suggestion-line">
                            {suggestion.suggestedSpotifyUrl ? (
                              <a
                                href={suggestion.suggestedSpotifyUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="spotify-link"
                              >
                                {suggestion.suggestedTrackName}
                              </a>
                            ) : (
                              suggestion.suggestedTrackName
                            )}{" "}
                            — {suggestion.suggestedArtistName} —{" "}
                            {suggestion.durationMs
                              ? formatDuration(suggestion.durationMs)
                              : "ukendt længde"}
                            {" / "}
                            {suggestion.estimatedBpm
                              ? `estimeret ${suggestion.estimatedBpm} BPM`
                              : "ukendt estimeret BPM"}
                          </p>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </section>
  );
}
