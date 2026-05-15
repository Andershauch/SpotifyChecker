import { describe, expect, it } from "vitest";
import { applyResumePoint, getPlaylistScanDecision } from "./checker";
import type { PlaylistSummary } from "./spotify";
import type { PlaylistCheckpointRow } from "./db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlaylist(id: string, snapshotId: string | null = "snap-abc"): PlaylistSummary {
  return { id, name: `Playlist ${id}`, snapshotId } as PlaylistSummary;
}

function makeCheckpoint(overrides: Partial<PlaylistCheckpointRow> = {}): PlaylistCheckpointRow {
  return {
    last_availability_scan_at: new Date().toISOString(),
    snapshot_id: "snap-abc",
    current_unavailable_count: 0,
    ...overrides,
  } as PlaylistCheckpointRow;
}

// ---------------------------------------------------------------------------
// applyResumePoint
// ---------------------------------------------------------------------------
describe("applyResumePoint", () => {
  const playlists = [
    makePlaylist("a"),
    makePlaylist("b"),
    makePlaylist("c"),
    makePlaylist("d"),
  ];

  it("returns all playlists when resumePlaylistId is null", () => {
    expect(applyResumePoint(playlists, null)).toEqual(playlists);
  });

  it("returns all playlists when resumePlaylistId is not found", () => {
    expect(applyResumePoint(playlists, "unknown")).toEqual(playlists);
  });

  it("slices from the matching playlist onward", () => {
    const result = applyResumePoint(playlists, "c");
    expect(result.map((p) => p.id)).toEqual(["c", "d"]);
  });

  it("returns all playlists when resume ID matches the first one", () => {
    expect(applyResumePoint(playlists, "a")).toEqual(playlists);
  });

  it("returns only the last playlist when resume ID matches it", () => {
    const result = applyResumePoint(playlists, "d");
    expect(result.map((p) => p.id)).toEqual(["d"]);
  });

  it("handles an empty playlist array", () => {
    expect(applyResumePoint([], "any")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getPlaylistScanDecision
// ---------------------------------------------------------------------------
describe("getPlaylistScanDecision", () => {
  it("scans with priority 1 when there is no checkpoint at all", () => {
    const decision = getPlaylistScanDecision(makePlaylist("p1"), undefined);
    expect(decision.shouldScan).toBe(true);
    expect(decision.priority).toBe(1);
  });

  it("scans with priority 1 when checkpoint exists but was never scanned", () => {
    const checkpoint = makeCheckpoint({ last_availability_scan_at: null });
    const decision = getPlaylistScanDecision(makePlaylist("p1"), checkpoint);
    expect(decision.shouldScan).toBe(true);
    expect(decision.priority).toBe(1);
  });

  it("scans with priority 0 when the Spotify snapshot ID has changed", () => {
    const playlist = makePlaylist("p1", "new-snap");
    const checkpoint = makeCheckpoint({ snapshot_id: "old-snap" });
    const decision = getPlaylistScanDecision(playlist, checkpoint);
    expect(decision.shouldScan).toBe(true);
    expect(decision.priority).toBe(0);
  });

  it("scans with priority 0 when snapshot exists remotely but not locally", () => {
    const playlist = makePlaylist("p1", "snap-abc");
    const checkpoint = makeCheckpoint({ snapshot_id: null });
    const decision = getPlaylistScanDecision(playlist, checkpoint);
    expect(decision.shouldScan).toBe(true);
    expect(decision.priority).toBe(0);
  });

  it("skips with priority 4 when snapshot is unchanged and scan is fresh", () => {
    const playlist = makePlaylist("p1", "snap-abc");
    const checkpoint = makeCheckpoint({
      snapshot_id: "snap-abc",
      last_availability_scan_at: new Date().toISOString(),
      current_unavailable_count: 0,
    });
    const decision = getPlaylistScanDecision(playlist, checkpoint);
    expect(decision.shouldScan).toBe(false);
    expect(decision.priority).toBe(4);
  });

  it("scans with priority 2 when there are unavailable tracks and scan is over 2 days old", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const playlist = makePlaylist("p1", "snap-abc");
    const checkpoint = makeCheckpoint({
      snapshot_id: "snap-abc",
      last_availability_scan_at: threeDaysAgo,
      current_unavailable_count: 3,
    });
    const decision = getPlaylistScanDecision(playlist, checkpoint);
    expect(decision.shouldScan).toBe(true);
    expect(decision.priority).toBe(2);
  });

  it("does not rescan with priority 2 when unavailable tracks exist but scan is recent (under 2 days)", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const playlist = makePlaylist("p1", "snap-abc");
    const checkpoint = makeCheckpoint({
      snapshot_id: "snap-abc",
      last_availability_scan_at: oneHourAgo,
      current_unavailable_count: 5,
    });
    const decision = getPlaylistScanDecision(playlist, checkpoint);
    // Recent scan with unavailable tracks — not old enough to re-check
    expect(decision.priority).not.toBe(2);
  });

  it("scans with priority 3 when scan is over 7 days old and no unavailable tracks", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const playlist = makePlaylist("p1", "snap-abc");
    const checkpoint = makeCheckpoint({
      snapshot_id: "snap-abc",
      last_availability_scan_at: eightDaysAgo,
      current_unavailable_count: 0,
    });
    const decision = getPlaylistScanDecision(playlist, checkpoint);
    expect(decision.shouldScan).toBe(true);
    expect(decision.priority).toBe(3);
  });

  it("does not treat a null playlist snapshotId as a changed snapshot", () => {
    // A playlist with no snapshot ID (dynamic playlist) should not trigger priority 0
    const playlist = makePlaylist("p1", null);
    const checkpoint = makeCheckpoint({
      snapshot_id: "some-snap",
      last_availability_scan_at: new Date().toISOString(),
      current_unavailable_count: 0,
    });
    const decision = getPlaylistScanDecision(playlist, checkpoint);
    // snapshotId is null on the playlist so neither snapshot condition fires
    expect(decision.priority).not.toBe(0);
  });
});
