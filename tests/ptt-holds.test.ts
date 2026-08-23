import { describe, expect, test } from "vitest";
import { PttHolds } from "../src/ptt-holds";

describe("PttHolds", () => {
  test("a press asks for a press", () => {
    const holds = new PttHolds();
    expect(holds.apply({ type: "keyDown", actionId: "a" })).toBe("press");
    expect(holds.heldCount).toBe(1);
  });

  test("a release after a press asks for a release", () => {
    const holds = new PttHolds();
    holds.apply({ type: "keyDown", actionId: "a" });
    expect(holds.apply({ type: "keyUp", actionId: "a" })).toBe("release");
    expect(holds.heldCount).toBe(0);
  });

  test("a release with no press behind it asks for nothing", () => {
    const holds = new PttHolds();
    expect(holds.apply({ type: "keyUp", actionId: "a" })).toBe("none");
  });

  test("a key disappearing while held asks for a release", () => {
    const holds = new PttHolds();
    holds.apply({ type: "keyDown", actionId: "a" });
    expect(holds.apply({ type: "disappear", actionId: "a" })).toBe("release");
  });

  test("a key disappearing while not held asks for nothing", () => {
    const holds = new PttHolds();
    expect(holds.apply({ type: "disappear", actionId: "a" })).toBe("none");
  });

  test("two keys are tracked apart", () => {
    const holds = new PttHolds();
    holds.apply({ type: "keyDown", actionId: "a" });
    holds.apply({ type: "keyDown", actionId: "b" });
    expect(holds.apply({ type: "keyUp", actionId: "a" })).toBe("release");
    expect(holds.heldCount).toBe(1);
  });

  test("a socket dropping mid-hold defers the release to the next open", () => {
    const holds = new PttHolds();
    holds.apply({ type: "keyDown", actionId: "a" });

    expect(holds.apply({ type: "socketClosed" })).toBe("none");
    expect(holds.heldCount).toBe(0);
    expect(holds.hasPendingRelease).toBe(true);

    expect(holds.apply({ type: "socketOpened" })).toBe("release");
  });

  test("the deferred release fires only once", () => {
    const holds = new PttHolds();
    holds.apply({ type: "keyDown", actionId: "a" });
    holds.apply({ type: "socketClosed" });

    expect(holds.apply({ type: "socketOpened" })).toBe("release");
    expect(holds.apply({ type: "socketOpened" })).toBe("none");
    expect(holds.hasPendingRelease).toBe(false);
  });

  test("a socket dropping with nothing held defers nothing", () => {
    const holds = new PttHolds();
    holds.apply({ type: "socketClosed" });
    expect(holds.apply({ type: "socketOpened" })).toBe("none");
  });

  test("an open with no drop behind it asks for nothing", () => {
    const holds = new PttHolds();
    expect(holds.apply({ type: "socketOpened" })).toBe("none");
  });
});
