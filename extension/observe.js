/**
 * Observation for the identity model
 * (docs/superpowers/specs/2026-08-31-metamux-identity-model-design.md).
 *
 * Chrome's own window and group ids are ephemeral: a windowId dies with the
 * window and a groupId does not survive a cross-window move. So every window
 * metamux manages carries a marker tab at `panel.html?win=<mintedId>`, and the
 * MINTED id is what the daemon stores. Chrome restores tabs on restart, so the
 * marker restores with them and the pairing survives.
 *
 * The pure functions here take snapshots as data; sw.js gathers them.
 */

/** Reads the minted id out of a marker tab URL, or null if this is not one. */
export function markerIdFromUrl(url, panelUrl) {
  if (typeof url !== "string" || !url.startsWith(panelUrl)) return null;
  const query = url.slice(panelUrl.length);
  const match = query.match(/[?&]win=([^&]+)/);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id === "" ? null : id;
  } catch {
    return null;
  }
}

/**
 * Builds the observation the daemon reconciles against.
 *
 * A group in an unmarked window reports `chromeWindowId: null` rather than
 * Chrome's numeric id: the daemon must never store an ephemeral value, and a
 * null is honest about the window not being paired yet.
 *
 * @param {{id: number, type: string}[]} windows
 * @param {{windowId: number, url: string}[]} markerTabs
 * @param {{groupId: number, title: string, windowId: number, tabs: {tabId: number, url: string}[]}[]} groups
 * @param {string} panelUrl
 */
export function buildObservation(windows, markerTabs, groups, panelUrl) {
  const mintedByWindow = new Map();
  for (const tab of markerTabs) {
    const minted = markerIdFromUrl(tab.url, panelUrl);
    // First marker wins: a duplicated marker must not flip the window's
    // identity from pass to pass.
    if (minted !== null && !mintedByWindow.has(tab.windowId)) mintedByWindow.set(tab.windowId, minted);
  }

  const normal = windows.filter((w) => w.type === "normal");
  const observedWindows = [];
  const unmarked = [];
  for (const win of normal) {
    const minted = mintedByWindow.get(win.id);
    if (minted === undefined) unmarked.push(win.id);
    else observedWindows.push({ chromeWindowId: minted, numericId: win.id });
  }

  const observedGroups = groups.map((g) => ({
    groupId: g.groupId,
    label: g.title,
    chromeWindowId: mintedByWindow.get(g.windowId) ?? null,
    tabs: g.tabs,
  }));

  return { windows: observedWindows, groups: observedGroups, unmarkedWindowIds: unmarked };
}

/** Maps a minted id back to the numeric window id an op has to act on. */
export function numericWindowFor(observation, chromeWindowId) {
  const found = observation.windows.find((w) => w.chromeWindowId === chromeWindowId);
  return found ? found.numericId : null;
}
