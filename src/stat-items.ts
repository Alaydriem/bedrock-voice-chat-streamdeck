import type { Snapshot } from "./metrics-frame";
import { labelFor, sectionFor, type StatSection } from "./stat-catalog";
import { flattenSnapshot } from "./stat-paths";
import type { DataSourceGroup, DataSourceItem } from "./target-items";

/** Sections in the order an operator reads them, link health first. */
const SECTION_ORDER: readonly StatSection[] = [
  "Link",
  "Microphone",
  "Playback",
  "Session",
  "Other",
];

const NONE: DataSourceItem = { label: "None", value: "" };

const WAITING: DataSourceItem = {
  label: "Waiting for Bedrock Voice Chat",
  value: "",
  disabled: true,
};

/**
 * The dropdown contents for a snapshot.
 *
 * With nothing received the list is one disabled entry rather than an empty control, so the
 * reason there is nothing to pick is on the page instead of being inferred from a blank
 * dropdown. This is how the Connect key already reports an empty target list.
 */
export function groupStats(snapshot: Snapshot | null): (DataSourceItem | DataSourceGroup)[] {
  const entries = flattenSnapshot(snapshot);
  if (entries.length === 0) return [WAITING];

  const groups: DataSourceGroup[] = [];

  for (const section of SECTION_ORDER) {
    const children = entries
      .filter((entry) => sectionFor(entry.path) === section)
      .map((entry): DataSourceItem => ({ label: labelFor(entry.path), value: entry.path }));

    if (children.length > 0) groups.push({ label: section, children });
  }

  return [NONE, ...groups];
}
