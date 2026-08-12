import { STALE_AFTER_MS } from "./metrics-core";
import type { HealthState, Snapshot } from "./metrics-frame";
import { formatValue, labelFor } from "./stat-catalog";
import { readPath } from "./stat-paths";

export interface StatCell {
  label: string;
  value: string;
  unit: string;
}

export type StatTone = "normal" | "alarm";

export type StatView =
  | { kind: "message"; text: string; tone: StatTone }
  | { kind: "cell"; cell: StatCell };

export interface StatViewInput {
  /** The configured stat, or `null` when the key has not been set up. */
  path: string | null;
  snapshot: Snapshot | null;
  /** Milliseconds since the last snapshot, or `null` if none has arrived. */
  ageMs: number | null;
  health: HealthState | null;
  /** The plugin's own `/metrics` socket. */
  socketUp: boolean;
}

/** The stat a key is configured with, treating an unset and an empty setting alike. */
export function configuredPath(settings: { stat?: string }): string | null {
  const path = settings.stat;
  return typeof path === "string" && path !== "" ? path : null;
}

function message(text: string, tone: StatTone = "normal"): StatView {
  return { kind: "message", text, tone };
}

/**
 * The word for a client that is not carrying a session, or `null` when it is.
 *
 * Only a refusal is an alarm. A disconnect and a reconnect are ordinary states of a client
 * working on it, and colouring those as alarms would cry wolf on every reconnect.
 */
function healthMessage(health: HealthState): StatView | null {
  switch (health.status) {
    case "Unauthorized":
      return message("AUTH", "alarm");
    case "VersionMismatch":
      return message("VERSION", "alarm");
    case "Failed":
      return message("FAILED", "alarm");
    case "Disconnected":
      return message("OFFLINE");
    case "Reconnecting":
      return message(`RETRY ${health.attempt}`);
    case "Connected":
      return null;
  }
}

function cell(path: string, snapshot: Snapshot | null): StatCell {
  const formatted = formatValue(path, readPath(snapshot, path));
  return { label: labelFor(path), value: formatted.value, unit: formatted.unit };
}

/**
 * What this key should draw right now.
 *
 * Most severe first. A shut socket outranks a health frame that says `Connected`, because that
 * frame stopped being current the moment the socket carrying it went away.
 */
export function statView(input: StatViewInput): StatView {
  const path = input.path;
  if (path === null) return message("NO STAT");
  if (!input.socketUp) return message("NO CLIENT", "alarm");

  // A stale snapshot is discarded rather than redrawn. Its numbers describe a moment that has
  // passed, and on a key there is nothing to say so except not showing them.
  const stale = input.ageMs === null || input.ageMs >= STALE_AFTER_MS;

  // Measurements outrank the health verdict, which exists to explain why they stopped. A
  // snapshot that arrived a second ago is proof the link is carrying traffic, whatever the
  // last verdict said — and because the client pushes health only when it changes, a verdict
  // that was already wrong when the socket opened is never corrected. Drawing it over live
  // numbers would hide them for the whole session.
  if (!stale) return { kind: "cell", cell: cell(path, input.snapshot) };

  if (input.health !== null) {
    const drawn = healthMessage(input.health);
    if (drawn !== null) return drawn;
  }

  return { kind: "cell", cell: cell(path, null) };
}
