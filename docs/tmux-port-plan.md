# Absorbing tmux-cmux-sync into metamux: port plan

> **Status: SHIPPED (2026-08-27).** This document is kept for its design rationale, not as a
> to-do list. The port landed on branch `tmux-absorption`: tmux is a live second source
> (`daemon/src/tmux-source.ts`, `tmux-reconcile.ts`) driving a second actuator
> (`cmux-actuator.ts`), partition mode is the default, and the legacy `~/bin/tmux-cmux-sync*`
> scripts are dead (still on disk as the documented rollback). Where this plan and
> `docs/protocol.md` disagree, protocol.md is the contract and wins.

Original analysis, as written before implementation. Source read in full:
`~/bin/tmux-cmux-sync` (bash, 257 lines), `~/bin/tmux-cmux-sync-tick.py` (311 lines),
`~/bin/tmux-cmux-crosswin.py` (74 lines, orphaned -- see §1.8), `docs/protocol.md`,
`BUILD-STATUS.md`, and the current daemon source (`registry.ts`, `group-projection.ts`,
`gate.ts`, `main.ts`, `cmux-rpc.ts`, `parser.ts`).

Zac's direction: *"one auto group per tmux session, the same way we generate one cmux tab
per tmux session; those two creation features should be tied together; it should all be one
program."* Today there are two programs (`tmux-cmux-sync`, a standalone tool that creates
cmux tabs for tmux sessions; `metamuxd`, which creates Chrome tab groups for cmux tabs) that
happen to compose because the second one watches the same `events.jsonl` the first one's
actions land in. The target is one program that owns both creation steps directly.

## 1. Complete behavior inventory of the existing tooling

### 1.1 Two files, one of which is half dead code

The header comment explains the split: *"bash 5.3.15 segfaults on the repeated
command-substitution-in-a-read-loop pattern"* the reconcile needs, so the reconcile was
ported to Python. What the comment doesn't say, and what tracing every call site confirms,
is that **the bash reimplementation was never deleted**. `tick()` (bash, lines 210-219)
unconditionally shells out to `tick.py`; nothing in the `case` dispatch at the bottom ever
calls the bash functions above it. That means `strip_ws`, `titles_in`, `ref_alive_in`,
`window_uuids`, `spawn_tab`, `host_map`, `alphabetize_window`, `tick_windows`, `tick_global`,
and `crosswindow_badges` (all bash, lines 45-208) are **~155 of the file's 257 lines,
entirely unreferenced**. They're a leftover of the incremental bash-to-Python port, not an
intentional fallback. The live bash surface is only: env/default wiring (27-43), the
singleton `--ensure` launcher (221-245), the `--loop` compat shim (246-253), and `tick()`'s
delegation to Python (210-219). **Everything else -- every mode, every edge case below --
is Python's behavior, not bash's.** This matters for the port: there is nothing to preserve
from the bash reconcile functions; they were already superseded once.

### 1.2 Two mirror modes (`TMUX_CMUX_MIRROR`)

- **`windows` (default)**: every cmux **window** gets its own tab attached to every tmux
  session -- true mirroring, one tmux client per (window, session) pair. The header comment
  gives the concrete reason: tmux sizes a shared client's display to `window-size latest` by
  default (the smallest attached client), so reusing one client across windows would shrink
  every pane to whatever window happens to be smallest. One client per window sidesteps that.
- **`global`**: one tab total per session, across all windows. A session already attached
  *anywhere* is left alone (`attached != 0` -> skip); only unattended sessions get surfaced.
  No mirroring, no multi-client story -- this mode assumes a single point of attachment.

Zac's live setup runs the default (`windows`) -- `.zshrc` never sets `TMUX_CMUX_MIRROR`.

### 1.3 Env vars (defaults as coded)

| Var | Default | Used by |
|---|---|---|
| `CMUX_BIN` | `cmux` on `$PATH`, else `/Applications/cmux.app/Contents/Resources/bin/cmux` | both |
| `CMUX_QUIET` | `1` (always exported) | both -- suppresses cmux CLI's decorated stdout |
| `TMUX_CMUX_HUB` | `~/Documents/GitHub` | spawn's `--cwd` (see §1.11 for why this isn't "the session's real cwd") |
| `TMUX_CMUX_STATE` | `~/.local/state/tmux-cmux-sync.json` | session -> cmux-tab-id cache |
| `TMUX_CMUX_LOG` | `~/.local/state/tmux-cmux-sync.log` | both |
| `TMUX_CMUX_PIDFILE` | `~/.local/state/tmux-cmux-sync.pid` | bash singleton + Python `loop()` |
| `TMUX_CMUX_LOCKDIR` | `~/.local/state/tmux-cmux-sync.lock` | bash `--ensure` race guard only |
| `TMUX_CMUX_MIRROR` | `windows` | mode select |
| `TMUX_CMUX_ALPHABETIZE` | `1` | windows-mode tab ordering |
| `TMUX_CMUX_CROSSWIN` | `1` | cross-window badge feature |
| `TMUX_CMUX_BADGES` | `~/.local/state/tmux-cmux-badges.json` | badge state cache |
| `TMUX_CMUX_GRACE` | `15` (seconds) | **global**-mode reattach throttle |
| `TMUX_CMUX_INTERVAL` | `2` (seconds) | `loop()` poll cadence |
| `TMUX_CMUX_CROSSWIN_COLOR` | `#2779FB` | badge rail color |
| `TMUX_CMUX_REATTACH` | `~/.local/state/tmux-cmux-reattach.json` | **windows**-mode reattach throttle cache |
| `TMUX_CMUX_REATTACH_GRACE` | `8` (seconds) | windows-mode reattach throttle |

Quirk: `TMUX_CMUX_REATTACH`/`TMUX_CMUX_REATTACH_GRACE` are read directly from `os.environ`
in `tick.py` but **are not in bash's env-forwarding list** (the block at lines 214-218 and
237-241 of the bash script). They still work today because bash doesn't unset them, so
anything set in the ambient shell environment passes through -- but there's no documented
bash-level way to override them, unlike every other knob. Minor, undocumented debt; not
something to reproduce.

Two *different* grace periods (`GRACE`=15s for global mode, `REATTACH_GRACE`=8s for windows
mode) exist for what is structurally the same concern -- don't re-litigate the throttle, just
unify it under one config key in the port (§2, §5).

### 1.4 State files

Four independent JSON files, all treated as **caches, not ledgers** -- every one of them is
re-derivable from live tmux + cmux state, which is exactly why the migration and rollback in
§3 are low-risk:

1. `tmux-cmux-sync.json` -- windows mode: `{windowUUID: {sessionName: cmuxTabUUID}}`.
   Global mode: `{sessionName: cmuxTabUUID}` (a bare string per session -- global mode's
   Python implementation dropped the timestamp bash's version kept here; see the gap noted
   in §1.6).
2. `tmux-cmux-sync.log` -- append-only, human-readable, `HH:MM:SS message` lines.
3. `tmux-cmux-sync.pid` -- owned and written by the Python `loop()`, not bash (see §1.9).
4. `tmux-cmux-badges.json` -- `{windowUUID: {tabUUID: colorHexOrLabel}}`, cross-window badge
   dedupe (§1.8).
5. `tmux-cmux-reattach.json` -- windows-mode only, `{"windowUUID|tabUUID": lastAttemptEpoch}`.

### 1.5 Content-based join: `host_map()`

The core correctness trick, present in both `tick.py` and the orphaned `crosswin.py`: map
**cmux workspace UUID -> tmux session name** by cross-referencing `tmux list-clients`
(`client_pid`, `client_session`) against `ps eww -o pid=,command= -p <pids>` and regexing
`CMUX_WORKSPACE_ID=<uuid>` out of each client process's inherited environment (visible via
`ps eww`'s `command=` column, which includes env on macOS). This is **content-based, not
title-based**: it's correct even after cmux auto-retitles a tab (e.g. a shell command changes
the terminal title) because it doesn't look at the tab's title at all, it looks at which
literal env var the tmux client process was launched with. Every place that needs "does this
cmux tab currently host tmux session X" goes through this join, never through title string
matching. This is the mechanism that makes title-lock (§1.6) and reattach-detection possible
without false positives from title drift.

### 1.6 Reconcile tick (Python, the live behavior)

**`tick_windows(sessions, host, wins)`** (called every `INTERVAL` seconds when
`MIRROR=windows`), per cmux window:

1. **Presence + title lock**: for every tab currently in the window, look up its host via
   `host_map()`. If it hosts a live tmux client, mark that session present, record
   `state[window][session] = tabId`, and if the tab's title doesn't already equal the session
   name, force-rename it (`workspace-action --action rename`). If a tab has no hosting client
   but its *title* matches a live session name, treat that as a **restored-or-detached** tab
   (see reattach below) rather than empty/orphaned.
2. **Reattach-after-restore** (windows mode only): a tab titled for a live session with no
   attached client means either a cmux session restore (the pane exists but tmux's client
   process is gone) or a manual `tmux detach`. Rather than leave it blank or spawn a
   duplicate, it re-types `tmux new -A -s <name>` + Enter into that exact tab, throttled by
   `TMUX_CMUX_REATTACH_GRACE` (8s) keyed on `window|tab` so the retype doesn't happen every
   2s tick while the pane is still warming up (a freshly sent command takes 1-2s to actually
   attach).
3. **Spawn**: any session not yet present in this window gets a new tab:
   `cmux new-workspace --window <w> --name <session> --cwd $HUB --focus false --command
   "tmux new -A -s <session>"`. `--focus false` is what makes this silent (no window-stealing
   on every tick).
4. **Alphabetize** (if `ALPHA=1`): pinned tabs stay wherever they are; every unpinned tab is
   sorted case-insensitively by title. Only tabs actually out of order get
   `reorder-workspace` calls -- it diffs current vs. desired order first and no-ops if already
   sorted, so a converged window issues zero reorder calls per tick.
5. **Reap**: a window that's disappeared from `list-windows` drops its whole state entry (no
   close calls -- the window and its tabs are already gone). A tracked session no longer in
   the live session list gets its tab explicitly closed (`close-workspace`) and removed from
   state.

**`tick_global(sessions_attached, host)`** (called when `MIRROR=global`): spawns a tab for
any session with `attached == 0` that isn't already titled into an existing tab; closes the
tab for any tracked session that no longer exists. **Gap**: unlike windows mode, global
mode's Python implementation has **no reattach logic at all** -- compare this to bash's
*dead* `tick_global` (§1.1), which *did* implement a grace-throttled reattach
(`ref_alive_in` + `now - ts >= GRACE`). That logic was not carried over to Python. Since
global mode isn't the mode actually running on Zac's machine, this gap is latent, not
observed -- but it means a restored/detached tab in global mode today would get a **duplicate
spawn** rather than a reattach. Worth a decision in the port: fix it, or preserve parity with
today's (broken) global-mode behavior. Recommend fixing it, since it's strictly a
generalization of the windows-mode logic that already exists and is tested by production use.

### 1.7 Crosswindow badges: two implementations, one live

`tick.py`'s own `main()` calls its **inline** `crosswindow_badges(host, wins)` (lines
196-221) when `CROSSWIN=1`. This colors a tab's **rail** (`workspace-action --action
set-color/clear-color`) brand-blue when that tab's session is the *selected* tab in a
*different* window -- so with multiple windows mirroring the same sessions, you can tell at a
glance which session is being actively looked at elsewhere. The function's own docstring
explains why it uses tab color and not a status pill: *"cmux does not render set-status pills
in this sidebar config."*

The **separate script** `~/bin/tmux-cmux-crosswin.py` is the *original* implementation --
functionally identical join/window logic, but it marks tabs with `cmux set-status crosswin
"w<idx>" --color ... --priority 90` (a real labelled pill) instead of a plain color. The
bash function `crosswindow_badges()` (line 206-208, itself dead per §1.1) is the only thing
that ever invoked it. **This script is fully orphaned**: nothing in the live pipeline calls
it. It was superseded when pills stopped rendering in Zac's sidebar config and the color-only
version got inlined directly into `tick.py`. Port the **color** approach; the
`set-status`/pill script is not live behavior and should not be ported (§4).

### 1.8 Singleton lifecycle

- **`--ensure`** (bash): gated on `$CMUX_SOCKET_CAPABILITY` (only runs from a real cmux
  shell, since the CLI auth token lives in that env). Checks the pidfile via `kill -0`; if
  alive, no-ops. Otherwise takes an `mkdir`-based lock (`LOCKDIR`, atomic -- only one
  concurrent `--ensure` across racing shells wins), re-checks the pidfile inside the lock
  (closing the TOCTOU race), then `nohup`s `python3 tick.py --loop`, disowns it, and
  **immediately writes `$!` to the pidfile itself** before the lock is released -- the
  comment calls this out explicitly ("closing the race"): the child's own first line of
  `main()` also writes the pidfile, so there are two writers, but bash writes first so a
  fast-racing second `--ensure` sees a live pidfile before Python has had a chance to.
- **Python `loop()`**: writes its own pid to the pidfile again (redundant with bash's, but
  authoritative going forward), then loops: on each iteration, checks `_owner() == pid`
  (bail if a newer instance has taken the pidfile -- self-supersession, not a hard singleton
  lock) and `cmux identify` returncode. Runs `main()` (one tick) if identify succeeds; if it
  fails 15 consecutive polls (`15 * INTERVAL` = 30s default), it logs and **returns**, ending
  the process -- deliberately, so the *next* cmux shell's `--ensure` relaunches it with a
  fresh env/auth token. `finally:` removes the pidfile if this process still owns it.
- **Signal handling gap**: no `signal.signal(...)` is installed anywhere in `tick.py`.
  Python's default disposition for `SIGINT` raises `KeyboardInterrupt`, which *does* unwind
  through `try/finally` -- so `kill -INT <pid>` cleanly hits the `finally:` block and removes
  the pidfile. `SIGTERM` (a bare `kill`) has **no Python-level handler installed**, so the OS
  terminates the process directly without ever running the `finally:` clause, leaving a stale
  pidfile behind. **This is the correct way to stop the tool by hand: `kill -INT`, not `kill`
  or `kill -9`.** This is not a hypothetical -- it's directly relevant to the migration's kill
  order (§3.2).

### 1.9 cmux CLI auth model

`cmux` only accepts connections (including plain CLI invocations, per the header comment)
from processes started inside cmux, authenticated via inherited `CMUX_*` env vars. This is
why `tmux-cmux-sync` cannot run from launchd and is instead lazily started from every
interactive cmux shell's `.zshrc`. `metamuxd` already has the identical constraint
(`cmux-rpc.ts`'s `probeSocketFeatures()`, gating ports/reverse-sync/window-follow) -- the
tmux actuator inherits this for free, it's not a new gate to design (§2.7 has one caveat).

### 1.10 Edge cases and quirks, with the why

- **Only tabs this tool spawned are ever closed.** A plain Claude session tab, a
  `sync-cmux PC-####` tab, or a scratch tab opened by hand is invisible to reap logic because
  reap only iterates `state`'s own tracked ids, never scans all tabs and guesses.
- **`--cwd $HUB` is always `~/Documents/GitHub`, never the session's actual directory.**
  This isn't a descriptive "this is where the session lives" field -- it's the directory the
  **spawn command** (`tmux new -A -s <name>`) runs from, and it needs to be a directory that
  reliably exists regardless of what the tmux session itself is doing, since a session can
  `cd` anywhere internally. Don't conflate this with a registry "cwd" field in the port (§2.1).
- **Title lock is one-directional and content-driven.** It only fires when `host_map` proves
  a tab hosts a given session (an actual tmux client env var match) -- a tab that *happens* to
  be titled the same as a session but isn't hosting it (e.g. the warmup window right after
  spawn, before the client has attached) is handled by the separate `elif title in sessions`
  branch, not title lock, and is never force-renamed.
- **Alphabetize diffs before acting.** `cur == desired` short-circuits with zero
  `reorder-workspace` calls; this matters because reorder calls are visible/disruptive (they
  move tabs), so a converged window is a true no-op every tick, not a silent reshuffle.
- **`spawn_tab`'s `--focus false`** is the only thing standing between "silent background
  tab creation" and "stealing your focus every time a new tmux session appears." Any port
  must preserve this -- it's the same "never focus automatically" rule metamux's own
  contract already states for F3 (extension side) and F-focus (explicit-only).
- **Session name interpolation into shell strings is unescaped.** `tmux new -A -s $name` (as
  a `--command` argument to `cmux new-workspace`, and again as literal text sent via `cmux
  send`) never validates or quotes `$name`/`$title`. tmux session names can contain spaces or
  shell-meaningful characters if renamed by hand (`tmux rename-session`); nothing here
  guards against that. Not a reported bug, but a real latent one visible from reading the
  code -- worth fixing in the port, not carrying forward as-is (§4).
- **`CMUX_QUIET=1`** is exported unconditionally in both scripts. Its purpose (suppress
  cmux's decorated terminal output) matters when a human might see raw stdout; `cmux-rpc.ts`
  already captures subprocess stdout/stderr via pipes without setting it and works fine, so
  it's likely moot for a Bun-spawned actuator -- flag as "probably drop, verify empirically"
  rather than asserting it's required (§4).
- **`main()`'s first line is `if cmux("identify").returncode != 0: return`** -- a per-tick
  socket-feature check, structurally identical to what `probeSocketFeatures()` already does
  once at `metamuxd` startup. See §2.7 for why "once at startup" vs. "every tick" is a real
  behavioral gap worth closing as part of this work, not just for tmux.

## 2. Target design in metamux

### 2.1 Registry identity: the tmux session, not the cmux tab

`WorkspaceRef.source` is currently the literal type `"cmux"`. It becomes a union:
`"cmux" | "tmux"`. For a tmux-sourced ref:

- `sourceId` = the tmux **`#{session_id}`** format variable (verified live on Zac's tmux
  3.6a: `tmux ls -F '#{session_id} #{session_name}'` -> `$25 cmux`, `$2 compliance`, etc.),
  **not** `#{session_name}`. This mirrors exactly why cmux workspaces key `sourceId` on a
  UUID and not on `title`: `#{session_id}` is assigned once at session creation and is stable
  across `tmux rename-session` for the life of the tmux server, whereas `#{session_name}` is
  the *mutable* identity a user can change at any time -- using the name as `sourceId` would
  make a rename indistinguishable from a kill+recreate.
- `title` = the session name (exactly what tmux-cmux-sync already titles tabs as).
- `cwd` = leave `null` or a fixed hub-equivalent, matching §1.10's finding that "cwd" here
  has never meant "the session's real directory" -- don't invent new meaning for the field
  without deciding that deliberately and separately.

**Required registry.ts fix, not optional**: `Registry.findMatch`'s title/cwd fallback branch
(`registry.ts:76-83`) currently matches on `(title, cwd)` alone, with no `source` check. Once
a tmux-sourced ref and a plain cmux-sourced ref can legitimately share a title (a tmux
session named "compliance" and an unrelated hand-opened cmux tab also titled "compliance"),
this fallback would wrongly re-bind them to the same `WorkspaceRef`. The fallback match must
additionally require `ref.source === <the event's source>`. This is a one-line change but a
correctness requirement for Phase 0 (§5), not a nice-to-have.

### 2.2 cmux tabs become attachments, not registry members

Today, `TMUX_CMUX_MIRROR=windows` creates **N separate cmux workspace UUIDs** (N = window
count) for one tmux session, each becoming its own `WorkspaceRef` under the current registry
(they're ordinary cmux tabs; they emit ordinary `workspace.created`/`workspace.selected`
events). `groupBy: "title"` (already shipped, see §2.6) is the *only* thing currently
collapsing those N duplicate refs into one Chrome group.

In the target design, the tmux session is the one registry identity. The N cmux tabs that
mirror it across windows become **attachments** tracked by the new cmux actuator, not
separate `WorkspaceRef`s:

```ts
interface CmuxAttachment {
  windowId: string;       // cmux window UUID
  cmuxWorkspaceId: string; // the underlying cmux tab's UUID (what cmux-rpc/registry call sourceId for a *cmux* ref)
}
// keyed by the tmux WorkspaceRef's id, held by the new actuator module -- NOT a field on WorkspaceRef.
```

This follows the existing architectural convention: `Registry` stays a single flat map of
refs with no feature-specific fields bolted on; per-feature side-state lives in its own
tracker (`PortsTracker`, `LazyGroupTracker`, `GroupProjection`'s private maps). An attachment
tracker is the same pattern applied to "which cmux tabs currently mirror this tmux session."

### 2.3 tmux source adapter

New module, e.g. `daemon/src/tmux-source.ts`. Two evaluated approaches for detecting
create/rename/kill:

**Polling** (recommended for v1): `tmux list-sessions -F '#{session_id} #{session_name}
#{session_attached}'` every `debounceMs`-independent interval (2s, matching the tool's own
default and metamux's existing 4s ports-poll precedent). Diff two polls by `session_id`:
a new id = created; same id, different name = renamed; a previously-seen id now missing =
closed. Cheap (`tmux ls` is near-instant), and it's exactly the primitive the current tool
already relies on. Verified live: `#{session_id}` is populated correctly today (`$25`, `$2`,
`$9`, ...).

**tmux hooks** (`set-hook -g session-created/session-renamed/session-closed 'run-shell ...'`)
-- evaluated and verified available (tmux 3.6a supports all three, confirmed via `tmux
show-hooks -g`). Event-driven, zero-latency, and would slot into the existing `Tailer`
pattern naturally: have each hook append a JSON line to a new
`~/.local/state/metamux/tmux-events.jsonl` and run a second `Tailer` instance against it,
identical in shape to how `~/.cmuxterm/events.jsonl` is consumed today. The real cost is
**where the hook lives**: `set-hook -g` issued at runtime does not survive `tmux
kill-server`; persisting it requires writing to Zac's `.tmux.conf`, which is a materially
bigger footprint than anything metamux currently touches (it doesn't edit cmux.json,
`.zshrc`, or any user dotfile -- `ensure-daemon.sh` only *reads* metamux's own config).
`session-attached`/`client-attached` hooks would still be needed for the attach-detection
half regardless (host_map is a poll-time cross-reference, not an event).

**Recommendation**: ship polling for v1 (matches the existing tool's proven cadence, zero new
footprint, and the reconcile is already going to run on a timer for the cmux-actuator side
anyway -- see §2.5). Leave hooks as a documented future optimization, gated behind an
explicit opt-in that edits `.tmux.conf`, only if 2s latency ever actually bothers Zac.

`hostMap()` (attach detection) ports essentially as-is: `tmux list-clients -F '#{client_pid}
#{client_session}'` + `ps eww -o pid=,command= -p <pids>` regexed for `CMUX_WORKSPACE_ID=`,
via `Bun.spawn` following `cmux-rpc.ts`'s existing subprocess pattern. This isn't a session
lifecycle signal; it runs every tick alongside the session poll, feeding the same reconcile
input (§2.5).

### 2.4 cmux actuator

New module, e.g. `daemon/src/cmux-actuator.ts`, a second actuator sitting alongside the
Chrome extension (which drives Chrome tab groups over WS) -- this one drives cmux tabs
directly via `Bun.spawn`ed `cmux` CLI calls, same trust boundary as `cmux-rpc.ts`. One
function per action, each a thin wrapper reusing exactly the CLI invocations the existing
tool already proved work:

| Function | Wraps | Ported from |
|---|---|---|
| `createTab({windowId, sessionName, cwd})` | `cmux new-workspace --window <w> --name <s> --cwd <hub> --focus false --command "tmux new -A -s <s>"` | `spawn_tab`/`spawn()` |
| `renameTab({cmuxWorkspaceId, title})` | `cmux workspace-action --action rename --workspace <id> --title <t>` | title lock |
| `reattachTab({cmuxWorkspaceId, sessionName})` | `cmux send "tmux new -A -s <s>"` + `cmux send-key Enter` | windows-mode reattach |
| `closeTab({cmuxWorkspaceId})` | `cmux close-workspace --workspace <id>` | reap |
| `reorderTabs({windowId, orderedIds})` | `cmux reorder-workspace --workspace <id> --index <i> --window <w>` per id | alphabetize |
| `setColor`/`clearColor` | `cmux workspace-action --action set-color/clear-color` | crosswin badges (§1.8, color version only) |
| `listWindows()` | prefer `cmux rpc window.list` (already wrapped in `cmux-rpc.ts`'s `listAllWorkspaceColors`) over text-parsing `cmux list-windows` | more robust than the bash/Python text-grep, no reason to keep parsing text once not shelling out generically |

Session names get validated/escaped before being interpolated into any `tmux new -A -s
<name>` string (§1.10's unescaped-interpolation finding) -- not a behavior change from what
users experience, just closing a latent injection/breakage risk that shouldn't be carried
into the port.

### 2.5 Pure reconcile core -- the TDD target

The actual decision logic (`tick_windows`/`tick_global`'s title-lock + presence + spawn +
reap + alphabetize, all interacting) is the single most state-machine-y, edge-case-heavy part
of the whole system, and it's exactly the kind of logic this codebase already isolates into
pure, fixture-tested modules (`group-projection.ts`, `gate.ts`, `ports.ts`). New module, e.g.
`daemon/src/tmux-reconcile.ts`:

```ts
interface ReconcileInput {
  sessions: { id: string; name: string; attached: number }[]; // from tmux ls
  hostMap: Map<string /* cmux tab uuid */, string /* session id */>;
  windows: { id: string }[];
  tabsByWindow: Map<string, { id: string; title: string; pinned: boolean; index: number }[]>;
  mirrorMode: "windows" | "global";
  previousAttachments: Map<string, CmuxAttachment[]>; // by tmux ref id, or by session id pre-registry-write
}

type ReconcileAction =
  | { type: "spawn"; windowId: string; sessionId: string; sessionName: string }
  | { type: "retitle"; tabId: string; title: string }
  | { type: "reattach"; tabId: string; sessionName: string }
  | { type: "reap"; tabId: string }
  | { type: "reorder"; windowId: string; orderedTabIds: string[] };

function reconcile(input: ReconcileInput): ReconcileAction[];
```

Pure input -> output, no I/O, no subprocess calls -- exactly what `group-projection.test.ts`
already demonstrates the testing convention for. Fixtures to cover (each a direct port of a
behavior documented in §1):

- Normal spawn: session exists, no tab in a window -> `spawn`.
- Title drift: `hostMap` says tab X hosts session "foo" but its title says "bar" ->
  `retitle`.
- Reattach: a tab titled for a live session with no `hostMap` entry -> `reattach`, throttled
  (grace window belongs in the reconcile's own state, not two separately-named env vars).
- Reap on session death: tracked tab, session no longer in `sessions` -> `reap`.
- Reap on window death: a window disappears entirely -> its tracked tabs drop from state
  with no explicit reap call (they're already gone).
- Alphabetize: pinned-stays-put ordering, and the no-op case (already sorted -> zero
  `reorder` actions).
- Global-mode grace-throttled reattach (the gap noted in §1.6 -- decide whether the port
  fixes it; recommend yes, and fixture it either way).
- The Phase-0 registry fix's exact scenario: a tmux session and an unrelated cmux tab
  sharing a title, verifying they don't cross-wire.

### 2.6 Interplay with `groupBy: "title"` (already shipped)

`GroupProjection` (`daemon/src/group-projection.ts`) already does exactly what this port
would otherwise need to reinvent: when `groupBy: "title"`, every `WorkspaceRef` sharing a
title is aliased to one Chrome-group identity (`titleAliasId`, `"t_" + 8 hex of an FNV-1a
hash`), computed fresh from whichever members are live. This is precisely why
`TMUX_CMUX_MIRROR=windows`' current N-tabs-per-session doesn't already produce N duplicate
Chrome groups today -- the hash-collapsing is carrying that weight right now, invisibly.

Once tmux sessions are first-class registry identities (§2.1-§2.2: **one** `WorkspaceRef` per
session, N cmux-tab *attachments* tracked separately, not N registry members), the dedup
becomes **structural**: one ref maps to one Chrome group by construction, no title-hashing
required. `groupBy: "title"` stops doing any real work for tmux-backed refs -- aliasing a
title held by exactly one ref to that ref's own alias id is a no-op modulo an extra
indirection.

`groupBy: "title"` remains genuinely useful for **non-tmux** cmux workspaces that
incidentally share a title (two unrelated hand-opened tabs both named "Terminal 1", say) --
that collision has nothing to do with tmux mirroring and this port doesn't remove the need
for it. Recommend: leave the default (`"title"`) alone. It's harmless dead weight for
tmux-backed refs post-port, not a correctness risk, and changing the default is an unrelated
decision with its own blast radius (every non-tmux title collision behaves differently).

### 2.7 Self-event-loop: the actuator's own writes come back through the source

The cmux actuator's `createTab`/`renameTab`/`reorderTabs` calls generate ordinary
`workspace.created`/`workspace.action(rename)` lines in `~/.cmuxterm/events.jsonl` -- the
same file metamuxd's **existing** cmux-source tail already reads. This is a new instance of
an old problem the contract already solves once: `docs/protocol.md`'s 500ms
created-then-selected suppression rule exists *specifically* because tmux-cmux-sync already
does this today (`BUILD-STATUS.md`'s "known facts" section says so explicitly: *"tmux-cmux-
sync creates/renames workspaces programmatically -> the 500ms created->selected suppression
rule in the contract exists for this"*). Absorbing the tool into metamuxd doesn't introduce
this problem, it makes metamuxd the direct cause of what used to be an external actor's
side effect -- the existing `Gate`'s suppression (keyed on workspace id + timing, source-
agnostic) should already cover it, but this needs an explicit test once the actuator exists
(Phase 4, §5): spawn a tab via the new actuator, confirm the resulting
`workspace.created`+`workspace.selected` lines that come back through the tail produce
**no** duplicate `WorkspaceRef` and no spurious Chrome-group flicker. If a gap surfaces,
the fix is the same shape as F9 reverse-sync's echo suppression
(`userActivatedGroup` ignored for the already-active workspace) -- tag self-caused actuator
actions with a short-lived "expected" set, analogous to `Gate.recentCreatedAt`.

Separately, worth flagging (not blocking, a natural side-observation from reading
`tick.py`'s `loop()`): `probeSocketFeatures()` in `main.ts` runs **once**, before the daemon's
main loop starts, not on any recurring cadence. `tick.py`'s `loop()`, by contrast, re-checks
`cmux identify` every single tick and **deliberately self-exits after 30s unreachable**, so
the next cmux-spawned shell's `--ensure`/`ensure-daemon.sh` invocation relaunches it with a
fresh auth token. metamuxd has no equivalent: if cmux restarts out from under a long-running
daemon process, every socket-gated feature (ports, reverse sync, window follow, and the new
tmux actuator) would silently go stale with no self-healing. This predates this port and
isn't tmux-specific, but the tmux actuator adds another feature that would be affected --
worth considering porting `tick.py`'s "re-probe periodically, self-exit and rely on
`ensure-daemon.sh`'s next invocation" pattern into metamuxd's daemon lifecycle generally,
as a follow-up outside this port's strict scope.

## 3. Migration & coexistence

### 3.1 The data-model decision this migration forces

There are two ways to land §2.1-§2.2's registry change against Zac's **live** state
(`~/.local/state/tmux-cmux-sync.json` currently tracks real cmux tab UUIDs that already
exist as ordinary `source: "cmux"` `WorkspaceRef`s in metamuxd's own registry today, because
they emit the same `workspace.created`/`workspace.selected` events any tab does):

- **(a) Bolt-on / transitional**: leave those cmux-sourced refs exactly as they are, and
  build the attachment tracker (§2.2) by reading `tmux-cmux-sync.json` once at startup,
  matching each `{session: cmuxTabUUID}` entry to the existing `WorkspaceRef` by
  `sourceId === cmuxTabUUID`. No registry schema change needed for existing tabs, lowest
  immediate risk, but it perpetuates exactly the two-programs-pretending-to-be-one shape
  Zac's direction is asking to eliminate -- the tmux session still isn't a registry identity,
  it's metadata glued onto N pre-existing cmux refs.
- **(b) Reclassify to the target state directly**: for each `{windowUUID: {session:
  cmuxTabUUID}}` entry, create (or find, if a prior boot already did this) a `source: "tmux"`
  `WorkspaceRef` for the session, record the N matched cmux tab UUIDs as attachments on it,
  and drop those N cmux-sourced refs from being independently tracked identities (they still
  exist as real cmux tabs -- the actuator still manages them -- they just aren't separate
  registry members anymore).

**Recommendation: (b).** (a) doesn't actually deliver "one program" -- it's the same
two-tier structure with a shared cache. (b) is a genuine one-time reclassification pass, not
a live-state migration in the risky sense (no Chrome groups need to close and reopen: a
`WorkspaceRef` rename/re-source doesn't necessarily need to change its `id`, so the paired
Chrome group can be preserved across the reclassification if the implementation is careful
to keep the same `mw_` id rather than minting a new one -- this is an implementation detail
worth pinning down precisely in Phase 5, not guessed at here).

### 3.2 Kill order

1. **Stop the running Python loop with `kill -INT $(cat ~/.local/state/tmux-cmux-sync.pid)`,
   not a bare `kill`.** §1.9 traced why: `SIGTERM` bypasses `tick.py`'s `finally:` block
   entirely (no handler installed) and leaves a stale pidfile; `SIGINT` unwinds cleanly via
   `KeyboardInterrupt` and removes it. This is the one step in this whole plan that's
   easy to get wrong silently (a stale pidfile doesn't error, it just sits there confusing a
   future `--ensure` check that will never actually run because the `.zshrc` line is about
   to be deleted anyway -- so getting this wrong is low-consequence today, but worth doing
   right since the pidfile is also the rollback path's signal, §3.4).
2. **Run the reclassification pass** (§3.1(b)) against the now-stopped tool's last-written
   `tmux-cmux-sync.json`, inside the new metamuxd build, before it starts actuating anything.
   Nothing needs to close or reopen during this step if the same `WorkspaceRef.id`s are
   preserved (see §3.1's caveat).
3. **Start (or hot-reload) metamuxd with the tmux adapter enabled.** No gap for already-
   existing sessions/tabs -- the reclassification pass already recognized them as attached
   on the very first tick, so nothing gets re-spawned. New session creation is picked up on
   metamuxd's next poll (<=2s, same latency the tool being replaced already had). The only
   real gap is the window *between* step 1 and step 3, during which no reconciler runs at
   all -- unavoidable in any handoff, and no worse than what already happens whenever
   tmux-cmux-sync itself gets relaunched by a fresh shell today (a normal, already-tolerated
   occurrence, not a new failure mode).

### 3.3 `.zshrc` changes

- **Delete** the tmux-cmux-sync `--ensure` block (`.zshrc:371-374`, comment included) --
  once metamuxd owns this, a second singleton-launcher racing to manage what's now one
  daemon's job is pure redundancy, not a safety net.
- **Keep** the existing metamux ensure line (`.zshrc:406`:
  `[ -n "$CMUX_WORKSPACE_ID" ] && (bash ~/Documents/GitHub/metamux/scripts/ensure-daemon.sh
  >/dev/null 2>&1 &)`) unchanged -- it already fires on every cmux shell and is exactly the
  mechanism that should now be solely responsible for keeping the (now tmux-aware) daemon
  running. No new `.zshrc` line is needed for this port; the existing one already covers it.

### 3.4 Rollback path

Every state file involved (§1.4, and the new attachment tracker) is a cache, not a ledger --
this makes rollback structurally low-risk, not just "should be fine":

1. Set `tmux.enabled: false` in metamux's config (hot-reloadable the same way `groupBy`/
   `createGroups` already are, per `main.ts`'s `applyConfigChanges` -- add it to that same
   hot-reload set rather than requiring a restart). metamuxd stops touching tmux/cmux tab
   creation entirely; the Chrome-group side keeps working exactly as it does today for
   whatever cmux tabs exist at that moment.
2. Restore the deleted `.zshrc` block (§3.3) and open a fresh cmux shell (or manually run
   `~/bin/tmux-cmux-sync --ensure`).
3. The old tool's `tmux-cmux-sync.json` doesn't need to be "restored" to some earlier state
   -- both tools treat their state files as best-effort caches of live reality, not sources
   of truth (this is explicit in `tick.py`: `state` only ever gets read to *avoid* redundant
   spawns, every actual decision is re-derived from live `tmux ls`/`cmux workspace list`
   each tick). If metamuxd created sessions/tabs the old JSON never learned about while it
   was live, the old tool's own spawn logic adopts them cleanly on its next tick (a tab
   titled for a live session it doesn't yet track just becomes a normal "spawn" or "already
   present" case, same as any tab that existed before tmux-cmux-sync was ever started).

## 4. What does NOT port

- **The bash `tick_windows`/`tick_global`/`alphabetize_window`/`host_map`/`spawn_tab`/
  `crosswindow_badges` functions.** Confirmed dead code (§1.1) -- Python's versions are the
  actual behavior; the bash versions were never deleted after the port, not a parallel
  implementation worth reconciling against.
- **The bash-vs-Python language split itself, and the segfault workaround it exists for.**
  Bash 5.3.15's segfault on repeated command-substitution-in-a-read-loop is a bash runtime
  bug, moot entirely once the reconcile is one TypeScript module running under Bun. No
  lifecycle-language/reconcile-language split is needed in the port.
- **The separate pidfile/lockdir/`--ensure`/`--loop` singleton machinery.** metamuxd is
  already a long-running daemon with its own process lifetime and `ensure-daemon.sh`'s
  port-probe-based idempotent launch (*"a lost race is self-resolving (the second instance
  fails to bind and exits)"* -- the same self-resolving-race philosophy, no lockdir needed).
  The tmux reconcile becomes one more poller inside that one process; it doesn't need its
  own pidfile, lockdir, or `.zshrc` line at all.
- **`~/.local/state/tmux-cmux-sync.{pid,lock}`** and the separate `tmux-cmux-sync.log`.
  Superseded by metamuxd's single process and its existing `daemon.log`
  (`paths.ts`'s `logPath()`).
- **`~/bin/tmux-cmux-crosswin.py`** (the `cmux set-status`/labelled-pill implementation) and
  the dead bash function that references it (§1.8). Genuinely orphaned; port the tab-color
  approach that's actually live in `tick.py`, not this.
- **Unescaped session-name interpolation into `tmux new -A -s <name>` command strings**
  (§1.10). The *mechanism* (typing a command into a cmux pane) ports; the lack of any
  validation/escaping around the session name should not.
- **`CMUX_QUIET=1`.** Likely moot once calling `cmux` via `Bun.spawn` with piped
  stdout/stderr (as `cmux-rpc.ts` already does without setting it) -- flagged as "probably
  drop," not asserted with certainty, since verifying it requires running code this task
  doesn't touch.
- **Two separately-named grace periods** (`TMUX_CMUX_GRACE` for global mode,
  `TMUX_CMUX_REATTACH_GRACE` for windows mode) for the same underlying "don't re-poke a
  target that's still warming up" concern -- unify under one config key.
- **Global mode's current reattach gap** (§1.6) is a bug to fix, not a behavior to preserve
  -- though it's flagged as a decision, not a unilateral call, since "preserve exact parity"
  is a legitimate alternative philosophy for a first cutover.

## 5. Phased implementation plan

Each phase should land with `bun test`/`bunx tsc --noEmit` green and nothing else broken,
same bar as every prior phase of this build per `BUILD-STATUS.md`.

**Phase 0 -- Registry groundwork (no behavior change for existing cmux-only workspaces)**
- Extend `WorkspaceRef.source` to `"cmux" | "tmux"`.
- Fix `Registry.findMatch`'s title/cwd fallback to also require matching `source` (§2.1 --
  required, not optional, for correctness once tmux and cmux refs can share a title).
- Tests: `registry.test.ts` additions -- a tmux-sourced upsert/re-bind by `(source,
  sourceId)`; the specific same-title-different-source non-collision case; confirm all
  existing cmux-only tests are unaffected.

**Phase 1 -- tmux source adapter, read-only (no actuation)**
- `daemon/src/tmux-source.ts`: `listSessions()` (`tmux ls -F session_id,session_name,
  session_attached`), `hostMap()` (`list-clients` + `ps eww` join, ported from §2.3).
- Pure `diffSessions(prev, next): SessionEvent[]` (created/renamed/closed by `session_id`).
  TDD target: fixture session-list pairs -> expected event lists, mirroring
  `parser.test.ts`'s style.
- Wire into `Registry` (generalizing `applyEvent` or adding a parallel `applyTmuxEvent` that
  shares the upsert/re-bind helper) -- registry updates only, no cmux actuation, no Chrome
  group creation beyond what `groupBy`/the extension already does automatically once a
  `WorkspaceRef` exists. Verify via `metamux state`/a `doctor`-style dry run that live tmux
  sessions appear correctly in the registry.

**Phase 2 -- cmux actuator + pure reconcile core (write side)**
- `daemon/src/cmux-actuator.ts` (§2.4): thin `Bun.spawn` wrappers, one per action, following
  `cmux-rpc.ts`'s `runCmux` pattern.
- `daemon/src/tmux-reconcile.ts` (§2.5): the pure `reconcile()` core. **This is the hardest-
  to-get-right, most-worth-TDD-ing piece of the whole port** -- fixture every case
  enumerated in §2.5, each one a direct port of a documented §1 behavior.
- Gate the whole poll -> reconcile -> actuate cycle behind `config.tmux.enabled` (default
  `false`), following the existing `config-diff.ts`/`config-watch.ts` hot-reload pattern so
  it can be flipped on live without a restart.

**Phase 3 -- Feature parity: crosswin badges, alphabetize, reattach grace**
- Port the tab-color crosswin logic (§1.8, color version only) as a pure function over
  `{sessions, hostMap, windows, tabsByWindow}` -> color assignments, same testing style.
- Port alphabetize and the unified reattach-grace throttle (§4) into the reconcile core,
  config-surfaced under `metamux config` rather than env vars.

**Phase 4 -- Self-event-loop safety**
- Explicit test: actuator spawns a tab, its own resulting `workspace.created`/
  `workspace.selected` lines flow back through the existing cmux-source tail, confirm no
  duplicate `WorkspaceRef` and no spurious Chrome-group flicker (§2.7). Add an
  echo-suppression guard (analogous to `Gate.recentCreatedAt` / F9's `userActivatedGroup`
  self-ignore) if this surfaces a real gap rather than assuming the existing 500ms
  suppression already covers it.

**Phase 5 -- Migration cutover + rollback drill**
- Extend `metamux doctor` (or a new `metamux tmux-doctor`) to dry-run the reconciler against
  Zac's *live* tmux/cmux state and his last-written `tmux-cmux-sync.json`, printing what it
  *would* do without acting -- the same no-side-effects philosophy `doctor` already has for
  the cmux event log. Run this before ever flipping `tmux.enabled: true` for real.
- Execute the cutover per §3.2's exact kill order (`kill -INT`, reclassify, enable, verify),
  then rehearse the rollback path (§3.4) once deliberately, off Zac's live machine if
  possible, to confirm it's as low-risk as the state-files-as-caches argument claims before
  it's ever needed for real.

## Appendix: cmux CLI surface already proven live (old tool + existing daemon)

For reference -- every one of these is already verified working by either the current
`tmux-cmux-sync`/`tick.py` or metamux's own `cmux-rpc.ts`, so none of it is unproven ground
for the port:

`cmux identify` -- `cmux new-workspace --window <w> --name <n> --cwd <c> --focus false
--command <cmd>` -- `cmux workspace list --window <w> --json` -- `cmux workspace-action
--action rename|set-color|clear-color --workspace <id> [--title <t>] [--color <c>]` --
`cmux reorder-workspace --workspace <id> --index <i> --window <w>` -- `cmux close-workspace
--workspace <id>` -- `cmux send --workspace <id> "<text>"` / `cmux send-key --workspace <id>
Enter` -- `cmux list-windows` -- `cmux list-clients` (this one's `tmux`, not `cmux`) --
`cmux rpc window.list` / `cmux rpc workspace.list {window_id}` (JSON, preferred over text
parsing where available, per `cmux-rpc.ts`'s existing precedent).
