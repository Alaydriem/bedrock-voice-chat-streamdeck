import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from "@elgato/streamdeck";
import type { ActionSettings } from "../types";
import { wsManager } from "../ws-manager";
import { icons } from "../icons";

@action({ UUID: "com.alaydriem.bedrock-voice-chat.streamdeck.deafen" })
export class DeafenAction extends SingletonAction<ActionSettings> {
  private subscribed = false;

  override onWillAppear(ev: WillAppearEvent<ActionSettings>): void {
    if (!this.subscribed) {
      this.subscribed = true;
      wsManager.on((event) => {
        if (event.type === "connectionChanged" || event.type === "outputMuteChanged") {
          this.updateAllIcons();
        }
      });
    }
    if (ev.action.isKey()) {
      ev.action.setImage(this.getIcon());
    }
  }

  override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    const sent = wsManager.send(
      { action: "mute", device: "output" },
      () => { ev.action.showAlert(); },
    );
    if (!sent) {
      await ev.action.showAlert();
    }
  }

  private getIcon(): string {
    const s = wsManager.state;
    if (!s.connected || s.outputMuted === null) return icons.headphonesDisconnected;
    return s.outputMuted ? icons.headphonesOff : icons.headphonesOn;
  }

  private updateAllIcons(): void {
    const icon = this.getIcon();
    for (const a of this.actions) {
      if (a.isKey()) a.setImage(icon);
    }
  }
}
