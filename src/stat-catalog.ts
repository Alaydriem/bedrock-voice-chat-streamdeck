import type { StatValue } from "./stat-paths";

export type StatSection = "Link" | "Microphone" | "Playback" | "Session" | "Other";

type ValueFormat =
  | { kind: "number"; decimals: number; unit: string; scale?: number; plain?: boolean }
  | { kind: "duration" }
  | { kind: "boolean"; whenTrue: string; whenFalse: string }
  | { kind: "map"; values: Readonly<Record<string, string>> }
  | { kind: "text" };

interface StatDefinition {
  label: string;
  format: ValueFormat;
  /**
   * What to draw when the client reports this as not measured.
   *
   * Set only where the client's own diagnostics pane substitutes a value, so the two surfaces
   * cannot disagree about the same measurement. Left unset everywhere else, because a
   * substituted number is a claim: a loss percentage defaulted to zero would draw an
   * unmeasured link as a flawless one.
   */
  whenAbsent?: StatValue;
}

export interface FormattedValue {
  value: string;
  unit: string;
}

/** Below this a count is drawn as it is; above it, shortened, because a cell is six characters. */
const SHORTEN_ABOVE = 10_000;
const MILLION = 1_000_000;

const num = (
  decimals: number,
  unit = "",
  extra: { scale?: number; plain?: boolean } = {},
): ValueFormat => ({ kind: "number", decimals, unit, ...extra });

const bool = (whenTrue: string, whenFalse: string): ValueFormat =>
  ({ kind: "boolean", whenTrue, whenFalse });

const TEXT: ValueFormat = { kind: "text" };
const DURATION: ValueFormat = { kind: "duration" };

/**
 * The stats the client reports today, with a label short enough for a grid cell.
 *
 * Not a gate. A path missing from here is still offered — see `labelFor` and `inferFormat`.
 * This table only makes the known ones read well.
 */
const STAT_CATALOG: Readonly<Record<string, StatDefinition>> = {
  // QUIC-only, so `None` over WSS and before the first sample. `DiagnosticsView.ts:33` shows
  // it as 0, and a key that disagreed with the pane about the same number would be worse than
  // one that is imprecise about an unmeasured link.
  "link.rtt_ms": { label: "RTT", format: num(0, "ms"), whenAbsent: 0 },
  "link.rtt_variance_ms": { label: "JITTER", format: num(0, "ms") },
  "link.uplink_loss_pct": { label: "UP LOSS", format: num(1, "%") },
  "link.downlink_loss_pct": { label: "DN LOSS", format: num(1, "%") },
  "link.burst_loss_pct": { label: "BURST", format: num(1, "%") },
  "link.worst_concealment_pct": { label: "CONCEAL", format: num(1, "%") },
  "link.jitter_buffer_ms": { label: "BUFFER", format: num(0, "ms") },
  "link.jitter_buffer_drops": { label: "DROPS", format: num(0) },
  "link.datagrams_dropped": { label: "LOST", format: num(0) },
  "link.uptime_secs": { label: "UPTIME", format: DURATION },
  "link.paths_used": { label: "PATHS", format: num(0) },
  "link.quic_port": { label: "PORT", format: num(0, "", { plain: true }) },
  "link.family": { label: "IP", format: TEXT },
  "link.state": { label: "LINK", format: TEXT },
  "link.quality": { label: "QUALITY", format: TEXT },
  "link.stalled": { label: "STALLED", format: bool("YES", "NO") },
  "mic.capture_frames_per_sec": { label: "CAPTURE", format: num(0, "/s") },
  "mic.datagrams_per_sec": { label: "MIC TX", format: num(0, "/s") },
  "mic.noise_gate": { label: "GATE", format: TEXT },
  // A muted microphone is off. Labelling the mute itself would read as "MIC: YES".
  "mic.muted": { label: "MIC", format: bool("OFF", "ON") },
  "mic.sample_rate": { label: "MIC HZ", format: num(1, "kHz", { scale: 0.001 }) },
  "mic.device": { label: "MIC DEV", format: TEXT },
  "playback.datagrams_per_sec": { label: "RX", format: num(0, "/s") },
  "playback.muted_peer_count": { label: "MUTED", format: num(0) },
  "playback.deafened": { label: "DEAF", format: bool("YES", "NO") },
  "playback.sample_rate": { label: "OUT HZ", format: num(1, "kHz", { scale: 0.001 }) },
  "playback.device": { label: "OUT DEV", format: TEXT },
  "session.server": { label: "SERVER", format: TEXT },
  // `TransportKind` has no serde rename, so it arrives as its Rust variant names. "WEBSOCKET"
  // is too wide for a cell, and "WSS" is what the client's own debug pane calls it.
  "session.transport": {
    label: "VIA",
    format: { kind: "map", values: { Quic: "QUIC", WebSocket: "WSS" } },
  },
  "session.protocol_version": { label: "PROTO", format: TEXT },
  "session.proximity_range": { label: "RANGE", format: num(0, "m") },
  "session.falloff": { label: "FALLOFF", format: TEXT },
  "session.family_preference": { label: "IP PREF", format: TEXT },
};

const SECTIONS: Readonly<Record<string, StatSection>> = {
  link: "Link",
  mic: "Microphone",
  playback: "Playback",
  session: "Session",
};

const ABSENT: FormattedValue = { value: "—", unit: "" };

/** The short label for a stat, derived from the path when the catalog has never seen it. */
export function labelFor(path: string): string {
  const known = STAT_CATALOG[path];
  if (known !== undefined) return known.label;

  const last = path.split(".").pop() ?? path;
  return last.replace(/_/g, " ").toUpperCase();
}

/** Which dropdown group a stat belongs to. */
export function sectionFor(path: string): StatSection {
  const group = path.split(".")[0] ?? "";
  return SECTIONS[group] ?? "Other";
}

/** How to draw a value the catalog does not describe, from the value's own type. */
function inferFormat(value: StatValue): ValueFormat {
  if (typeof value === "number") return num(1);
  if (typeof value === "boolean") return bool("YES", "NO");
  return TEXT;
}

function formatNumber(
  value: StatValue,
  format: { decimals: number; unit: string; scale?: number; plain?: boolean },
): FormattedValue {
  if (typeof value !== "number" || !Number.isFinite(value)) return ABSENT;

  const scaled = value * (format.scale ?? 1);

  // A port is an identifier. Shortening it to "19.1k" would make it wrong rather than short.
  if (format.plain === true) return { value: String(scaled), unit: format.unit };

  const magnitude = Math.abs(scaled);
  if (magnitude >= MILLION) {
    return { value: `${(scaled / MILLION).toFixed(1)}M`, unit: format.unit };
  }
  if (magnitude >= SHORTEN_ABOVE) {
    return { value: `${(scaled / 1000).toFixed(1)}k`, unit: format.unit };
  }

  return { value: scaled.toFixed(format.decimals), unit: format.unit };
}

function formatDuration(value: StatValue): FormattedValue {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return ABSENT;

  const total = Math.floor(value);
  if (total < 60) return { value: `${total}s`, unit: "" };
  if (total < 3600) return { value: `${Math.floor(total / 60)}m`, unit: "" };

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return { value: `${hours}h${String(minutes).padStart(2, "0")}`, unit: "" };
}

/**
 * One value, ready to draw.
 *
 * The unit is returned apart from the value because the single-stat layout gives it its own
 * line, while the grid concatenates the two.
 */
export function formatValue(path: string, value: StatValue): FormattedValue {
  const definition = STAT_CATALOG[path];
  const resolved = value === null ? definition?.whenAbsent ?? null : value;
  if (resolved === null) return ABSENT;

  const format = definition?.format ?? inferFormat(resolved);

  switch (format.kind) {
    case "number":
      return formatNumber(resolved, format);

    case "duration":
      return formatDuration(resolved);

    case "boolean":
      return { value: resolved === true ? format.whenTrue : format.whenFalse, unit: "" };

    case "map": {
      const key = String(resolved);
      return { value: format.values[key] ?? key.toUpperCase(), unit: "" };
    }

    case "text":
      return { value: String(resolved).toUpperCase(), unit: "" };
  }
}
