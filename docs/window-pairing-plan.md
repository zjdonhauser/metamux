# Space-based window pairing: design

> **Status: IN PROGRESS.** The join, the helper, the pairing layer, and follow-the-tab are built;
> auto-create-partner and park-partner are not. The contract now lives in `docs/protocol.md`
> ("Space-based window pairing"); this document is kept for the design rationale and the
> measurements behind it. Where this and `docs/protocol.md` disagree, protocol.md is the contract and
> wins; this doc becomes protocol text once it ships.

## The problem

metamux identifies "the Chrome window" with a marker tab pointing at `panel.html`
(`protocol.md:303`). It is a token metamux plants and hopes survives. When it does not,
`protocol.md:702` guesses: adopt the window with the most managed-title groups.

Everything downstream inherits that uncertainty. `placementOverride` exists because metamux
cannot tell **"the user dragged this group"** from **"the workspace moved, so the group should
follow."** It resolves the ambiguity bluntly: assume the user did it, stop touching the group.
That is correct when you cannot tell, and it is exactly what blocks follow-the-tab.

## The invariant

> **One cmux window and one Chrome window per display, per Space.**

Zac works fullscreen-split, one cmux plus one Chrome per Space, across multiple monitors. That
is not a workaround for this design; it is the invariant that makes a three-step join correct.
metamux **verifies** it rather than assuming it (see Behavior 2).

## The join

Three steps, no permission, no private API:

1. **Enumerate on-screen windows.** `CGWindowListCopyWindowInfo([.optionOnScreenOnly,
   .excludeDesktopElements], kCGNullWindowID)`. `.optionOnScreenOnly` is implicitly a Space
   filter: measured 2 real windows on the active Space against 4 across all Spaces.
2. **Bucket by display.** Intersect window bounds with each `NSScreen` frame.
3. **Pair within a bucket.** One cmux window plus one Chrome window is the pair.

Identical for Split View and side-by-side, because both put exactly one of each app on one
display of one Space.

**Coordinate flip, the classic bug here.** CG's origin is the *primary* screen's top-left:
`cgY = NSScreen.screens[0].frame.maxY - screen.frame.maxY`. Using the union's max Y instead
makes a window intersect two displays. Zac's secondary display sits *above* the primary
(`-1539, 1440`), which is precisely the arrangement that exposes it. A first draft of the probe
had this bug and silently mispaired.

**Filtering.** The raw list contains overlays and slivers (a 13x1440 divider, a 1290x47 strip).
Filter to `width > 400 && height > 300`, then take the largest per PID per display.

### Joining to Chrome's own window ids

Chrome's `chrome.windows` integer id and the CGWindowID are unrelated, and nothing maps them.
The bridge is geometry: the extension reports `chrome.windows.getAll()` bounds, the helper
reports CG bounds, the daemon matches rectangles. Recomputed every tick, so it is self-healing
and never persisted as truth.

### Off-Space destinations

The on-screen filter only sees the active Space. Chrome's own API sees all its windows
regardless. So:

> **Derive when visible, remember when not, re-verify on return.**

The join establishes and refreshes pairings; the registry persists them; a move to an off-Space
window uses the remembered pairing and re-verifies when that Space next activates. Private CGS
space-id APIs (`CGSCopySpacesForWindows`) are deliberately **not** used.

## Components

| Component | New? | Responsibility |
|---|---|---|
| `window-source/metamux-windows.swift` | new | Poll CG window list at 1 Hz, POST to daemon. Optional AX tier. |
| `daemon/src/window-join.ts` | new | **Pure.** (cgWindows, chromeWindows, screens) -> pairs + violations. Unit-testable with no windows. |
| `daemon/src/registry.ts` | edit | Persist `chromeWindowId` and `displayId` alongside `cmuxWindowId`. |
| `extension/sw.js` | edit | Report `chrome.windows.getAll()` bounds in the state frame. |
| `POST /window-state` | new | Helper -> daemon. Token-authed like `/open`. |

`window-join.ts` being pure and separately testable is the point: it matches `gate.ts` and
`group-projection.ts`, and it means the whole join is provable without a display attached.

**Helper lifecycle:** spawned by the daemon as a child process, not a LaunchAgent. Its lifetime
is tied to the daemon, it leaves no orphan, and it needs no separate install step.

## Permission tiers

| Tier | Permission | API | Provides |
|---|---|---|---|
| 1 | **none** | `CGWindowListCopyWindowInfo` | identity, display, Space membership, the join |
| 2 | Accessibility | `AXObserver` | push events instead of 1 Hz polling |
| 3 | Accessibility | `kAXPositionAttribute`, `kAXRaiseAction` | focus-raise, geometry yoking |

**Tier 1 is load-bearing; 2 and 3 are additive.** A Claude Code TCC grant is recorded per
version binary and lapses on auto-update (see `BUILD-STATUS.md`, 2026-08-28). The helper must
therefore detect a revoked Accessibility grant, log it loudly, drop to tier 1, and keep every
tier-1 behavior working. Silent degradation is the failure mode to avoid.

In Split View macOS owns the layout, so tier 3 mostly buys focus-raise. Build it last.

## Behaviors

### 1. Follow-the-tab

Move a cmux workspace to another cmux window; its Chrome group follows.

**Detection is the hard part, and the event log will not do it.** Measured: `window_id` rides
only on `workspace.action` events (set_color, clear_color, mark_read). It is absent from
`selected`, `created`, `closed`, and `reordered`, and there is no `workspace.moved` event.

So: event-triggered, CLI-confirmed. On `workspace.selected`, query `listWindows` / `listTabs`
for the holding window, compare to the stored `cmuxWindowId`, and treat a change as a move.
Moving a tab nearly always selects it at the destination, so this is responsive in practice.

Then `chrome.tabGroups.move(groupId, { windowId, index: -1 })`.

**This is only possible because identity is real.** A confirmed `cmuxWindowId` change
distinguishes a workspace-move from a user-drag for the first time, which is what
`placementOverride` could never do.

Echo suppression: the move fires `tabs.onActivated`. Extend the existing 1500ms post-activate
suppression or it reads back as user intent.

Refusals to handle: Chrome will not move a group into a popup or app window.

### 2. Invariant guard

Two Chrome windows on one display means the invariant broke. **Log loudly, fall back to the
marker tab, act on nothing.** Never guess.

This is what makes the other three trustworthy, and it is the behavior the current design cannot
express: today an ambiguous state is indistinguishable from a normal one.

### 3. Auto-create the partner

A cmux window on a display with no Chrome partner gets one created and paired.

Guarded: only for a cmux window metamux knows about, at most one creation per display per 30s,
and never while the invariant guard is tripped. metamux opening windows unprompted is the most
intrusive behavior here, so it is the one most worth rate-limiting.

### 4. Park the partner

When a cmux window closes, its paired Chrome window is **parked (minimized), not closed.**

Config `windowCloseBehavior: "park" | "close"`, default `park`, mirroring `closeBehavior:
"archive"`. Closing destroys tabs the user may still want; parking is reversible. `close` is
available for anyone who wants it and is never the default.

## Assumptions, and the one that gates this

- **Split View was over-gated in the first draft of this doc, and the gate has been lowered.**
  `com.apple.spaces.plist` records `TileWindowID` per tile, which is a plain CGWindowID, so tiled
  windows carry ordinary window ids: the only property the join needs. The plist also records
  `Inter-Tile Spacing: 12`, which means the 12px gap first read as evidence AGAINST Split View is
  actually consistent with it. Confirming per-display `pairable: YES` while tiled is still worth
  doing, but it validates rather than blocks: the join is pure and tested against both shapes, and
  the only Split-View-dependent piece is the helper's size filter, which is relative to display
  area rather than absolute.
- Verified: the Space filter discriminates (2 on-Space vs 4 total).
- Verified: window id, owner, and bounds need no TCC grant. Only `kCGWindowName` is gated.
- Verified: `window_id` is absent from the workspace events that matter.

## Rollback

Every behavior is config-gated and defaults off. The marker tab stays in place as the fallback
path and is not deleted until the join has run clean for a sustained period. Turning the config
off restores today's behavior exactly, with no migration.
