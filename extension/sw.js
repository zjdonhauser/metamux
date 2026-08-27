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
 * their follow-up local facts) before the next message is processed.
 * @param {import("./reducer.js").Msg} msg
 */
function dispatch(msg) {
  dispatchChain = (dispatchChain ?? Promise.resolve()).then(() => dispatchNow(msg));
  return dispatchChain;
}

/**
 * @param {import("./reducer.js").Msg} msg
 */
async function dispatchNow(msg) {
  const { state: next, ops } = reduce(state, msg);
  state = next;
  if (windowId == null) return; // not booted yet; state is still updated for later saveState
  const followUps = await chromeOps.executeOps(ops, state, { windowId });
  for (const fact of followUps) {
    await dispatchNow(fact);
  }
}

async function boot() {
  const stored = await chrome.storage.local.get("metamuxState");
  if (stored.metamuxState) state = stored.metamuxState;

  windowId = await chromeOps.resolveMetamuxWindow();
  state = { ...state, windowId };

  const corrections = await chromeOps.reresolveGroupIds(state, windowId);
  for (const fact of corrections) {
    await dispatch(fact);
  }

  chromeOps.watchTabActivation(
    windowId,
    () => state,
    dispatch,
    (id) => ws.send({ type: "userActivatedGroup", id }),
  );
  chromeOps.watchGroupRemap(() => state, /** @type {number} */ (windowId), dispatch);

  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES });

  ws.connect({
    onMessage: dispatch,
    onStatus: (status) => {
      chrome.storage.local.set({ metamuxStatus: { ...status, at: Date.now() } });
    },
  });
}

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
