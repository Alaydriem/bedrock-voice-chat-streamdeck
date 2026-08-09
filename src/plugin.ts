import streamDeck from "@elgato/streamdeck";
import { MuteAction } from "./actions/mute";
import { DeafenAction } from "./actions/deafen";
import { RecordAction } from "./actions/record";
import { ConnectAction } from "./actions/connect";
import { wsManager } from "./ws-manager";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new MuteAction());
streamDeck.actions.registerAction(new DeafenAction());
streamDeck.actions.registerAction(new RecordAction());
streamDeck.actions.registerAction(new ConnectAction());

streamDeck.connect().then(() => {
  wsManager.initialize();
}).catch((err) => {
  streamDeck.logger.error("Failed to initialize:", err);
});
