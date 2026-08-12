import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type SendToPluginEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { metricsManager } from "../metrics-manager";
import { renderStatKey } from "../stat-image";
import { groupStats } from "../stat-items";
import { configuredPath, statView } from "../stat-view";
import type { StatActionSettings } from "../types";

const DATASOURCE_EVENT = "getStats";

/**
 * The stat key. A readout of one live number.
 *
 * A press does nothing on purpose: there is no command this key could send that its own display
 * would not contradict.
 *
 * The metrics subscription is reference counted here. Every key that appears takes a reference
 * and every key that goes away drops one, so the second socket exists only while something is
 * drawing from it.
 */
@action({ UUID: "com.alaydriem.bedrock-voice-chat.streamdeck.stat" })
export class StatAction extends SingletonAction<StatActionSettings> {
  private subscribed = false;

  // Which key instances hold a reference. A set rather than a count because Stream Deck may
  // raise `willAppear` for a key that is already on screen, and a second reference for one key
  // would keep the socket open after that key had gone.
  private readonly appeared = new Set<string>();

  // The last image pushed per key, so a 1 Hz frame that changes nothing costs no redraw.
  private readonly lastImage = new Map<string, string>();

  override onWillAppear(ev: WillAppearEvent<StatActionSettings>): void {
    if (!this.subscribed) {
      this.subscribed = true;
      metricsManager.on(() => {
        void this.renderAll();
      });
    }

    if (!this.appeared.has(ev.action.id)) {
      this.appeared.add(ev.action.id);
      metricsManager.acquire();
    }

    if (ev.action.isKey()) {
      void this.render(ev.action, ev.payload.settings);
    }
  }

  override onWillDisappear(ev: WillDisappearEvent<StatActionSettings>): void {
    if (this.appeared.delete(ev.action.id)) {
      metricsManager.release();
    }
    this.lastImage.delete(ev.action.id);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<StatActionSettings>,
  ): Promise<void> {
    if (ev.action.isKey()) {
      await this.render(ev.action, ev.payload.settings);
    }
  }

  /** Fills the Property Inspector's stat dropdown. */
  override async onSendToPlugin(
    ev: SendToPluginEvent<JsonValue, StatActionSettings>,
  ): Promise<void> {
    const payload = ev.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    if ((payload as Record<string, unknown>).event !== DATASOURCE_EVENT) return;

    await streamDeck.ui.sendToPropertyInspector({
      event: DATASOURCE_EVENT,
      items: groupStats(metricsManager.snapshot),
    });
  }

  private async render(
    target: KeyAction<StatActionSettings>,
    settings: StatActionSettings,
  ): Promise<void> {
    const image = renderStatKey(
      statView({
        path: configuredPath(settings),
        snapshot: metricsManager.snapshot,
        ageMs: metricsManager.ageMs,
        health: metricsManager.health,
        socketUp: metricsManager.socketUp,
      }),
    );

    if (this.lastImage.get(target.id) === image) return;
    this.lastImage.set(target.id, image);
    await target.setImage(image);
  }

  private async renderAll(): Promise<void> {
    for (const instance of this.actions) {
      if (!instance.isKey()) continue;
      await this.render(instance, await instance.getSettings());
    }
  }
}
