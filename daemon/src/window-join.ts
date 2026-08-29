// Pure Space-based window pairing. Given the windows macOS reports as on-screen
// (which is implicitly the active Space), the bounds Chrome reports for its own
// windows, and the display layout, decide which cmux window is paired with which
// Chrome window.
//
// Pure and display-free on purpose, like gate.ts and group-projection.ts: the
// whole join is provable in tests without a window server attached.
//
// Every rectangle here is in CG coordinates, whose origin is the PRIMARY screen's
// top-left with y growing DOWN. The caller owns that conversion, and it is the
// trap in this area: flipping NSScreen frames with the union's max Y rather than
// the primary's makes a full-height window match two displays at once.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CGWindow {
  id: number;
  owner: string;
  bounds: Rect;
}

/** A window as Chrome's own `chrome.windows` API reports it. Its integer id is
 * unrelated to any CGWindowID, which is why bounds are the only bridge. */
export interface ChromeWindow {
  id: number;
  bounds: Rect;
}

export interface Display {
  id: number;
  bounds: Rect;
}

export interface Pair {
  displayId: number;
  cmuxWindowId: number;
  chromeCgWindowId: number;
  chromeWindowId: number | null;
}

export type Violation =
  | { kind: "ambiguous"; displayId: number; owner: string; count: number }
  | { kind: "unpaired"; displayId: number; owner: string };

export interface JoinResult {
  pairs: Pair[];
  violations: Violation[];
}

export const TERMINAL_OWNERS = ["cmux", "Ghostty"];
export const BROWSER_OWNERS = ["Google Chrome"];

/** Below this, a "window" is a toolbar, a divider, or a tab strip. The real list
 * is full of them: a 13x1440 sliver and a 1290x47 strip on this machine. */
const MIN_W = 400;
const MIN_H = 300;

/** Chrome and CoreGraphics disagree by a pixel or two on the same window. */
const BOUNDS_TOLERANCE = 4;

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Assign by center, not intersection: a window overlapping two displays belongs
 * to exactly one, and intersection would double-count it. */
function displayFor(w: CGWindow, displays: Display[]): Display | null {
  const c = center(w.bounds);
  return (
    displays.find(
      (d) =>
        c.x >= d.bounds.x &&
        c.x < d.bounds.x + d.bounds.w &&
        c.y >= d.bounds.y &&
        c.y < d.bounds.y + d.bounds.h,
    ) ?? null
  );
}

function boundsDelta(a: Rect, b: Rect): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h);
}

function resolveChromeWindowId(cg: CGWindow, reported: ChromeWindow[]): number | null {
  let best: { id: number; delta: number } | null = null;
  for (const c of reported) {
    const delta = boundsDelta(cg.bounds, c.bounds);
    if (delta > BOUNDS_TOLERANCE * 4) continue;
    if (!best || delta < best.delta) best = { id: c.id, delta };
  }
  return best?.id ?? null;
}

export function joinWindows(
  cgWindows: CGWindow[],
  chromeWindows: ChromeWindow[],
  displays: Display[],
): JoinResult {
  const real = cgWindows.filter((w) => w.bounds.w > MIN_W && w.bounds.h > MIN_H);

  const byDisplay = new Map<number, CGWindow[]>();
  for (const w of real) {
    const d = displayFor(w, displays);
    if (!d) continue;
    const list = byDisplay.get(d.id);
    if (list) list.push(w);
    else byDisplay.set(d.id, [w]);
  }

  const pairs: Pair[] = [];
  const violations: Violation[] = [];

  for (const [displayId, windows] of byDisplay) {
    const terminals = windows.filter((w) => TERMINAL_OWNERS.includes(w.owner));
    const browsers = windows.filter((w) => BROWSER_OWNERS.includes(w.owner));

    // Never guess. Two candidates on one display means the one-per-Space
    // invariant broke, and acting on a guess is how groups end up in the wrong
    // window. The caller falls back to the marker tab on any violation.
    if (terminals.length > 1) {
      violations.push({ kind: "ambiguous", displayId, owner: terminals[0].owner, count: terminals.length });
    }
    if (browsers.length > 1) {
      violations.push({ kind: "ambiguous", displayId, owner: browsers[0].owner, count: browsers.length });
    }
    if (terminals.length > 1 || browsers.length > 1) continue;

    if (terminals.length === 1 && browsers.length === 1) {
      pairs.push({
        displayId,
        cmuxWindowId: terminals[0].id,
        chromeCgWindowId: browsers[0].id,
        chromeWindowId: resolveChromeWindowId(browsers[0], chromeWindows),
      });
      continue;
    }

    // One half present and the other absent: reportable, but not an error. A
    // display holding no managed windows at all produces nothing.
    for (const w of [...terminals, ...browsers]) {
      violations.push({ kind: "unpaired", displayId, owner: w.owner });
    }
  }

  return { pairs, violations };
}
