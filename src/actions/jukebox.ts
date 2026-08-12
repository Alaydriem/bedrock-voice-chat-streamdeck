import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from "@elgato/streamdeck";
import type { ActionSettings } from "../types";
import { wsManager } from "../ws-manager";
import { icons } from "../icons";

/**
 * The jukebox key. A toggle, like Deafen.
 *
 * `jukebox` is a toggle rather than a setter on the client too, so the key sends the same
 * command whatever it is currently showing. The icon follows the frame that comes back, never
 * the press — a refused toggle must not leave the key claiming something the client did not do.
 */
@action({ UUID: "com.alaydriem.bedrock-voice-chat.streamdeck.jukebox" })
export class JukeboxAction extends SingletonAction<ActionSettings> {
  private subscribed = false;

  override onWillAppear(ev: WillAppearEvent<ActionSettings>): void {
    if (!this.subscribed) {
      this.subscribed = true;
      wsManager.on((event) => {
        if (event.type === "connectionChanged" || event.type === "jukeboxMuteChanged") {
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
      { action: "jukebox" },
      { onError: () => void ev.action.showAlert() },
    );
    if (!sent) {
      await ev.action.showAlert();
    }
  }

  private getIcon(): string {
    const s = wsManager.state;
    if (!s.connected || s.jukeboxMuted === null) return icons.jukeboxDisconnected;
    return s.jukeboxMuted ? icons.jukeboxOff : icons.jukeboxOn;
  }

  private updateAllIcons(): void {
    const icon = this.getIcon();
    for (const a of this.actions) {
      if (a.isKey()) a.setImage(icon);
    }
  }
}
