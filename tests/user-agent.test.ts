import { describe, expect, test } from "vitest";
import { buildUserAgent } from "../src/user-agent";

describe("buildUserAgent", () => {
  test("drops the zero build segment from a manifest version", () => {
    expect(buildUserAgent("1.0.0.0")).toBe("StreamDeck/1.0.0");
  });

  test("keeps a non-zero build segment", () => {
    expect(buildUserAgent("1.2.3.4")).toBe("StreamDeck/1.2.3.4");
  });

  test("passes shorter versions through untouched", () => {
    expect(buildUserAgent("1.0.0")).toBe("StreamDeck/1.0.0");
    expect(buildUserAgent("2.1")).toBe("StreamDeck/2.1");
  });

  test("returns the bare product token when the version is unavailable", () => {
    expect(buildUserAgent(undefined)).toBe("StreamDeck");
    expect(buildUserAgent("")).toBe("StreamDeck");
    expect(buildUserAgent("   ")).toBe("StreamDeck");
  });
});
