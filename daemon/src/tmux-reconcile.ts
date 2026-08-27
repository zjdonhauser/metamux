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

export type MirrorMode = "windows" | "global";

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
}

export interface ReconcileWindow {
  id: string;
  tabs: ReconcileTab[];
}

/** Everything this module needs to remember between ticks -- the
 * equivalent of tmux-cmux-sync.json + tmux-cmux-reattach.json combined
 * into one typed, pure-functional state object. A cache the caller
 * persists and feeds back in, never a source of truth: every field here
 * is re-derivable from a fresh poll, same as the originals (plan §1.4,
 * §3.4). */
export interface ReconcileState {
  /** windows mode: windowId -> sessionId -> the cmux tab id last known to
   * host that session in that window. */
  windowAttachments: Map<string, Map<string, string>>;
  /** global mode: sessionId -> the cmux tab id tracked for it. */
  globalAttachments: Map<string, string>;
  /** Reattach throttle, unified across both modes (plan §4 -- the
   * original's two separately-named grace periods, TMUX_CMUX_GRACE and
   * TMUX_CMUX_REATTACH_GRACE, collapse to one config value here).
   * Windows mode keys on "windowId|tabId"; global mode keys on the
   * sessionId. Value is the epoch ms of the last reattach attempt. */
  reattachAttempts: Map<string, number>;
}

export function emptyReconcileState(): ReconcileState {
  return { windowAttachments: new Map(), globalAttachments: new Map(), reattachAttempts: new Map() };
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
  | { type: "upsertTmuxRef"; sessionId: string; sessionName: string }
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

export type ReconcileInput = ReconcileWindowsInput | ReconcileGlobalInput;

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
    nextState: { windowAttachments: nextWindowAttachments, globalAttachments: new Map(state.globalAttachments), reattachAttempts: nextReattachAttempts },
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
    nextState: { windowAttachments: cloneWindowAttachments(state.windowAttachments), globalAttachments: nextGlobalAttachments, reattachAttempts: nextReattachAttempts },
  };
}

/** One reconcile tick. Dispatches on `input.mode`; see reconcileWindows /
 * reconcileGlobal for the two modes' semantics (plan §1.6). Pure: same
 * input always produces the same output, no I/O. */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  return input.mode === "windows" ? reconcileWindows(input) : reconcileGlobal(input);
}
