import { describe, expect, test } from "vitest";
import { flattenSnapshot, readPath } from "../src/stat-paths";

const SNAPSHOT = {
  captured_at_ms: 1_700_000_000_000,
  mic: { device: "Yeti", sample_rate: 48000, capture_frames_per_sec: null },
  link: { rtt_ms: 42, stalled: false },
  meter_events_per_sec: 30,
  peers: [{ name: "someone", underruns: 3 }],
  history: [{ rtt_ms: 40 }],
};

describe("flattenSnapshot", () => {
  test("finds the nested scalars", () => {
    expect(flattenSnapshot(SNAPSHOT)).toEqual([
      { path: "mic.device", value: "Yeti" },
      { path: "mic.sample_rate", value: 48000 },
      { path: "mic.capture_frames_per_sec", value: null },
      { path: "link.rtt_ms", value: 42 },
      { path: "link.stalled", value: false },
    ]);
  });

  test("keeps a stat that is not measured right now, so it stays selectable", () => {
    const paths = flattenSnapshot(SNAPSHOT).map((entry) => entry.path);
    expect(paths).toContain("mic.capture_frames_per_sec");
  });

  test("skips arrays, so per-speaker rows and history are not offered", () => {
    const paths = flattenSnapshot(SNAPSHOT).map((entry) => entry.path);
    expect(paths.some((path) => path.startsWith("peers"))).toBe(false);
    expect(paths.some((path) => path.startsWith("history"))).toBe(false);
  });

  test("hides the two paths that are not stats", () => {
    const paths = flattenSnapshot(SNAPSHOT).map((entry) => entry.path);
    expect(paths).not.toContain("captured_at_ms");
    expect(paths).not.toContain("meter_events_per_sec");
  });

  test("a missing snapshot has nothing to offer", () => {
    expect(flattenSnapshot(null)).toEqual([]);
  });

  test("an empty snapshot has nothing to offer", () => {
    expect(flattenSnapshot({})).toEqual([]);
  });
});

describe("readPath", () => {
  test("reads a nested value", () => {
    expect(readPath(SNAPSHOT, "link.rtt_ms")).toBe(42);
  });

  test("reads a boolean", () => {
    expect(readPath(SNAPSHOT, "link.stalled")).toBe(false);
  });

  test("reads a string", () => {
    expect(readPath(SNAPSHOT, "mic.device")).toBe("Yeti");
  });

  test("a path that is not there reads as not measured", () => {
    expect(readPath(SNAPSHOT, "link.nonsense")).toBeNull();
    expect(readPath(SNAPSHOT, "nonsense.at.all")).toBeNull();
  });

  test("a path naming an object rather than a value reads as not measured", () => {
    expect(readPath(SNAPSHOT, "link")).toBeNull();
  });

  test("a path naming an array reads as not measured", () => {
    expect(readPath(SNAPSHOT, "peers")).toBeNull();
  });

  test("a missing snapshot reads as not measured", () => {
    expect(readPath(null, "link.rtt_ms")).toBeNull();
  });
});
