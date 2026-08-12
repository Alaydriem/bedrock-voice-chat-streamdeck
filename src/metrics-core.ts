import type { HealthState, MetricsFrame, Snapshot } from "./metrics-frame";

/**
 * How long a snapshot may go unrefreshed before its numbers stop being drawn.
 *
 * Three missed pushes at the client's 1 Hz cadence. Holding the last number past that would
 * draw a dead link as a healthy one, which is the failure this stream exists to report.
 */
export const STALE_AFTER_MS = 3000;

export type MetricsEvent = "snapshot" | "health" | "socket" | "stale";

/**
 * The decisions the metrics subscription makes, with no socket and no timers.
 *
 * Split from the transport for the reason `pending-requests.ts` is split from `ws-manager.ts`:
 * reference counting, staleness and frame application are the parts that can be wrong, and
 * none of them need a WebSocket to exercise.
 */
export class MetricsCore {
  private refs = 0;
  private open = false;

  // Whether the settings holding the host, port and key have been read yet. A key already
  // sitting on the Stream Deck appears before that read finishes, and a socket opened then
  // would have no key to authenticate with.
  private ready = false;
  private lastSnapshot: Snapshot | null = null;
  private lastFrameAtMs: number | null = null;
  private lastHealth: HealthState | null = null;

  // Starts true: nothing has arrived, so nothing is fresh. Without this the first snapshot
  // would report no change and a key waiting on the event would never draw.
  private staleReported = true;

  get subscribed(): boolean {
    return this.refs > 0;
  }

  get socketUp(): boolean {
    return this.open;
  }

  get snapshot(): Snapshot | null {
    return this.lastSnapshot;
  }

  get health(): HealthState | null {
    return this.lastHealth;
  }

  ageMs(nowMs: number): number | null {
    return this.lastFrameAtMs === null ? null : nowMs - this.lastFrameAtMs;
  }

  isStale(nowMs: number): boolean {
    const age = this.ageMs(nowMs);
    return age === null || age >= STALE_AFTER_MS;
  }

  /**
   * The settings have been read, so an endpoint is known.
   *
   * Returns "open" when a key was already waiting on it. Without this a key that was on screen
   * at startup takes the reference, fails to connect with an empty key, and is never asked
   * again — the reference count says it is already handled.
   */
  markReady(): "open" | "none" {
    if (this.ready) return "none";
    this.ready = true;
    return this.refs > 0 ? "open" : "none";
  }

  /**
   * A stat key appeared. "open" only on the first, and only once an endpoint is known.
   *
   * A key that arrives before the settings do is still counted; `markReady` opens the socket
   * for it.
   */
  acquire(): "open" | "none" {
    this.refs += 1;
    if (this.refs !== 1) return "none";
    return this.ready ? "open" : "none";
  }

  /** A stat key went away. "close" only on the last. A release with nothing behind it is a no-op. */
  release(): "close" | "none" {
    if (this.refs === 0) return "none";
    this.refs -= 1;
    return this.refs === 0 ? "close" : "none";
  }

  /**
   * The socket came up or went down.
   *
   * Nothing measured survives the socket going down. A number kept from before the drop would
   * be drawn as current the moment the socket came back, before any frame had arrived.
   */
  setSocketUp(up: boolean): MetricsEvent[] {
    if (this.open === up) return [];
    this.open = up;

    if (!up) {
      this.lastSnapshot = null;
      this.lastFrameAtMs = null;
      this.lastHealth = null;
      this.staleReported = true;
    }

    return ["socket"];
  }

  applyFrame(frame: MetricsFrame, nowMs: number): MetricsEvent[] {
    switch (frame.kind) {
      case "metrics": {
        this.lastSnapshot = frame.snapshot;
        this.lastFrameAtMs = nowMs;

        const events: MetricsEvent[] = ["snapshot"];
        if (this.staleReported) {
          this.staleReported = false;
          events.push("stale");
        }
        return events;
      }

      case "health":
        this.lastHealth = frame.health;
        return ["health"];

      case "unknown":
        return [];
    }
  }

  /**
   * The watchdog.
   *
   * Non-empty only when staleness changes, so a quiet second costs no redraw. Without this a
   * key that stopped receiving frames would keep drawing its last numbers forever: there is no
   * frame to trigger the redraw that would clear them.
   */
  tick(nowMs: number): MetricsEvent[] {
    const stale = this.isStale(nowMs);
    if (stale === this.staleReported) return [];
    this.staleReported = stale;
    return ["stale"];
  }
}
