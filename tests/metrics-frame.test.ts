import { describe, expect, test } from "vitest";
import { parseMetricsFrame } from "../src/metrics-frame";

const metrics = (data: unknown): string => JSON.stringify({ type: "metrics", data });
const health = (data: unknown): string => JSON.stringify({ type: "health", data });

describe("parseMetricsFrame", () => {
  test("returns unknown for text that is not JSON", () => {
    expect(parseMetricsFrame("not json").kind).toBe("unknown");
  });

  test("returns unknown for a JSON array", () => {
    expect(parseMetricsFrame("[1,2,3]").kind).toBe("unknown");
  });

  test("returns unknown for a frame with no type", () => {
    expect(parseMetricsFrame(JSON.stringify({ data: { rtt_ms: 42 } })).kind).toBe("unknown");
  });

  test("returns unknown for a type it does not recognise", () => {
    expect(parseMetricsFrame(JSON.stringify({ type: "rollup", data: {} })).kind).toBe("unknown");
  });

  test("returns unknown for a frame with no data", () => {
    expect(parseMetricsFrame(JSON.stringify({ type: "metrics" })).kind).toBe("unknown");
  });

  test("reads a metrics frame and keeps the payload whole", () => {
    const frame = parseMetricsFrame(metrics({ link: { rtt_ms: 42 }, captured_at_ms: 1700 }));
    expect(frame).toEqual({
      kind: "metrics",
      snapshot: { link: { rtt_ms: 42 }, captured_at_ms: 1700 },
    });
  });

  test("reads a connected health frame", () => {
    expect(parseMetricsFrame(health({ status: "Connected" }))).toEqual({
      kind: "health", health: { status: "Connected" },
    });
  });

  test("reads a reconnecting health frame and keeps the attempt", () => {
    expect(parseMetricsFrame(health({ status: "Reconnecting", attempt: 3 }))).toEqual({
      kind: "health", health: { status: "Reconnecting", attempt: 3 },
    });
  });

  test("a reconnecting frame with no attempt reads as attempt zero", () => {
    expect(parseMetricsFrame(health({ status: "Reconnecting" }))).toEqual({
      kind: "health", health: { status: "Reconnecting", attempt: 0 },
    });
  });

  test("reads a disconnected health frame", () => {
    expect(parseMetricsFrame(health({ status: "Disconnected" }))).toEqual({
      kind: "health", health: { status: "Disconnected" },
    });
  });

  test("reads a failed health frame", () => {
    expect(parseMetricsFrame(health({ status: "Failed" }))).toEqual({
      kind: "health", health: { status: "Failed" },
    });
  });

  test("reads a version mismatch, dropping the versions it does not draw", () => {
    const raw = health({
      status: "VersionMismatch",
      client_version: "1.0.0", server_version: "2.0.0", client_too_old: true,
    });
    expect(parseMetricsFrame(raw)).toEqual({
      kind: "health", health: { status: "VersionMismatch" },
    });
  });

  test("reads an unauthorized health frame, dropping the reason it does not draw", () => {
    const raw = health({ status: "Unauthorized", reason: "certificate rejected" });
    expect(parseMetricsFrame(raw)).toEqual({
      kind: "health", health: { status: "Unauthorized" },
    });
  });

  test("returns unknown for a health status it does not recognise", () => {
    expect(parseMetricsFrame(health({ status: "Ascended" })).kind).toBe("unknown");
  });
});
