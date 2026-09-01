// @ts-check
/**
 * Background service worker: thin glue between ws.js (server frames),
 * reducer.js (pure state + op decisions), and chrome-ops.js (execution).
 *
 * MV3 requires top-level listener registration, since the worker can be
 * killed and woken at any time — see docs/protocol.md.
 */

import { initialState, reduce } from "./reducer.js";
import * as chromeOps from "./chrome-ops.js";
import * as ws from "./ws.js";
import { executeAutomation } from "./automation.js";
import { chainStep } from "./chain.js";
import { orderCalls, planChromeCall } from "./apply.js";

/** Last observation sent, so the actions reply can map minted ids back to
 *  numeric ones without re-querying Chrome.
 *  @type {{windows: {chromeWindowId: string, numericId: number}[], groups: any[], unmarkedWindowIds: number[]} | null} */
let lastObservation = null;

const HEARTBEAT_ALARM = "metamux-heartbeat";
const HEARTBEAT_PERIOD_MINUTES = 0.5;

/** @type {import("./reducer.js").State} */
let state = initialState();
/** @type {number|null} */
let windowId = null;
/** @type {Promise<void>|null} */
let dispatchChain = null;

/**
 * Serializes dispatches so ops from one message always finish (including
 * their follow-up local facts) before the next message is processed. Uses
 * chain.js's chainStep (see its own doc comment) so one bad message's
 * dispatchNow rejection is isolated -- logged and dropped -- rather than
 * permanently poisoning dispatchChain for every message after it, the same
 * way executeOps already isolates one bad op from the rest of its batch.
 * @param {import("./reducer.js").Msg} msg
 */
function dispatch(msg) {
  dispatchChain = chainStep(dispatchChain, () => dispatchNow(msg), (err) => {
    console.error("[metamux] dispatch failed, message dropped:", msg, err);
  });
  return dispatchChain;
}

/**
 * @param {import("./reducer.js").Msg} msg
 */
async function dispatchNow(msg) {
  const { state: next, ops } = reduce(state, msg);
  state = next;
  if (windowId == null) return; // not booted yet; state is still updated for later saveState
  const followUps = await chromeOps.executeOps(ops, state, { windowId, sendFrame: ws.send });
  for (const fact of followUps) {
    await dispatchNow(fact);
  }
}

async function boot() {
  const stored = await chrome.storage.local.get("metamuxState");
  if (stored.metamuxState) state = stored.metamuxState;

  windowId = await chromeOps.resolveMetamuxWindow(state.byId);
  state = { ...state, windowId };

  const corrections = await chromeOps.reresolveGroupIds(state);
  for (const fact of corrections) {
    await dispatch(fact);
  }

  chromeOps.watchTabActivation(
    () => state,
    dispatch,
    (id) => ws.send({ type: "userActivatedGroup", id }),
  );
  chromeOps.watchGroupPlacement(() => state, dispatch);
  chromeOps.watchGroupRemoved(
    () => state,
    dispatch,
    (id) => ws.send({ type: "userClosedGroup", id }),
  );

  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES });

  ws.connect({
    onMessage: async (msg) => {
      // Janitor: attach a live tab-group enumeration to every "sync" frame
      // before dispatch, so classifyJanitor's pure classification runs as
      // part of every sync reconciliation (docs/protocol.md, "Extension
      // behavior"). Gathering the snapshot is chrome-ops's job -- the
      // reducer stays pure and only ever sees it as data on the message.
      // foreignJanitorGroups (window-split fix, 2026-08-27): every
      // managed-title group living in a window OTHER than this one, for
      // the cross-window recovery pass -- derived from the same
      // all-windows snapshot the boot-time cache invalidation uses.
      if (msg && msg.type === "sync" && windowId != null) {
        const [janitorGroups, allGroups] = await Promise.all([
          chromeOps.scanTabGroups(windowId),
          chromeOps.allGroupsSnapshot(),
        ]);
        const foreignJanitorGroups = allGroups.filter((g) => g.windowId !== windowId);
        msg = { ...msg, janitorGroups, foreignJanitorGroups };
      }

      // Identity model cutover, gated on config.identityModel. Report what
      // Chrome actually looks like, keyed by minted window ids, and let the
      // daemon's reconciler decide. Any window with no marker gets one first,
      // or its groups report a null window and can never be paired.
      if (msg && msg.type === "sync" && msg.config && msg.config.identityModel) {
        try {
          let observation = await chromeOps.gatherObservation();
          if (observation.unmarkedWindowIds.length > 0) {
            for (const windowId of observation.unmarkedWindowIds) await chromeOps.markWindow(windowId);
            observation = await chromeOps.gatherObservation();
          }
          ws.send({ type: "observation", groups: observation.groups });
          lastObservation = observation;
        } catch (err) {
          console.warn("[metamux] observation failed:", err);
        }
      }

      // The reconciler's reply. planChromeCall is the only place a minted
      // window id becomes a numeric one, and it skips rather than retargeting
      // when the intended window is not live.
      if (msg && msg.type === "actions" && Array.isArray(msg.actions) && lastObservation) {
        const calls = orderCalls(msg.actions.map((/** @type {any} */ a) => planChromeCall(a, lastObservation)));
        for (const call of calls) {
          if (call.op === "skip") continue;
          try {
            await chromeOps.runChromeCall(call);
          } catch (err) {
            console.warn("[metamux] action failed:", call.op, err);
          }
        }
        return;
      }

      // Workspace-scoped browser automation (docs/protocol.md): a
      // request/response op, not a state fact -- handled directly here
      // rather than through reduce()/executeOps, same as the janitor
      // enrichment above bypasses the reducer for its own I/O. The
      // reducer stays untouched by this feature entirely.
      if (msg && msg.type === "automationRequest") {
        const { id, identityId, op } = msg;
        try {
          const result = await executeAutomation(state.byId, identityId, op);
          ws.send({ type: "automationResponse", id, ok: true, result });
        } catch (err) {
          ws.send({ type: "automationResponse", id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      dispatch(msg);
    },
    onStatus: (status) => {
      chrome.storage.local.set({ metamuxStatus: { ...status, at: Date.now() } });
      // Geometry is the only bridge between Chrome's integer windowId and the
      // CGWindowID the daemon's window helper sees, so re-report on every
      // (re)connect (docs/window-pairing-plan.md).
      if (status?.connected) void reportWindowBounds();
    },
  });
}

/**
 * Reports every normal Chrome window's bounds to the daemon. Advisory only:
 * the daemon pairs on geometry and simply leaves chromeWindowId null if this
 * never arrives, so a failure here degrades rather than breaks.
 */
async function reportWindowBounds() {
  try {
    const wins = await chrome.windows.getAll({ populate: false });
    const windows = wins
      .filter((w) => w.type === "normal" && typeof w.id === "number")
      .map((w) => ({ id: w.id, left: w.left ?? 0, top: w.top ?? 0, width: w.width ?? 0, height: w.height ?? 0 }));
    ws.send({ type: "windowBounds", windows });
  } catch (err) {
    console.warn("[metamux] windowBounds report failed:", err);
  }
}

// Re-report whenever the window layout could have changed. onBoundsChanged
// fires continuously during a drag, so this is debounced.
/** @type {ReturnType<typeof setTimeout>|null} */
let boundsTimer = null;
function scheduleBoundsReport() {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    void reportWindowBounds();
  }, 400);
}
chrome.windows.onBoundsChanged?.addListener(scheduleBoundsReport);
chrome.windows.onCreated.addListener(scheduleBoundsReport);
chrome.windows.onRemoved.addListener(scheduleBoundsReport);

chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(boot);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) ws.kick();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.port || changes.secret)) {
    ws.resetAuthGate();
  }
});

// The worker can also start "cold" without onStartup/onInstalled firing
// (e.g. woken by an alarm after being suspended); boot() is idempotent
// enough to run once per worker lifetime either way.
boot();
