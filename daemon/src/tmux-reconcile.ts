// Pure reconcile core for the tmux port (docs/tmux-port-plan.md §2.5).
// Given a snapshot of live tmux sessions, the content-based host join, and
// live cmux window/tab state, decides what the cmux actuator
// (cmux-actuator.ts) should do and what the registry should know --
// without doing any I/O itself. This is a direct, faithful port of
// tick.py's tick_windows/tick_global (the only LIVE reconcile behavior;
// the bash reimplementation of the same functions is dead code, see plan
// §1.1), with one deliberate identity change: tick.py keys its
// present/spawn/reap bookkeeping by session NAME throughout; this keys by
// session ID instead (both are 1:1 with the live session at any single
// tick, so this changes no decision tick.py would make -- it only makes
// the state and registry intents survive a mid-flight rename, which is
// the entire reason plan §2.1 argues for id-keyed identity in the first
// place).
//
// No I/O, no subprocess calls, no registry import -- see registry
// intents below for why.

/** "partition" (docs/protocol.md, "Window pairing") is the new DEFAULT:
 * one tab per session, period -- no mirroring. "windows" (true mirroring)
 * and "global" (unattended-only) remain for compatibility but are
 * deprecated. */
export type MirrorMode = "windows" | "global" | "partition";

export interface ReconcileSession {
  id: string; // tmux #{session_id}, stable across a rename
  name: string;
  attached: number;
}

/** cmux workspace UUID -> tmux session id, from tmux-source.ts's
 * hostMap(). Content-based, never trusted from a tab's title. */
export type HostMap = Map<string, string>;

export interface ReconcileTab {
  id: string; // cmux workspace UUID (or ref, for a just-spawned tab -- see cmux-actuator.ts's SpawnTabResult)
  title: string;
  pinned: boolean;
  index: number;
  /** Currently the active tab within ITS window (a per-window property).
   * Partition mode only -- windows/global mode ignore it. */
  selected: boolean;
}

export interface ReconcileWindow {
  id: string;
  /** Window ordering, for partition mode's lowest-index fallback. */
  index: number;
  tabs: ReconcileTab[];
}

/** Everything this module needs to remember between ticks -- the
 * equivalent of tmux-cmux-sync.json + tmux-cmux-reattach.json combined
 * into one typed, pure-functional state object. A cache the caller
 * persists and feeds back in, never a source of truth: every field here
 * is re-derivable from a fresh poll, same as the originals (plan §1.4,
 * §3.4). */
export interface PartitionAttachment {
  tabId: string;
  windowId: string;
}

export interface ReconcileState {
  /** windows mode: windowId -> sessionId -> the cmux tab id last known to
   * host that session in that window. */
  windowAttachments: Map<string, Map<string, string>>;
  /** global mode: sessionId -> the cmux tab id tracked for it. */
  globalAttachments: Map<string, string>;
  /** partition mode: sessionId -> the ONE cmux tab (and its window)
   * tracked for it. Recomputed fresh from live state every tick (never
   * diffed against the old value to decide anything) -- this is what
   * makes a user-dragged tab's new window "just work": the next tick's
   * live snapshot already shows it there. */
  partitionAttachments: Map<string, PartitionAttachment>;
  /** Reattach throttle, unified across all three modes (plan §4 -- the
   * original's two separately-named grace periods, TMUX_CMUX_GRACE and
   * TMUX_CMUX_REATTACH_GRACE, collapse to one config value here).
   * Windows/partition mode key on "windowId|tabId"; global mode keys on
   * the sessionId. Value is the epoch ms of the last reattach attempt. */
  reattachAttempts: Map<string, number>;
}

export function emptyReconcileState(): ReconcileState {
  return { windowAttachments: new Map(), globalAttachments: new Map(), partitionAttachments: new Map(), reattachAttempts: new Map() };
}

export interface ReconcileConfig {
  mirrorMode: MirrorMode;
  /** Windows mode only -- pinned tabs stay put, the rest sort
   * case-insensitively by title. Default true, matching TMUX_CMUX_ALPHABETIZE. */
  alphabetize: boolean;
  /** Throttle window (ms) before a reattach is retried for the same
   * tab/session -- see ReconcileState.reattachAttempts. */
  reattachGraceMs: number;
  /** --cwd for a spawned tab's `tmux new -A -s` command -- always a fixed
   * directory (plan §1.10/§2.1: this is not "the session's real cwd"). */
  spawnCwd: string;
  /** Injected clock so this stays a pure function in tests -- Date.now()
   * in production. */
  now: number;
}

export type CmuxActuatorAction =
  | { type: "spawn"; windowId: string | null; sessionId: string; sessionName: string; cwd: string }
  | { type: "retitle"; workspaceRef: string; title: string }
  | { type: "reattach"; workspaceRef: string; sessionName: string }
  | { type: "reap"; workspaceRef: string }
  | { type: "reorder"; windowId: string; orderedWorkspaceRefs: string[] };

/** What the (future, Phase 0+) registry needs to know. Deliberately not
 * `WorkspaceRef` or any registry.ts type -- this module has no import
 * from registry.ts, both to stay decoupled from daemon-builder's
 * concurrent edits there and because a plain intent is easier to test and
 * to eventually replay against whatever the landed registry API turns
 * out to look like. `upsertTmuxRef` is emitted every tick for every live
 * session this reconcile touches (idempotent by construction, same
 * "changed = title !== existing.title || ..." philosophy
 * registry.ts's own upsert() already uses) -- not only when a rename is
 * detected, so the registry side can decide idempotently what actually
 * changed, exactly like every other event it already consumes. */
export type RegistryIntent =
  | { type: "upsertTmuxRef"; sessionId: string; sessionName: string; cmuxWindowId?: string }
  | { type: "archiveTmuxRef"; sessionId: string };

export interface ReconcileWindowsInput {
  mode: "windows";
  sessions: ReconcileSession[];
  hostMap: HostMap;
  windows: ReconcileWindow[];
  state: ReconcileState;
  config: ReconcileConfig;
}

export interface ReconcileGlobalInput {
  mode: "global";
  sessions: ReconcileSession[];
  hostMap: HostMap;
  /** Every tab across every window -- global mode's presence check is
   * "does ANY tab, anywhere, already carry this title" (plan §1.6),
   * unlike windows mode which checks per-window. */
  allTabs: ReconcileTab[];
  state: ReconcileState;
  config: ReconcileConfig;
}

export interface ReconcilePartitionInput {
  mode: "partition";
  sessions: ReconcileSession[];
  hostMap: HostMap;
  windows: ReconcileWindow[];
  /** `cmux current-window` -- where a session with no existing tab spawns.
   * null if unavailable (falls back to the lowest-index window). */
  focusedWindowId: string | null;
  state: ReconcileState;
  config: ReconcileConfig;
}

export type ReconcileInput = ReconcileWindowsInput | ReconcileGlobalInput | ReconcilePartitionInput;

export interface ReconcileOutput {
  actions: CmuxActuatorAction[];
  registryIntents: RegistryIntent[];
  nextState: ReconcileState;
}

function cloneWindowAttachments(src: Map<string, Map<string, string>>): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [windowId, bySession] of src) out.set(windowId, new Map(bySession));
  return out;
}

function desiredTabOrder(tabs: ReconcileTab[]): string[] {
  const byIndex = [...tabs].sort((a, b) => a.index - b.index);
  const pinned = byIndex.filter((t) => t.pinned).map((t) => t.id);
  const rest = byIndex
    .filter((t) => !t.pinned)
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()))
    .map((t) => t.id);
  return [...pinned, ...rest];
}

function currentTabOrder(tabs: ReconcileTab[]): string[] {
  return [...tabs].sort((a, b) => a.index - b.index).map((t) => t.id);
}

function reconcileWindows(input: ReconcileWindowsInput): ReconcileOutput {
  const { sessions, hostMap, windows, state, config } = input;
  const sessionsById = new Map(sessions.map((s) => [s.id, s] as const));
  const liveSessionIds = new Set(sessions.map((s) => s.id));
  const liveWindowIds = new Set(windows.map((w) => w.id));

  const actions: CmuxActuatorAction[] = [];
  const upsertedSessionIds = new Set<string>();
  const nextWindowAttachments = new Map<string, Map<string, string>>();
  const nextReattachAttempts = new Map(state.reattachAttempts);

  for (const window of windows) {
    const present = new Set<string>(); // session ids accounted for in this window this tick
    const attachmentsForWindow = new Map<string, string>();

    for (const tab of window.tabs) {
      const hostedSessionId = hostMap.get(tab.id);
      const hostedSession = hostedSessionId ? sessionsById.get(hostedSessionId) : undefined;

      if (hostedSession) {
        present.add(hostedSession.id);
        attachmentsForWindow.set(hostedSession.id, tab.id);
        upsertedSessionIds.add(hostedSession.id);
        if (tab.title !== hostedSession.name) {
          actions.push({ type: "retitle", workspaceRef: tab.id, title: hostedSession.name });
        }
        continue;
      }

      // No hosting client, but the tab's title matches a live session:
      // a restored (or manually detached) tab. Reattach, throttled.
      const matchingSession = sessions.find((s) => s.name === tab.title);
      if (matchingSession) {
        present.add(matchingSession.id);
        upsertedSessionIds.add(matchingSession.id);
        const key = `${window.id}|${tab.id}`;
        const lastAttempt = state.reattachAttempts.get(key) ?? 0;
        if (config.now - lastAttempt >= config.reattachGraceMs) {
          actions.push({ type: "reattach", workspaceRef: tab.id, sessionName: matchingSession.name });
          nextReattachAttempts.set(key, config.now);
        } else {
          nextReattachAttempts.set(key, lastAttempt);
        }
      }
    }

    for (const session of sessions) {
      if (present.has(session.id)) continue;
      actions.push({ type: "spawn", windowId: window.id, sessionId: session.id, sessionName: session.name, cwd: config.spawnCwd });
      upsertedSessionIds.add(session.id);
    }

    if (config.alphabetize) {
      const desired = desiredTabOrder(window.tabs);
      const current = currentTabOrder(window.tabs);
      if (desired.join(",") !== current.join(",")) {
        actions.push({ type: "reorder", windowId: window.id, orderedWorkspaceRefs: desired });
      }
    }

    nextWindowAttachments.set(window.id, attachmentsForWindow);
  }

  // Reap: a window that's disappeared drops its whole entry (no close
  // calls -- its tabs are already gone with it). A tracked session no
  // longer live gets its tab explicitly closed.
  const archivedSessionIds = new Set<string>();
  for (const [windowId, bySession] of state.windowAttachments) {
    if (!liveWindowIds.has(windowId)) continue; // window itself is gone -- already excluded from nextWindowAttachments
    for (const [sessionId, tabId] of bySession) {
      if (liveSessionIds.has(sessionId)) continue; // still live -- was just re-recorded above, not a reap
      actions.push({ type: "reap", workspaceRef: tabId });
      archivedSessionIds.add(sessionId);
    }
  }

  const registryIntents: RegistryIntent[] = [];
  for (const sessionId of upsertedSessionIds) {
    const session = sessionsById.get(sessionId);
    if (session) registryIntents.push({ type: "upsertTmuxRef", sessionId: session.id, sessionName: session.name });
  }
  for (const sessionId of archivedSessionIds) {
    registryIntents.push({ type: "archiveTmuxRef", sessionId });
  }

  return {
    actions,
    registryIntents,
    nextState: {
      windowAttachments: nextWindowAttachments,
      globalAttachments: new Map(state.globalAttachments),
      partitionAttachments: new Map(state.partitionAttachments),
      reattachAttempts: nextReattachAttempts,
    },
  };
}

function reconcileGlobal(input: ReconcileGlobalInput): ReconcileOutput {
  const { sessions, allTabs, state, config } = input;
  const liveSessionIds = new Set(sessions.map((s) => s.id));
  const titlesInUse = new Set(allTabs.map((t) => t.title));
  const tabById = new Map(allTabs.map((t) => [t.id, t] as const));

  const actions: CmuxActuatorAction[] = [];
  const registryIntents: RegistryIntent[] = [];
  const nextGlobalAttachments = new Map(state.globalAttachments);
  const nextReattachAttempts = new Map(state.reattachAttempts);

  for (const session of sessions) {
    if (session.attached !== 0) continue; // someone's already viewing it -- leave alone

    registryIntents.push({ type: "upsertTmuxRef", sessionId: session.id, sessionName: session.name });

    const trackedTabId = state.globalAttachments.get(session.id);
    if (trackedTabId && tabById.has(trackedTabId)) {
      const lastAttempt = state.reattachAttempts.get(session.id) ?? 0;
      if (config.now - lastAttempt >= config.reattachGraceMs) {
        actions.push({ type: "reattach", workspaceRef: trackedTabId, sessionName: session.name });
        nextReattachAttempts.set(session.id, config.now);
      } else {
        nextReattachAttempts.set(session.id, lastAttempt);
      }
      continue;
    }

    // A tab already exists titled exactly for this session but isn't
    // tracked (e.g. from before this reconcile started watching): left
    // alone, never adopted -- faithfully matching tick.py's tick_global,
    // which has the same gap (plan §1.6/§4 notes this is a known,
    // deliberately-preserved quirk of the ported behavior, not a fix).
    if (titlesInUse.has(session.name)) continue;

    actions.push({ type: "spawn", windowId: null, sessionId: session.id, sessionName: session.name, cwd: config.spawnCwd });
  }

  for (const [sessionId, tabId] of state.globalAttachments) {
    if (liveSessionIds.has(sessionId)) continue;
    actions.push({ type: "reap", workspaceRef: tabId });
    registryIntents.push({ type: "archiveTmuxRef", sessionId });
    nextGlobalAttachments.delete(sessionId);
    nextReattachAttempts.delete(sessionId);
  }

  return {
    actions,
    registryIntents,
    nextState: {
      windowAttachments: cloneWindowAttachments(state.windowAttachments),
      globalAttachments: nextGlobalAttachments,
      partitionAttachments: new Map(state.partitionAttachments),
      reattachAttempts: nextReattachAttempts,
    },
  };
}

interface PartitionCandidate {
  tab: ReconcileTab;
  windowId: string;
}

/** Picks which duplicate tab survives when a session has candidates in
 * MULTIPLE windows (mirror-era legacy convergence, docs/protocol.md's
 * "Window pairing": "keeps the most-recently-selected one (fallback
 * lowest window index)"). "Most-recently-selected" reduces to "currently
 * selected" here: cmux's `selected` flag is an instantaneous per-window
 * fact (`cmux workspace list --json`), not a selection-history timestamp
 * -- there's nothing to rank duplicates by beyond "is it the active tab
 * in its window right now." When exactly one candidate is selected, it
 * wins outright. When zero or MULTIPLE are (routine in mirror mode: the
 * same session can easily be the frontmost tab in more than one window
 * simultaneously), the contract's own explicitly-stated fallback --
 * lowest window index -- breaks the tie. Deterministic either way. */
function pickCanonical(candidates: PartitionCandidate[], windowIndexById: Map<string, number>): PartitionCandidate {
  const selected = candidates.filter((c) => c.tab.selected);
  const pool = selected.length > 0 ? selected : candidates;
  return [...pool].sort(
    (a, b) => (windowIndexById.get(a.windowId) ?? Number.POSITIVE_INFINITY) - (windowIndexById.get(b.windowId) ?? Number.POSITIVE_INFINITY),
  )[0]!;
}

function lowestIndexWindowId(windows: ReconcileWindow[]): string | null {
  if (windows.length === 0) return null;
  return [...windows].sort((a, b) => a.index - b.index)[0]!.id;
}

/** Partition mode (docs/protocol.md, "Window pairing"): one tab per
 * session, no mirroring. Per session, every tick:
 *  - Gather every LIVE candidate tab for it across ALL windows: hosted
 *    (a real tmux client attached, via hostMap) or title-matched-but-
 *    unhosted (restored/detached, same warmup concept as windows mode).
 *  - Zero candidates -> spawn ONE tab in the focused window (fallback
 *    lowest-index window).
 *  - One candidate -> that's the tab. Title-locked/reattached exactly
 *    like windows mode's single-tab case.
 *  - Multiple candidates (mirror-era leftovers, or a duplicate spawn
 *    race) -> pickCanonical keeps ONE, every other candidate is reaped.
 *    One-time convergence: once only one tab remains, later ticks only
 *    ever see one candidate again.
 * A tracked tab moving to a different window is respected implicitly --
 * this function never compares against the OLD attachment to decide
 * anything, it only ever derives the canonical tab fresh from the live
 * windows/tabs snapshot, so a moved tab's new window is just where it's
 * found this tick. Alphabetizes every window that hosts at least one of
 * our tabs, same as windows mode (not explicitly contracted for partition
 * mode, kept for UX parity -- see the port plan report). */
function reconcilePartition(input: ReconcilePartitionInput): ReconcileOutput {
  const { sessions, hostMap, windows, focusedWindowId, state, config } = input;
  const sessionsById = new Map(sessions.map((s) => [s.id, s] as const));
  const liveSessionIds = new Set(sessions.map((s) => s.id));
  const windowIndexById = new Map(windows.map((w) => [w.id, w.index] as const));
  const tabsByWindow = new Map(windows.map((w) => [w.id, w.tabs] as const));

  const actions: CmuxActuatorAction[] = [];
  const upsertedWindowBySession = new Map<string, string>();
  const nextPartitionAttachments = new Map<string, PartitionAttachment>();
  const nextReattachAttempts = new Map(state.reattachAttempts);
  const windowsNeedingReorder = new Set<string>();

  for (const session of sessions) {
    const hosted: PartitionCandidate[] = [];
    const titleMatched: PartitionCandidate[] = [];
    for (const window of windows) {
      for (const tab of window.tabs) {
        const hostedSessionId = hostMap.get(tab.id);
        if (hostedSessionId === session.id) {
          hosted.push({ tab, windowId: window.id });
        } else if (hostedSessionId === undefined && tab.title === session.name) {
          titleMatched.push({ tab, windowId: window.id });
        }
      }
    }

    if (hosted.length > 0) {
      const canonical = pickCanonical(hosted, windowIndexById);
      nextPartitionAttachments.set(session.id, { tabId: canonical.tab.id, windowId: canonical.windowId });
      upsertedWindowBySession.set(session.id, canonical.windowId);
      windowsNeedingReorder.add(canonical.windowId);
      if (canonical.tab.title !== session.name) {
        actions.push({ type: "retitle", workspaceRef: canonical.tab.id, title: session.name });
      }
      for (const other of hosted) {
        if (other.tab.id === canonical.tab.id) continue;
        actions.push({ type: "reap", workspaceRef: other.tab.id });
      }
      continue;
    }

    if (titleMatched.length > 0) {
      const canonical = pickCanonical(titleMatched, windowIndexById);
      upsertedWindowBySession.set(session.id, canonical.windowId);
      const key = `${canonical.windowId}|${canonical.tab.id}`;
      const lastAttempt = state.reattachAttempts.get(key) ?? 0;
      if (config.now - lastAttempt >= config.reattachGraceMs) {
        actions.push({ type: "reattach", workspaceRef: canonical.tab.id, sessionName: session.name });
        nextReattachAttempts.set(key, config.now);
      } else {
        nextReattachAttempts.set(key, lastAttempt);
      }
      // No partitionAttachment recorded yet -- same "warmup" precedent as
      // windows mode: the tracked tabId only lands once hostMap confirms
      // a real client attached, on a later tick.
      for (const other of titleMatched) {
        if (other.tab.id === canonical.tab.id) continue;
        actions.push({ type: "reap", workspaceRef: other.tab.id });
      }
      continue;
    }

    const targetWindowId = focusedWindowId && windowIndexById.has(focusedWindowId) ? focusedWindowId : lowestIndexWindowId(windows);
    if (targetWindowId) {
      actions.push({ type: "spawn", windowId: targetWindowId, sessionId: session.id, sessionName: session.name, cwd: config.spawnCwd });
      upsertedWindowBySession.set(session.id, targetWindowId);
    }
  }

  if (config.alphabetize) {
    for (const windowId of windowsNeedingReorder) {
      const tabs = tabsByWindow.get(windowId) ?? [];
      const desired = desiredTabOrder(tabs);
      const current = currentTabOrder(tabs);
      if (desired.join(",") !== current.join(",")) {
        actions.push({ type: "reorder", windowId, orderedWorkspaceRefs: desired });
      }
    }
  }

  const archivedSessionIds = new Set<string>();
  for (const [sessionId, attachment] of state.partitionAttachments) {
    if (liveSessionIds.has(sessionId)) continue;
    actions.push({ type: "reap", workspaceRef: attachment.tabId });
    archivedSessionIds.add(sessionId);
  }

  const registryIntents: RegistryIntent[] = [];
  for (const [sessionId, cmuxWindowId] of upsertedWindowBySession) {
    const session = sessionsById.get(sessionId);
    if (session) registryIntents.push({ type: "upsertTmuxRef", sessionId: session.id, sessionName: session.name, cmuxWindowId });
  }
  for (const sessionId of archivedSessionIds) {
    registryIntents.push({ type: "archiveTmuxRef", sessionId });
  }

  return {
    actions,
    registryIntents,
    nextState: {
      windowAttachments: cloneWindowAttachments(state.windowAttachments),
      globalAttachments: new Map(state.globalAttachments),
      partitionAttachments: nextPartitionAttachments,
      reattachAttempts: nextReattachAttempts,
    },
  };
}

/** One reconcile tick. Dispatches on `input.mode`; see reconcileWindows /
 * reconcileGlobal / reconcilePartition for the modes' semantics (plan
 * §1.6, docs/protocol.md's "Window pairing"). Pure: same input always
 * produces the same output, no I/O. */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  if (input.mode === "windows") return reconcileWindows(input);
  if (input.mode === "global") return reconcileGlobal(input);
  return reconcilePartition(input);
}
