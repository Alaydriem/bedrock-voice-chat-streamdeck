import { describe, expect, test } from "vitest";
import { renderStatKey } from "../src/stat-image";
import type { StatCell, StatView } from "../src/stat-view";

const PREFIX = "data:image/svg+xml;base64,";

const decode = (uri: string): string =>
  Buffer.from(uri.slice(PREFIX.length), "base64").toString("utf8");

const cell = (over: Partial<StatCell> = {}): StatView => ({
  kind: "cell",
  cell: { label: "RTT", value: "42", unit: "ms", ...over },
});

describe("renderStatKey", () => {
  test("returns a base64 SVG data URI", () => {
    expect(renderStatKey(cell()).startsWith(PREFIX)).toBe(true);
  });

  test("draws a 144 square on the plugin's background", () => {
    const svg = decode(renderStatKey(cell()));
    expect(svg).toContain('viewBox="0 0 144 144"');
    expect(svg).toContain('fill="#19102f"');
  });

  test("gives the stat the whole key, with its unit on its own line", () => {
    const svg = decode(renderStatKey(cell()));
    expect(svg).toContain(">RTT<");
    expect(svg).toContain(">42<");
    expect(svg).toContain(">ms<");
    expect(svg).toContain('font-size="46"');
  });

  test("omits the unit line for a stat that has no unit", () => {
    const svg = decode(renderStatKey(cell({ label: "LINK", value: "UP", unit: "" })));
    expect(svg.match(/<text/g)).toHaveLength(2);
  });

  test("drops the value size so a long one stays inside the key", () => {
    const svg = decode(renderStatKey(cell({ label: "OUT DEV", value: "VOICEMEETER", unit: "" })));
    expect(svg).toContain('font-size="30"');
    expect(svg).not.toContain('font-size="46"');
  });

  test("draws a message centred", () => {
    const svg = decode(renderStatKey({ kind: "message", text: "OFFLINE", tone: "normal" }));
    expect(svg).toContain(">OFFLINE<");
    expect(svg).toContain('text-anchor="middle"');
  });

  test("draws an alarm message in the alarm colour", () => {
    const svg = decode(renderStatKey({ kind: "message", text: "AUTH", tone: "alarm" }));
    expect(svg).toContain('fill="#ff8266"');
  });

  test("shrinks a long message so it fits the key", () => {
    const short = decode(renderStatKey({ kind: "message", text: "AUTH", tone: "alarm" }));
    const long = decode(renderStatKey({ kind: "message", text: "NO CLIENT", tone: "alarm" }));
    expect(short).toContain('font-size="24"');
    expect(long).toContain('font-size="18"');
  });

  test("escapes text, so a device name cannot break the image", () => {
    const svg = decode(renderStatKey(cell({ label: "MIC DEV", value: "FOCUSRITE & <CO>", unit: "" })));
    expect(svg).toContain("FOCUSRITE &amp; &lt;CO&gt;");
    expect(svg).not.toContain("<CO>");
  });

  test("the same view always produces the same string", () => {
    expect(renderStatKey(cell())).toBe(renderStatKey(cell()));
  });

  test("a different value produces a different string", () => {
    expect(renderStatKey(cell({ value: "42" }))).not.toBe(renderStatKey(cell({ value: "43" })));
  });
});
