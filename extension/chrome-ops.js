// @ts-check
/**
 * Executes reducer.js op descriptors against the real chrome.* APIs, plus the
 * bootstrap/watch helpers sw.js needs (window identity, groupId cache
 * re-resolution, tab-activation tracking, cross-window remap handling).
 *
 * This module is browser-only and intentionally thin: it trusts the state it
 * is given and does not itself decide *whether* to act, only *how*.
 *
 * See docs/protocol.md ("Extension behavior") for the hard rules this file
 * must honor, especially: never chrome.windows.update({focused:true}) (F3).
 */

import { resolveGroupCache, chooseAdoptionWindow } from "./reducer.js";

/** @typedef {import("./reducer.js").Op} Op */
/** @typedef {import("./reducer.js").State} State */
/** @typedef {import("./reducer.js").Msg} Msg */
/** @typedef {import("./reducer.js").WorkspaceEntry} WorkspaceEntry */

const TAB_GROUP_ID_NONE = -1;

// Reverse sync (F9) echo suppression: after executing a server-driven
// "activate" op, a matching tabs.onActivated fires because we called
// tabs.update({active:true}) ourselves. Ignore user-activation reporting for
// this long afterward so it isn't mistaken for a real user click. Lives here
// (not in the pure reducer) since it depends on wall-clock time.
const ECHO_SUPPRESS_MS = 1500;
let lastServerActivationAt = 0;

// Detach-on-close echo suppression: after WE dissolve a group ourselves
// (archiveGroup's "close" behavior, the janitor's mergeGroup/closeGroup),
// tabGroups.onRemoved fires for it. Mark it here so watchGroupRemoved
// below doesn't mistake our own removal for the user closing the group by
// hand. Per-groupId (not a single global timestamp like
// lastServerActivationAt) since one batch can dissolve several groups at
// once -- a merge pass, or several archiveGroup(close) ops in one sync.
const GROUP_REMOVE_ECHO_SUPPRESS_MS = 1500;
/** @type {Map<number, number>} groupId -> Date.now() when WE removed it */
const serverRemovedGroupIds = new Map();

/** @param {number} groupId */
function markServerRemoval(groupId) {
  serverRemovedGroupIds.set(groupId, Date.now());
}

/**
 * @param {Op[]} ops
 * @param {State} state  the state AFTER the reduce() call that produced these ops
 * @param {{windowId: number, sendFrame?: (frame: Record<string, any>) => void}} ctx
 * @returns {Promise<Msg[]>} follow-up local facts to feed back into reduce()
 */
export async function executeOps(ops, state, ctx) {
  const followUps = [];
  for (const op of ops) {
    try {
      const fact = await executeOp(op, state, ctx);
      if (fact) followUps.push(fact);
    } catch (err) {
      console.error("[metamux] op failed:", op, err);
    }
  }
  return followUps;
}

/**
 * @param {Op} op
 * @param {State} state
 * @param {{windowId: number, sendFrame?: (frame: Record<string, any>) => void}} ctx
 * @returns {Promise<Msg|null>}
 */
function executeOp(op, state, ctx) {
  switch (op.op) {
    case "ensureGroup":
      return ensureGroup(op, ctx);
    case "activate":
      return activate(op, state);
    case "collapseOthers":
      return collapseOthers(op, state);
    case "archiveGroup":
      return archiveGroup(op, state);
    case "openUrl":
      return openUrl(op, state, ctx);
    case "saveState":
      return saveState(state);
    case "focusWindow":
      return focusWindow(ctx);
    case "markServerActivation":
      return markServerActivation();
    case "mergeGroup":
      return mergeGroup(op);
    case "closeGroup":
      return closeGroup(op);
    case "recoverCrossWindow":
      return recoverCrossWindow(op, ctx);
    case "reportForeignGroups":
      return reportForeignGroups(op, ctx);
    default:
      return Promise.resolve(null);
  }
}

/**
 * Idempotent: re-resolves by title first so a duplicate sync/upsert never
 * creates a second group for the same workspace.
 * @param {Op} op
 * @param {{windowId: number}} ctx
 * @returns {Promise<Msg>}
 */
async function ensureGroup(op, ctx) {
  const title = /** @type {string} */ (op.title);
  const color = /** @type {string} */ (op.color);
  const found = await chrome.tabGroups.query({ title, windowId: ctx.windowId });
  let groupId;
  if (found.length > 0) {
    groupId = found[0].id;
    await chrome.tabGroups.update(groupId, { title, color: /** @type {chrome.tabGroups.ColorEnum} */ (color) });
  } else {
    const tab = await chrome.tabs.create({ windowId: ctx.windowId, url: "chrome://newtab/", active: false });
    groupId = await chrome.tabs.group({ tabIds: [/** @type {number} */ (tab.id)] });
    await chrome.tabGroups.update(groupId, {
      title,
      color: /** @type {chrome.tabGroups.ColorEnum} */ (color),
      collapsed: true,
    });
  }
  return { type: "local", name: "groupCreated", id: /** @type {string} */ (op.id), groupId };
}

/**
 * @param {Op} op
 * @param {State} state
 * @returns {Promise<null>}
 */
async function activate(op, state) {
  const entry = state.byId[/** @type {string} */ (op.id)];
  if (!entry || entry.groupId == null) return null;
  await chrome.tabGroups.update(entry.groupId, { collapsed: false });
  let tabId = entry.lastActiveTabId;
  if (tabId == null) {
    const tabs = await chrome.tabs.query({ groupId: entry.groupId });
    tabId = tabs[0]?.id ?? null;
  }
  if (tabId != null) {
    // Hard rule F3: activate the tab, never focus the window.
    await chrome.tabs.update(tabId, { active: true });
  }
  return null;
}

/**
 * @param {Op} op
 * @param {State} state
 * @returns {Promise<null>}
 */
async function collapseOthers(op, state) {
  for (const [id, entry] of Object.entries(state.byId)) {
    if (id === op.exceptId || entry.archived || entry.groupId == null) continue;
    await chrome.tabGroups.update(entry.groupId, { collapsed: true });
  }
  return null;
}

/**
 * @param {Op} op
 * @param {State} state
 * @returns {Promise<Msg|null>}
 */
async function archiveGroup(op, state) {
  const entry = state.byId[/** @type {string} */ (op.id)];
  if (!entry || entry.groupId == null) return null;
  if (op.behavior === "close") {
    markServerRemoval(entry.groupId);
    const tabs = await chrome.tabs.query({ groupId: entry.groupId });
    if (tabs.length > 0) {
      await chrome.tabs.remove(/** @type {number[]} */ (tabs.map((t) => t.id)));
    }
    // Group is gone: invalidate the cached groupId.
    return { type: "local", name: "groupCreated", id: /** @type {string} */ (op.id), groupId: null };
  }
  await chrome.tabGroups.update(entry.groupId, { collapsed: true });
  await chrome.tabGroups.move(entry.groupId, { index: -1 });
  return null;
}

/**
 * createGroups: "on-open" -- open_url is often the FIRST time an identity
 * ever reaches the extension (attachment happens only here, not on
 * activation), so reducer.js's reduceOpenUrl always establishes a byId
 * entry before this runs; the group forms around the real tab just
 * opened, never a separate chrome://newtab placeholder.
 * @param {Op} op
 * @param {State} state
 * @param {{windowId: number}} ctx
 * @returns {Promise<Msg|null>}
 */
async function openUrl(op, state, ctx) {
  const entry = state.byId[/** @type {string} */ (op.id)];
  const tab = await chrome.tabs.create({ windowId: ctx.windowId, url: op.url, active: true });

  let groupId = entry.groupId;
  if (groupId == null) {
    const found = await chrome.tabGroups.query({ title: entry.title, windowId: ctx.windowId });
    if (found.length > 0) {
      groupId = found[0].id;
    } else {
      groupId = await chrome.tabs.group({ tabIds: [/** @type {number} */ (tab.id)] });
      await chrome.tabGroups.update(groupId, {
        title: entry.title,
        color: /** @type {chrome.tabGroups.ColorEnum} */ (entry.color),
      });
      return { type: "local", name: "groupCreated", id: /** @type {string} */ (op.id), groupId };
    }
  }
  await chrome.tabs.group({ tabIds: [/** @type {number} */ (tab.id)], groupId });
  return { type: "local", name: "groupCreated", id: /** @type {string} */ (op.id), groupId };
}

/**
 * @param {State} state
 * @returns {Promise<null>}
 */
async function saveState(state) {
  await chrome.storage.local.set({ metamuxState: state });
  return null;
}

/**
 * The ONLY path allowed to focus the window (F7 explicit-focus command):
 * unlike the server-driven activate op, this is always a deliberate,
 * user-initiated action, so it doesn't violate hard rule F3.
 * @param {{windowId: number}} ctx
 * @returns {Promise<null>}
 */
async function focusWindow(ctx) {
  await chrome.windows.update(ctx.windowId, { focused: true });
  return null;
}

/**
 * Records that an "activate" op was just executed by the server (sync
 * reconciliation or a workspace.activated event), so the tabs.onActivated
 * listener below can suppress reporting the resulting activation back to the
 * server as if the user had clicked it (F9 echo suppression).
 * @returns {Promise<null>}
 */
async function markServerActivation() {
  lastServerActivationAt = Date.now();
  return null;
}

/**
 * Janitor: merges a duplicate group's tabs into the canonical group for the
 * same managed title. tabs.group into an existing groupId dissolves the
 * now-empty source group automatically -- no explicit close, and no tab is
 * ever discarded.
 * @param {Op} op
 * @returns {Promise<null>}
 */
async function mergeGroup(op) {
  markServerRemoval(/** @type {number} */ (op.fromGroupId));
  const tabs = await chrome.tabs.query({ groupId: /** @type {number} */ (op.fromGroupId) });
  if (tabs.length > 0) {
    await chrome.tabs.group({
      tabIds: /** @type {number[]} */ (tabs.map((t) => t.id)),
      groupId: /** @type {number} */ (op.intoId),
    });
  }
  return null;
}

/**
 * Janitor: removes a blank orphan group's placeholder tabs; the group
 * dissolves once its last tab is gone.
 * @param {Op} op
 * @returns {Promise<null>}
 */
async function closeGroup(op) {
  markServerRemoval(/** @type {number} */ (op.groupId));
  const tabs = await chrome.tabs.query({ groupId: /** @type {number} */ (op.groupId) });
  if (tabs.length > 0) {
    await chrome.tabs.remove(/** @type {number[]} */ (tabs.map((t) => t.id)));
  }
  return null;
}

/**
 * Cross-window recovery merge (window-split fix, 2026-08-27): a managed-
 * title group living in a DIFFERENT window (found by the janitor's
 * foreign-group scan) gets its tabs moved into the canonical in-window
 * group. tabs.move first -- a tab must already be in the target window
 * before tabs.group can add it to a group there -- then tabs.group.
 * markServerRemoval on the source group so watchGroupRemoved's detach
 * echo-suppression doesn't mistake this recovery for the user closing the
 * group by hand (the source group dissolves once its last tab moves out,
 * same as mergeGroup's in-window case).
 * @param {Op} op
 * @param {{windowId: number}} ctx
 * @returns {Promise<null>}
 */
async function recoverCrossWindow(op, ctx) {
  markServerRemoval(/** @type {number} */ (op.fromGroupId));
  const tabs = await chrome.tabs.query({ groupId: /** @type {number} */ (op.fromGroupId) });
  if (tabs.length > 0) {
    const tabIds = /** @type {number[]} */ (tabs.map((t) => t.id));
    await chrome.tabs.move(tabIds, { windowId: ctx.windowId, index: -1 });
    await chrome.tabs.group({ tabIds, groupId: /** @type {number} */ (op.intoId) });
  }
  return null;
}

/**
 * Janitor: reports unrecognized, non-blank groups back to the daemon via
 * the existing client->server "state" frame (docs/protocol.md, Wire
 * protocol) so it can log them for the human to review. The janitor never
 * touches a group it doesn't recognize.
 * @param {Op} op
 * @param {{sendFrame?: (frame: Record<string, any>) => void}} ctx
 * @returns {Promise<null>}
 */
async function reportForeignGroups(op, ctx) {
  ctx.sendFrame?.({ type: "state", groups: op.groups });
  return null;
}

/**
 * Every tab group chrome currently knows about, across ALL windows (unlike
 * scanTabGroups, which is metamux-window-only and carries per-tab detail
 * for the blank-orphan check). Feeds resolveGroupCache's cache-
 * invalidation check, chooseAdoptionWindow's window-adoption decision, and
 * the cross-window janitor recovery scan -- all three need to reason about
 * groups OUTSIDE the (not yet fully known, at boot) managed window.
 * @returns {Promise<import("./reducer.js").GroupSnapshot[]>}
 */
export async function allGroupsSnapshot() {
  const groups = await chrome.tabGroups.query({});
  return groups.map((g) => ({ groupId: g.id, windowId: g.windowId, title: g.title ?? "" }));
}

/**
 * Finds THE metamux window via chooseAdoptionWindow's pure decision
 * (window-split fix, 2026-08-27): every real tab whose URL is panel.html
 * is a marker sighting; every real tab group is scanned for managed-title
 * membership. One marker -> keep it. Multiple markers -> keep the
 * group-richest window's, close the rest (a leftover from a prior boot
 * that never got cleaned up). Zero markers -> adopt the group-richest
 * window if one has any managed-title groups (create a marker tab there),
 * else create a brand-new window (the original, now last-resort, behavior).
 * @param {Object<string, WorkspaceEntry>} [byId]
 * @returns {Promise<number>} windowId
 */
export async function resolveMetamuxWindow(byId = {}) {
  const panelUrl = chrome.runtime.getURL("panel.html");
  const tabs = await chrome.tabs.query({});
  /** @type {import("./reducer.js").MarkerTabSighting[]} */
  const markers = [];
  for (const t of tabs) {
    if (t.url && t.url.startsWith(panelUrl) && t.id != null && t.windowId != null) {
      markers.push({ tabId: t.id, windowId: t.windowId });
    }
  }

  const allGroups = await allGroupsSnapshot();
  const decision = chooseAdoptionWindow(markers, byId, allGroups);

  for (const tabId of decision.closeTabIds) {
    await chrome.tabs.remove(tabId).catch(() => {}); // best-effort -- already-closed tab is not an error here
  }

  if (decision.action === "keep") return /** @type {number} */ (decision.windowId);

  if (decision.action === "adopt") {
    await chrome.tabs.create({ windowId: /** @type {number} */ (decision.windowId), url: panelUrl, active: false });
    return /** @type {number} */ (decision.windowId);
  }

  const win = await chrome.windows.create({ url: panelUrl, focused: false });
  return /** @type {number} */ (win.id);
}

/**
 * groupId is never trusted across restarts OR across a window-resolution
 * change (window-split fix, 2026-08-27: the cached groupId itself is
 * checked for membership in `windowId` before anything is trusted -- see
 * resolveGroupCache for why "chrome APIs accept a groupId cross-window"
 * made the old title-only re-resolution insufficient on its own).
 * @param {State} state
 * @param {number} windowId
 * @returns {Promise<Msg[]>}
 */
export async function reresolveGroupIds(state, windowId) {
  const allGroups = await allGroupsSnapshot();
  return resolveGroupCache(state.byId, windowId, allGroups);
}

/**
 * Tracks lastActiveTabId per group, scoped to the metamux window only, and
 * reports user-initiated group activations for reverse sync (F9): a group
 * counts as "user-activated" only when its tab was activated outside the
 * echo-suppression window that follows a server-driven activate op. The
 * marker tab and ungrouped tabs are never grouped, so they're excluded by
 * the same groupId check that already guards lastActiveTabId tracking.
 * @param {number} windowId
 * @param {() => State} getState
 * @param {(fact: Msg) => void} onFact
 * @param {(id: string) => void} onUserActivation
 */
export function watchTabActivation(windowId, getState, onFact, onUserActivation) {
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    if (activeInfo.windowId !== windowId) return;
    let tab;
    try {
      tab = await chrome.tabs.get(activeInfo.tabId);
    } catch {
      return; // tab already gone
    }
    if (tab.groupId == null || tab.groupId === TAB_GROUP_ID_NONE) return;
    onFact({ type: "local", name: "tabActivated", groupId: tab.groupId, tabId: activeInfo.tabId });

    if (Date.now() - lastServerActivationAt < ECHO_SUPPRESS_MS) return;
    const state = getState();
    const match = Object.entries(state.byId).find(([, entry]) => entry.groupId === tab.groupId);
    if (match) onUserActivation(match[0]);
  });
}

/**
 * Enumerates every real chrome tab group in the metamux window plus its
 * tabs, for the janitor's pure classification pass (reducer.js
 * classifyJanitor). Only ever scans the metamux window -- the marker tab
 * (panel.html) is never grouped, so it's excluded automatically.
 * @param {number} windowId
 * @returns {Promise<import("./reducer.js").JanitorGroupSnapshot[]>}
 */
export async function scanTabGroups(windowId) {
  const groups = await chrome.tabGroups.query({ windowId });
  const snapshot = [];
  for (const group of groups) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    snapshot.push({
      groupId: group.id,
      title: group.title ?? "",
      tabs: tabs.map((t) => ({ tabId: /** @type {number} */ (t.id), url: t.url ?? "" })),
    });
  }
  return snapshot;
}

/**
 * Cross-window moves fire tabGroups.onCreated with a new groupId for a group
 * we already track by title. Detect that and correct the cache.
 * @param {() => State} getState
 * @param {number} windowId
 * @param {(fact: Msg) => void} onFact
 */
export function watchGroupRemap(getState, windowId, onFact) {
  chrome.tabGroups.onCreated.addListener((group) => {
    if (group.windowId !== windowId) return;
    const state = getState();
    const match = Object.entries(state.byId).find(([, entry]) => entry.title === group.title);
    if (match && match[1].groupId !== group.id) {
      onFact({ type: "local", name: "groupCreated", id: match[0], groupId: group.id });
    }
  });
}

/**
 * Detach-on-close: when the user closes a MANAGED group by hand (drags it
 * to the trash, right-click "Close group", closes its last tab, ...),
 * invalidates its cached groupId locally (the same correction
 * archiveGroup's own "close" behavior makes for itself) and reports it to
 * the daemon so attachedAt clears and future syncs stop including it.
 * Echo-suppressed against our own archiveGroup(close)/mergeGroup/
 * closeGroup removals via markServerRemoval, called by those three
 * functions. Note: dragging a managed group into a DIFFERENT window also
 * fires this in the metamux window (a cross-window move looks identical to
 * a removal here) -- treated as a close, consistent with "never manage
 * groups in other windows."
 * @param {() => State} getState
 * @param {number} windowId
 * @param {(fact: Msg) => void} onFact
 * @param {(id: string) => void} onUserClosedGroup
 */
export function watchGroupRemoved(getState, windowId, onFact, onUserClosedGroup) {
  chrome.tabGroups.onRemoved.addListener((group) => {
    if (group.windowId !== windowId) return;
    const suppressedAt = serverRemovedGroupIds.get(group.id);
    serverRemovedGroupIds.delete(group.id);
    if (suppressedAt !== undefined && Date.now() - suppressedAt < GROUP_REMOVE_ECHO_SUPPRESS_MS) return;

    const state = getState();
    const match = Object.entries(state.byId).find(([, entry]) => entry.groupId === group.id);
    if (!match) return;
    const [id] = match;
    onFact({ type: "local", name: "groupCreated", id, groupId: null });
    onUserClosedGroup(id);
  });
}
