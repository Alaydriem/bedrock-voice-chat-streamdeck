import { describe, expect, test } from "vitest";
import { configuredPath, statView } from "../src/stat-view";
import { STALE_AFTER_MS } from "../src/metrics-core";

const SNAPSHOT = {
  mic: { muted: false },
  link: { rtt_ms: 42, uplink_loss_pct: 0.4 },
};

const live = (path: string | null) => ({
  path,
  snapshot: SNAPSHOT,
  ageMs: 500,
  health: { status: "Connected" } as const,
  socketUp: true,
});

describe("configuredPath", () => {
  test("reads the configured stat", () => {
    expect(configuredPath({ stat: "link.rtt_ms" })).toBe("link.rtt_ms");
  });

  test("treats an empty setting as unset", () => {
    expect(configuredPath({ stat: "" })).toBeNull();
  });

  test("nothing configured is no stat", () => {
    expect(configuredPath({})).toBeNull();
  });
});

describe("statView", () => {
  test("says so when no stat has been chosen", () => {
    expect(statView(live(null)))
      .toEqual({ kind: "message", text: "NO STAT", tone: "normal" });
  });

  test("a shut socket outranks a health frame that says connected", () => {
    const view = statView({ ...live("link.rtt_ms"), socketUp: false });
    expect(view).toEqual({ kind: "message", text: "NO CLIENT", tone: "alarm" });
  });

  // A health frame explains why the snapshots stopped, so it is only drawn once they have.
  // The client pushes health on change only, so a verdict that was already stale when the
  // socket opened stays stale for the whole session. Letting it outrank live measurements
  // hides good numbers behind a word that nothing will ever correct.
  const stalled = (path: string) => ({ ...live(path), snapshot: null, ageMs: null });

  test("draws a refused identity as an alarm", () => {
    const view = statView({ ...stalled("link.rtt_ms"), health: { status: "Unauthorized" } });
    expect(view).toEqual({ kind: "message", text: "AUTH", tone: "alarm" });
  });

  test("draws a version mismatch as an alarm", () => {
    const view = statView({ ...stalled("link.rtt_ms"), health: { status: "VersionMismatch" } });
    expect(view).toEqual({ kind: "message", text: "VERSION", tone: "alarm" });
  });

  test("draws a failure as an alarm", () => {
    const view = statView({ ...stalled("link.rtt_ms"), health: { status: "Failed" } });
    expect(view).toEqual({ kind: "message", text: "FAILED", tone: "alarm" });
  });

  test("draws a disconnected client plainly, because it is not an emergency", () => {
    const view = statView({ ...stalled("link.rtt_ms"), health: { status: "Disconnected" } });
    expect(view).toEqual({ kind: "message", text: "OFFLINE", tone: "normal" });
  });

  test("draws a reconnecting client with its attempt, plainly", () => {
    const view = statView({
      ...stalled("link.rtt_ms"),
      health: { status: "Reconnecting", attempt: 3 },
    });
    expect(view).toEqual({ kind: "message", text: "RETRY 3", tone: "normal" });
  });

  test("fresh measurements outrank a health verdict that says otherwise", () => {
    // The observed bug: the client reported Disconnected on subscribe and then streamed a
    // snapshot every second. A snapshot one second old is proof the link carries traffic.
    const view = statView({ ...live("link.rtt_ms"), health: { status: "Disconnected" } });
    expect(view).toEqual({
      kind: "cell",
      cell: { label: "RTT", value: "42", unit: "ms" },
    });
  });

  test("a health verdict returns once the measurements stop", () => {
    const view = statView({
      ...live("link.rtt_ms"),
      ageMs: STALE_AFTER_MS,
      health: { status: "Disconnected" },
    });
    expect(view).toEqual({ kind: "message", text: "OFFLINE", tone: "normal" });
  });

  test("draws the value when everything is live", () => {
    expect(statView(live("link.rtt_ms"))).toEqual({
      kind: "cell",
      cell: { label: "RTT", value: "42", unit: "ms" },
    });
  });

  test("draws a dash rather than the last number once a snapshot goes stale", () => {
    const view = statView({ ...live("link.uplink_loss_pct"), ageMs: STALE_AFTER_MS });
    expect(view).toEqual({
      kind: "cell",
      cell: { label: "UP LOSS", value: "—", unit: "" },
    });
  });

  test("draws a dash when no snapshot has arrived at all", () => {
    const view = statView({ ...live("link.uplink_loss_pct"), snapshot: null, ageMs: null });
    expect(view.kind === "cell" && view.cell.value).toBe("—");
  });

  test("draws the value when no health frame has arrived yet", () => {
    const view = statView({ ...live("link.rtt_ms"), health: null });
    expect(view.kind === "cell" && view.cell.value).toBe("42");
  });

  test("a stat the snapshot does not carry draws as a dash", () => {
    const view = statView(live("link.gone"));
    expect(view.kind === "cell" && view.cell.value).toBe("—");
  });
});
