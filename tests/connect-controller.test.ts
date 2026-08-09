import { describe, expect, test } from "vitest";
import { isUnknownTargetError, pressTarget } from "../src/connect-controller";
import type { ActiveConnection, BvcCommand } from "../src/types";

function fakeTransport(activeConnection: ActiveConnection | null, sendResult = true) {
  const sent: BvcCommand[] = [];
  return {
    sent,
    transport: {
      activeConnection,
      send(command: BvcCommand): boolean {
        sent.push(command);
        return sendResult;
      },
    },
  };
}

const live: ActiveConnection = { id: "saved:a", name: "Alpha", kind: "proxy" };
const noop = (): void => {};

describe("pressTarget", () => {
  test("connects when nothing is running", () => {
    const { sent, transport } = fakeTransport(null);
    expect(pressTarget(transport, "saved:a", noop)).toBe(true);
    expect(sent).toEqual([{ action: "connect", id: "saved:a" }]);
  });

  test("disconnects when this key's own target is running", () => {
    const { sent, transport } = fakeTransport(live);
    pressTarget(transport, "saved:a", noop);
    expect(sent).toEqual([{ action: "disconnect" }]);
  });

  test("switches when a different target is running, disconnect first", () => {
    const { sent, transport } = fakeTransport(live);
    pressTarget(transport, "realm:3", noop);
    expect(sent).toEqual([
      { action: "disconnect" },
      { action: "connect", id: "realm:3" },
    ]);
  });

  test("reports failure when the socket refuses the frame", () => {
    const { transport } = fakeTransport(null, false);
    expect(pressTarget(transport, "saved:a", noop)).toBe(false);
  });

  test("reports failure when a switch cannot be sent", () => {
    const { transport } = fakeTransport(live, false);
    expect(pressTarget(transport, "realm:3", noop)).toBe(false);
  });
});

describe("isUnknownTargetError", () => {
  test("recognises the client's unknown-id error", () => {
    expect(isUnknownTargetError("No target with id saved:gone")).toBe(true);
  });

  test("does not match other errors", () => {
    expect(isUnknownTargetError("Invalid authentication key")).toBe(false);
    expect(isUnknownTargetError("Proxy is already running.")).toBe(false);
  });
});
