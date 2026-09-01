/**
 * Caps how many /open calls one workspace can make in a short window.
 *
 * Built after a Claude session running a PR-review skill opened 51 distinct
 * PR URLs into one tab group in under a second, despite the tool description
 * and skill text both saying not to. Text-only guidance is not enforcement --
 * this is the actual backstop, independent of what any given caller decides.
 *
 * A sliding window, not a fixed bucket: a fixed per-minute counter lets a
 * caller burst at the boundary (59 at :59, 8 more at :00). Sliding avoids
 * that by keeping only timestamps still inside the window.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Present only when allowed is false: how many opens landed in the window,
   *  for the log line and the error the caller sees. */
  countInWindow?: number;
}

export class OpenRateLimiter {
  private readonly timestampsByWorkspace = new Map<string, number[]>();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
  ) {}

  /** Records this attempt's timestamp only when it is allowed, so a caller
   *  hammering past the cap does not itself extend how long the window stays
   *  full -- rejected attempts are free to retry as soon as the window clears. */
  check(workspaceId: string, now: number): RateLimitDecision {
    const cutoff = now - this.windowMs;
    const existing = this.timestampsByWorkspace.get(workspaceId) ?? [];
    const inWindow = existing.filter((t) => t > cutoff);

    if (inWindow.length >= this.maxPerWindow) {
      this.timestampsByWorkspace.set(workspaceId, inWindow);
      return { allowed: false, countInWindow: inWindow.length };
    }

    inWindow.push(now);
    this.timestampsByWorkspace.set(workspaceId, inWindow);
    return { allowed: true };
  }
}

/** 8 opens per 10 seconds: generous enough for a legitimate cluster (a PR
 *  plus its checks plus a related doc), tight enough that a 51-URL sweep
 *  hits the wall almost immediately instead of landing in full. */
export const DEFAULT_OPEN_RATE_LIMIT = { maxPerWindow: 8, windowMs: 10_000 };
