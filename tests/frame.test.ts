import { describe, expect, test } from "vitest";
import { parseFrame } from "../src/frame";

const wrap = (data: unknown): string => JSON.stringify({ success: true, data });

describe("parseFrame", () => {
  test("returns unknown for text that is not JSON", () => {
    expect(parseFrame("not json").kind).toBe("unknown");
  });

  test("returns unknown for a JSON array", () => {
    expect(parseFrame("[1,2,3]").kind).toBe("unknown");
  });

  test("reads an error frame", () => {
    const frame = parseFrame(JSON.stringify({ success: false, error: "Invalid authentication key" }));
    expect(frame).toEqual({ kind: "error", message: "Invalid authentication key" });
  });

  test("reads an error frame with no message", () => {
    const frame = parseFrame(JSON.stringify({ success: false }));
    expect(frame).toEqual({ kind: "error", message: "unknown error" });
  });

  test("reads a pong", () => {
    expect(parseFrame(wrap({ pong: true })).kind).toBe("pong");
  });

  test("reads a targets frame", () => {
    const frame = parseFrame(wrap({
      targets: [
        { id: "saved:abc", name: "My Server", kind: "proxy" },
        { id: "realm:12345", name: "My Realm", kind: "realm" },
      ],
    }));
    expect(frame).toEqual({
      kind: "targets",
      targets: [
        { id: "saved:abc", name: "My Server", kind: "proxy" },
        { id: "realm:12345", name: "My Realm", kind: "realm" },
      ],
    });
  });

  test("drops targets with an unrecognised kind rather than the whole list", () => {
    const frame = parseFrame(wrap({
      targets: [
        { id: "saved:abc", name: "Good", kind: "proxy" },
        { id: "weird:1", name: "Bad", kind: "hyperspace" },
      ],
    }));
    expect(frame).toEqual({
      kind: "targets",
      targets: [{ id: "saved:abc", name: "Good", kind: "proxy" }],
    });
  });

  test("reads an empty targets list", () => {
    expect(parseFrame(wrap({ targets: [] }))).toEqual({ kind: "targets", targets: [] });
  });

  test("reads a mute response and does not mistake it for state", () => {
    const frame = parseFrame(wrap({ device: "input", muted: true }));
    expect(frame).toEqual({ kind: "mute", device: "input", muted: true });
  });

  test("reads a jukebox response and does not mistake it for mute or state", () => {
    expect(parseFrame(wrap({ muted: true }))).toEqual({ kind: "jukebox", muted: true });
  });

  test("reads a jukebox response reporting music playing", () => {
    expect(parseFrame(wrap({ muted: false }))).toEqual({ kind: "jukebox", muted: false });
  });

  test("still reads a mute response, which also carries muted", () => {
    expect(parseFrame(wrap({ device: "output", muted: true }))).toEqual({
      kind: "mute", device: "output", muted: true,
    });
  });

  test("reads jukebox_muted from a state frame", () => {
    const frame = parseFrame(wrap({
      muted: false, deafened: false, recording: false,
      voice_mode: "openMic", ptt_active: false, jukebox_muted: true, connection: null,
    }));
    expect(frame.kind === "state" && frame.state.jukeboxMuted).toBe(true);
  });

  test("a state frame with no jukebox_muted reads as music playing", () => {
    const frame = parseFrame(wrap({
      muted: false, deafened: false, recording: false,
      voice_mode: "openMic", ptt_active: false, connection: null,
    }));
    expect(frame.kind === "state" && frame.state.jukeboxMuted).toBe(false);
  });

  test("reads a full state frame with no active connection", () => {
    const frame = parseFrame(wrap({
      muted: false, deafened: true, recording: false,
      voice_mode: "openMic", ptt_active: false, jukebox_muted: false, connection: null,
    }));
    expect(frame).toEqual({
      kind: "state",
      state: {
        muted: false, deafened: true, recording: false,
        voiceMode: "openMic", pttActive: false, jukeboxMuted: false, connection: null,
      },
    });
  });

  test("reads a full state frame carrying an active connection", () => {
    const frame = parseFrame(wrap({
      muted: true, deafened: false, recording: false,
      voice_mode: "pushToTalk", ptt_active: true, jukebox_muted: true,
      connection: { id: "realm:12345", name: "My Realm", kind: "realm" },
    }));
    expect(frame).toEqual({
      kind: "state",
      state: {
        muted: true, deafened: false, recording: false,
        voiceMode: "pushToTalk", pttActive: true, jukeboxMuted: true,
        connection: { id: "realm:12345", name: "My Realm", kind: "realm" },
      },
    });
  });

  test("reports an unrecognised voice mode as not known", () => {
    const frame = parseFrame(wrap({
      muted: false, deafened: false, recording: false,
      voice_mode: "telepathy", ptt_active: false, connection: null,
    }));
    expect(frame.kind === "state" && frame.state.voiceMode).toBeNull();
  });

  test("reads a connect response and does not mistake it for record", () => {
    const frame = parseFrame(wrap({ connected: true, id: "saved:abc", name: "My Server" }));
    expect(frame).toEqual({ kind: "connect", connected: true, id: "saved:abc", name: "My Server" });
  });

  test("reads a disconnect response that found nothing running", () => {
    const frame = parseFrame(wrap({ connected: false, id: null, name: null }));
    expect(frame).toEqual({ kind: "connect", connected: false, id: null, name: null });
  });

  test("reads a record response", () => {
    expect(parseFrame(wrap({ recording: true }))).toEqual({ kind: "record", recording: true });
  });

  test("reads a ptt response", () => {
    expect(parseFrame(wrap({ active: true }))).toEqual({ kind: "ptt", active: true });
  });

  test("returns unknown for a success frame with no data", () => {
    expect(parseFrame(JSON.stringify({ success: true })).kind).toBe("unknown");
  });

  test("returns unknown for a data shape it does not recognise", () => {
    expect(parseFrame(wrap({ somethingNew: 42 })).kind).toBe("unknown");
  });
});
