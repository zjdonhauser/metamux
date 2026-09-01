import type { CallerIdentity } from "./caller-identity.ts";
import type { Action, Observed, Workspace, WorkspaceId } from "./identity.ts";
import { projectWorkspaces, type TmuxSession } from "./project-workspaces.ts";
import { reconcile } from "./reconcile.ts";
import { EMPTY, type DesiredState } from "./store.ts";
import { resolvePairs, type PairObservation } from "./window-pairs.ts";

/** Everything the engine needs from the outside world, injected so the
 *  orchestration is testable without a tmux server or a browser. */
export interface EngineIO {
  listSessions(): TmuxSession[];
  stampId(sessionName: string, id: WorkspaceId): boolean;
  load(): DesiredState;
  save(state: DesiredState): void;
  mintId(): WorkspaceId;
}

/**
 * Owns the desired state and turns it into actions.
 *
 * The daemon's loop reduces to: refresh, then plan against what Chrome reports.
 * Nothing here talks to Chrome or tmux directly.
 */
export class IdentityEngine {
  private state: DesiredState;

  constructor(private readonly io: EngineIO) {
    this.state = io.load();
  }

  get workspaces(): readonly Workspace[] {
    return this.state.workspaces;
  }

  get pairs(): DesiredState["pairs"] {
    return this.state.pairs;
  }

  /**
   * Re-projects the workspace set from tmux and stamps any session that needs
   * an id. Safe to call on every hook nudge and every poll: it is idempotent,
   * and a session already carrying its id is not re-stamped.
   */
  refresh(): void {
    const { workspaces, toStamp } = projectWorkspaces(
      this.io.listSessions(),
      this.state.workspaces,
      // Wrapped, not passed bare: an unbound io.mintId loses `this` and throws
      // inside the projection.
      () => this.io.mintId(),
    );
    for (const { sessionName, id } of toStamp) this.io.stampId(sessionName, id);
    this.commit({ ...this.state, workspaces });
  }

  /** Records a confirmed cmux-window/Chrome-window sighting. */
  observePair(observation: PairObservation | null, liveCmuxWindows: string[], liveChromeWindows: string[]): void {
    const { pairs, changed } = resolvePairs(this.state.pairs, liveCmuxWindows, liveChromeWindows, observation);
    if (changed) this.commit({ ...this.state, pairs });
  }

  /** Records which cmux window a workspace currently sits in. */
  placeWorkspace(id: WorkspaceId, cmuxWindowId: string | null): void {
    let changed = false;
    const workspaces = this.state.workspaces.map((w) => {
      if (w.id !== id || w.cmuxWindowId === cmuxWindowId) return w;
      changed = true;
      return { ...w, cmuxWindowId };
    });
    if (changed) this.commit({ ...this.state, workspaces });
  }

  /**
   * Resolves a caller to its workspace: by stamped id first, then by session
   * name for the window after a tmux restart. Returns null for a caller outside
   * tmux, which is the fail-loud path rather than a fallback.
   */
  workspaceFor(identity: CallerIdentity): Workspace | null {
    if (identity.kind !== "tmux") return null;
    const live = this.state.workspaces.filter((w) => !w.archived);
    if (identity.metamuxId !== null) {
      const byId = live.find((w) => w.id === identity.metamuxId);
      if (byId) return byId;
    }
    return live.find((w) => w.sessionName === identity.sessionName) ?? null;
  }

  plan(observed: Observed): Action[] {
    return reconcile({ workspaces: this.state.workspaces, pairs: this.state.pairs }, observed);
  }

  private commit(next: DesiredState): void {
    this.state = next;
    this.io.save(next);
  }
}

export const emptyState = (): DesiredState => ({ ...EMPTY });
