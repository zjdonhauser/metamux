// @ts-check
/**
 * WebSocket client to the metamux daemon's actuator endpoint.
 * Browser-only (uses the global WebSocket + chrome.storage.local).
 *
 * See docs/protocol.md ("Wire protocol") for the hello/sync/event frames and
 * the 4001 bad-token close code.
 */

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10000;
const BAD_TOKEN_CLOSE_CODE = 4001;

/** @type {WebSocket|null} */
let socket = null;
let backoffMs = MIN_BACKOFF_MS;
/** @type {number|undefined} */
let reconnectTimer;
let stopRetrying = false;
/** @type {((msg: any) => void)|null} */
let onMessageCb = null;
/** @type {((status: {connected: boolean, reason?: string}) => void)|null} */
let onStatusCb = null;

/**
 * @param {{onMessage: (msg: any) => void, onStatus?: (status: {connected: boolean, reason?: string}) => void}} handlers
 */
export function connect({ onMessage, onStatus }) {
  onMessageCb = onMessage;
  onStatusCb = onStatus ?? null;
  stopRetrying = false;
  backoffMs = MIN_BACKOFF_MS;
  attemptConnect();
}

async function attemptConnect() {
  if (stopRetrying) return;
  clearTimeout(reconnectTimer);

  const { port, secret } = await chrome.storage.local.get(["port", "secret"]);
  if (!port || !secret) {
    scheduleRetry();
    return;
  }

  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/actuator`);
  } catch (err) {
    console.error("[metamux] failed to open websocket", err);
    scheduleRetry();
    return;
  }
  socket = ws;

  ws.addEventListener("open", () => {
    backoffMs = MIN_BACKOFF_MS;
    ws.send(JSON.stringify({ type: "hello", token: secret, protocol: 1, client: "extension" }));
    onStatusCb?.({ connected: true });
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(/** @type {string} */ (event.data));
    } catch (err) {
      console.error("[metamux] malformed frame", err);
      return;
    }
    onMessageCb?.(msg);
  });

  ws.addEventListener("close", (event) => {
    if (socket === ws) socket = null;
    onStatusCb?.({ connected: false, reason: event.code === BAD_TOKEN_CLOSE_CODE ? "bad_token" : "closed" });
    if (event.code === BAD_TOKEN_CLOSE_CODE) {
      // Bad token: stop retrying until the options page saves new values.
      stopRetrying = true;
      return;
    }
    scheduleRetry();
  });

  ws.addEventListener("error", () => {
    // The close event fires right after; retry scheduling happens there.
  });
}

function scheduleRetry() {
  if (stopRetrying) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = /** @type {number} */ (/** @type {unknown} */ (setTimeout(attemptConnect, backoffMs)));
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

/**
 * Called from the chrome.alarms heartbeat: re-kicks the connection if it
 * died silently (service worker suspend/resume, network blip) without
 * waiting out the rest of the current backoff.
 */
export function kick() {
  if (stopRetrying) return;
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    backoffMs = MIN_BACKOFF_MS;
    attemptConnect();
  }
}

/**
 * Called when the options page saves new port/secret values: clears the
 * bad-token gate and retries immediately.
 */
export function resetAuthGate() {
  stopRetrying = false;
  backoffMs = MIN_BACKOFF_MS;
  attemptConnect();
}

/**
 * Sends a client->server frame (e.g. userActivatedGroup for reverse sync,
 * F9). Silently drops the frame when not connected: reverse sync is
 * best-effort, and the next sync reconciliation covers any gap.
 * @param {Record<string, any>} frame
 */
export function send(frame) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(frame));
}
