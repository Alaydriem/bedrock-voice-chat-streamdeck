/**
 * The client's diagnostics snapshot, left exactly as it arrived.
 *
 * Deliberately untyped. The plugin walks this to discover what it can offer rather than
 * reading named fields, which is what lets a stat added to the client appear in the dropdown
 * without a plugin release. Typing it here would turn every client change into a plugin change.
 */
export type Snapshot = Record<string, unknown>;

/**
 * Why the snapshot stream is silent, or that it is not.
 *
 * The client's `ConnectionHealth` carries versions and a refusal reason on two of its variants.
 * Neither fits on a key, so neither is kept: a controller draws the status word and nothing
 * else.
 */
export type HealthState =
  | { status: "Connected" }
  | { status: "Reconnecting"; attempt: number }
  | { status: "Disconnected" }
  | { status: "Failed" }
  | { status: "VersionMismatch" }
  | { status: "Unauthorized" };

export type MetricsFrame =
  | { kind: "metrics"; snapshot: Snapshot }
  | { kind: "health"; health: HealthState }
  | { kind: "unknown" };

const UNKNOWN: MetricsFrame = { kind: "unknown" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toHealth(data: Record<string, unknown>): HealthState | null {
  switch (data.status) {
    case "Connected":
      return { status: "Connected" };
    case "Reconnecting":
      return {
        status: "Reconnecting",
        attempt: typeof data.attempt === "number" ? data.attempt : 0,
      };
    case "Disconnected":
      return { status: "Disconnected" };
    case "Failed":
      return { status: "Failed" };
    case "VersionMismatch":
      return { status: "VersionMismatch" };
    case "Unauthorized":
      return { status: "Unauthorized" };
    default:
      return null;
  }
}

/**
 * Turn one raw `/metrics` message into a frame.
 *
 * This route tags every frame with `type`, so there is no shape guessing here — unlike the
 * command socket, whose responses are an untagged Rust enum.
 */
export function parseMetricsFrame(raw: string): MetricsFrame {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return UNKNOWN;
  }

  if (!isRecord(message)) return UNKNOWN;

  const data = message.data;
  if (!isRecord(data)) return UNKNOWN;

  if (message.type === "metrics") return { kind: "metrics", snapshot: data };

  if (message.type === "health") {
    const health = toHealth(data);
    return health === null ? UNKNOWN : { kind: "health", health };
  }

  return UNKNOWN;
}
