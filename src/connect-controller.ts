import type { ActiveConnection, BvcCommand } from "./types";

/** What pressing a target key needs from the socket. Narrow, so it can be faked in tests. */
export interface ConnectTransport {
  readonly activeConnection: ActiveConnection | null;
  send(command: BvcCommand, opts?: { onError?: (message: string) => void }): boolean;
}

/** The client's wording when a target id names nothing it knows about. */
const UNKNOWN_TARGET_PREFIX = "No target with id";

/**
 * What a press on a key bound to `targetId` means.
 *
 *  - its own world is running  -> stop it
 *  - a different world is running -> switch to this one
 *  - nothing is running -> start it
 *
 * The switch sends both frames without waiting. That is safe because the client reads one
 * frame at a time and finishes each command before reading the next, so the disconnect
 * always completes before the connect is even read. Each frame carries its own error
 * callback, so a failure in either is reported on its own terms.
 *
 * Nothing here draws anything. The state frame the client broadcasts afterwards is what
 * moves the icon, so a press that fails leaves the key showing what is actually true.
 */
export function pressTarget(
  transport: ConnectTransport,
  targetId: string,
  onError: (message: string) => void,
): boolean {
  const live = transport.activeConnection;

  if (live === null) {
    return transport.send({ action: "connect", id: targetId }, { onError });
  }

  if (live.id === targetId) {
    return transport.send({ action: "disconnect" }, { onError });
  }

  const stopped = transport.send({ action: "disconnect" }, { onError });
  const started = transport.send({ action: "connect", id: targetId }, { onError });
  return stopped && started;
}

/**
 * Whether an error means the plugin's target list is stale.
 *
 * This is the one failure a retry can fix, so it is the one that triggers a refetch.
 */
export function isUnknownTargetError(message: string): boolean {
  return message.startsWith(UNKNOWN_TARGET_PREFIX);
}
