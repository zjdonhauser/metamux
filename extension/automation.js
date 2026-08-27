// @ts-check
/**
 * Workspace-scoped browser automation (docs/protocol.md, "Workspace-scoped
 * browser automation"): executes one automationRequest frame's op against a
 * tab in the CALLING workspace's Chrome tab group only, via chrome.debugger
 * (CDP). Thin and untested below resolveTarget -- it trusts what it's
 * given and does not itself decide scope beyond re-checking the tab
 * actually belongs to the requested group (see resolveTarget); daemon-side
 * workspace->identity resolution and the navigate SSRF gate are the real
 * policy layer (server.ts, navigate-gate.ts).
 *
 * chrome.debugger session lifecycle: attach per request, detach in a
 * finally (including on error/timeout) -- never left dangling. Chrome shows
 * its own "<ext> is debugging this browser" infobar on the target tab for
 * as long as any debugger is attached; it clears automatically when we
 * detach.
 */

/** @typedef {{ref: string, tag: string, role: string|null, text: string}} SnapshotElement */

/**
 * Resolves the target tab for an automation op, scoped to one identity's
 * Chrome tab group: refuses if the identity has no live group, the group
 * has no tabs, or an explicitly requested tabId doesn't belong to that
 * group's tabs -- the actual scope enforcement (a tabId from another
 * identity's group is never found here, since `tabsInGroup` is already
 * scoped to the ONE group being resolved). Pure: `tabsInGroup` is the
 * caller's chrome.tabs.query({groupId}) result, passed in as data.
 * @param {Record<string, {groupId: number|null}>} byId
 * @param {string} identityId
 * @param {{id: number, active: boolean}[]} tabsInGroup
 * @param {number|null} requestedTabId
 * @returns {{ok: true, tabId: number} | {ok: false, reason: string}}
 */
export function resolveTarget(byId, identityId, tabsInGroup, requestedTabId) {
  const entry = byId[identityId];
  if (!entry || entry.groupId == null) {
    return { ok: false, reason: `no active tab group for identity ${identityId}` };
  }
  if (tabsInGroup.length === 0) {
    return { ok: false, reason: `group for ${identityId} has no tabs` };
  }
  if (requestedTabId != null) {
    const match = tabsInGroup.find((t) => t.id === requestedTabId);
    if (!match) return { ok: false, reason: `tab ${requestedTabId} is not in identity ${identityId}'s group` };
    return { ok: true, tabId: requestedTabId };
  }
  const active = tabsInGroup.find((t) => t.active);
  return { ok: true, tabId: (active ?? tabsInGroup[0]).id };
}

/**
 * Full resolution: looks up the identity's group and its live tabs via
 * chrome.tabs, then delegates to resolveTarget. Split out from
 * resolveTarget so the pure/tested core stays chrome-API-free.
 * @param {Record<string, {groupId: number|null}>} byId
 * @param {string} identityId
 * @param {number|null} [requestedTabId]
 */
async function resolveTargetLive(byId, identityId, requestedTabId = null) {
  const entry = byId[identityId];
  const tabsInGroup = entry && entry.groupId != null ? await chrome.tabs.query({ groupId: entry.groupId }) : [];
  return resolveTarget(
    byId,
    identityId,
    tabsInGroup.map((t) => ({ id: /** @type {number} */ (t.id), active: !!t.active })),
    requestedTabId,
  );
}

/**
 * @param {number} tabId
 * @param {(target: {tabId: number}) => Promise<any>} fn
 */
async function withDebugger(tabId, fn) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    return await fn(target);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

/** @param {{tabId: number}} target @param {string} method @param {Record<string, any>} [params] */
function sendCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

const SERIALIZE_SNAPSHOT_EXPR = `(() => {
  const results = [];
  let refCounter = 0;
  const selector = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [onclick], [tabindex]:not([tabindex="-1"])';
  for (const el of document.querySelectorAll(selector)) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const ref = 'r' + (refCounter++);
    el.setAttribute('data-metamux-ref', ref);
    results.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || null,
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 200),
    });
  }
  return JSON.stringify({ url: location.href, title: document.title, elements: results });
})()`;

/** @param {string} ref */
function refCenterExpr(ref) {
  return `(() => {
    const el = document.querySelector('[data-metamux-ref="' + ${JSON.stringify(ref)} + '"]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  })()`;
}

/** @param {{kind: string, [k: string]: any}} op @param {number} tabId */
async function runOp(op, tabId) {
  switch (op.kind) {
    case "screenshot": {
      return withDebugger(tabId, async (target) => {
        await sendCommand(target, "Page.enable");
        const result = await sendCommand(target, "Page.captureScreenshot", { format: "png" });
        return { imageBase64: result.data };
      });
    }
    case "snapshot": {
      return withDebugger(tabId, async (target) => {
        await sendCommand(target, "Runtime.enable");
        const result = await sendCommand(target, "Runtime.evaluate", { expression: SERIALIZE_SNAPSHOT_EXPR, returnByValue: true });
        return JSON.parse(result.result.value);
      });
    }
    case "navigate": {
      return withDebugger(tabId, async (target) => {
        await sendCommand(target, "Page.enable");
        await sendCommand(target, "Page.navigate", { url: op.url });
        return { navigated: op.url };
      });
    }
    case "click": {
      return withDebugger(tabId, async (target) => {
        await sendCommand(target, "Runtime.enable");
        const located = await sendCommand(target, "Runtime.evaluate", { expression: refCenterExpr(op.ref), returnByValue: true });
        const point = located.result.value ? JSON.parse(located.result.value) : null;
        if (!point) throw new Error(`ref ${op.ref} not found (stale snapshot?)`);
        await sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        return { clicked: op.ref };
      });
    }
    case "type": {
      return withDebugger(tabId, async (target) => {
        await sendCommand(target, "Input.insertText", { text: op.text });
        return { typed: op.text.length };
      });
    }
    default:
      throw new Error(`unknown automation op: ${op.kind}`);
  }
}

/**
 * Executes one automationRequest frame's op, scoped to `identityId`'s tab
 * group. Returns the op's result on success; throws on refusal/failure --
 * sw.js's caller turns that into the automationResponse error frame.
 * @param {Record<string, {groupId: number|null}>} byId
 * @param {string} identityId
 * @param {{kind: string, tabId?: number, [k: string]: any}} op
 */
export async function executeAutomation(byId, identityId, op) {
  const target = await resolveTargetLive(byId, identityId, op.tabId ?? null);
  if (!target.ok) throw new Error(target.reason);

  if (op.kind === "tabContext") {
    const entry = byId[identityId];
    const tabsInGroup = entry && entry.groupId != null ? await chrome.tabs.query({ groupId: entry.groupId }) : [];
    return tabsInGroup.map((t) => ({ id: t.id, url: t.url, title: t.title, active: !!t.active }));
  }

  return runOp(op, target.tabId);
}
