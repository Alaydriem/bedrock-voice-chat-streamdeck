import WebSocket from "ws";
import streamDeck from "@elgato/streamdeck";
import type { BvcCommand, BvcState, BvcStateEvent, GlobalSettings } from "./types";

export type StateListener = (event: BvcStateEvent) => void;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9595;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 15000;
const STABLE_THRESHOLD_MS = 30000;

/** Parse a port string, returning the default if empty/invalid. */
function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const n = typeof value === "number" ? value : parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : DEFAULT_PORT;
}

class WsManager {
  private ws: WebSocket | null = null;
  private host = DEFAULT_HOST;
  private port = DEFAULT_PORT;
  private authenticationKey = "";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;
  private backoffAttempts = 0;
  private intentionalClose = false;
  private listeners = new Set<StateListener>();
  private pendingErrorCallback: (() => void) | null = null;

  public state: BvcState = {
    connected: false,
    inputMuted: null,
    outputMuted: null,
    recording: null,
  };

  async initialize(): Promise<void> {
    const globalSettings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
    this.applySettings(globalSettings);

    streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
      const changed = this.applySettings(ev.settings);
      if (changed) {
        streamDeck.logger.info(`Settings changed (${this.host}:${this.port}), reconnecting...`);
        this.disconnect();
        this.backoffAttempts = 0;
        this.connect();
      }
    });

    this.connect();
  }

  /** Apply settings, return true if connection-relevant values changed. */
  private applySettings(s: GlobalSettings): boolean {
    const newHost = s.host?.trim() || DEFAULT_HOST;
    const newPort = parsePort(s.port);
    const newKey = s.authenticationKey?.trim() ?? "";

    const changed = newHost !== this.host || newPort !== this.port || newKey !== this.authenticationKey;
    this.host = newHost;
    this.port = newPort;
    this.authenticationKey = newKey;
    return changed;
  }

  on(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(cmd: BvcCommand, onError?: () => void): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }
    const payload: Record<string, unknown> = { ...cmd };
    if (this.authenticationKey) {
      payload.key = this.authenticationKey;
    }
    this.pendingErrorCallback = onError ?? null;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  private connect(): void {
    // Clear any pending reconnect
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Terminate any existing connection
    if (this.ws) {
      this.intentionalClose = true;
      this.ws.terminate();
      this.ws = null;
    }

    this.intentionalClose = false;
    const url = `ws://${this.host}:${this.port}/ws`;
    streamDeck.logger.info(`Connecting to BVC at ${url}`);

    const ws = new WebSocket(url, { maxPayload: 64 * 1024 });

    ws.on("error", (err) => {
      streamDeck.logger.error(`WebSocket error: ${err.message}`);
    });

    ws.on("open", () => {
      streamDeck.logger.info("Connected to BVC");
      this.setConnected(true);
      this.send({ action: "state" });
      this.startPing();
      this.startStableTimer();
    });

    ws.on("close", () => {
      this.stopPing();
      this.stopStableTimer();
      this.ws = null;

      if (this.state.connected) {
        this.setConnected(false);
        this.setDisconnectedState();
      }

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    ws.on("pong", () => {
      this.awaitingPong = false;
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== "object") return;

        // Error response — alert the key that triggered it
        if (msg.success === false) {
          streamDeck.logger.warn(`BVC error: ${msg.error ?? "unknown"}`);
          this.pendingErrorCallback?.();
          this.pendingErrorCallback = null;
          return;
        }

        if (!msg.data) return;
        this.handleMessage(msg.data);
      } catch {
        streamDeck.logger.warn("Failed to parse WebSocket message");
      }
    });

    this.ws = ws;
  }

  private disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.stopStableTimer();
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    if (this.state.connected) {
      this.setConnected(false);
      this.setDisconnectedState();
    }
  }

  private handleMessage(data: Record<string, unknown>): void {
    // Pong response
    if (data.pong === true) {
      return;
    }

    // Mute response
    if (data.device === "input" && typeof data.muted === "boolean") {
      if (this.state.inputMuted !== data.muted) {
        this.state.inputMuted = data.muted;
        this.emit({ type: "inputMuteChanged", muted: data.muted });
      }
      return;
    }

    if (data.device === "output" && typeof data.muted === "boolean") {
      if (this.state.outputMuted !== data.muted) {
        this.state.outputMuted = data.muted;
        this.emit({ type: "outputMuteChanged", muted: data.muted });
      }
      return;
    }

    // Full state (from state command or server broadcast)
    if (typeof data.muted === "boolean" &&
        typeof data.deafened === "boolean" &&
        typeof data.recording === "boolean") {
      if (this.state.inputMuted !== data.muted) {
        this.state.inputMuted = data.muted;
        this.emit({ type: "inputMuteChanged", muted: data.muted });
      }
      if (this.state.outputMuted !== data.deafened) {
        this.state.outputMuted = data.deafened;
        this.emit({ type: "outputMuteChanged", muted: data.deafened });
      }
      if (this.state.recording !== data.recording) {
        this.state.recording = data.recording;
        this.emit({ type: "recordingChanged", recording: data.recording });
      }
      return;
    }

    // Record response
    if (typeof data.recording === "boolean") {
      if (this.state.recording !== data.recording) {
        this.state.recording = data.recording;
        this.emit({ type: "recordingChanged", recording: data.recording });
      }
    }
  }

  private setConnected(connected: boolean): void {
    this.state.connected = connected;
    this.emit({ type: "connectionChanged", connected });
  }

  private setDisconnectedState(): void {
    if (this.state.inputMuted !== null) {
      this.state.inputMuted = null;
      this.emit({ type: "inputMuteChanged", muted: null });
    }
    if (this.state.outputMuted !== null) {
      this.state.outputMuted = null;
      this.emit({ type: "outputMuteChanged", muted: null });
    }
    if (this.state.recording !== null) {
      this.state.recording = null;
      this.emit({ type: "recordingChanged", recording: null });
    }
  }

  private emit(event: BvcStateEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.backoffAttempts),
      RECONNECT_MAX_MS,
    );
    this.backoffAttempts++;
    streamDeck.logger.info(`Reconnecting in ${delay}ms (attempt ${this.backoffAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      if (this.awaitingPong) {
        streamDeck.logger.warn("Pong not received, terminating connection");
        this.ws?.terminate();
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.awaitingPong = true;
        this.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.awaitingPong = false;
  }

  private startStableTimer(): void {
    this.stableTimer = setTimeout(() => {
      this.backoffAttempts = 0;
    }, STABLE_THRESHOLD_MS);
  }

  private stopStableTimer(): void {
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }
}

export const wsManager = new WsManager();
