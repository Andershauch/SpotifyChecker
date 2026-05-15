import { describe, expect, it } from "vitest";
import {
  buildTrackSearchQueries,
  getArtistSearchTokens,
  getBaseTrackTitle,
  getSearchMatchScore,
  isAcceptableTrackSearchMatch,
  isMatchingArtist,
  isMatchingTrackTitle,
  normalizeArtistText,
  normalizeSearchText,
} from "./spotify";

// ---------------------------------------------------------------------------
// normalizeSearchText
// ---------------------------------------------------------------------------
describe("normalizeSearchText", () => {
  it("lowercases and strips diacritics", () => {
    expect(normalizeSearchText("Café")).toBe("cafe");
    expect(normalizeSearchText("Ñoño")).toBe("nono");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeSearchText("a  b   c")).toBe("a b c");
  });

  it("removes non-alphanumeric characters", () => {
    expect(normalizeSearchText("track (remix)")).toBe("track remix");
    expect(normalizeSearchText("artist & co.")).toBe("artist co");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeSearchText("  song  ")).toBe("song");
  });

  it("handles empty string", () => {
    expect(normalizeSearchText("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// normalizeArtistText
// ---------------------------------------------------------------------------
describe("normalizeArtistText", () => {
  it("returns empty string for null or undefined", () => {
    expect(normalizeArtistText(null)).toBe("");
    expect(normalizeArtistText(undefined)).toBe("");
    expect(normalizeArtistText("")).toBe("");
  });

  it("strips 'feat' suffix and everything after it", () => {
    expect(normalizeArtistText("Artist feat. Other")).toBe("artist");
    expect(normalizeArtistText("Artist feat Someone")).toBe("artist");
  });

  it("strips 'ft' suffix and everything after it", () => {
    expect(normalizeArtistText("Artist ft. Other")).toBe("artist");
  });

  it("normalizes diacritics and casing", () => {
    expect(normalizeArtistText("Björk")).toBe("bjork");
  });
});

// ---------------------------------------------------------------------------
// getArtistSearchTokens
// ---------------------------------------------------------------------------
describe("getArtistSearchTokens", () => {
  it("splits on '&'", () => {
    expect(getArtistSearchTokens("artist a & artist b")).toEqual(["artist a", "artist b"]);
  });

  it("splits on 'and'", () => {
    expect(getArtistSearchTokens("artist a and artist b")).toEqual(["artist a", "artist b"]);
  });

  it("splits on comma", () => {
    expect(getArtistSearchTokens("a, b, c")).toEqual(["a", "b", "c"]);
  });

  it("splits on 'x' (collaboration separator)", () => {
    expect(getArtistSearchTokens("artist a x artist b")).toEqual(["artist a", "artist b"]);
  });

  it("returns single-element array for plain name", () => {
    expect(getArtistSearchTokens("solo artist")).toEqual(["solo artist"]);
  });

  it("filters out empty parts after split", () => {
    expect(getArtistSearchTokens("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getBaseTrackTitle
// ---------------------------------------------------------------------------
describe("getBaseTrackTitle", () => {
  it("removes 'remaster' and related keywords", () => {
    expect(getBaseTrackTitle("song remaster")).toBe("song");
    expect(getBaseTrackTitle("song remastered")).toBe("song");
  });

  it("removes 'remix'", () => {
    expect(getBaseTrackTitle("song remix")).toBe("song");
  });

  it("removes 'radio edit'", () => {
    expect(getBaseTrackTitle("song radio edit")).toBe("song");
  });

  it("removes year patterns", () => {
    expect(getBaseTrackTitle("song 2021")).toBe("song");
    expect(getBaseTrackTitle("song 1999")).toBe("song");
  });

  it("removes 'deluxe edition'", () => {
    expect(getBaseTrackTitle("song deluxe edition")).toBe("song");
  });

  it("leaves unrelated words intact", () => {
    expect(getBaseTrackTitle("original sin")).toBe("sin");
    // 'original' is stripped but 'sin' remains
  });

  it("collapses resulting whitespace", () => {
    expect(getBaseTrackTitle("my   song")).toBe("my song");
  });
});

// ---------------------------------------------------------------------------
// getSearchMatchScore
// ---------------------------------------------------------------------------
describe("getSearchMatchScore", () => {
  it("gives 100 points for exact track name match", () => {
    const score = getSearchMatchScore(
      { name: "song name", artists: [] },
      { trackName: "song name" },
    );
    expect(score).toBe(100);
  });

  it("gives 60 points for substring track name match", () => {
    const score = getSearchMatchScore(
      { name: "song name (live)", artists: [] },
      { trackName: "song name" },
    );
    expect(score).toBe(60);
  });

  it("gives 0 track name points when no match", () => {
    const score = getSearchMatchScore(
      { name: "completely different", artists: [] },
      { trackName: "song name" },
    );
    expect(score).toBe(0);
  });

  it("adds 80 points for exact artist match", () => {
    const score = getSearchMatchScore(
      { name: "song", artists: [{ name: "the artist" }] },
      { trackName: "song", artistName: "the artist" },
    );
    expect(score).toBe(100 + 80);
  });

  it("adds 40 points for partial artist match", () => {
    const score = getSearchMatchScore(
      { name: "song", artists: [{ name: "the artist feat. other" }] },
      { trackName: "song", artistName: "the artist" },
    );
    expect(score).toBe(100 + 40);
  });

  it("adds up to 40 duration points for exact duration match", () => {
    const score = getSearchMatchScore(
      { name: "song", duration_ms: 200000 },
      { trackName: "song", durationMs: 200000 },
    );
    expect(score).toBe(100 + 40);
  });

  it("reduces duration points as difference grows", () => {
    const scoreExact = getSearchMatchScore(
      { name: "s", duration_ms: 200000 },
      { trackName: "s", durationMs: 200000 },
    );
    const scoreOff10s = getSearchMatchScore(
      { name: "s", duration_ms: 210000 },
      { trackName: "s", durationMs: 200000 },
    );
    expect(scoreExact).toBeGreaterThan(scoreOff10s);
  });

  it("gives 0 duration points when difference exceeds 40 seconds", () => {
    const score = getSearchMatchScore(
      { name: "song", duration_ms: 300000 },
      { trackName: "song", durationMs: 200000 }, // 100s difference
    );
    const durationPoints = score - 100; // subtract track name points
    expect(durationPoints).toBe(0);
  });

  it("skips duration scoring when either duration is missing", () => {
    const scoreNoCandidateDuration = getSearchMatchScore(
      { name: "song" },
      { trackName: "song", durationMs: 200000 },
    );
    const scoreNoInputDuration = getSearchMatchScore(
      { name: "song", duration_ms: 200000 },
      { trackName: "song" },
    );
    expect(scoreNoCandidateDuration).toBe(100);
    expect(scoreNoInputDuration).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// isMatchingTrackTitle
// ---------------------------------------------------------------------------
describe("isMatchingTrackTitle", () => {
  it("matches identical titles (case-insensitive)", () => {
    expect(isMatchingTrackTitle("Song Name", "song name", false)).toBe(true);
  });

  it("matches despite diacritics", () => {
    expect(isMatchingTrackTitle("Café Song", "Cafe Song", false)).toBe(true);
  });

  it("rejects different titles without version match", () => {
    expect(isMatchingTrackTitle("Song (Radio Edit)", "Song", false)).toBe(false);
  });

  it("matches via base title when version match is allowed", () => {
    expect(isMatchingTrackTitle("Song (Radio Edit)", "Song (Remix)", true)).toBe(true);
  });

  it("still rejects genuinely different titles even with version match", () => {
    expect(isMatchingTrackTitle("Completely Different", "Song Name", true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isMatchingArtist
// ---------------------------------------------------------------------------
describe("isMatchingArtist", () => {
  it("returns true when no artist is requested (null)", () => {
    expect(isMatchingArtist([{ name: "Anyone" }], null)).toBe(true);
  });

  it("returns true for empty candidates when no artist requested", () => {
    expect(isMatchingArtist([], null)).toBe(true);
  });

  it("returns false for empty candidates when artist is requested", () => {
    expect(isMatchingArtist([], "Specific Artist")).toBe(false);
  });

  it("matches exact artist name (case-insensitive)", () => {
    expect(isMatchingArtist([{ name: "The Artist" }], "the artist")).toBe(true);
  });

  it("matches when candidate name contains requested name", () => {
    expect(isMatchingArtist([{ name: "The Artist feat. Other" }], "The Artist")).toBe(true);
  });

  it("matches via token split — one of multiple artists", () => {
    expect(isMatchingArtist([{ name: "Artist A & Artist B" }], "Artist A")).toBe(true);
  });

  it("rejects unrelated artist", () => {
    expect(isMatchingArtist([{ name: "Unrelated" }], "Specific Artist")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAcceptableTrackSearchMatch
// ---------------------------------------------------------------------------
describe("isAcceptableTrackSearchMatch", () => {
  const baseItem = { id: "track-1", name: "Song Name", duration_ms: 200000 };

  it("accepts a matching item with no constraints", () => {
    expect(isAcceptableTrackSearchMatch(baseItem, { trackName: "Song Name" })).toBe(true);
  });

  it("rejects item that matches the excluded track ID", () => {
    expect(
      isAcceptableTrackSearchMatch(baseItem, {
        trackName: "Song Name",
        excludeTrackId: "track-1",
      }),
    ).toBe(false);
  });

  it("accepts item with different ID even when exclude is set", () => {
    expect(
      isAcceptableTrackSearchMatch(baseItem, {
        trackName: "Song Name",
        excludeTrackId: "other-track",
      }),
    ).toBe(true);
  });

  it("rejects when requireExactTitle is set and title does not match", () => {
    expect(
      isAcceptableTrackSearchMatch(
        { id: "t1", name: "Song Name (Live)" },
        { trackName: "Song Name", requireExactTitle: true, allowVersionTitleMatch: false },
      ),
    ).toBe(false);
  });

  it("accepts version title match when allowVersionTitleMatch is enabled", () => {
    expect(
      isAcceptableTrackSearchMatch(
        { id: "t1", name: "Song (Radio Edit)" },
        {
          trackName: "Song (Remix)",
          requireExactTitle: true,
          allowVersionTitleMatch: true,
        },
      ),
    ).toBe(true);
  });

  it("rejects when duration difference exceeds the maximum", () => {
    expect(
      isAcceptableTrackSearchMatch(
        { id: "t1", name: "Song", duration_ms: 300000 },
        { trackName: "Song", durationMs: 200000, maxDurationDifferenceMs: 60000 },
      ),
    ).toBe(false);
  });

  it("accepts when duration difference is within the maximum", () => {
    expect(
      isAcceptableTrackSearchMatch(
        { id: "t1", name: "Song", duration_ms: 210000 },
        { trackName: "Song", durationMs: 200000, maxDurationDifferenceMs: 60000 },
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildTrackSearchQueries
// ---------------------------------------------------------------------------
describe("buildTrackSearchQueries", () => {
  it("builds a single field query without fallback", () => {
    const queries = buildTrackSearchQueries({ trackName: "Song", artistName: "Artist" });
    expect(queries).toEqual(["track:Song artist:Artist"]);
  });

  it("omits artist field when no artist provided", () => {
    const queries = buildTrackSearchQueries({ trackName: "Song" });
    expect(queries).toEqual(["track:Song"]);
  });

  it("adds broad fallback queries when useBroadFallback is true", () => {
    const queries = buildTrackSearchQueries({
      trackName: "Song",
      artistName: "Artist",
      useBroadFallback: true,
    });
    expect(queries).toContain("Song Artist");
    expect(queries).toContain("Song");
  });

  it("deduplicates queries", () => {
    const queries = buildTrackSearchQueries({
      trackName: "Song",
      useBroadFallback: true,
    });
    const unique = new Set(queries);
    expect(queries.length).toBe(unique.size);
  });

  it("adds base title variants when allowVersionTitleMatch is enabled", () => {
    const queries = buildTrackSearchQueries({
      trackName: "Song Remix",
      artistName: "Artist",
      useBroadFallback: true,
      allowVersionTitleMatch: true,
    });
    // 'song remix' normalizes to base 'song', so base queries should appear
    expect(queries.some((q) => q.includes("track:song"))).toBe(true);
  });
});
