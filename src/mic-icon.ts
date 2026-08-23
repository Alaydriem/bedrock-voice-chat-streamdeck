import type { BvcState } from "./types";

/** What the microphone key is showing, independent of which artwork draws it. */
export type MicIconState = "disconnected" | "muted" | "open" | "transmitting";

/** Just the fields the decision needs, so tests do not have to build a whole state. */
export type MicIconInput = Pick<
  BvcState,
  "connected" | "voiceMode" | "inputMuted" | "pttActive"
>;

/**
 * What the microphone key should show.
 *
 * There is no push-to-talk special case, because the client does not need one: holding the
 * key genuinely unmutes the input and releasing it genuinely mutes it again
 * (`dispatch_ptt_press` / `dispatch_ptt_release`). So `inputMuted` is already the truth in
 * both voice modes — push-to-talk simply rests at muted.
 *
 * `pttActive` only earns its own state so a registered hold looks different from a plain
 * unmute, which is how the user can see the press landed. It leads because the release tail
 * keeps the microphone open for 300 ms after the hold ends.
 */
export function micIconState(state: MicIconInput): MicIconState {
  if (!state.connected || state.voiceMode === null || state.inputMuted === null) {
    return "disconnected";
  }
  if (state.pttActive === true) return "transmitting";
  return state.inputMuted ? "muted" : "open";
}
