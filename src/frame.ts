import type { ActiveConnection, ConnectTarget, ConnectTargetKind, VoiceMode } from "./types";

/** The parsed contents of a state frame, whether solicited or broadcast. */
export interface StateFrameData {
  muted: boolean;
  deafened: boolean;
  recording: boolean;
  voiceMode: VoiceMode | null;
  pttActive: boolean;
  connection: ActiveConnection | null;
}

export type BvcFrame =
  | { kind: "error"; message: string }
  | { kind: "pong" }
  | { kind: "targets"; targets: ConnectTarget[] }
  | { kind: "mute"; device: "input" | "output"; muted: boolean }
  | { kind: "state"; state: StateFrameData }
  | { kind: "connect"; connected: boolean; id: string | null; name: string | null }
  | { kind: "record"; recording: boolean }
  | { kind: "ptt"; active: boolean }
  | { kind: "unknown" };

const UNKNOWN: BvcFrame = { kind: "unknown" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toKind(value: unknown): ConnectTargetKind | null {
  return value === "proxy" || value === "realm" ? value : null;
}

function toVoiceMode(value: unknown): VoiceMode | null {
  return value === "openMic" || value === "pushToTalk" ? value : null;
}

/** A target or an active connection — the same three fields on the wire. */
function toTarget(value: unknown): ConnectTarget | null {
  if (!isRecord(value)) return null;
  const kind = toKind(value.kind);
  if (typeof value.id !== "string" || typeof value.name !== "string" || kind === null) {
    return null;
  }
  return { id: value.id, name: value.name, kind };
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Turn one raw WebSocket message into a frame.
 *
 * The client's `ResponseData` is an untagged enum, so the shape is all there is to go on.
 * The order below has no collisions against the current payloads: `mute` is checked before
 * `state` because a mute response also carries `muted`, and `connect` before `record`
 * because a record response is the more permissive shape of the two.
 */
export function parseFrame(raw: string): BvcFrame {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return UNKNOWN;
  }

  if (!isRecord(message)) return UNKNOWN;

  if (message.success === false) {
    return { kind: "error", message: toOptionalString(message.error) ?? "unknown error" };
  }

  const data = message.data;
  if (!isRecord(data)) return UNKNOWN;

  if (data.pong === true) return { kind: "pong" };

  if (Array.isArray(data.targets)) {
    const targets = data.targets
      .map(toTarget)
      .filter((target): target is ConnectTarget => target !== null);
    return { kind: "targets", targets };
  }

  if ((data.device === "input" || data.device === "output") && typeof data.muted === "boolean") {
    return { kind: "mute", device: data.device, muted: data.muted };
  }

  if (
    typeof data.muted === "boolean" &&
    typeof data.deafened === "boolean" &&
    typeof data.recording === "boolean"
  ) {
    return {
      kind: "state",
      state: {
        muted: data.muted,
        deafened: data.deafened,
        recording: data.recording,
        voiceMode: toVoiceMode(data.voice_mode),
        pttActive: data.ptt_active === true,
        connection: toTarget(data.connection),
      },
    };
  }

  if (typeof data.connected === "boolean") {
    return {
      kind: "connect",
      connected: data.connected,
      id: toOptionalString(data.id),
      name: toOptionalString(data.name),
    };
  }

  if (typeof data.recording === "boolean") return { kind: "record", recording: data.recording };
  if (typeof data.active === "boolean") return { kind: "ptt", active: data.active };

  return UNKNOWN;
}
