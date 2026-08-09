import { describe, expect, test } from "vitest";
import { micIconState, type MicIconInput } from "../src/mic-icon";

const base: MicIconInput = {
  connected: true,
  voiceMode: "openMic",
  inputMuted: false,
  pttActive: false,
};

describe("micIconState", () => {
  test("disconnected when the socket is down", () => {
    expect(micIconState({ ...base, connected: false })).toBe("disconnected");
  });

  test("disconnected when the voice mode is not yet known", () => {
    expect(micIconState({ ...base, voiceMode: null })).toBe("disconnected");
  });

  test("disconnected when the mute state is not yet known", () => {
    expect(micIconState({ ...base, inputMuted: null })).toBe("disconnected");
  });

  test("open mic, unmuted, reads as open", () => {
    expect(micIconState(base)).toBe("open");
  });

  test("open mic, muted, reads as muted", () => {
    expect(micIconState({ ...base, inputMuted: true })).toBe("muted");
  });

  // Push-to-talk rests muted: dispatch_ptt_press unmutes and the release tail re-mutes.
  // Drawing this as open was the inversion reported from hardware.
  test("push-to-talk at rest reads as muted, not open", () => {
    expect(micIconState({
      ...base, voiceMode: "pushToTalk", inputMuted: true, pttActive: false,
    })).toBe("muted");
  });

  test("push-to-talk while held reads as transmitting", () => {
    expect(micIconState({
      ...base, voiceMode: "pushToTalk", inputMuted: false, pttActive: true,
    })).toBe("transmitting");
  });

  test("transmitting wins over the mute flag during the release tail", () => {
    expect(micIconState({
      ...base, voiceMode: "pushToTalk", inputMuted: true, pttActive: true,
    })).toBe("transmitting");
  });
});
