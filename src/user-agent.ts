/**
 * The `User-Agent` the plugin sends on the WebSocket upgrade request so BVC can tell
 * a Stream Deck apart from the desktop client and other consumers.
 *
 * Kept to a bare product/version token: the plugin UUID and the Stream Deck application
 * version added nothing BVC acts on, and they made every log line and client list entry
 * long enough to hide the part that matters.
 */

const PRODUCT = "StreamDeck";

/**
 * Stream Deck manifests declare four-part versions ("1.0.0.0"). The last segment is a build
 * counter this plugin never sets, so drop it when it is zero and keep semver-shaped output.
 */
function trimBuildSegment(version: string): string {
  const parts = version.split(".");
  return parts.length === 4 && parts[3] === "0" ? parts.slice(0, 3).join(".") : version;
}

/** Build the identity token, e.g. `StreamDeck/1.0.0`. */
export function buildUserAgent(pluginVersion: string | undefined): string {
  const version = pluginVersion?.trim();
  if (!version) return PRODUCT;
  return `${PRODUCT}/${trimBuildSegment(version)}`;
}
