import { describe, expect, it } from "vitest";
import { enforceOpenAiDurationTolerance, extractSpotifyTrackId } from "./replacements";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuggestion(durationMs: number | null) {
  return {
    suggestedTrackName: "Test Track",
    suggestedArtistName: "Test Artist",
    suggestedSpotifyUrl: null,
    suggestedSpotifyTrackId: null,
    durationMs,
    estimatedBpm: null,
  };
}

const BASE_RESULT = {
  referenceArtistName: "Reference Artist",
  referenceEstimatedBpm: 128,
  suggestions: [] as ReturnType<typeof makeSuggestion>[],
};

// ---------------------------------------------------------------------------
// enforceOpenAiDurationTolerance
// ---------------------------------------------------------------------------
describe("enforceOpenAiDurationTolerance", () => {
  it("returns result unchanged when referenceDurationMs is null", () => {
    const suggestions = [makeSuggestion(200000), makeSuggestion(205000)];
    const input = { ...BASE_RESULT, suggestions };
    const result = enforceOpenAiDurationTolerance(input, null);
    expect(result).toEqual(input);
  });

  it("accepts two suggestions within the ±5 second tolerance", () => {
    const ref = 300000; // 5 minutes
    const suggestions = [
      makeSuggestion(ref + 3000), // +3s — within tolerance
      makeSuggestion(ref - 4000), // -4s — within tolerance
    ];
    const result = enforceOpenAiDurationTolerance({ ...BASE_RESULT, suggestions }, ref);
    expect(result.suggestions).toHaveLength(2);
  });

  it("throws when fewer than 2 suggestions are within tolerance", () => {
    const ref = 300000;
    const suggestions = [
      makeSuggestion(ref + 3000),   // within
      makeSuggestion(ref + 60000),  // 60s over — outside tolerance
    ];
    expect(() =>
      enforceOpenAiDurationTolerance({ ...BASE_RESULT, suggestions }, ref),
    ).toThrow();
  });

  it("throws when no suggestions are within tolerance", () => {
    const ref = 300000;
    const suggestions = [
      makeSuggestion(ref + 30000), // 30s over
      makeSuggestion(ref - 20000), // 20s under
    ];
    expect(() =>
      enforceOpenAiDurationTolerance({ ...BASE_RESULT, suggestions }, ref),
    ).toThrow();
  });

  it("filters out suggestions with null durationMs", () => {
    const ref = 300000;
    const suggestions = [
      makeSuggestion(null),          // no duration — filtered out
      makeSuggestion(ref + 3000),    // within
    ];
    // Only 1 valid suggestion remains → should throw (needs exactly 2)
    expect(() =>
      enforceOpenAiDurationTolerance({ ...BASE_RESULT, suggestions }, ref),
    ).toThrow();
  });

  it("accepts suggestions at the exact boundary (±5000ms)", () => {
    const ref = 300000;
    const suggestions = [
      makeSuggestion(ref + 5000), // exactly at the boundary
      makeSuggestion(ref - 5000), // exactly at the boundary
    ];
    const result = enforceOpenAiDurationTolerance({ ...BASE_RESULT, suggestions }, ref);
    expect(result.suggestions).toHaveLength(2);
  });

  it("rejects suggestions just outside the boundary (5001ms)", () => {
    const ref = 300000;
    const suggestions = [
      makeSuggestion(ref + 5001), // 1ms past boundary
      makeSuggestion(ref - 5001), // 1ms past boundary
    ];
    expect(() =>
      enforceOpenAiDurationTolerance({ ...BASE_RESULT, suggestions }, ref),
    ).toThrow();
  });

  it("preserves referenceArtistName and referenceEstimatedBpm in output", () => {
    const ref = 300000;
    const suggestions = [makeSuggestion(ref + 1000), makeSuggestion(ref - 1000)];
    const input = { ...BASE_RESULT, suggestions };
    const result = enforceOpenAiDurationTolerance(input, ref);
    expect(result.referenceArtistName).toBe("Reference Artist");
    expect(result.referenceEstimatedBpm).toBe(128);
  });
});

// ---------------------------------------------------------------------------
// extractSpotifyTrackId
// ---------------------------------------------------------------------------
describe("extractSpotifyTrackId", () => {
  it("returns null for null input", () => {
    expect(extractSpotifyTrackId(null)).toBeNull();
  });

  it("returns null for a URL without a track segment", () => {
    expect(extractSpotifyTrackId("https://open.spotify.com/playlist/abc123")).toBeNull();
  });

  it("extracts the track ID from a standard Spotify URL", () => {
    expect(
      extractSpotifyTrackId("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"),
    ).toBe("4uLU6hMCjMI75M1A2tKUQC");
  });

  it("extracts track ID when URL has query parameters", () => {
    expect(
      extractSpotifyTrackId(
        "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc123",
      ),
    ).toBe("4uLU6hMCjMI75M1A2tKUQC");
  });

  it("handles mixed alphanumeric track IDs", () => {
    expect(extractSpotifyTrackId("https://open.spotify.com/track/ABC123xyz")).toBe(
      "ABC123xyz",
    );
  });
});
