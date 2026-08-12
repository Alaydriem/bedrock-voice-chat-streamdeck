import { describe, expect, test } from "vitest";
import { MetricsCore, STALE_AFTER_MS } from "../src/metrics-core";
import type { MetricsFrame } from "../src/metrics-frame";

const snapshotFrame = (rtt: number): MetricsFrame => ({
  kind: "metrics",
  snapshot: { link: { rtt_ms: rtt } },
});

const healthFrame: MetricsFrame = { kind: "health", health: { status: "Connected" } };

describe("MetricsCore reference counting", () => {
  test("the first key asks for the socket to open", () => {
    const core = new MetricsCore();
    core.markReady();
    expect(core.acquire()).toBe("open");
    expect(core.subscribed).toBe(true);
  });

  test("a second key does not open a second socket", () => {
    const core = new MetricsCore();
    core.markReady();
    core.acquire();
    expect(core.acquire()).toBe("none");
  });

  test("the last key to go asks for the socket to close", () => {
    const core = new MetricsCore();
    core.markReady();
    core.acquire();
    expect(core.release()).toBe("close");
    expect(core.subscribed).toBe(false);
  });

  test("two keys need two releases", () => {
    const core = new MetricsCore();
    core.markReady();
    core.acquire();
    core.acquire();
    expect(core.release()).toBe("none");
    expect(core.release()).toBe("close");
  });

  test("a release with nothing behind it does nothing and does not go negative", () => {
    const core = new MetricsCore();
    core.markReady();
    expect(core.release()).toBe("none");
    expect(core.acquire()).toBe("open");
  });
});

describe("MetricsCore readiness", () => {
  // A key already sitting on the Stream Deck appears before the plugin has read its global
  // settings, so the first `acquire` can arrive with no host, port or key known. Opening then
  // connects to nothing and, because the reference count is already taken, nothing ever asks
  // again. The socket must wait for settings and open itself once they arrive.

  test("a key that appears before settings are read does not open a socket", () => {
    const core = new MetricsCore();
    expect(core.acquire()).toBe("none");
    expect(core.subscribed).toBe(true);
  });

  test("settings arriving after that key opens the socket", () => {
    const core = new MetricsCore();
    core.acquire();
    expect(core.markReady()).toBe("open");
  });

  test("settings arriving with no key on screen opens nothing", () => {
    const core = new MetricsCore();
    expect(core.markReady()).toBe("none");
  });

  test("a key appearing after settings opens the socket straight away", () => {
    const core = new MetricsCore();
    core.markReady();
    expect(core.acquire()).toBe("open");
  });

  test("readiness is reported once, so a later settings push does not reopen", () => {
    const core = new MetricsCore();
    core.acquire();
    expect(core.markReady()).toBe("open");
    expect(core.markReady()).toBe("none");
  });

  test("releasing and reacquiring after settings still opens", () => {
    const core = new MetricsCore();
    core.markReady();
    core.acquire();
    expect(core.release()).toBe("close");
    expect(core.acquire()).toBe("open");
  });
});

describe("MetricsCore frames", () => {
  test("a metrics frame is kept and reported", () => {
    const core = new MetricsCore();
    const events = core.applyFrame(snapshotFrame(42), 1000);
    expect(events).toContain("snapshot");
    expect(core.snapshot).toEqual({ link: { rtt_ms: 42 } });
  });

  test("the first metrics frame also reports the end of staleness", () => {
    const core = new MetricsCore();
    expect(core.applyFrame(snapshotFrame(42), 1000)).toEqual(["snapshot", "stale"]);
  });

  test("a second metrics frame reports only the snapshot", () => {
    const core = new MetricsCore();
    core.applyFrame(snapshotFrame(42), 1000);
    expect(core.applyFrame(snapshotFrame(43), 2000)).toEqual(["snapshot"]);
  });

  test("a health frame is kept and reported", () => {
    const core = new MetricsCore();
    expect(core.applyFrame(healthFrame, 1000)).toEqual(["health"]);
    expect(core.health).toEqual({ status: "Connected" });
  });

  test("an unknown frame changes nothing", () => {
    const core = new MetricsCore();
    expect(core.applyFrame({ kind: "unknown" }, 1000)).toEqual([]);
    expect(core.snapshot).toBeNull();
  });
});

describe("MetricsCore staleness", () => {
  test("nothing received is stale", () => {
    const core = new MetricsCore();
    expect(core.isStale(1000)).toBe(true);
    expect(core.ageMs(1000)).toBeNull();
  });

  test("a fresh snapshot is not stale", () => {
    const core = new MetricsCore();
    core.applyFrame(snapshotFrame(42), 1000);
    expect(core.isStale(1500)).toBe(false);
    expect(core.ageMs(1500)).toBe(500);
  });

  test("a snapshot older than the threshold is stale", () => {
    const core = new MetricsCore();
    core.applyFrame(snapshotFrame(42), 1000);
    expect(core.isStale(1000 + STALE_AFTER_MS)).toBe(true);
  });

  test("the watchdog reports the crossing into staleness once", () => {
    const core = new MetricsCore();
    core.applyFrame(snapshotFrame(42), 1000);

    expect(core.tick(2000)).toEqual([]);
    expect(core.tick(1000 + STALE_AFTER_MS)).toEqual(["stale"]);
    expect(core.tick(1000 + STALE_AFTER_MS + 1000)).toEqual([]);
  });

  test("the watchdog says nothing while nothing has ever arrived", () => {
    const core = new MetricsCore();
    expect(core.tick(1000)).toEqual([]);
    expect(core.tick(9000)).toEqual([]);
  });
});

describe("MetricsCore socket state", () => {
  test("the socket coming up is reported once", () => {
    const core = new MetricsCore();
    expect(core.setSocketUp(true)).toEqual(["socket"]);
    expect(core.setSocketUp(true)).toEqual([]);
    expect(core.socketUp).toBe(true);
  });

  test("the socket going down discards everything it reported", () => {
    const core = new MetricsCore();
    core.setSocketUp(true);
    core.applyFrame(snapshotFrame(42), 1000);
    core.applyFrame(healthFrame, 1000);

    expect(core.setSocketUp(false)).toEqual(["socket"]);
    expect(core.snapshot).toBeNull();
    expect(core.health).toBeNull();
    expect(core.ageMs(2000)).toBeNull();
  });

  test("a snapshot after a reconnect reports the end of staleness again", () => {
    const core = new MetricsCore();
    core.setSocketUp(true);
    core.applyFrame(snapshotFrame(42), 1000);
    core.setSocketUp(false);
    core.setSocketUp(true);

    expect(core.applyFrame(snapshotFrame(43), 5000)).toEqual(["snapshot", "stale"]);
  });
});
