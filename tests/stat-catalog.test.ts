import { describe, expect, test } from "vitest";
import { formatValue, labelFor, sectionFor } from "../src/stat-catalog";

describe("labelFor", () => {
  test("gives a known path its short label", () => {
    expect(labelFor("link.rtt_ms")).toBe("RTT");
    expect(labelFor("link.worst_concealment_pct")).toBe("CONCEAL");
  });

  test("derives a label for a path it has never seen", () => {
    expect(labelFor("link.new_counter")).toBe("NEW COUNTER");
  });

  test("derives a label for a top-level path", () => {
    expect(labelFor("something")).toBe("SOMETHING");
  });
});

describe("sectionFor", () => {
  test("groups by the first path segment", () => {
    expect(sectionFor("link.rtt_ms")).toBe("Link");
    expect(sectionFor("mic.muted")).toBe("Microphone");
    expect(sectionFor("playback.deafened")).toBe("Playback");
    expect(sectionFor("session.server")).toBe("Session");
  });

  test("an unrecognised group is Other", () => {
    expect(sectionFor("gpu.temperature")).toBe("Other");
    expect(sectionFor("bare")).toBe("Other");
  });
});

describe("formatValue", () => {
  test("draws a value that is not measured as a dash", () => {
    expect(formatValue("link.jitter_buffer_ms", null)).toEqual({ value: "—", unit: "" });
  });

  // `smoothed_rtt_ms()` is QUIC-only and returns None over WSS and before the first sample.
  // The client's own pane does `link.rtt_ms ?? 0` (DiagnosticsView.ts:33), so the key shows
  // what the app shows rather than disagreeing with it on the same measurement.
  test("draws an unmeasured round-trip time the way the client's own pane does", () => {
    expect(formatValue("link.rtt_ms", null)).toEqual({ value: "0", unit: "ms" });
  });

  test("still draws a measured round-trip time of zero as zero", () => {
    expect(formatValue("link.rtt_ms", 0)).toEqual({ value: "0", unit: "ms" });
  });

  // The client keeps this one null on purpose: a capture rate of zero is an accusation that
  // the microphone stopped, and the tick with no previous reading must not be able to make it.
  test("leaves a stat the client deliberately reports as unmeasured alone", () => {
    expect(formatValue("mic.capture_frames_per_sec", null)).toEqual({ value: "—", unit: "" });
  });

  test("rounds a round-trip time to whole milliseconds", () => {
    expect(formatValue("link.rtt_ms", 42.7)).toEqual({ value: "43", unit: "ms" });
  });

  test("rounds a percentage to one decimal", () => {
    expect(formatValue("link.uplink_loss_pct", 0.4231)).toEqual({ value: "0.4", unit: "%" });
  });

  test("shortens a large count so it fits a cell", () => {
    expect(formatValue("link.datagrams_dropped", 12345).value).toBe("12.3k");
    expect(formatValue("link.datagrams_dropped", 2_400_000).value).toBe("2.4M");
  });

  test("does not shorten a port, which is an identifier and not a quantity", () => {
    expect(formatValue("link.quic_port", 19132)).toEqual({ value: "19132", unit: "" });
  });

  test("scales a sample rate reported in hertz", () => {
    expect(formatValue("mic.sample_rate", 48000)).toEqual({ value: "48.0", unit: "kHz" });
  });

  test("draws an uptime under a minute in seconds", () => {
    expect(formatValue("link.uptime_secs", 45)).toEqual({ value: "45s", unit: "" });
  });

  test("draws an uptime under an hour in minutes", () => {
    expect(formatValue("link.uptime_secs", 720)).toEqual({ value: "12m", unit: "" });
  });

  test("draws a longer uptime in hours and minutes", () => {
    expect(formatValue("link.uptime_secs", 3720)).toEqual({ value: "1h02", unit: "" });
  });

  test("draws a boolean with the words its stat calls for", () => {
    expect(formatValue("link.stalled", true).value).toBe("YES");
    expect(formatValue("link.stalled", false).value).toBe("NO");
    expect(formatValue("mic.muted", true).value).toBe("OFF");
    expect(formatValue("mic.muted", false).value).toBe("ON");
  });

  test("shortens the transport names, which do not fit as reported", () => {
    expect(formatValue("session.transport", "WebSocket").value).toBe("WSS");
    expect(formatValue("session.transport", "Quic").value).toBe("QUIC");
  });

  test("passes an unmapped transport through rather than hiding it", () => {
    expect(formatValue("session.transport", "Carrier Pigeon").value).toBe("CARRIER PIGEON");
  });

  test("upper-cases a text stat", () => {
    expect(formatValue("mic.device", "Blue Yeti")).toEqual({ value: "BLUE YETI", unit: "" });
  });

  test("formats an unknown numeric path to one decimal", () => {
    expect(formatValue("link.new_counter", 3.14159)).toEqual({ value: "3.1", unit: "" });
  });

  test("formats an unknown boolean path as yes or no", () => {
    expect(formatValue("link.new_flag", true).value).toBe("YES");
  });

  test("formats an unknown text path as text", () => {
    expect(formatValue("link.new_name", "hello").value).toBe("HELLO");
  });

  test("a value of the wrong type for its stat is not measured", () => {
    expect(formatValue("link.rtt_ms", "forty two")).toEqual({ value: "—", unit: "" });
  });
});
