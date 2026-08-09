import type { BvcFrame } from "./frame";
import type { ConnectTarget } from "./types";

export const REQUEST_TIMEOUT_MS = 10_000;

/** A backstop, not a working limit. Reaching it means the client stopped answering. */
export const MAX_PENDING = 16;

export interface PendingRequest {
  readonly kind: "targets" | "other";
  readonly onError?: (message: string) => void;
  readonly onTargets?: (targets: ConnectTarget[]) => void;
}

interface Entry {
  readonly request: PendingRequest;
  abandoned: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Matches responses to the requests that caused them.
 *
 * A plain queue is enough because the client reads one frame, finishes the command, and
 * writes the response before reading again — responses cannot overtake each other.
 *
 * The one ambiguity is that a broadcast state frame is shape-identical to the response to a
 * `state` command. It is sidestepped rather than solved: `ping` and `state` are never
 * enqueued, so a state frame never has to decide whether it is a response, and never
 * settles anything.
 */
export class PendingRequests {
  private entries: Entry[] = [];

  constructor(private readonly timeoutMs: number = REQUEST_TIMEOUT_MS) {}

  get size(): number {
    return this.entries.length;
  }

  push(request: PendingRequest): void {
    if (this.entries.length >= MAX_PENDING) {
      this.clear("Bedrock Voice Chat stopped responding");
    }

    const entry: Entry = { request, abandoned: false, timer: null };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (entry.abandoned) return;
      entry.abandoned = true;
      request.onError?.("Timed out waiting for Bedrock Voice Chat");
    }, this.timeoutMs);

    this.entries.push(entry);
  }

  /**
   * Settle whatever this frame answers.
   *
   * State, pong and unrecognised frames are left alone. The first two are ambiguous with
   * broadcasts; an unrecognised frame may be a broadcast this plugin does not parse, and
   * settling on one would put the queue permanently out of step. Leaving it costs at most
   * one entry, which its own timeout reclaims.
   */
  settle(frame: BvcFrame): void {
    if (frame.kind === "state" || frame.kind === "pong" || frame.kind === "unknown") {
      return;
    }

    const entry = this.shift();
    if (entry === undefined || entry.abandoned) return;

    if (frame.kind === "error") {
      entry.request.onError?.(frame.message);
      return;
    }

    if (frame.kind === "targets" && entry.request.kind === "targets") {
      entry.request.onTargets?.(frame.targets);
    }
  }

  /** Settle everything outstanding with an error. Used when the socket goes away. */
  clear(message: string): void {
    const entries = this.entries;
    this.entries = [];
    for (const entry of entries) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (!entry.abandoned) {
        entry.abandoned = true;
        entry.request.onError?.(message);
      }
    }
  }

  private shift(): Entry | undefined {
    const entry = this.entries.shift();
    if (entry?.timer != null) clearTimeout(entry.timer);
    return entry;
  }
}
