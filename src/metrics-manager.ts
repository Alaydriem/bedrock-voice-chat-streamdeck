import WebSocket from "ws";
import streamDeck from "@elgato/streamdeck";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  readConnection,
  sameConnection,
} from "./connection-settings";
import { MetricsCore, type MetricsEvent } from "./metrics-core";
import { parseMetricsFrame, type HealthState, type Snapshot } from "./metrics-frame";
import type { GlobalSettings } from "./types";
import { buildUserAgent } from "./user-agent";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const STABLE_THRESHOLD_MS = 30000;
const WATCHDOG_MS = 1000;

/**
 * The `/metrics` subscription.
 *
 * A second socket rather than a second use of the command socket: this route is push-only,
 * authenticates at the handshake instead of per message, and carries a frame every second. It
 * shares nothing with the command protocol but the host, the port and the key.
 *
 * Opened only while a stat key is on screen. A user with no stat key never opens it, and the
 * client never pushes diagnostics into a plugin that would discard them.
 */
class MetricsManager {
  private ws: WebSocket | null = null;
  private host = DEFAULT_HOST;
  private port = DEFAULT_PORT;
  private key = "";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private backoffAttempts = 0;
  private intentionalClose = false;
  private listeners = new Set<(event: MetricsEvent) => void>();
  private userAgent = buildUserAgent(undefined);
  private readonly core = new MetricsCore();

  get snapshot(): Snapshot | null {
    return this.core.snapshot;
  }

  get health(): HealthState | null {
    return this.core.health;
  }

  get socketUp(): boolean {
    return this.core.socketUp;
  }

  get ageMs(): number | null {
    return this.core.ageMs(Date.now());
  }

  /** Read settings and watch for changes. Opens nothing: that waits for a stat key. */
  async initialize(): Promise<void> {
    this.userAgent = buildUserAgent(this.pluginVersion());

    this.applySettings(await streamDeck.settings.getGlobalSettings<GlobalSettings>());

    // A stat key already on the Stream Deck appears before this read finishes, so the endpoint
    // is only known now. If such a key is waiting, this is what opens its socket.
    if (this.core.markReady() === "open") {
      this.openSocket();
    }

    streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
      if (!this.applySettings(ev.settings)) return;
      if (!this.core.subscribed) return;

      streamDeck.logger.info("Metrics settings changed, reconnecting...");
      this.closeSocket();
      this.backoffAttempts = 0;
      this.openSocket();
    });
  }

  on(listener: (event: MetricsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A stat key appeared. */
  acquire(): void {
    if (this.core.acquire() !== "open") return;
    this.backoffAttempts = 0;
    this.openSocket();
  }

  /** A stat key went away. */
  release(): void {
    if (this.core.release() !== "close") return;
    this.closeSocket();
  }

  private pluginVersion(): string | undefined {
    try {
      return streamDeck.info.plugin.version;
    } catch {
      return undefined;
    }
  }

  /** Returns true when the endpoint changed. */
  private applySettings(settings: GlobalSettings): boolean {
    const next = readConnection(settings);
    const changed = !sameConnection(next, {
      host: this.host,
      port: this.port,
      key: this.key,
    });

    this.host = next.host;
    this.port = next.port;
    this.key = next.key;
    return changed;
  }

  private openSocket(): void {
    this.clearReconnect();

    if (this.ws !== null) {
      this.intentionalClose = true;
      this.ws.terminate();
      this.ws = null;
    }

    // The route refuses an upgrade with no key whenever the client has one configured, so an
    // attempt without one can only fail the handshake.
    if (this.key === "") {
      streamDeck.logger.warn(
        "No authentication key configured. The metrics stream cannot be subscribed to " +
          "without one.",
      );
      return;
    }

    this.intentionalClose = false;
    const url = `ws://${this.host}:${this.port}/metrics?key=${encodeURIComponent(this.key)}`;
    streamDeck.logger.info(`Subscribing to BVC metrics at ${this.host}:${this.port}/metrics`);

    const ws = new WebSocket(url, {
      maxPayload: 256 * 1024,
      headers: { "User-Agent": this.userAgent },
    });
    this.ws = ws;

    ws.on("error", (err) => {
      if (this.ws !== ws) return; // stale socket
      streamDeck.logger.error(`Metrics WebSocket error: ${err.message}`);
    });

    ws.on("open", () => {
      if (this.ws !== ws) return; // stale socket
      streamDeck.logger.info("Subscribed to BVC metrics");
      this.emit(this.core.setSocketUp(true));
      this.startWatchdog();
      this.startStableTimer();
    });

    ws.on("close", () => {
      if (this.ws !== ws) return; // stale socket — a new connection is already active
      this.stopWatchdog();
      this.stopStableTimer();
      this.ws = null;
      this.emit(this.core.setSocketUp(false));

      if (!this.intentionalClose && this.core.subscribed) {
        this.scheduleReconnect();
      }
    });

    ws.on("message", (raw) => {
      if (this.ws !== ws) return; // stale socket
      this.emit(this.core.applyFrame(parseMetricsFrame(raw.toString()), Date.now()));
    });
  }

  private closeSocket(): void {
    this.intentionalClose = true;
    this.clearReconnect();
    this.stopWatchdog();
    this.stopStableTimer();

    if (this.ws !== null) {
      this.ws.terminate();
      this.ws = null;
    }

    this.emit(this.core.setSocketUp(false));
  }

  private clearReconnect(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.backoffAttempts),
      RECONNECT_MAX_MS,
    );
    this.backoffAttempts++;
    streamDeck.logger.info(
      `Resubscribing to metrics in ${delay}ms (attempt ${this.backoffAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.core.subscribed) this.openSocket();
    }, delay);
  }

  /**
   * The staleness watchdog.
   *
   * No ping rides this route — nothing reads inbound frames on the client side, so a keepalive
   * would be answered by nothing. What matters is whether the data is current, and a client
   * whose voice session is down stops pushing while its socket stays perfectly healthy.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      this.emit(this.core.tick(Date.now()));
    }, WATCHDOG_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer === null) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private startStableTimer(): void {
    this.stableTimer = setTimeout(() => {
      this.backoffAttempts = 0;
    }, STABLE_THRESHOLD_MS);
  }

  private stopStableTimer(): void {
    if (this.stableTimer === null) return;
    clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private emit(events: readonly MetricsEvent[]): void {
    for (const event of events) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }
}

export const metricsManager = new MetricsManager();
