import streamDeck from "@elgato/streamdeck";
import { MuteAction } from "./actions/mute";
import { DeafenAction } from "./actions/deafen";
import { RecordAction } from "./actions/record";
import { JukeboxAction } from "./actions/jukebox";
import { ConnectAction } from "./actions/connect";
import { StatAction } from "./actions/stat";
import { wsManager } from "./ws-manager";
import { metricsManager } from "./metrics-manager";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new MuteAction());
streamDeck.actions.registerAction(new DeafenAction());
streamDeck.actions.registerAction(new RecordAction());
streamDeck.actions.registerAction(new JukeboxAction());
streamDeck.actions.registerAction(new ConnectAction());
streamDeck.actions.registerAction(new StatAction());

streamDeck.connect().then(() => {
  wsManager.initialize();
  void metricsManager.initialize();
}).catch((err) => {
  streamDeck.logger.error("Failed to initialize:", err);
});
