import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { isUnknownTargetError, pressTarget } from "../connect-controller";
import { icons } from "../icons";
import { groupTargets } from "../target-items";
import type { ConnectActionSettings } from "../types";
import { wsManager } from "../ws-manager";

const DATASOURCE_EVENT = "getTargets";

@action({ UUID: "com.alaydriem.bedrock-voice-chat.streamdeck.connect" })
export class ConnectAction extends SingletonAction<ConnectActionSettings> {
  private subscribed = false;

  override onWillAppear(ev: WillAppearEvent<ConnectActionSettings>): void {
    if (!this.subscribed) {
      this.subscribed = true;
      wsManager.on((event) => {
        if (
          event.type === "connectionChanged" ||
          event.type === "activeConnectionChanged" ||
          // A list arriving late — a retried fetch, or a Property Inspector refresh — is
          // the first chance a key configured while the client was unreachable has to
          // learn its world's name.
          event.type === "targetsChanged"
        ) {
          void this.renderAll();
        }
      });
    }
    if (ev.action.isKey()) {
      void this.render(ev.action, ev.payload.settings);
    }
  }

  /**
   * The Property Inspector writes only the id. The name is resolved here and cached, so a
   * key still reads correctly when the client is not running.
   */
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ConnectActionSettings>,
  ): Promise<void> {
    const settings = await this.cacheName(ev.action, ev.payload.settings);
    if (ev.action.isKey()) {
      await this.render(ev.action, settings);
    }
  }

  /**
   * Resolve the configured id to a name and persist it, returning the settings to draw from.
   *
   * `setSettings` does not come back through `onDidReceiveSettings` — the SDK raises that
   * for Property Inspector writes and `getSettings` only — so the caller draws from the
   * returned object rather than waiting for a re-entry that never arrives.
   */
  private async cacheName(
    instance: { setSettings(settings: ConnectActionSettings): Promise<void> },
    settings: ConnectActionSettings,
  ): Promise<ConnectActionSettings> {
    const target = wsManager.state.targets.find((entry) => entry.id === settings.targetId);
    if (target === undefined || target.name === settings.targetName) {
      return settings;
    }

    const updated = { ...settings, targetName: target.name, targetKind: target.kind };
    await instance.setSettings(updated);
    return updated;
  }

  override async onKeyDown(ev: KeyDownEvent<ConnectActionSettings>): Promise<void> {
    const targetId = ev.payload.settings.targetId;
    if (targetId === undefined || targetId === "") {
      streamDeck.logger.warn("Connect key pressed with no target configured");
      await ev.action.showAlert();
      return;
    }

    const sent = pressTarget(wsManager, targetId, (message) => {
      streamDeck.logger.warn(`Connect failed: ${message}`);
      if (isUnknownTargetError(message)) {
        void wsManager.requestTargets().catch(() => {
          // The refetch is best effort; the alert has already been raised.
        });
      }
      void ev.action.showAlert();
    });

    if (!sent) {
      await ev.action.showAlert();
    }
  }

  /** Fills the Property Inspector's target dropdown. */
  override async onSendToPlugin(
    ev: SendToPluginEvent<JsonValue, ConnectActionSettings>,
  ): Promise<void> {
    const payload = ev.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    if ((payload as Record<string, unknown>).event !== DATASOURCE_EVENT) return;

    try {
      const targets = await wsManager.requestTargets();
      await streamDeck.ui.sendToPropertyInspector({
        event: DATASOURCE_EVENT,
        items: groupTargets(targets),
      });
    } catch (error: unknown) {
      // The client's own wording is more useful than anything invented here — "Xbox Live
      // authentication required" tells the user exactly what to go and do.
      const message = error instanceof Error
        ? error.message
        : "Bedrock Voice Chat is unavailable";
      await streamDeck.ui.sendToPropertyInspector({
        event: DATASOURCE_EVENT,
        items: [{ label: message, value: "", disabled: true }],
      });
    }
  }

  private async render(
    target: KeyAction<ConnectActionSettings>,
    settings: ConnectActionSettings,
  ): Promise<void> {
    await target.setImage(this.icon(settings));
    await target.setTitle(settings.targetName ?? "");
  }

  private async renderAll(): Promise<void> {
    for (const instance of this.actions) {
      if (!instance.isKey()) continue;
      const settings = await this.cacheName(instance, await instance.getSettings());
      await this.render(instance, settings);
    }
  }

  private icon(settings: ConnectActionSettings): string {
    const state = wsManager.state;
    if (!state.connected || settings.targetId === undefined || settings.targetId === "") {
      return icons.connectDisconnected;
    }
    return state.connection?.id === settings.targetId ? icons.connectOn : icons.connectOff;
  }
}
