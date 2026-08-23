import { describe, expect, test } from "vitest";
import { groupTargets } from "../src/target-items";
import type { ConnectTarget } from "../src/types";

describe("groupTargets", () => {
  test("groups proxies and realms separately", () => {
    const targets: ConnectTarget[] = [
      { id: "saved:a", name: "Alpha", kind: "proxy" },
      { id: "realm:3", name: "Charlie", kind: "realm" },
      { id: "server:h:1", name: "Bravo", kind: "proxy" },
    ];

    expect(groupTargets(targets)).toEqual([
      {
        label: "Proxies",
        children: [
          { label: "Alpha", value: "saved:a" },
          { label: "Bravo", value: "server:h:1" },
        ],
      },
      { label: "Realms", children: [{ label: "Charlie", value: "realm:3" }] },
    ]);
  });

  test("omits a group with no entries", () => {
    const targets: ConnectTarget[] = [{ id: "realm:3", name: "Charlie", kind: "realm" }];
    expect(groupTargets(targets)).toEqual([
      { label: "Realms", children: [{ label: "Charlie", value: "realm:3" }] },
    ]);
  });

  test("reports an empty list as a disabled entry rather than an empty dropdown", () => {
    expect(groupTargets([])).toEqual([
      { label: "No Realms or proxies available", value: "", disabled: true },
    ]);
  });
});
