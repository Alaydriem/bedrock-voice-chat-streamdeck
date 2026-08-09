import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_PENDING, PendingRequests, REQUEST_TIMEOUT_MS } from "../src/pending-requests";
import type { BvcFrame } from "../src/frame";

const stateFrame: BvcFrame = {
  kind: "state",
  state: {
    muted: false, deafened: false, recording: false,
    voiceMode: "openMic", pttActive: false, connection: null,
  },
};
const errorFrame = (message: string): BvcFrame => ({ kind: "error", message });
const targetsFrame: BvcFrame = {
  kind: "targets",
  targets: [{ id: "saved:abc", name: "My Server", kind: "proxy" }],
};
const recordFrame: BvcFrame = { kind: "record", recording: true };

describe("PendingRequests", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("an error settles the oldest request", () => {
    const first = vi.fn();
    const second = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "other", onError: first });
    queue.push({ kind: "other", onError: second });

    queue.settle(errorFrame("boom"));

    expect(first).toHaveBeenCalledWith("boom");
    expect(second).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
  });

  test("a broadcast state frame does not settle anything", () => {
    const onError = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "other", onError });

    queue.settle(stateFrame);

    expect(queue.size).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test("a pong does not settle anything", () => {
    const queue = new PendingRequests();
    queue.push({ kind: "other" });
    queue.settle({ kind: "pong" });
    expect(queue.size).toBe(1);
  });

  test("an unrecognised frame does not settle anything", () => {
    const queue = new PendingRequests();
    queue.push({ kind: "other" });
    queue.settle({ kind: "unknown" });
    expect(queue.size).toBe(1);
  });

  test("a targets frame delivers to a targets request", () => {
    const onTargets = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "targets", onTargets });

    queue.settle(targetsFrame);

    expect(onTargets).toHaveBeenCalledWith([{ id: "saved:abc", name: "My Server", kind: "proxy" }]);
    expect(queue.size).toBe(0);
  });

  test("a response settles the oldest request even when it is not a targets frame", () => {
    const queue = new PendingRequests();
    queue.push({ kind: "other" });
    queue.push({ kind: "targets" });

    queue.settle(recordFrame);

    expect(queue.size).toBe(1);
  });

  test("a state frame arriving between a request and its response keeps the queue aligned", () => {
    const onTargets = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "targets", onTargets });

    queue.settle(stateFrame);
    queue.settle(targetsFrame);

    expect(onTargets).toHaveBeenCalledOnce();
    expect(queue.size).toBe(0);
  });

  test("a timed out request stops calling back but still consumes its slot", () => {
    const onError = vi.fn();
    const onTargets = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "targets", onError, onTargets });

    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(onError).toHaveBeenCalledOnce();
    expect(queue.size).toBe(1);

    queue.settle(targetsFrame);
    expect(onTargets).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(queue.size).toBe(0);
  });

  test("clear settles everything outstanding with the given message", () => {
    const first = vi.fn();
    const second = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "other", onError: first });
    queue.push({ kind: "targets", onError: second });

    queue.clear("socket closed");

    expect(first).toHaveBeenCalledWith("socket closed");
    expect(second).toHaveBeenCalledWith("socket closed");
    expect(queue.size).toBe(0);
  });

  test("clear stops a cleared request from timing out afterwards", () => {
    const onError = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "other", onError });

    queue.clear("socket closed");
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS * 2);

    expect(onError).toHaveBeenCalledOnce();
  });

  test("overflowing the cap clears the queue rather than growing past it", () => {
    const onError = vi.fn();
    const queue = new PendingRequests();
    for (let i = 0; i < MAX_PENDING; i++) queue.push({ kind: "other", onError });

    expect(queue.size).toBe(MAX_PENDING);
    queue.push({ kind: "other" });

    expect(queue.size).toBe(1);
    expect(onError).toHaveBeenCalledTimes(MAX_PENDING);
  });
});
