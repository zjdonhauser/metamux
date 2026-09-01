import type { Workspace, WorkspaceId } from "./identity.ts";

export interface TmuxSession {
  name: string;
  /** The `@metamux_id` session option, or null when tmux has never been stamped
   *  (a brand new session, or every session after a tmux server restart). */
  metamuxId: string | null;
}

export interface Projection {
  workspaces: Workspace[];
  /** Sessions that need `@metamux_id` written back, so the next pass matches by id. */
  toStamp: { sessionName: string; id: WorkspaceId }[];
}

/**
 * Projects the live tmux session list onto workspaces.
 *
 * The workspace set is a projection, not an accumulating store: anything not
 * backed by a live session is archived on sight. That is what makes the
 * duplicates and orphans in the old registry structurally impossible rather
 * than something a janitor has to clean up afterwards.
 *
 * Identity resolution, in order:
 *  1. the session's stamped id, which survives rename and re-attach
 *  2. failing that, the session NAME, used as a rendezvous key for the one
 *     moment after a tmux server restart, then immediately re-stamped
 *  3. failing that, a freshly minted id
 */
export function projectWorkspaces(
  sessions: TmuxSession[],
  storedWorkspaces: Workspace[],
  mintId: () => WorkspaceId,
): Projection {
  const storedById = new Map(storedWorkspaces.map((w) => [w.id, w]));
  const workspaces: Workspace[] = [];
  const toStamp: { sessionName: string; id: WorkspaceId }[] = [];
  const claimed = new Set<WorkspaceId>();

  for (const session of sessions) {
    const byId = session.metamuxId === null ? undefined : storedById.get(session.metamuxId);
    // Rendezvous by name only among rows not already claimed by a stamped id,
    // so duplicate stored rows for one name collapse onto a single workspace.
    const byName =
      byId ?? storedWorkspaces.find((w) => w.sessionName === session.name && !claimed.has(w.id));

    const existing = byId ?? byName;
    const id = existing?.id ?? mintId();
    if (session.metamuxId !== id) toStamp.push({ sessionName: session.name, id });
    claimed.add(id);

    workspaces.push({
      id,
      sessionName: session.name,
      label: session.name,
      cmuxWindowId: existing?.cmuxWindowId ?? null,
      harness: existing?.harness ?? null,
      archived: false,
    });
  }

  for (const stale of storedWorkspaces) {
    if (claimed.has(stale.id)) continue;
    workspaces.push({ ...stale, archived: true });
  }

  return { workspaces, toStamp };
}
