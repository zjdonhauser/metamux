// Pure state machine for socket-gated feature health. metamuxd is now
// long-lived (zshrc-ensured); probeSocketFeatures() previously ran once at
// startup, so a cmux restart left ports/reverse-sync/window-follow
// silently dead for the rest of the daemon's life (docs/tmux-port-plan.md
// §2.7). Two independent inputs drive state:
//
//  - recordCallOutcome: every socket-dependent RPC call (ports poll,
//    reverse sync's workspace.select) reports success/failure. N=3
//    consecutive failures while enabled trips to disabled. Ignored while
//    already disabled -- only a probe can recover from there.
//  - recordProbeOutcome: a periodic (30s) re-probe, run ONLY while
//    disabled (the cheap recovery path -- no point probing a socket
//    that's already known-good). A successful probe recovers to enabled.
//    Ignored while already enabled.

export type SocketFeatureState = "enabled" | "disabled";

export interface SocketHealthTransition {
  from: SocketFeatureState;
  to: SocketFeatureState;
  reason: "consecutive-failures" | "probe-recovered";
}

const FAILURE_THRESHOLD = 3;

export class SocketHealthMonitor {
  private state: SocketFeatureState;
  private consecutiveFailures = 0;

  constructor(initialState: SocketFeatureState) {
    this.state = initialState;
  }

  getState(): SocketFeatureState {
    return this.state;
  }

  /** Report the outcome of a socket-dependent call. Returns the
   * enabled->disabled transition if this call tripped the breaker, else
   * null (including when already disabled -- calls don't matter there). */
  recordCallOutcome(ok: boolean): SocketHealthTransition | null {
    if (this.state === "disabled") return null;
    if (ok) {
      this.consecutiveFailures = 0;
      return null;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures < FAILURE_THRESHOLD) return null;
    this.state = "disabled";
    this.consecutiveFailures = 0;
    return { from: "enabled", to: "disabled", reason: "consecutive-failures" };
  }

  /** Report the outcome of a periodic re-probe. Returns the
   * disabled->enabled transition on a successful probe, else null
   * (including when already enabled -- probes only run while disabled). */
  recordProbeOutcome(ok: boolean): SocketHealthTransition | null {
    if (this.state === "enabled") return null;
    if (!ok) return null;
    this.state = "enabled";
    this.consecutiveFailures = 0;
    return { from: "disabled", to: "enabled", reason: "probe-recovered" };
  }
}
