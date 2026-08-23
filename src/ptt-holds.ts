export type PttHoldEvent =
  | { type: "keyDown"; actionId: string }
  | { type: "keyUp"; actionId: string }
  | { type: "disappear"; actionId: string }
  | { type: "socketClosed" }
  | { type: "socketOpened" };

export type PttHoldOutcome = "press" | "release" | "none";

/**
 * Which push-to-talk keys are held, and when a release has to be sent.
 *
 * The client will not close the microphone on its own if a connection drops mid-hold — its
 * own `PttHold` has no watchdog and says so. So a drop while held is remembered as a debt
 * and paid on the next open, which is the first moment anything can be sent again.
 *
 * Held keys are tracked by action instance because a profile can carry more than one.
 */
export class PttHolds {
  private readonly held = new Set<string>();
  private releasePending = false;

  get heldCount(): number {
    return this.held.size;
  }

  get hasPendingRelease(): boolean {
    return this.releasePending;
  }

  apply(event: PttHoldEvent): PttHoldOutcome {
    switch (event.type) {
      case "keyDown":
        this.held.add(event.actionId);
        return "press";

      case "keyUp":
      case "disappear":
        return this.held.delete(event.actionId) ? "release" : "none";

      case "socketClosed":
        this.releasePending = this.held.size > 0;
        this.held.clear();
        return "none";

      case "socketOpened":
        if (!this.releasePending) return "none";
        this.releasePending = false;
        return "release";
    }
  }
}
