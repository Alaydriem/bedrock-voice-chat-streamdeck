import WebSocket from "ws";
import streamDeck from "@elgato/streamdeck";
import { parseFrame, type BvcFrame, type StateFrameData } from "./frame";
import { PendingRequests } from "./pending-requests";
import type {
  ActiveConnection,
  BvcCommand,
  BvcState,
  BvcStateEvent,
  ConnectTarget,
  GlobalSettings,
} from "./types";

export type StateListener = (event: BvcStateEvent) => void;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9595;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 15000;
const STABLE_THRESHOLD_MS = 30000;
const USER_AGENT_PRODUCT = "Stream Deck";
const DISCONNECTED_MESSAGE = "Disconnected from Bedrock Voice Chat";

/**
 * Backoff for the opening target listing.
 *
 * `targets` needs Xbox Live sign-in, which the client often completes seconds after its
 * WebSocket server starts accepting connections. Fetching once on open therefore loses the
 * race routinely, and without a retry the list stays empty for the whole session — every
 * Connect key then reports no target configured until someone opens a Property Inspector.
 */
const TARGETS_RETRY_MS = [5000, 15000, 45000];

/** Parse a port string, returning the default if empty/invalid. */
function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const n = typeof value === "number" ? value : parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : DEFAULT_PORT;
}

/**
 * Build the User-Agent sent on the WebSocket upgrade request so BVC can identify
 * the connecting client, e.g. `Stream Deck/6.9.1 (com.alaydriem...; plugin 1.0.0.0)`.
 * Registration info is only populated after `streamDeck.connect()`; fall back to the
 * bare product token if it is unavailable.
 */
function buildUserAgent(): string {
  try {
    const { application, plugin } = streamDeck.info;
    return `${USER_AGENT_PRODUCT}/${application.version} (${plugin.uuid}; plugin ${plugin.version})`;
  } catch {
    return USER_AGENT_PRODUCT;
  }
}

class WsManager {
  private ws: WebSocket | null = null;
  private host = DEFAULT_HOST;
  private port = DEFAULT_PORT;
  private authenticationKey = "";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private targetsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private targetsAttempts = 0;
  private awaitingPong = false;
  private backoffAttempts = 0;
  private intentionalClose = false;
  private listeners = new Set<StateListener>();
  private readonly pending = new PendingRequests();
  private userAgent = USER_AGENT_PRODUCT;

  public state: BvcState = {
    connected: false,
    inputMuted: null,
    outputMuted: null,
    recording: null,
    voiceMode: null,
    pttActive: null,
    connection: null,
    targets: [],
  };

  /** The world a session is running against, for `ConnectTransport`. */
  get activeConnection(): ActiveConnection | null {
    return this.state.connection;
  }

  async initialize(): Promise<void> {
    // Resolved here (not at construction) — registration info exists only post-connect.
    this.userAgent = buildUserAgent();

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

  /**
   * Send a command.
   *
   * `key` rides on every frame: the client refuses anything without it.
   *
   * `ping` and `state` are deliberately not enqueued. Their responses are shape-identical
   * to the frames the client broadcasts unprompted, so enqueuing them would make every
   * broadcast look like it might be an answer.
   */
  send(
    command: BvcCommand,
    opts?: {
      onError?: (message: string) => void;
      onTargets?: (targets: ConnectTarget[]) => void;
    },
  ): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (command.action !== "ping" && command.action !== "state") {
      this.pending.push({
        kind: command.action === "targets" ? "targets" : "other",
        onError: opts?.onError,
        onTargets: opts?.onTargets,
      });
    }

    this.ws.send(JSON.stringify({ ...command, key: this.authenticationKey }));
    return true;
  }

  /**
   * Fetch the target list, retrying a failure a few times before giving up.
   *
   * The common failure is a startup race: the socket is up before Xbox Live sign-in
   * finishes, and `targets` is all-or-nothing, so it errors outright. Retrying turns a
   * permanently empty list into a few seconds of waiting. A Property Inspector opening
   * always refetches regardless, which is the backstop once these attempts are spent.
   */
  private refreshTargets(): void {
    void this.requestTargets()
      .then(() => {
        this.targetsAttempts = 0;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown error";

        if (this.targetsAttempts >= TARGETS_RETRY_MS.length) {
          streamDeck.logger.warn(
            `Could not list connect targets: ${message}. Giving up until a property ` +
              "inspector asks again.",
          );
          return;
        }

        const delay = TARGETS_RETRY_MS[this.targetsAttempts]!;
        this.targetsAttempts++;
        streamDeck.logger.warn(
          `Could not list connect targets: ${message}. Retrying in ${delay}ms.`,
        );
        this.targetsRetryTimer = setTimeout(() => {
          this.targetsRetryTimer = null;
          this.refreshTargets();
        }, delay);
      });
  }

  private stopTargetsRetry(): void {
    if (this.targetsRetryTimer !== null) {
      clearTimeout(this.targetsRetryTimer);
      this.targetsRetryTimer = null;
    }
  }

  /** Ask the client what worlds it can connect to. */
  requestTargets(): Promise<readonly ConnectTarget[]> {
    return new Promise((resolve, reject) => {
      const sent = this.send(
        { action: "targets" },
        {
          onTargets: (targets) => resolve(targets),
          onError: (message) => reject(new Error(message)),
        },
      );
      if (!sent) {
        reject(new Error("Not connected to Bedrock Voice Chat"));
      }
    });
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

    // The client refuses every command without a key, including `ping` — a socket opened
    // here would fail its own keepalive and reconnect forever. Staying down is honest, and
    // every key draws disconnected until a key is configured.
    if (this.authenticationKey === "") {
      streamDeck.logger.warn(
        "No authentication key configured. Set one in the plugin settings — " +
          "Bedrock Voice Chat refuses every command without it.",
      );
      return;
    }

    this.intentionalClose = false;
    const url = `ws://${this.host}:${this.port}/ws`;
    streamDeck.logger.info(`Connecting to BVC at ${url}`);

    const ws = new WebSocket(url, {
      maxPayload: 64 * 1024,
      headers: { "User-Agent": this.userAgent },
    });
    this.ws = ws;

    ws.on("error", (err) => {
      if (this.ws !== ws) return; // stale socket
      streamDeck.logger.error(`WebSocket error: ${err.message}`);
    });

    ws.on("open", () => {
      if (this.ws !== ws) return; // stale socket
      streamDeck.logger.info("Connected to BVC");
      this.setConnected(true);
      this.send({ action: "state" });
      this.targetsAttempts = 0;
      this.refreshTargets();
      this.startPing();
      this.startStableTimer();
    });

    ws.on("close", () => {
      if (this.ws !== ws) return; // stale socket — new connection already active
      this.stopPing();
      this.stopStableTimer();
      this.stopTargetsRetry();
      this.ws = null;

      this.pending.clear(DISCONNECTED_MESSAGE);

      if (this.state.connected) {
        this.setConnected(false);
        this.clearReportedState();
      }

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    ws.on("message", (raw) => {
      if (this.ws !== ws) return; // stale socket
      const frame = parseFrame(raw.toString());
      if (frame.kind === "unknown") {
        streamDeck.logger.warn("Ignoring unrecognised WebSocket frame");
      }
      this.pending.settle(frame);
      this.applyFrame(frame);
    });
  }

  private disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.stopStableTimer();
    this.stopTargetsRetry();
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }

    this.pending.clear(DISCONNECTED_MESSAGE);
    if (this.state.connected) {
      this.setConnected(false);
      this.clearReportedState();
    }
  }

  private applyFrame(frame: BvcFrame): void {
    switch (frame.kind) {
      case "error":
        // The pending queue has already told whoever asked. This is for the log.
        streamDeck.logger.warn(`BVC error: ${frame.message}`);
        return;

      case "pong":
        this.awaitingPong = false;
        return;

      case "mute":
        if (frame.device === "input") this.setInputMuted(frame.muted);
        else this.setOutputMuted(frame.muted);
        return;

      case "state":
        this.applyState(frame.state);
        return;

      case "record":
        this.setRecording(frame.recording);
        return;

      case "ptt":
        this.setPttActive(frame.active);
        return;

      case "targets":
        this.setTargets(frame.targets);
        return;

      case "connect":
        // Nothing to draw: the client broadcasts a full state frame either way, and that
        // is the only thing the icons follow.
        streamDeck.logger.info(
          frame.connected
            ? `Connected to ${frame.name ?? "a world"}`
            : `Disconnected from ${frame.name ?? "nothing"}`,
        );
        return;

      case "unknown":
        return;
    }
  }

  private applyState(state: StateFrameData): void {
    this.setInputMuted(state.muted);
    this.setOutputMuted(state.deafened);
    this.setRecording(state.recording);
    this.setVoiceMode(state.voiceMode);
    this.setPttActive(state.pttActive);
    this.setActiveConnection(state.connection);
  }

  /** Everything the client reports becomes unknown when the socket goes away. */
  private clearReportedState(): void {
    this.setInputMuted(null);
    this.setOutputMuted(null);
    this.setRecording(null);
    this.setVoiceMode(null);
    this.setPttActive(null);
    this.setActiveConnection(null);
  }

  private setInputMuted(muted: boolean | null): void {
    if (this.state.inputMuted === muted) return;
    this.state.inputMuted = muted;
    this.emit({ type: "inputMuteChanged", muted });
  }

  private setOutputMuted(muted: boolean | null): void {
    if (this.state.outputMuted === muted) return;
    this.state.outputMuted = muted;
    this.emit({ type: "outputMuteChanged", muted });
  }

  private setRecording(recording: boolean | null): void {
    if (this.state.recording === recording) return;
    this.state.recording = recording;
    this.emit({ type: "recordingChanged", recording });
  }

  private setVoiceMode(voiceMode: BvcState["voiceMode"]): void {
    if (this.state.voiceMode === voiceMode) return;
    this.state.voiceMode = voiceMode;
    this.emit({ type: "voiceModeChanged", voiceMode });
  }

  private setPttActive(active: boolean | null): void {
    if (this.state.pttActive === active) return;
    this.state.pttActive = active;
    this.emit({ type: "pttActiveChanged", active });
  }

  private setActiveConnection(connection: ActiveConnection | null): void {
    const current = this.state.connection;
    if (current?.id === connection?.id) return;
    this.state.connection = connection;
    this.emit({ type: "activeConnectionChanged", connection });
  }

  private setTargets(targets: readonly ConnectTarget[]): void {
    this.state.targets = targets;
    this.emit({ type: "targetsChanged", targets });
  }

  private setConnected(connected: boolean): void {
    this.state.connected = connected;
    this.emit({ type: "connectionChanged", connected });
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
      this.awaitingPong = true;
      this.send({ action: "ping" });
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
