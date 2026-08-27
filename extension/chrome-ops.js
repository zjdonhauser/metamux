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

/** @typedef {import("./reducer.js").Op} Op */
/** @typedef {import("./reducer.js").State} State */
/** @typedef {import("./reducer.js").Msg} Msg */

const TAB_GROUP_ID_NONE = -1;

// Reverse sync (F9) echo suppression: after executing a server-driven
// "activate" op, a matching tabs.onActivated fires because we called
// tabs.update({active:true}) ourselves. Ignore user-activation reporting for
// this long afterward so it isn't mistaken for a real user click. Lives here
// (not in the pure reducer) since it depends on wall-clock time.
const ECHO_SUPPRESS_MS = 1500;
let lastServerActivationAt = 0;

/**
 * @param {Op[]} ops
 * @param {State} state  the state AFTER the reduce() call that produced these ops
 * @param {{windowId: number}} ctx
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
 * @param {{windowId: number}} ctx
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
 * @param {Op} op
 * @param {State} state
 * @param {{windowId: number}} ctx
 * @returns {Promise<Msg|null>}
 */
async function openUrl(op, state, ctx) {
  const entry = state.byId[/** @type {string} */ (op.id)];
  const tab = await chrome.tabs.create({ windowId: ctx.windowId, url: op.url, active: true });
  if (!entry) return null;

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
 * Finds the marker tab (panel.html) to identify THE metamux window, or
 * creates a fresh window with panel.html as its only tab.
 * @returns {Promise<number>} windowId
 */
export async function resolveMetamuxWindow() {
  const panelUrl = chrome.runtime.getURL("panel.html");
  const tabs = await chrome.tabs.query({});
  const marker = tabs.find((t) => t.url && t.url.startsWith(panelUrl));
  if (marker && marker.windowId != null) return marker.windowId;
  const win = await chrome.windows.create({ url: panelUrl, focused: false });
  return /** @type {number} */ (win.id);
}

/**
 * groupId is never trusted across restarts. Re-resolve every tracked,
 * unarchived entry's group by title within the metamux window and emit
 * correction facts for anything that changed (including entries that lost
 * their group and must fall back to null, to be recreated by the next
 * ensureGroup op).
 * @param {State} state
 * @param {number} windowId
 * @returns {Promise<Msg[]>}
 */
export async function reresolveGroupIds(state, windowId) {
  /** @type {Msg[]} */
  const facts = [];
  for (const [id, entry] of Object.entries(state.byId)) {
    if (entry.archived) continue;
    const found = await chrome.tabGroups.query({ title: entry.title, windowId });
    const groupId = found[0]?.id ?? null;
    if (groupId !== entry.groupId) {
      facts.push({ type: "local", name: "groupCreated", id, groupId });
    }
  }
  return facts;
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
