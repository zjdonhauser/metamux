// Per-target failure backoff for color backflow (main.ts's pollColorBackflow):
// stops retrying a paint that keeps failing for a TRANSIENT reason (cmux
// CLI timeout, a momentary socket hiccup) instead of hammering it every 5s
// forever. A `not_found` failure specifically is handled separately and
// more directly, by archiving the ref outright (main.ts) -- that's
// definitive proof the workspace no longer exists in cmux, not something a
// retry could ever fix, so it never needs to reach this tracker at all.
// Stateful, in-memory, no I/O -- same shape as gate.ts/ports.ts.

export type FailureOutcome = "keep-retrying" | "just-gave-up" | "already-given-up";

export class BackflowFailureTracker {
  private consecutiveFailures = new Map<string, number>();
  private givenUp = new Set<string>();

  constructor(private maxConsecutiveFailures: number = 3) {}

  /** True once `targetKey` has crossed the threshold -- the caller should
   * skip attempting to paint it at all until a success (or a fresh
   * registry entry, e.g. via a new refId after a re-create) clears it. */
  isGivenUp(targetKey: string): boolean {
    return this.givenUp.has(targetKey);
  }

  /** Records one failed paint attempt for `targetKey`. Returns
   * "keep-retrying" while under the threshold, "just-gave-up" the ONE
   * failure that crosses it (the caller's cue to log once), and
   * "already-given-up" for every failure after that (the caller stays
   * silent -- no per-poll log spam for a target it's already stopped
   * targeting in practice). */
  recordFailure(targetKey: string): FailureOutcome {
    if (this.givenUp.has(targetKey)) return "already-given-up";
    const count = (this.consecutiveFailures.get(targetKey) ?? 0) + 1;
    this.consecutiveFailures.set(targetKey, count);
    if (count >= this.maxConsecutiveFailures) {
      this.givenUp.add(targetKey);
      return "just-gave-up";
    }
    return "keep-retrying";
  }

  /** Records a successful paint: clears all failure history for
   * `targetKey`, including a prior give-up -- a target that starts
   * working again deserves a fresh chance, not to stay silently skipped
   * forever. */
  recordSuccess(targetKey: string): void {
    this.consecutiveFailures.delete(targetKey);
    this.givenUp.delete(targetKey);
  }
}
