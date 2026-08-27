// @ts-check
/**
 * Pure state reducer for the metamux extension. No chrome.* references here —
 * this module must be importable and testable under plain Bun/Node.
 *
 * See docs/protocol.md ("Extension behavior" + "Wire protocol") for the contract.
 */

/**
 * @typedef {Object} WorkspaceEntry
 * @property {string} title
 * @property {string} color
 * @property {boolean} archived
 * @property {number|null} groupId          cached chrome tabGroups id, re-resolved on startup
 * @property {number|null} lastActiveTabId  last active tab within this group
 * @property {number[]} ports               listening ports reported by the daemon's ports watcher (F8)
 */

/**
 * @typedef {Object} Config
 * @property {boolean} collapseOthers
 * @property {"archive"|"close"} closeBehavior
 * @property {boolean} [janitor]  default true when absent -- see the janitor section below
 */

/**
 * @typedef {Object} State
 * @property {Object<string, WorkspaceEntry>} byId
 * @property {number} lastSeq
 * @property {number|null} windowId   the metamux window's chrome window id
 * @property {string|null} activeId
 * @property {Config} config
 */

/**
 * @typedef {Object} SyncWorkspace
 * @property {string} id
 * @property {string} title
 * @property {string} color
 * @property {boolean} archived
 * @property {number[]} [ports]  optional; present when the daemon's ports watcher (F8) is on
 */

/**
 * @typedef {Object} JanitorTab
 * @property {number} tabId
 * @property {string} url
 */

/**
 * @typedef {Object} JanitorGroupSnapshot  one real chrome tab group in the metamux window
 * @property {number} groupId
 * @property {string} title
 * @property {JanitorTab[]} tabs
 */

/**
 * @typedef {Object} SyncMsg
 * @property {"sync"} type
 * @property {number} seq
 * @property {Config} config
 * @property {{activeId: string|null, workspaces: SyncWorkspace[]}} state
 * @property {JanitorGroupSnapshot[]} [janitorGroups]  live tab-group enumeration, attached
 *   locally by sw.js before dispatch -- see the janitor section below. Absent (e.g. in older
 *   test fixtures) means "skip the janitor pass this reconciliation".
 */

/**
 * @typedef {Object} EventWorkspace
 * @property {string} id
 * @property {string} title
 * @property {string} color
 * @property {number[]} [ports]  optional; present when the daemon's ports watcher (F8) is on
 */

/**
 * @typedef {Object} EventMsg
 * @property {"event"} type
 * @property {number} seq
 * @property {"workspace.activated"|"workspace.upserted"|"workspace.archived"|"open_url"|"focus_window"} name
 * @property {EventWorkspace} [workspace]  absent for focus_window, which carries no workspace
 * @property {string} [url]  present only for open_url
 */

/**
 * @typedef {Object} LocalMsg
 * @property {"local"} type
 * @property {"tabActivated"|"groupCreated"|"windowResolved"} name
 * @property {string} [id]          metamux workspace id, for groupCreated
 * @property {number|null} [groupId] group lookup key for tabActivated; for groupCreated, the
 *                                    resolved id, or null to invalidate a stale cache entry
 * @property {number} [tabId]       for tabActivated
 * @property {number} [windowId]    for windowResolved
 */

/**
 * @typedef {SyncMsg|EventMsg|LocalMsg} Msg
 */

/**
 * @typedef {Object} Op
 * @property {string} op
 * @property {string} [id]
 * @property {string} [title]
 * @property {string} [color]
 * @property {string} [exceptId]
 * @property {"archive"|"close"} [behavior]
 * @property {string} [url]
 * @property {number} [fromGroupId]  mergeGroup: the duplicate group to dissolve
 * @property {number} [intoId]      mergeGroup: the canonical group to merge into
 * @property {number} [groupId]     closeGroup: the blank-orphan group to remove
 * @property {{title: string, tabCount: number}[]} [groups]  reportForeignGroups
 */

/**
 * @returns {State}
 */
export function initialState() {
  return {
    byId: {},
    lastSeq: 0,
    windowId: null,
    activeId: null,
    config: { collapseOthers: true, closeBehavior: "archive", janitor: true },
  };
}

/**
 * @param {State} state
 * @param {Msg} msg
 * @returns {{state: State, ops: Op[]}}
 */
export function reduce(state, msg) {
  if (!msg || typeof msg !== "object") return { state, ops: [] };
  switch (msg.type) {
    case "sync":
      return reduceSync(state, /** @type {SyncMsg} */ (msg));
    case "event":
      return reduceEvent(state, /** @type {EventMsg} */ (msg));
    case "local":
      return reduceLocal(state, /** @type {LocalMsg} */ (msg));
    default:
      return { state, ops: [] };
  }
}

/**
 * @param {State} state
 * @param {SyncMsg} msg
 * @returns {{state: State, ops: Op[]}}
 */
function reduceSync(state, msg) {
  /** @type {Object<string, WorkspaceEntry>} */
  const byId = { ...state.byId };
  /** @type {Op[]} */
  const ops = [];

  for (const ws of msg.state.workspaces) {
    const existing = byId[ws.id];
    byId[ws.id] = {
      title: ws.title,
      color: ws.color,
      archived: ws.archived,
      groupId: existing ? existing.groupId : null,
      lastActiveTabId: existing ? existing.lastActiveTabId : null,
      ports: resolvePorts(ws, existing),
    };
    if (!ws.archived) {
      ops.push({ op: "ensureGroup", id: ws.id, title: ws.title, color: ws.color });
    } else if (existing && existing.groupId != null) {
      ops.push({ op: "archiveGroup", id: ws.id, behavior: msg.config.closeBehavior });
    }
  }

  // Tab group janitor (2026-08-27): runs on every sync reconciliation,
  // idempotent, honors config.janitor (default true). Prepended ahead of
  // the ensureGroup/archiveGroup ops above so any merge/close resolves
  // BEFORE ensureGroup's own tabGroups.query({title}) runs -- by execution
  // time only one group per managed title remains, so that query can't
  // pick a stale duplicate. See docs/protocol.md ("Extension behavior").
  if (msg.config.janitor !== false && Array.isArray(msg.janitorGroups)) {
    ops.unshift(...classifyJanitor(byId, msg.janitorGroups));
  }

  // Sync is authoritative for byId: prune every entry whose id is absent
  // from this sync frame's workspaces list. Runs AFTER the janitor
  // classification above (which needs the full, pre-prune byId to still
  // recognize a stale identity's title and merge/close its leftover
  // group one last time), not before -- pruning first would make that
  // title invisible to classifyJanitor's idByTitle map, turning a
  // recognized DUPLICATE/CANONICAL into an unrecognized BLANK
  // ORPHAN/FOREIGN on its very last sync. A pruned identity isn't lost:
  // it reappears with fresh defaults the moment the daemon includes it
  // again (createGroups' attachment model already handles that). This is
  // what keeps the panel/janitor scope tracking the daemon's actual live
  // view instead of accumulating every identity ever seen in this
  // extension instance's lifetime.
  const syncIds = new Set(msg.state.workspaces.map((ws) => ws.id));
  for (const id of Object.keys(byId)) {
    if (!syncIds.has(id)) delete byId[id];
  }

  if (msg.state.activeId) {
    ops.push({ op: "activate", id: msg.state.activeId });
    ops.push({ op: "markServerActivation", id: msg.state.activeId });
    if (msg.config.collapseOthers) {
      ops.push({ op: "collapseOthers", exceptId: msg.state.activeId });
    }
  }

  ops.push({ op: "saveState" });

  const nextState = {
    ...state,
    byId,
    lastSeq: msg.seq,
    activeId: msg.state.activeId,
    config: msg.config,
  };
  return { state: nextState, ops };
}

const BLANK_TAB_URLS = new Set(["chrome://newtab/", "chrome://newtab", "about:blank"]);

/**
 * @param {string} url
 * @returns {boolean}
 */
function isBlankTabUrl(url) {
  return BLANK_TAB_URLS.has(url);
}

/**
 * Classifies every real chrome tab group against the current managed-identity
 * set (title -> the identity carrying that title, live or archived). A
 * group is:
 *  - CANONICAL: the cached groupId for a managed identity, or -- when no
 *    cached groupId is present among the scanned groups -- the first
 *    scan-order group with a matching title, which becomes bound. Left alone.
 *  - DUPLICATE: title matches a managed identity but isn't the canonical
 *    group for it -> merges into canonical (never discards a tab).
 *  - BLANK ORPHAN: title matches no managed identity and every tab is a
 *    new-tab/blank placeholder -> closes.
 *  - FOREIGN: title matches no managed identity and it has real tabs ->
 *    left untouched, reported.
 * Pure: the enumeration snapshot is passed in as data, not gathered here.
 * @param {Object<string, WorkspaceEntry>} byId
 * @param {JanitorGroupSnapshot[]} groups
 * @returns {Op[]}
 */
function classifyJanitor(byId, groups) {
  /** @type {Object<string, string>} */
  const idByTitle = {};
  for (const [id, entry] of Object.entries(byId)) {
    idByTitle[entry.title] = id;
  }

  /** @type {Object<string, number>} */
  const canonicalGroupIdByTitle = {};
  for (const group of groups) {
    const id = idByTitle[group.title];
    if (id !== undefined && byId[id].groupId === group.groupId) {
      canonicalGroupIdByTitle[group.title] = group.groupId;
    }
  }
  for (const group of groups) {
    const id = idByTitle[group.title];
    if (id === undefined || canonicalGroupIdByTitle[group.title] !== undefined) continue;
    canonicalGroupIdByTitle[group.title] = group.groupId;
  }

  /** @type {Op[]} */
  const ops = [];
  /** @type {{title: string, tabCount: number}[]} */
  const foreign = [];

  for (const group of groups) {
    const id = idByTitle[group.title];
    if (id !== undefined) {
      const canonicalGroupId = canonicalGroupIdByTitle[group.title];
      if (group.groupId !== canonicalGroupId) {
        ops.push({ op: "mergeGroup", fromGroupId: group.groupId, intoId: canonicalGroupId });
      }
      continue;
    }
    if (group.tabs.every((t) => isBlankTabUrl(t.url))) {
      ops.push({ op: "closeGroup", groupId: group.groupId });
    } else {
      foreign.push({ title: group.title, tabCount: group.tabs.length });
    }
  }

  if (foreign.length > 0) {
    ops.push({ op: "reportForeignGroups", groups: foreign });
  }
  return ops;
}

/**
 * @param {State} state
 * @param {EventMsg} msg
 * @returns {{state: State, ops: Op[]}}
 */
function reduceEvent(state, msg) {
  if (msg.seq <= state.lastSeq) return { state, ops: [] };

  switch (msg.name) {
    case "workspace.upserted":
      return withSeq(reduceUpserted(state, msg), msg.seq);
    case "workspace.activated":
      return withSeq(reduceActivated(state, msg), msg.seq);
    case "workspace.archived":
      return withSeq(reduceArchived(state, msg), msg.seq);
    case "open_url":
      return withSeq(reduceOpenUrl(state, msg), msg.seq);
    case "focus_window":
      return withSeq({ state, ops: [{ op: "focusWindow" }] }, msg.seq);
    default:
      return withSeq({ state, ops: [] }, msg.seq);
  }
}

/**
 * @param {{state: State, ops: Op[]}} result
 * @param {number} seq
 * @returns {{state: State, ops: Op[]}}
 */
function withSeq(result, seq) {
  return { state: { ...result.state, lastSeq: seq }, ops: result.ops };
}

/**
 * Ports (F8) are optional on any workspace payload: keep the incoming value
 * when present, otherwise carry the existing entry's ports forward, else [].
 * @param {{ports?: number[]}} ws
 * @param {WorkspaceEntry} [existing]
 * @returns {number[]}
 */
function resolvePorts(ws, existing) {
  return ws.ports ?? existing?.ports ?? [];
}

/**
 * @param {State} state
 * @param {EventMsg} msg
 * @returns {{state: State, ops: Op[]}}
 */
function reduceUpserted(state, msg) {
  const ws = /** @type {EventWorkspace} */ (msg.workspace);
  const existing = state.byId[ws.id];
  const byId = {
    ...state.byId,
    [ws.id]: {
      title: ws.title,
      color: ws.color,
      archived: false,
      groupId: existing ? existing.groupId : null,
      lastActiveTabId: existing ? existing.lastActiveTabId : null,
      ports: resolvePorts(ws, existing),
    },
  };
  const ops = [
    { op: "ensureGroup", id: ws.id, title: ws.title, color: ws.color },
    { op: "saveState" },
  ];
  return { state: { ...state, byId }, ops };
}

/**
 * @param {State} state
 * @param {EventMsg} msg
 * @returns {{state: State, ops: Op[]}}
 */
function reduceActivated(state, msg) {
  // createGroups: "on-open" decision (docs/protocol.md): activation of an
  // identity that was never open_url'd still reaches here as a bare
  // workspace.activated -- the daemon does NOT filter it out. Safe by
  // construction: this never emits ensureGroup (only ensureGroup/openUrl
  // do), and chrome-ops's activate() is a no-op whenever the byId entry
  // it targets has groupId: null, which is exactly the case for a
  // never-attached identity (the branch below, when `existing` is
  // undefined, always sets groupId: null). A bare activation can never
  // create a group.
  const ws = /** @type {EventWorkspace} */ (msg.workspace);
  const existing = state.byId[ws.id];
  const byId = existing
    ? state.byId
    : {
        ...state.byId,
        [ws.id]: {
          title: ws.title,
          color: ws.color,
          archived: false,
          groupId: null,
          lastActiveTabId: null,
          ports: resolvePorts(ws, existing),
        },
      };

  /** @type {Op[]} */
  const ops = [{ op: "activate", id: ws.id }, { op: "markServerActivation", id: ws.id }];
  if (state.config.collapseOthers) {
    ops.push({ op: "collapseOthers", exceptId: ws.id });
  }
  ops.push({ op: "saveState" });

  return { state: { ...state, byId, activeId: ws.id }, ops };
}

/**
 * @param {State} state
 * @param {EventMsg} msg
 * @returns {{state: State, ops: Op[]}}
 */
function reduceArchived(state, msg) {
  const ws = /** @type {EventWorkspace} */ (msg.workspace);
  const existing = state.byId[ws.id];
  const byId = {
    ...state.byId,
    [ws.id]: {
      title: existing ? existing.title : ws.title,
      color: existing ? existing.color : ws.color,
      archived: true,
      groupId: existing ? existing.groupId : null,
      lastActiveTabId: existing ? existing.lastActiveTabId : null,
      ports: resolvePorts(ws, existing),
    },
  };
  const ops = [
    { op: "archiveGroup", id: ws.id, behavior: state.config.closeBehavior },
    { op: "saveState" },
  ];
  return { state: { ...state, byId }, ops };
}

/**
 * @param {State} state
 * @param {EventMsg} msg
 * @returns {{state: State, ops: Op[]}}
 */
function reduceOpenUrl(state, msg) {
  const ws = /** @type {EventWorkspace} */ (msg.workspace);
  const existing = state.byId[ws.id];
  // createGroups: "on-open" can target an identity the extension has never
  // seen before (attachment happens only via open_url, so nothing upserted
  // it first) -- establish the byId entry here, same shape as
  // reduceActivated's "new identity" branch, so chrome-ops's openUrl always
  // has an entry to create the group around instead of orphaning the tab.
  const byId = existing
    ? state.byId
    : {
        ...state.byId,
        [ws.id]: {
          title: ws.title,
          color: ws.color,
          archived: false,
          groupId: null,
          lastActiveTabId: null,
          ports: resolvePorts(ws, existing),
        },
      };
  const ops = [{ op: "openUrl", id: ws.id, url: /** @type {string} */ (msg.url) }];
  return { state: { ...state, byId }, ops };
}

/**
 * @param {State} state
 * @param {LocalMsg} msg
 * @returns {{state: State, ops: Op[]}}
 */
function reduceLocal(state, msg) {
  switch (msg.name) {
    case "tabActivated":
      return reduceTabActivated(state, msg);
    case "groupCreated":
      return reduceGroupCreated(state, msg);
    case "windowResolved":
      return { state: { ...state, windowId: /** @type {number} */ (msg.windowId) }, ops: [] };
    default:
      return { state, ops: [] };
  }
}

/**
 * @param {State} state
 * @param {LocalMsg} msg
 * @returns {{state: State, ops: Op[]}}
 */
function reduceTabActivated(state, msg) {
  const entryId = Object.keys(state.byId).find((id) => state.byId[id].groupId === msg.groupId);
  if (!entryId) return { state, ops: [] };
  const byId = {
    ...state.byId,
    [entryId]: { ...state.byId[entryId], lastActiveTabId: /** @type {number} */ (msg.tabId) },
  };
  return { state: { ...state, byId }, ops: [{ op: "saveState" }] };
}

/**
 * @param {State} state
 * @param {LocalMsg} msg
 * @returns {{state: State, ops: Op[]}}
 */
function reduceGroupCreated(state, msg) {
  const id = /** @type {string} */ (msg.id);
  const existing = state.byId[id];
  if (!existing) return { state, ops: [] };
  const byId = { ...state.byId, [id]: { ...existing, groupId: /** @type {number} */ (msg.groupId) } };
  return { state: { ...state, byId }, ops: [{ op: "saveState" }] };
}
