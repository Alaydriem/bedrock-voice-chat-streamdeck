import type { ConnectTarget } from "./types";

// These cross the wire to the Property Inspector as JSON, so both carry an index signature.
// Without one the SDK's `JsonObject` will not accept them, since a plain interface makes no
// promise about the keys it does not declare.

/** One entry in an sdpi-components datasource dropdown. */
export interface DataSourceItem {
  label: string;
  value: string;
  disabled?: boolean;
  [key: string]: string | boolean | undefined;
}

/** A named group of entries. */
export interface DataSourceGroup {
  label: string;
  children: DataSourceItem[];
  [key: string]: string | DataSourceItem[] | undefined;
}

const EMPTY: DataSourceItem = {
  label: "No Realms or proxies available",
  value: "",
  disabled: true,
};

function toItem(target: ConnectTarget): DataSourceItem {
  return { label: target.name, value: target.id };
}

/**
 * The dropdown contents for a list of targets.
 *
 * An empty list becomes one disabled entry rather than an empty dropdown, so the reason the
 * user has nothing to pick is visible on the page instead of being inferred from a blank
 * control.
 */
export function groupTargets(
  targets: readonly ConnectTarget[],
): (DataSourceItem | DataSourceGroup)[] {
  const proxies = targets.filter((target) => target.kind === "proxy").map(toItem);
  const realms = targets.filter((target) => target.kind === "realm").map(toItem);

  const groups: DataSourceGroup[] = [];
  if (proxies.length > 0) groups.push({ label: "Proxies", children: proxies });
  if (realms.length > 0) groups.push({ label: "Realms", children: realms });

  return groups.length > 0 ? groups : [EMPTY];
}
