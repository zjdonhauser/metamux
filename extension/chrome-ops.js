import { buildObservation } from "./observe.js";
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

import { resolveGroupCache, chooseAdoptionWindow, targetWindowFor } from "./reducer.js";

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
    case "reportGroupPlacement":
      return reportGroupPlacement(op, ctx);
    case "moveGroupToWindow":
      return moveGroupToWindow(op);
    case "createPartnerWindow":
      return createPartnerWindow(op);
    case "parkWindow":
      return parkWindow(op);
    default:
      return Promise.resolve(null);
  }
}

/**
 * Window pairing (docs/protocol.md, "Window pairing" / "Chrome window
 * pairing"): resolves the ACTUAL Chrome window an ensureGroup/openUrl op
 * should execute in.
 *  - op.windowId already resolved (a real number, including the legacy
 *    single metamux window via ctx.windowId as the reducer's own
 *    fallback) -- use it directly, no chrome calls needed.
 *  - op.windowId is null but op.cmuxWindowId isn't: this identity wants a
 *    per-window home that has no Chrome pairing YET. Create one --
 *    unfocused, per hard rule F3 -- with its own per-window marker tab at
 *    `panel.html?win=<cmuxWindowId>` (the contract's own resolution
 *    mechanism: "the marker becomes per-window, marker URL carries the
 *    cmuxWindowId as a query param"), report the new pairing to the
 *    daemon so `Registry.windowPairings` picks it up, and use the new
 *    window from here on.
 *  - neither -- ctx.windowId, the legacy single metamux window. This is
 *    the null-safe path every cmux-sourced identity and every tmux
 *    session in legacy windows/global mirror mode always takes.
 * @param {Op} op
 * @param {{windowId: number, sendFrame?: (frame: Record<string, any>) => void}} ctx
 * @returns {Promise<number>}
 */
async function resolveTargetWindow(op, ctx) {
  if (op.windowId != null) return op.windowId;
  if (op.cmuxWindowId != null) {
    const markerUrl = chrome.runtime.getURL(`panel.html?win=${encodeURIComponent(op.cmuxWindowId)}`);
    const win = await chrome.windows.create({ url: markerUrl, focused: false });
    const chromeWindowId = /** @type {number} */ (win.id);
    ctx.sendFrame?.({ type: "windowPairing", cmuxWindowId: op.cmuxWindowId, chromeWindowId: String(chromeWindowId) });
    return chromeWindowId;
  }
  return ctx.windowId;
}

/**
 * Idempotent: re-resolves by title first so a duplicate sync/upsert never
 * creates a second group for the same workspace.
 * @param {Op} op
 * @param {{windowId: number, sendFrame?: (frame: Record<string, any>) => void}} ctx
 * @returns {Promise<Msg>}
 */
async function ensureGroup(op, ctx) {
  const title = /** @type {string} */ (op.title);
  const color = /** @type {string} */ (op.color);
  const windowId = await resolveTargetWindow(op, ctx);
  const found = await chrome.tabGroups.query({ title, windowId });
  let groupId;
  if (found.length > 0) {
    groupId = found[0].id;
    await chrome.tabGroups.update(groupId, { title, color: /** @type {chrome.tabGroups.ColorEnum} */ (color) });
  } else {
    const tab = await chrome.tabs.create({ windowId, url: "chrome://newtab/", active: false });
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
 * Per-window collapse scoping (docs/protocol.md, "Window pairing" ->
 * "Chrome window pairing": "switching cmux tabs in window W
 * activates/collapses groups ONLY within W's paired Chrome window. Other
 * pairs are untouched"). Falls out of targetWindowFor -- the SAME pure
 * resolution the reducer used for the activated identity's own op.windowId
 * -- applied per OTHER entry: skip anything not sharing that window.
 * Null-safe by construction: when no identity anywhere has a pairing,
 * every entry resolves to the same state.windowId, so nothing is ever
 * filtered out -- exactly today's behavior.
 * @param {Op} op
 * @param {State} state
 * @returns {Promise<null>}
 */
async function collapseOthers(op, state) {
  for (const [id, entry] of Object.entries(state.byId)) {
    if (id === op.exceptId || entry.archived || entry.groupId == null) continue;
    if (targetWindowFor(entry, state) !== op.windowId) continue;
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
 * @param {{windowId: number, sendFrame?: (frame: Record<string, any>) => void}} ctx
 * @returns {Promise<Msg|null>}
 */
async function openUrl(op, state, ctx) {
  const entry = state.byId[/** @type {string} */ (op.id)];
  const windowId = await resolveTargetWindow(op, ctx);
  const tab = await chrome.tabs.create({ windowId, url: op.url, active: true });

  let groupId = entry.groupId;
  if (groupId == null) {
    const found = await chrome.tabGroups.query({ title: entry.title, windowId });
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
 * Auto-create-partner: a display holds a cmux window with no Chrome partner,
 * so open one there. Created unfocused so it never steals the screen, and
 * positioned to the display bounds the daemon supplies.
 * @param {Op} op
 * @returns {Promise<null>}
 */
async function createPartnerWindow(op) {
  try {
    await chrome.windows.create({
      focused: false,
      type: "normal",
      left: /** @type {number} */ (op.left),
      top: /** @type {number} */ (op.top),
      width: /** @type {number} */ (op.width),
      height: /** @type {number} */ (op.height),
    });
  } catch (err) {
    console.warn("[metamux] createPartnerWindow failed:", err);
  }
  return null;
}

/**
 * Park-the-partner: the paired cmux window went away. Minimize by default;
 * "close" destroys the window and every tab in it, so the daemon only ever
 * sends that when explicitly configured to.
 * @param {Op} op
 * @returns {Promise<null>}
 */
async function parkWindow(op) {
  const windowId = /** @type {number} */ (op.chromeWindowId);
  try {
    if (op.mode === "close") {
      await chrome.windows.remove(windowId);
    } else {
      await chrome.windows.update(windowId, { state: "minimized" });
    }
  } catch (err) {
    console.warn("[metamux] parkWindow failed:", err);
  }
  return null;
}

/**
 * Follow-the-tab (docs/window-pairing-plan.md): the workspace moved to another
 * cmux window, so its group moves to that window's paired Chrome window.
 *
 * Resolved by TITLE rather than a cached groupId, because a groupId is not
 * stable across a cross-window move (the same reason ensureGroup re-resolves
 * on startup). Refuses quietly when the group or target window is gone, or
 * when the group is already where it belongs.
 *
 * RETURNS A CACHE CORRECTION. A cross-window move can mint a NEW group id, so
 * leaving the cached one in place points every later activate/collapse at a
 * dead group ("No group with id: ..."). archiveGroup's close path already
 * corrects itself this way; this must too, and cannot rely on
 * watchGroupPlacement's debounced rescan, which never runs if the service
 * worker dies first.
 * @param {Op} op
 * @returns {Promise<Msg|null>}
 */
async function moveGroupToWindow(op) {
  const targetWindowId = /** @type {number} */ (op.chromeWindowId);
  const title = /** @type {string} */ (op.title);
  try {
    const groups = await chrome.tabGroups.query({ title });
    const group = groups.find((g) => g.windowId !== targetWindowId);
    if (!group) return null;
    // Chrome refuses a move into a popup or app window; check before asking.
    const target = await chrome.windows.get(targetWindowId);
    if (target.type !== "normal") return null;
    // Suppress the activation echo this move generates, the same guard
    // reverse sync uses, or the daemon reads it back as user intent.
    markServerActivation();
    // The old id may not survive the move, so suppress its removal too, or
    // watchGroupRemoved reads the move as the user closing the group.
    markServerRemoval(group.id);
    await chrome.tabGroups.move(group.id, { windowId: targetWindowId, index: -1 });

    if (op.id == null) return null;
    const after = await chrome.tabGroups.query({ title, windowId: targetWindowId });
    return {
      type: "local",
      name: "groupCreated",
      id: /** @type {string} */ (op.id),
      groupId: after[0]?.id ?? null,
    };
  } catch (err) {
    console.warn("[metamux] moveGroupToWindow failed:", err);
    return null;
  }
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
 * Placement ownership (docs/protocol.md, "Placement ownership"): reports
 * an observed group move (or the fresh-boot "adopt reality" placement) to
 * the daemon, which persists it as the identity's placementOverride.
 * @param {Op} op
 * @param {{sendFrame?: (frame: Record<string, any>) => void}} ctx
 * @returns {Promise<null>}
 */
async function reportGroupPlacement(op, ctx) {
  ctx.sendFrame?.({ type: "groupPlacement", id: op.id, chromeWindowId: String(op.chromeWindowId) });
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
    if (!t.url || !t.url.startsWith(panelUrl) || t.id == null || t.windowId == null) continue;
    // Window pairing (docs/protocol.md, "Chrome window pairing"): a marker
    // carrying `?win=<cmuxWindowId>` is a PER-WINDOW pairing marker, never
    // a candidate for chooseAdoptionWindow's single-legacy-window
    // consolidation -- resolveTargetWindow (chrome-ops.js) creates and
    // owns these independently. Without this exclusion, the very first
    // per-window marker this feature ever creates would get swept up here
    // and closed as a "duplicate" of the legacy metamux marker.
    if (t.url.includes("?win=")) continue;
    markers.push({ tabId: t.id, windowId: t.windowId });
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
 * checked against its entry's OWN target window before anything is
 * trusted -- see resolveGroupCache for why "chrome APIs accept a groupId
 * cross-window" made the old title-only re-resolution insufficient on its
 * own, and for the placement-following follow-up that widened this from
 * one global windowId to per-entry targetWindowFor).
 * @param {State} state
 * @returns {Promise<Msg[]>}
 */
export async function reresolveGroupIds(state) {
  const allGroups = await allGroupsSnapshot();
  return resolveGroupCache(state.byId, state, allGroups);
}

/**
 * Tracks lastActiveTabId per group and reports user-initiated group
 * activations for reverse sync (F9): a group counts as "user-activated"
 * only when its tab was activated outside the echo-suppression window
 * that follows a server-driven activate op. Covers EVERY window (not just
 * the legacy metamux window -- docs/protocol.md, "Window pairing": F9
 * reverse sync must work for a group wherever it's paired/moved to) --
 * safe by construction: the match lookup below only ever succeeds for a
 * groupId genuinely tracked in `state.byId`, so activity in some
 * unrelated, unmanaged window/tab simply never matches anything.
 * @param {() => State} getState
 * @param {(fact: Msg) => void} onFact
 * @param {(id: string) => void} onUserActivation
 */
export function watchTabActivation(getState, onFact, onUserActivation) {
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
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

// Placement following debounce (docs/protocol.md, "Placement ownership",
// follow-up round): a single drag can fire several onCreated/onMoved
// events in a burst (Chrome's cross-window group move mechanics aren't a
// single atomic event -- see the comment on watchGroupPlacement below).
// Coalesce them into one rescan.
const PLACEMENT_RESCAN_DEBOUNCE_MS = 400;
// Give watchGroupPlacement's rescan a head start before watchGroupRemoved
// decides a vanished group was genuinely closed rather than moved -- see
// that function's own comment for why this can't be made airtight without
// an atomic Chrome API for "this group's window changed".
const GROUP_REMOVED_MOVE_CHECK_DELAY_MS = 500;

/**
 * Placement following (docs/protocol.md, "Placement ownership" / "Window
 * pairing"): a managed group appearing or moving ANYWHERE gets re-resolved
 * against the SAME pure decision boot uses (resolveGroupCache), against a
 * fresh any-window snapshot. Covers two ways Chrome can report a
 * cross-window group move, since the mechanism isn't consistent: a whole-
 * group drag mints a NEW group id in the target window (tabGroups.onCreated
 * fires, tabGroups.onRemoved fires for the old one -- the ORIGINAL window-
 * split incident's mechanism), while some moves preserve the id and
 * surface via tabGroups.onMoved instead. Debounced: only the LAST event in
 * a burst actually rescans.
 * @param {() => State} getState
 * @param {(fact: Msg) => void} onFact
 */
export function watchGroupPlacement(getState, onFact) {
  let pending = false;
  const rescan = () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => {
      pending = false;
      const state = getState();
      const allGroups = await allGroupsSnapshot();
      for (const fact of resolveGroupCache(state.byId, state, allGroups)) onFact(fact);
    }, PLACEMENT_RESCAN_DEBOUNCE_MS);
  };
  chrome.tabGroups.onCreated.addListener(rescan);
  chrome.tabGroups.onMoved.addListener(rescan);
}

/**
 * Detach-on-close: when the user closes a MANAGED group by hand (drags it
 * to the trash, right-click "Close group", closes its last tab, ...),
 * invalidates its cached groupId locally (the same correction
 * archiveGroup's own "close" behavior makes for itself) and reports it to
 * the daemon so attachedAt clears and future syncs stop including it.
 * Echo-suppressed against our own archiveGroup(close)/mergeGroup/
 * closeGroup removals via markServerRemoval, called by those three
 * functions. Covers every window a managed group could live in (docs/
 * protocol.md, "Window pairing": detach-on-close must work wherever a
 * group is paired/moved to).
 *
 * A cross-window drag ALSO fires onRemoved for the group's old id (Chrome
 * mints a new one in the target window -- see watchGroupPlacement) --
 * indistinguishable from a genuine close at the instant this fires. There
 * is no atomic Chrome signal for "this specific group moved windows", so
 * this waits a beat and re-checks whether a group with the same title
 * exists ANYWHERE before concluding it's really gone; watchGroupPlacement's
 * own rescan (debounced shorter, so it normally settles first) is what
 * would have already re-established tracking if this was actually a move.
 * @param {() => State} getState
 * @param {(fact: Msg) => void} onFact
 * @param {(id: string) => void} onUserClosedGroup
 */
export function watchGroupRemoved(getState, onFact, onUserClosedGroup) {
  chrome.tabGroups.onRemoved.addListener((group) => {
    const suppressedAt = serverRemovedGroupIds.get(group.id);
    serverRemovedGroupIds.delete(group.id);
    if (suppressedAt !== undefined && Date.now() - suppressedAt < GROUP_REMOVE_ECHO_SUPPRESS_MS) return;

    const state = getState();
    const match = Object.entries(state.byId).find(([, entry]) => entry.groupId === group.id);
    if (!match) return;
    const [id, entry] = match;

    setTimeout(async () => {
      const allGroups = await allGroupsSnapshot();
      const stillExists = allGroups.some((g) => g.title === entry.title);
      if (stillExists) return; // moved, not closed -- watchGroupPlacement already handled it
      onFact({ type: "local", name: "groupCreated", id, groupId: null });
      onUserClosedGroup(id);
    }, GROUP_REMOVED_MOVE_CHECK_DELAY_MS);
  });
}

/**
 * Identity model: gathers what Chrome actually looks like, keyed by the minted
 * window ids carried in marker tabs. Pure classification lives in observe.js;
 * this is only the chrome.* gathering.
 */
export async function gatherObservation() {
  const panelUrl = chrome.runtime.getURL("panel.html");
  const [windows, markerTabs, groups] = await Promise.all([
    chrome.windows.getAll({ populate: false }),
    chrome.tabs.query({ url: `${panelUrl}*` }),
    chrome.tabGroups.query({}),
  ]);
  const withTabs = await Promise.all(
    groups.map(async (g) => ({
      groupId: g.id,
      title: g.title ?? "",
      windowId: g.windowId,
      tabs: (await chrome.tabs.query({ groupId: g.id })).map((t) => ({ tabId: t.id, url: t.url ?? "" })),
    })),
  );
  return buildObservation(
    windows.map((w) => ({ id: w.id, type: w.type ?? "normal" })),
    markerTabs.map((t) => ({ windowId: t.windowId, url: t.url ?? "" })),
    withTabs,
    panelUrl,
  );
}

/** Stamps a window with a minted id by opening its marker tab, pinned so it
 *  survives casual tab closing and restores with the session. */
export async function markWindow(windowId) {
  const mintedId = crypto.randomUUID();
  const url = chrome.runtime.getURL(`panel.html?win=${encodeURIComponent(mintedId)}`);
  await chrome.tabs.create({ windowId, url, active: false, pinned: true, index: 0 });
  return mintedId;
}

/** Runs one call from planChromeCall. Returns false when it could not act. */
export async function runChromeCall(call) {
  switch (call.op) {
    case "createGroup": {
      const tab = await chrome.tabs.create({ windowId: call.windowId, url: "chrome://newtab/", active: false });
      const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: call.label, collapsed: true });
      return true;
    }
    case "moveGroup":
      markServerActivation();
      markServerRemoval(call.groupId);
      await chrome.tabGroups.move(call.groupId, { windowId: call.windowId, index: -1 });
      return true;
    case "mergeGroups": {
      const tabs = await chrome.tabs.query({ groupId: call.fromGroupId });
      if (tabs.length > 0) await chrome.tabs.group({ groupId: call.intoGroupId, tabIds: tabs.map((t) => t.id) });
      return true;
    }
    case "closeGroup": {
      const tabs = await chrome.tabs.query({ groupId: call.groupId });
      if (tabs.length > 0) await chrome.tabs.remove(tabs.map((t) => t.id));
      return true;
    }
    default:
      return false;
  }
}
