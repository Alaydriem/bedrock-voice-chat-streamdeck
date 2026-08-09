import streamDeck, {
  action,
  SingletonAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { icons } from "../icons";
import { micIconState } from "../mic-icon";
import { PttHolds } from "../ptt-holds";
import type { ActionSettings } from "../types";
import { wsManager } from "../ws-manager";

/**
 * The microphone key. One control, two behaviours, chosen by the client's voice mode:
 *
 *  - open mic      press toggles input mute; the release means nothing
 *  - push-to-talk  press opens the microphone, release closes it
 *
 * The mode is not a plugin setting. It is whatever the client last reported, which is why
 * `voice_mode` rides every state frame — a key that offered a toggle in push-to-talk would
 * be a second word for a state the hold already owns, and the client refuses it outright.
 *
 * The release is owned here. The client will not close the microphone by itself if the
 * connection drops mid-hold, so a release is sent on key up, on the key going away, and once
 * on the next open after a drop.
 */
@action({ UUID: "com.alaydriem.bedrock-voice-chat.streamdeck.mute" })
export class MuteAction extends SingletonAction<ActionSettings> {
  private subscribed = false;
  private readonly holds = new PttHolds();

  override onWillAppear(ev: WillAppearEvent<ActionSettings>): void {
    if (!this.subscribed) {
      this.subscribed = true;
      wsManager.on((event) => {
        if (event.type === "connectionChanged") {
          const outcome = this.holds.apply({
            type: event.connected ? "socketOpened" : "socketClosed",
          });
          if (outcome === "release") this.sendRelease();
        }
        if (
          event.type === "connectionChanged" ||
          event.type === "inputMuteChanged" ||
          event.type === "voiceModeChanged" ||
          event.type === "pttActiveChanged"
        ) {
          this.updateAllIcons();
        }
      });
    }
    if (ev.action.isKey()) {
      void ev.action.setImage(this.getIcon());
    }
  }

  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    if (this.holds.apply({ type: "disappear", actionId: ev.action.id }) === "release") {
      this.sendRelease();
    }
  }

  override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    const mode = wsManager.state.voiceMode;

    // No state frame has arrived, so which command this key means is not yet known.
    if (mode === null) {
      await ev.action.showAlert();
      return;
    }

    if (mode === "pushToTalk") {
      this.holds.apply({ type: "keyDown", actionId: ev.action.id });
    }

    const command = mode === "pushToTalk"
      ? ({ action: "ptt", down: true } as const)
      : ({ action: "mute", device: "input" } as const);

    const sent = wsManager.send(command, {
      onError: () => void ev.action.showAlert(),
    });
    if (!sent) {
      await ev.action.showAlert();
    }
  }

  override async onKeyUp(ev: KeyUpEvent<ActionSettings>): Promise<void> {
    // In open mic the press already did the work; a toggle has no release.
    if (this.holds.apply({ type: "keyUp", actionId: ev.action.id }) !== "release") return;

    const sent = wsManager.send(
      { action: "ptt", down: false },
      { onError: () => void ev.action.showAlert() },
    );
    if (!sent) {
      await ev.action.showAlert();
    }
  }

  /** A release nobody asked for: a key going away, or a socket coming back after a drop. */
  private sendRelease(): void {
    if (!wsManager.send({ action: "ptt", down: false })) {
      streamDeck.logger.warn("Could not release push-to-talk; the socket is not open");
    }
  }

  private getIcon(): string {
    switch (micIconState(wsManager.state)) {
      case "disconnected":
        return icons.micDisconnected;
      case "muted":
        return icons.micOff;
      case "transmitting":
        return icons.micLive;
      case "open":
        return icons.micOn;
    }
  }

  private updateAllIcons(): void {
    const icon = this.getIcon();
    for (const instance of this.actions) {
      if (instance.isKey()) void instance.setImage(icon);
    }
  }
}
