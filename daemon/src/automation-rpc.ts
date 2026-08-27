// Request/response correlation for the daemon<->extension automation RPC
// (docs/protocol.md, "Workspace-scoped browser automation"): POST
// /automation sends one automationRequest frame over the WS and awaits its
// automationResponse by id. No I/O of its own -- server.ts owns the socket
// send and the incoming-frame dispatch; this is purely the pending-request
// bookkeeping, same "stateful class, injected clock/scheduler, fully
// unit-testable" shape as gate.ts/ports.ts.

export type Scheduler = (cb: () => void, ms: number) => { cancel: () => void };

function realScheduler(cb: () => void, ms: number): { cancel: () => void } {
  const handle = setTimeout(cb, ms);
  return { cancel: () => clearTimeout(handle) };
}

interface Entry {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  cancelTimer: () => void;
}

export class PendingRequestTable {
  private pending = new Map<string, Entry>();

  constructor(private scheduler: Scheduler = realScheduler) {}

  /** Registers a new in-flight request: returns the promise the caller
   * awaits, which settles via resolveRequest/rejectRequest (by id), or
   * rejects on its own once `timeoutMs` elapses with no response. */
  register(id: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const { cancel } = this.scheduler(() => {
        if (this.pending.delete(id)) reject(new Error(`automation request ${id} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, cancelTimer: cancel });
    });
  }

  /** Settles a pending request successfully. false (no-op) if `id` is
   * unknown or already settled -- a late or duplicate response frame. */
  resolveRequest(id: string, result: unknown): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.cancelTimer();
    entry.resolve(result);
    return true;
  }

  /** Settles a pending request with an error. Same no-op contract as
   * resolveRequest. */
  rejectRequest(id: string, err: Error): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.cancelTimer();
    entry.reject(err);
    return true;
  }

  size(): number {
    return this.pending.size;
  }
}
