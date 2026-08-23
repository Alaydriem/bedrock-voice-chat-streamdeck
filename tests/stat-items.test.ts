import { describe, expect, test } from "vitest";
import { groupStats } from "../src/stat-items";

const SNAPSHOT = {
  mic: { muted: false, device: "Yeti" },
  link: { rtt_ms: 42 },
  gpu: { temperature: 60 },
};

describe("groupStats", () => {
  test("offers a way to clear a slot before anything else", () => {
    const items = groupStats(SNAPSHOT);
    expect(items[0]).toEqual({ label: "None", value: "" });
  });

  test("groups the stats by section", () => {
    const groups = groupStats(SNAPSHOT).slice(1);
    expect(groups.map((group) => (group as { label: string }).label))
      .toEqual(["Link", "Microphone", "Other"]);
  });

  test("labels each entry and keeps its path as the value", () => {
    const groups = groupStats(SNAPSHOT).slice(1) as { label: string; children: unknown[] }[];
    const link = groups.find((group) => group.label === "Link");
    expect(link?.children).toEqual([{ label: "RTT", value: "link.rtt_ms" }]);
  });

  test("carries a stat the catalog has never seen", () => {
    const groups = groupStats(SNAPSHOT).slice(1) as { label: string; children: unknown[] }[];
    const other = groups.find((group) => group.label === "Other");
    expect(other?.children).toEqual([{ label: "TEMPERATURE", value: "gpu.temperature" }]);
  });

  test("says why there is nothing to pick when no snapshot has arrived", () => {
    expect(groupStats(null)).toEqual([
      { label: "Waiting for Bedrock Voice Chat", value: "", disabled: true },
    ]);
  });

  test("says the same for a snapshot carrying nothing selectable", () => {
    expect(groupStats({ peers: [] })).toEqual([
      { label: "Waiting for Bedrock Voice Chat", value: "", disabled: true },
    ]);
  });
});
