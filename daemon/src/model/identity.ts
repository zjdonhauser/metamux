/**
 * The metamux identity model (docs/superpowers/specs/2026-08-31-metamux-identity-model-design.md).
 *
 * Three categories of state, and mixing them is what caused every linking bug
 * this model replaces:
 *  - DESIRED: durable, persisted, built from minted ids.
 *  - OBSERVED: read fresh each pass, never persisted. Chrome owns these values
 *    and changes them without telling us (a groupId does not survive a
 *    cross-window move).
 *  - SNAPSHOTTED: observed, but written down because the source is gone when we
 *    need it. `Workspace.harness` only.
 */

/** Minted by metamux, stamped into the tmux session option `@metamux_id`. */
export type WorkspaceId = string;
/** Provided by cmux. Stable for the cmux process lifetime. */
export type CmuxWindowId = string;
/** Minted by metamux, stamped via a marker tab so it survives a Chrome restart. */
export type ChromeWindowId = string;

export interface Harness {
  kind: "claude" | "codex" | "grok";
  sessionId: string;
}

export interface Workspace {
  id: WorkspaceId;
  /** Rendezvous key, consulted ONLY to re-link after a tmux server restart. */
  sessionName: string;
  /** Display only. Also the runtime lookup key for the group, since tmux session
   *  names are unique per server, so managed labels are unique too. */
  label: string;
  cmuxWindowId: CmuxWindowId | null;
  harness: Harness | null;
  archived: boolean;
}

export interface WindowPair {
  cmuxWindowId: CmuxWindowId;
  chromeWindowId: ChromeWindowId;
}

export interface Desired {
  workspaces: Workspace[];
  pairs: WindowPair[];
}

export interface ObservedTab {
  tabId: number;
  url: string;
}

export interface ObservedGroup {
  groupId: number;
  label: string;
  chromeWindowId: ChromeWindowId;
  tabs: ObservedTab[];
}

export interface Observed {
  groups: ObservedGroup[];
}

export type Action =
  | { kind: "createGroup"; workspaceId: WorkspaceId; label: string; chromeWindowId: ChromeWindowId }
  | { kind: "mergeGroups"; fromGroupId: number; intoGroupId: number }
  | { kind: "moveGroup"; groupId: number; toChromeWindowId: ChromeWindowId }
  | { kind: "archiveGroup"; groupId: number }
  | { kind: "closeBlankGroup"; groupId: number }
  | { kind: "reportForeign"; groupId: number; label: string };

/** A tab Chrome opens as a placeholder. A group of only these is not real work. */
export function isBlankUrl(url: string): boolean {
  return url === "" || url === "chrome://newtab/" || url === "about:blank";
}
