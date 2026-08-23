import type { Snapshot } from "./metrics-frame";

/** A leaf of the snapshot. `null` means the client is not measuring it right now. */
export type StatValue = number | string | boolean | null;

export interface StatEntry {
  path: string;
  value: StatValue;
}

/**
 * Paths that are in the snapshot but are not stats.
 *
 * `captured_at_ms` is the timestamp the staleness check reads. `meter_events_per_sec` counts
 * the client's own webview paints, which describes its renderer and nothing a controller can
 * act on.
 */
const HIDDEN_PATHS: ReadonlySet<string> = new Set(["captured_at_ms", "meter_events_per_sec"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A scalar, or `undefined` when the value is not a leaf at all. */
function toStatValue(value: unknown): StatValue | undefined {
  if (value === null) return null;
  const type = typeof value;
  if (type === "number" || type === "string" || type === "boolean") {
    return value as StatValue;
  }
  return undefined;
}

function walk(node: Record<string, unknown>, prefix: string, entries: StatEntry[]): void {
  for (const [key, raw] of Object.entries(node)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (HIDDEN_PATHS.has(path)) continue;

    // Arrays are out of scope. A per-speaker row and an RTT history are lists, and a key holds
    // one number.
    if (Array.isArray(raw)) continue;

    if (isRecord(raw)) {
      walk(raw, path, entries);
      continue;
    }

    const value = toStatValue(raw);
    if (value === undefined) continue;
    entries.push({ path, value });
  }
}

/**
 * Everything in this snapshot a key could show, in the order the client reported it.
 *
 * The order is the Rust struct's field order, preserved through JSON, which is why the
 * dropdown reads in a sensible order without the plugin knowing any of the names.
 */
export function flattenSnapshot(snapshot: Snapshot | null): StatEntry[] {
  if (snapshot === null) return [];
  const entries: StatEntry[] = [];
  walk(snapshot, "", entries);
  return entries;
}

/** Read one path. Anything missing, or anything that is not a scalar, is not measured. */
export function readPath(snapshot: Snapshot | null, path: string): StatValue {
  if (snapshot === null) return null;

  let node: unknown = snapshot;
  for (const segment of path.split(".")) {
    if (!isRecord(node)) return null;
    node = node[segment];
  }

  const value = toStatValue(node);
  return value === undefined ? null : value;
}
