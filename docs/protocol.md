# metamux v1 protocol + conventions (THE contract)

All components conform to this file. Change this file first, code second.

## Paths

- State dir: `~/.local/state/metamux/`
  - `registry.json` (workspace registry, atomic write via tmp+rename)
  - `cursor.json` (`{"bootId": string, "seq": number}` last processed cmux event)
  - `secret` (32 hex chars, mode 0600, generated on first daemon start)
  - `daemon.log`
- Config (optional): `~/.config/metamux/config.json`
  ```json
  {
    "port": 8377,
    "eventsPath": "~/.cmuxterm/events.jsonl",
    "closeBehavior": "archive",        // "archive" | "close"
    "collapseOthers": true,
    "debounceMs": 200,
    "groupBy": "title",                // "title" | "workspace" -- see Grouping
    "createGroups": "on-open",         // "on-open" | "on-activate" | "eager" -- see Grouping
    "tmux": {                          // see "tmux source + cmux actuator" below
      "enabled": false,
      "mirror": "partition",           // "partition" (default) | "windows" | "global" (deprecated)
      "alphabetize": true,
      "reattachGraceMs": 8000,
      "spawnCwd": "~/Documents/GitHub"
    },
    "colorBackflow": true,             // see "Color backflow" below
    "pruneArchivedAfterDays": 7,       // 0 = off -- see "Registry compaction" below
    "colorMode": "palette",            // "palette" | "hash" -- see "Palette allocation" below
    "agentBrowser": "read"             // "off" | "read" | "full" -- see "Workspace-scoped browser automation" below
  }
  ```
  All fields optional; defaults above. `~` expansion required. `ports.*`, `reverseSync`,
  `janitor` (default `true` -- extension-side tab-group janitor, "Extension behavior" below), and
  `janitorCrossWindow` (default `true` -- see "Window-split recovery" below) are also valid
  top-level keys -- see their own sections below. `tmux.mirror` falls back to the
  `TMUX_CMUX_MIRROR` env var (tmux-cmux-sync compatibility) only when `tmux.mirror` is absent
  from the file; an explicit file value always wins. A config file written before the
  `createGroups` rename below and still saying `"lazy"` is read as `"on-activate"`, its exact
  behavioral successor. `METAMUX_PORT` / `METAMUX_STATE_DIR` / `METAMUX_CONFIG_PATH` env vars
  override the port and the two paths above respectively (tolerant, absent -> unchanged
  defaults) -- isolation for `scripts/e2e-chromium.ts` and other throwaway daemon runs; never
  set for the real daemon.

## cmux source (input)

Tail `eventsPath` (JSONL, rotated at 16MiB to `events.jsonl.1`). Each line has:
`boot_id, seq, name, category, payload, workspace_id, occurred_at, version`.

Consume ONLY `category == "workspace"` with names:
- `workspace.selected`  payload: `{workspace_id, title, custom_title?, cwd, index, previous_workspace_id, tab_count}`
- `workspace.created`, `workspace.renamed`, `workspace.closed` (payload shapes may vary; be tolerant: use `payload.workspace_id ?? line.workspace_id`, `payload.custom_title ?? payload.title`)
- `workspace.action` with `payload.params.action === "rename"`: REAL renames arrive this way (verified against live data 2026-08-27; `workspace.renamed` does not occur). Parse it into the same internal `renamed` event, new title from `payload.params.title ?? payload.params.custom_title ?? payload.title` (inspect a real line and use the actual field).
- `workspace.action` with `payload.params.action === "set_color"` or `"clear_color"`: parse into an internal `colored` event `{workspaceId, color}`. `set_color`'s raw color is `payload.params.color` -- either a `"#RRGGBB"` hex (dominant in live data, 166/175 real occurrences) or a named cmux.json `workspaceColors.colors` slot (e.g. `"Navy"`, `"Blue"`); left UNRESOLVED by the parser (see Registry below). `clear_color` has no color param -- `color: null`. Other `workspace.action` actions are ignored.

Ignore every other line silently. Never throw on a malformed line (skip + count).

Rules:
- On daemon start: full read of the current file to seed the registry (replay all workspace events in order), then tail from EOF. The cursor `(bootId, seq)` prevents re-acting on events already ACTED on: during seeding, events with `boot_id == cursor.bootId && seq <= cursor.seq` update the registry but MUST NOT emit actuator events.
- Rotation/truncation: if file size < previous offset or inode changes, reopen and read from 0.
- Debounce `workspace.selected` by `debounceMs` (act on the latest only).
- Suppression: ignore a `workspace.selected` that arrives within 500ms AFTER a `workspace.created` for the SAME workspace_id (tmux-cmux-sync creates tabs programmatically; auto-select on create must not yank Chrome).

## Registry (daemon-owned state)

```ts
interface WorkspaceRef {
  id: string;            // "mw_" + 8 random hex; stable forever
  title: string;
  cwd: string | null;
  source: "cmux" | "tmux";
  sourceId: string;      // cmux workspace UUID (per-boot stable), OR tmux #{session_id} ("$N", stable across a rename) -- see "tmux source + cmux actuator"
  archived: boolean;
  cmuxColor: string | null;  // resolved "#RRGGBB" hex, or null if never set/cleared (cmux-sourced refs only)
  attachedAt: string | null; // ISO, set on first attachment (open_url always; activation too in createGroups: "on-activate"), null again after a userClosedGroup detach -- see Grouping
  paintedColor: string | null; // hex backflow itself last painted, or null -- see "Color backflow"
  paletteIndex: number | null; // colorMode: "palette" allocation, or null -- see "Palette allocation"
  updatedAt: string;     // ISO
}
```

Re-bind on upsert: match by (source, sourceId); else by (title, cwd) AMONG REFS OF THE SAME SOURCE, archived+live; else create new.
The same-source scoping on the title/cwd fallback is required once `source: "tmux"` refs exist: a
tmux session and an unrelated cmux tab can legitimately share a title, and without the scope they
would wrongly re-bind to the same ref.
`workspace.closed` sets `archived: true` (never delete). `workspace.renamed`/`selected` refresh title/cwd. Selected also sets registry-level `activeId`, and -- only when `Registry.attachOnActivate` is true (`createGroups: "on-activate"`; false for `"on-open"`; see Grouping) -- calls `markAttached` (idempotent, first call wins) on the ref. `activateBySourceId` (window follow) is gated the same way. `open_url` (server.ts's `pushOpenUrl`) always calls `markAttached`, regardless of the flag -- see Grouping.
A `colored` event resolves its raw color (hex or named cmux.json slot, via a `namedSlots` table injected into the Registry at construction, read once from `~/.config/cmux/cmux.json`) and sets `cmuxColor` on the matching ref (found by sourceId only -- a color change carries no title/cwd to re-bind against); no-op if the workspace is unknown. Either way, `workspace.upserted` fires so the extension re-applies the group color (it already updates color on `ensureGroup`).
Startup backfill: `set_color`/`clear_color` only appear in the JSONL log from whenever the daemon started tailing, so a color set earlier never shows up as an event. When socket features are on, right after seeding the daemon asks cmux directly (`cmux rpc window.list` + `workspace.list` per window) for every workspace's current `custom_color` and applies it once via the same path.

## Registry compaction (2026-08-27)

The registry never deletes on its own -- `applyEvent`'s `closed` branch only ever sets
`archived: true` -- so it grows forever across a long-lived daemon's life. `Registry.pruneArchived`
removes archived refs; it NEVER touches a live (unarchived) ref regardless of how it's called.
Two paths:

- **Manual, hot, no restart**: `POST /prune` (`metamux prune`) removes EVERY archived ref, no age
  cutoff -- see Wire protocol above. Persists registry.json and pushes a fresh `sync` frame only
  when something was actually removed.
- **Auto, on startup only**: config `"pruneArchivedAfterDays"` (default `7`, `0` disables it)
  removes archived refs with `updatedAt` strictly older than that many days. Runs once, right
  after the registry is hydrated from disk and BEFORE the seed replay or lazy-tracker seeding --
  not hot-reloadable (`config-diff.ts`'s `HOT_APPLICABLE_CONFIG_KEYS`), since auto-compaction has
  no live behavior a hot-apply could trigger.

Neither path is destructive in any lasting sense: a pruned ref's cmux workspace, if ever seen
again, simply creates a fresh ref via the normal upsert-with-no-match path (a new `mw_` id, a new
Chrome group) -- exactly as if metamux had never seen it before. `groupBy: "title"` aliasing needs
no separate cleanup: an alias is computed fresh from `Registry.workspaces` on every projection, so
a title with zero remaining members simply stops appearing on its own, with no persisted
"bucket" state of its own to clean up.

## Wire protocol (one port, default 8377, 127.0.0.1 only)

Auth token = contents of the `secret` file. Reject bad token: WS close code 4001 / HTTP 401.

### WebSocket `ws://127.0.0.1:<port>/actuator` (extension + fake client)

Client first frame:
```json
{"type":"hello","token":"...","protocol":1,"client":"extension"}
```
Server replies (always, immediately):
```json
{"type":"sync","seq":123,"config":{"collapseOthers":true,"closeBehavior":"archive"},
 "state":{"activeId":"mw_ab12cd34","workspaces":[{"id":"mw_ab12cd34","title":"mh-accounts","color":"yellow","archived":false}]}}
```
Then pushes events (monotonic `seq`, client ignores `seq <= lastSeen`):
```json
{"type":"event","seq":124,"name":"workspace.activated","workspace":{"id":"...","title":"...","color":"..."}}
{"type":"event","seq":125,"name":"workspace.upserted","workspace":{...}}          // create OR rename (title changed) OR unarchive
{"type":"event","seq":126,"name":"workspace.archived","workspace":{...}}
{"type":"event","seq":127,"name":"open_url","workspace":{...},"url":"https://...","homeChromeWindowId":"<uuid>"|null}
```
Every sync/state-frame workspace object and every `open_url` event also carry `homeChromeWindowId`
and (sync/state only) `placementOverride` -- see "Window pairing" below. Both are computed at
serialization time (like `ports`), NOT stored on `ActuatorWorkspace` itself.

Client MAY send `{"type":"state","groups":[{"title":"...","tabCount":3}]}` reports; server logs them
(sent by the extension's tab-group janitor, one entry per unrecognized FOREIGN group it left
untouched -- server logs each as `janitor: leaving unknown group '<title>' (N tabs)`).

Client MAY send `{"type":"userClosedGroup","id":"mw_..."}` (detach-on-close, see Grouping) when the
user closes a MANAGED group by hand. No reply frame; the daemon clears attachment and the next
sync reconciliation stops including it.

Client MAY send `{"type":"groupPlacement","id":"mw_...","chromeWindowId":"<uuid>"|null}` (Placement
ownership, see "Window pairing" below) when the user moves a MANAGED group to a Chrome window
other than its home, or `null` when it's back home. No reply frame; the daemon persists the
override and broadcasts the identity's `workspace.upserted`.

Client MAY send `{"type":"windowPairing","cmuxWindowId":"<uuid>","chromeWindowId":"<uuid>"}` (Chrome
window pairing, see "Window pairing" below) once it resolves or creates the paired Chrome window
for a cmux window, via its per-window marker tab. No reply frame; the daemon persists the pairing
and pushes a fresh `sync` to every client (pairing-dependent fields are computed at serialization
time, not carried by individual events, so already-connected clients need an explicit sync to see
a new pairing).

`color`: one of Chrome's 9 tabGroups colors, `["grey","blue","red","yellow","green","pink","purple","cyan","orange"]`.
When a workspace's `cmuxColor` is set, map it HUE-FIRST (humans classify color by hue, not raw RGB distance -- a dark, desaturated navy IS blue to a person even though it sits numerically closer to a dark green/grey swatch under Euclidean RGB):
1. Convert the hex to HSL.
2. `saturation < 0.15`, or `lightness > 0.92` or `< 0.05` -> `"grey"` (no meaningful hue).
3. Else the chromatic swatch with the smallest circular hue distance, computed from these 8 representative hexes (grey has no hue and isn't in this comparison): blue `#1a73e8`, red `#d93025`, yellow `#f9ab00`, green `#188038`, pink `#d01884`, purple `#a142f4`, cyan `#007b83`, orange `#fa903e`. Ties: deterministic, first in `[blue,red,yellow,green,pink,purple,cyan,orange]`.

When `cmuxColor` is unset (or unresolvable), fall back to a deterministic hash of `title`: sum of UTF-16 char codes mod 9 into the same 9-color list.

### HTTP (same port)

- `POST /open` body `{"token":"...","url":"https://...","cmuxWorkspaceId":"<uuid, optional>"}`
  Resolve target: by sourceId if given, else current activeId. 200 `{"ok":true,"workspace":"mw_..."}`; 404 if no target.
- `GET /status?token=...` → `{"ok":true,"clients":1,"lastSeq":127,"activeId":"mw_...","workspaces":9,"cursor":{...},"skippedLines":0}`
- `GET /state?token=...` → full registry JSON.
- `POST /prune` body `{"token":"..."}` → registry compaction, hot, no restart. Deletes ALL
  archived refs (no age cutoff -- see "Registry compaction" below for the age-cutoff auto path).
  200 `{"ok":true,"removed":[{"id":"mw_...","title":"..."}]}` (empty array if nothing archived).
  Persists registry.json and pushes a fresh `sync` frame to every client only when something was
  actually removed. `metamux prune` (CLI) calls this.

## Grouping: groupBy + createGroups (2026-08-27, afternoon; createGroups reworked 2026-08-27 evening)

Config: `"groupBy": "title" | "workspace"` (default `"title"`),
`"createGroups": "on-open" | "on-activate" | "eager"` (default `"on-open"`). Both hot-reloadable;
a change pushes a fresh `sync` frame to every client. A legacy `"lazy"` value in an existing
config file reads as `"on-activate"`.

Both live entirely in a wire-projection layer between the Registry and the actuator wire
(`daemon/src/group-projection.ts`, `daemon/src/lazy-groups.ts`) -- the Registry itself is
UNCHANGED and keeps full per-workspace fidelity regardless of config. The extension is unaware
of either: identity ids are opaque to it.

### groupBy: title (alias projection)

Rationale: tmux-cmux-sync mirrors every tmux session into every cmux window, so the registry
legitimately holds several same-title `WorkspaceRef`s. In `groupBy: "title"`, ALL workspaces
sharing a title alias to ONE canonical actuator identity before anything reaches the wire:

- **Id scheme**: `"t_" + 8-hex-of-FNV-1a-hash(title)`. Stable regardless of which/how-many real
  workspaces carry the title.
- **Activated on ANY member** -> `workspace.activated` for the shared alias.
- **All-archived rule**: `workspace.archived` for the alias only when every member with that
  title is archived (or the last member moved away by a rename -- the degenerate empty case).
  While at least one member is live, the alias stays live even if others archive.
- **Rename = bucket move**: a member's title change is detected by comparing against the last
  title seen for that real workspace id. Reports the OLD bucket archived-if-now-empty (per the
  all-archived rule above) and the NEW bucket's `workspace.upserted`.
- **Color aggregation**: the first non-null `cmuxColor` among LIVE members (archived members'
  colors don't leak through), else the alias title's hash -- same fallback rule as a single
  workspace.
- **Ports union**: `GET /state` / sync-frame `ports` for an alias is the union (deduped, sorted)
  of every live member's ports, since one alias can represent several real workspaces.
- **Dedup**: an unrelated field change on one member that doesn't change the bucket's aggregate
  (title/color/archived) emits nothing new -- one `workspace.upserted` per actual change, not
  per member update.

`groupBy: "workspace"` is pass-through: one identity per real workspace, the pre-grouping
behavior, unchanged.

### createGroups: on-open / on-activate / eager

An identity (alias id in `groupBy: "title"`, real workspace id in `"workspace"`) is "attached"
once it's been marked so. What attaches it depends on the mode:

- **`on-open`** (default): attachment happens ONLY via `open_url` (`server.ts`'s `pushOpenUrl`).
  Activation (a `selected`/window-follow event) and mere activity never attach anything.
  Result: a group is only ever created carrying a real tab -- switching to a workspace that was
  never opened shows no group at all, even transiently. Zac's original complaint about "lazy"
  ("still spawns empty groups because ACTIVATION attaches") is what this mode fixes.
- **`on-activate`**: the exact behavioral successor to the old `"lazy"` value -- activation
  ALSO attaches (`Registry.attachOnActivate: true`, the default for any caller that doesn't set
  it explicitly), so switching to a workspace shows its (possibly empty) group immediately, same
  as before this rework.
- **`eager`**: includes everything regardless of attachment, unchanged.

In both `on-open` and `on-activate` (anything but `eager`): the sync frame's `state.workspaces`
and any `workspace.upserted` event only include identities that have ever been attached -- there
is no "or currently active" exception (removed in the on-open rework: it used to leak an
unattached-but-active identity's group into the very next sync, and into the SAME broadcast batch
as a brand-new workspace's first upserted+activated pair). `workspace.activated` and
`workspace.archived` still always pass through regardless of attachment -- an archive of
something never attached is a harmless no-op for the extension, and a bare `workspace.activated`
for an unattached identity is provably safe: it never carries `ensureGroup`, and the extension's
`activate()` op is a no-op whenever the byId entry it targets has `groupId: null`, which is
exactly the case for something never attached (this was evaluated against the alternative --
daemon-side filtering the event instead -- and rejected: filtering would make `metamux current`/
`GET /status`/the MCP tools' notion of "what's active" lag reality for no benefit, since the
client-side no-op is already free).

Attachment is PERSISTED on `WorkspaceRef.attachedAt` so a daemon restart does not re-hide groups
the user already had open (the extension's offline-archive sync rule would otherwise collapse
them the moment a mode re-hid their identities -- a restart must not reshuffle the browser). This
also means a config file carried over from the "lazy" era, with its existing attachedAt values,
switches cleanly to `on-open`'s default: everything the user had already attached (via a past
activation) stays visible; only NEW, never-before-attached identities get the stricter treatment
going forward. Alias-level attachment ("any member attached") falls out of persistence for free:
on daemon start, the in-memory lazy tracker is seeded from every ref's persisted `attachedAt`,
projected through the same `groupBy`-aware identity mapping used everywhere else, so a single
attached member seeds the whole alias. `Registry.attachOnActivate` itself is set from config
immediately after construction, BEFORE the startup seed replay (a replay pushes historical
`selected` events through the registry too; setting it any later would re-stamp `attachedAt` for
everything with a history on every restart, silently reverting `on-open` to attach-everything).

### Detach-on-close

The extension watches `chrome.tabGroups.onRemoved` for the metamux window. When a MANAGED group
is removed by the user (drag to trash, right-click "close group", closing its last tab by hand --
including a cross-window drag-out, indistinguishable here from a close, consistent with "never
manage groups in other windows") and it was NOT one of the extension's own removals, it sends
`{"type":"userClosedGroup","id":"..."}` (Wire protocol, above) and locally invalidates its own
cached `groupId` for that identity (same correction `archiveGroup`'s `"close"` behavior makes for
itself). The daemon resolves `id` to every real `WorkspaceRef` composing it (all members sharing
an alias's title in `groupBy: "title"`, not just the currently-active one -- otherwise a still-
attached sibling would keep the alias included via the union rule above) and clears `attachedAt`
on each, plus the in-memory lazy tracker. The underlying workspace(s) stay live/unarchived --
detach only un-attaches the group; the next activation (in `on-activate`) or `open_url` (in
either mode) reattaches and recreates it from scratch.

**Echo suppression:** the extension's own group-dissolving ops -- `archiveGroup`'s `"close"`
behavior, the janitor's `mergeGroup`/`closeGroup` (see Extension behavior, tab-group janitor) --
mark the groupId they're about to remove in a short-lived, per-groupId map (1500ms) before acting;
`onRemoved` checks that map first and drops the echo rather than reporting a self-inflicted
removal as a user close.

**Interplay with the janitor:** the janitor can only classify a scanned group as CANONICAL/
DUPLICATE against a title the extension already has in `byId` -- in `on-open` mode that's exactly
the set of identities ever attached (or transiently activated this session; see the reducer test
suite for that one documented edge). A title truly unknown to the client is orphan/foreign,
dissolved like any other leftover -- nothing is ever resurrected.

### Reverse sync alias resolution

`userActivatedGroup`'s `id` (Wire protocol, above) is a wire identity -- an alias id in
`groupBy: "title"`, not necessarily a real workspace id. The daemon resolves it before acting:
- The already-active guard compares against the PROJECTED active identity (the active alias in
  title mode), not the raw registry `activeId`.
- The RPC target is resolved via the alias's currently-active member if one exists, else its
  first live member. `cmux rpc workspace.select` targets that member's `sourceId`.

## Extension behavior (Chrome MV3)

- Permissions: `tabs`, `tabGroups`, `storage`, `alarms`. No host permissions, no content scripts.
- **The metamux window** is identified by a marker tab pointing at the extension's own `panel.html`. On startup: find a tab with that URL → that window is THE window; else create a new window with `panel.html` as its only tab. Never manage groups in other windows.
- Mapping in `chrome.storage.local`: `{ byId: { [metamuxId]: { title, color, groupId|null, lastActiveTabId|null } }, lastSeq }`.
  `groupId` is a cache, never trusted across restarts: re-resolve by `tabGroups.query({title, windowId})` on startup, and handle `tabGroups.onCreated` remaps (cross-window moves change groupId).
- **Sync is authoritative for byId** (2026-08-27): every `sync` frame PRUNES any `byId` entry whose
  id is absent from that frame's `state.workspaces` -- a plain identity that reduceSync only ever
  upserted before now also deletes. Nothing is lost: a pruned entry reappears with fresh defaults
  the moment the daemon includes its id in a later sync (registry compaction above, or the id's
  own attachment simply lapsing, are the two ways that happens). This is what keeps the panel
  showing the daemon's actual live view instead of accumulating every identity the extension has
  EVER seen across its lifetime (Zac's panel once showed ~75 identities against 8 live tmux
  sessions). Ordering matters: the tab-group janitor classification below runs against the
  PRE-prune `byId` (so it still recognizes a title about to be pruned and merges/blank-closes its
  leftover group one last time), and pruning happens immediately after, before this reduce call
  returns.
- `workspace.upserted`: ensure a group exists (create one background `chrome://newtab` tab, `tabs.group` it, set title+color, collapse). Rename = `tabGroups.update({title})` and mapping key update.
- `workspace.activated`: expand the group, activate `lastActiveTabId` (fallback: first tab in group) via `tabs.update(tabId, {active:true})`. If `collapseOthers`, collapse every other managed group. **NEVER call `chrome.windows.update({focused:true})`** (F3, hard rule).
- `workspace.archived`: `closeBehavior === "archive"` → collapse + `tabGroups.move({index:-1})`; `"close"` → remove the group's tabs.
- `open_url`: `tabs.create({windowId, url, active:true})` then group into target group, creating one around the new tab if none exists yet -- never a separate `chrome://newtab` placeholder (that pattern is `ensureGroup`-only). In `createGroups: "on-open"`, this is often the identity's first-ever appearance client-side; the reducer establishes its `byId` entry (from the event's own title/color) before emitting the op, so there's always something to create the group around. Do not focus the window.
- Track `lastActiveTabId` per group via `tabs.onActivated` (only for tabs in the metamux window).
- Detach-on-close: `chrome.tabGroups.onRemoved`, metamux window only -- see Grouping, "Detach-on-close" for the full echo-suppression + daemon-resolution contract.
- WS client with exponential backoff (500ms → 10s cap), `chrome.alarms` every 30s as resurrection heartbeat, reconnect sends `hello` again and reconciles from the fresh `sync` snapshot.
- Options page: inputs for port + secret, saved to `storage.local`; a "Test connection" button.
- Structure: `reducer.js` is PURE (state + event → list of chrome-op descriptors, e.g. `{op:"activateTab",tabId}`); `chrome-ops.js` executes descriptors; `sw.js` is thin glue. The reducer is unit-tested in Bun with a fake chrome adapter.

## Phase 2 additions (2026-08-27, overnight build)

### Socket-gated features

At startup the daemon probes `cmux identify` (needs a cmux-spawned shell's env). Success →
"socket features enabled ✓" (ports watcher, reverse sync, window follow); failure → log
"socket features disabled (start the daemon from a cmux shell to enable)" and run tail-only.

### Ports watcher (F8)

Config: `"ports": {"mode": "auto" | "notify" | "off", "ignore": [<port numbers>], "maxPort": number}`
default `{"mode":"auto","ignore":[],"maxPort":49151}`. When socket features are on, poll
`cmux rpc workspace.current` every 4s and diff the ACTIVE workspace's `listening_ports`
against three guards, in order:

1. **Baseline on first sight.** The FIRST poll observed for a given workspaceId establishes
   a baseline: those ports are recorded as seen but NEVER emitted. Only ports that appear on
   a LATER poll (a server starting while the daemon is watching) are candidates. This matches
   the "his dev server starts in a workspace" narrative, not "the daemon just noticed 28
   already-open ports and opened 28 tabs."
2. **Ephemeral cutoff.** Ports `> maxPort` (default 49151, i.e. the 49152+ macOS ephemeral
   range: debuggers, MCP servers, etc.) are never auto-opened. They're still tracked and
   still shown in `GET /state` and the panel — just never actioned.
3. **Per-cycle cap.** At most 2 auto-opens per poll cycle per workspace. Extras (fresh,
   non-ephemeral ports beyond the first 2 in one cycle) are logged as `notify` lines instead
   of opened, and are marked seen either way (a capped port never re-triggers on a later poll).

Dedupe (baseline + already-emitted + capped-and-logged) is per (workspaceId, port) for the
daemon's lifetime. After the guards: mode `auto` → emit `open_url` with `http://localhost:<port>`
targeted at that workspace for the (up to 2) auto-open candidates, log the rest; `notify` → log
every fresh candidate, cap doesn't apply since nothing opens; `off` → dedupe/baseline state still
updates, nothing emitted or logged.
Ports also surface in `GET /state` per workspace and in the `sync` frame workspace objects
as `ports: number[]` (optional field, extension displays it in the panel) — this list includes
ephemeral ports; only the auto-open *action* excludes them.

### Reverse sync (F9)

Config: `"reverseSync": false` (default). New ext→daemon frame, sent ONLY for user-initiated
group activation (see echo suppression):
```json
{"type":"userActivatedGroup","id":"mw_..."}
```
Daemon: if reverseSync && socket features && id !== activeId → `cmux rpc workspace.select`
targeting the workspace's sourceId (check `cmux rpc --help` for exact arg shape; verify with a
real call). The resulting `workspace.selected` event flows back through the normal pipeline.
**Echo suppression (extension side):** after executing a server-driven `activate` op, ignore
`tabs.onActivated`/group-activation facts for 1500ms. Additionally the daemon ignores
`userActivatedGroup` for the already-active workspace. Both guards together prevent loops.

### Window follow (F7, best effort, socket-gated)

Investigate real data first: if `window.focused` (or similar window-category) events exist in
events.jsonl, then on window focus change resolve that window's selected workspace via
`cmux list-windows` (or `cmux rpc window.current`) and emit `workspace.activated` for it.
If the real data has no usable window-focus signal, document that in BUILD-STATUS and skip.

### Explicit focus (new command)

`metamux focus` (CLI) → `POST /focus {token}` → daemon pushes
```json
{"type":"event","seq":n,"name":"focus_window"}
```
Extension op `{op:"focusWindow"}` → `chrome.windows.update(windowId, {focused:true})`.
This is the ONLY path allowed to focus the window: it is explicit and user-initiated, so it
does not violate F3 (which bans focus stealing on automatic switches).

### MCP server (workspace-context)

`metamux mcp` (CLI subcommand): a stdio JSON-RPC 2.0 MCP server bridging to the daemon's HTTP
API. Tools:
- `metamux_current` → active workspace {id, title, cwd, ports}
- `metamux_workspaces` → non-archived workspace list
- `metamux_open` {url, workspaceId?} → same as POST /open
Support `initialize` (echo a current protocolVersion), `notifications/initialized` (ignore),
`tools/list`, `tools/call`, `ping`. Tolerant of unknown methods (JSON-RPC error -32601).
Register in Claude Code: `claude mcp add metamux -- bun <repo>/cli/metamux.ts mcp`.

### launchd

`scripts/install-launchd.sh` + `scripts/com.metamux.daemon.plist` template (bun path resolved
at install time). Socket features degrade gracefully under launchd (no cmux env): tail-only.

## tmux source + cmux actuator (2026-08-27, tmux absorption)

Absorbs `~/bin/tmux-cmux-sync` into metamuxd as a second source (tmux) and a second actuator
(cmux tabs), per `docs/tmux-port-plan.md` -- one program instead of two. Off by default
(`tmux.enabled: false`); every piece below is inert until it's turned on.

### Registry model

A tmux session is a first-class `WorkspaceRef`: `source: "tmux"`, `sourceId` = the session's
`#{session_id}` ("$N" form, stable across a `tmux rename-session` for the life of the tmux
server -- NOT `#{session_name}`, which is the mutable title), `title` = the session name. The
cmux tabs that mirror a session across windows (`tmux.mirror: "windows"`) are NOT separate
registry members -- they're tracked as actuator-owned attachments (window id -> tab id), the
same way `PortsTracker`/`LazyGroupTracker` hold feature-specific side-state next to the Registry
rather than on it. This makes the Chrome-group dedupe for a tmux session STRUCTURAL: one ref,
one group, no `groupBy: "title"` hash-collapsing needed for tmux-backed refs (that projection
stays in effect, unchanged, for incidental same-title collisions among plain cmux workspaces).

`Registry.applyTmuxIntent({type: "upsertTmuxRef"|"archiveTmuxRef", sessionId, sessionName?})`
mirrors `applyEvent`'s upsert/archive shape for tmux-sourced refs -- emitted every reconcile
tick for every live session touched, idempotent by construction (same "did anything actually
change" check `upsert` already uses for cmux refs).

### tmux source adapter (`daemon/src/tmux-source.ts`)

Polling, not tmux hooks (`session-created`/`session-renamed`/`session-closed` are available on
tmux 3.6a, but persisting them means writing to `~/.tmux.conf`, a materially bigger footprint
than anything else metamux touches, for a latency win nothing here needs -- plan §2.3). Every
poll:
- `tmux list-sessions -F session_id\tsession_name\tsession_attached` -> `{id, name, attached}[]`.
- The content-based host join (`tmux list-clients` + `ps eww` for `CMUX_WORKSPACE_ID=`, exactly
  as tmux-cmux-sync's `host_map()`, plan §1.5) -> `Map<cmuxWorkspaceUUID, tmuxSessionId>`. Never
  title-based -- correct even when cmux has auto-retitled a tab.

Tolerant of tmux being absent or having no running server: every function returns `[]`/`Map()`
rather than throwing.

### cmux actuator (`daemon/src/cmux-actuator.ts`)

Direct `cmux <subcommand>` CLI calls (not `cmux rpc`) for the actions tmux-cmux-sync already
proved live: `new-workspace` (spawn), `workspace-action --action rename` (title lock),
`send`+`send-key Enter` (reattach), `close-workspace` (reap), `reorder-workspace`
(alphabetize), `workspace-action --action set-color/clear-color` (crosswin badges -- ported
as the tab-color version, not the orphaned `set-status`/pill script; see plan §1.8/§4).
`listWindows()` reuses `cmux-rpc.ts`'s `rpc("window.list")`. Session names are validated
(`isSafeSessionName`, alnum/space/dash/underscore only) before being interpolated into any
`tmux new -A -s <name>` command string -- tmux-cmux-sync never did this (plan §1.10/§4);
an unsafe name fails the action rather than building it.

### Reconcile (`daemon/src/tmux-reconcile.ts`, pure)

One function, `reconcile(input) -> {actions, registryIntents, nextState}`, ported faithfully
from `tick.py`'s LIVE behavior (the bash reimplementation of the same logic is dead code,
never called -- plan §1.1) for both mirror modes:

- **`windows`** (default): every cmux window mirrors every tmux session. Per window: a hosted
  tab (host map confirms it) gets title-locked to the session name if drifted; an unhosted tab
  titled for a live session is reattached, throttled by `reattachGraceMs`; a session missing
  from the window is spawned; tabs are alphabetized (pinned stay put) with zero reorder calls
  when already sorted. A dead window drops its state with no close calls; a dead session's
  tracked tab is explicitly reaped.
- **`global`**: one tab per session across all windows; only sessions attached nowhere are
  surfaced. Reattach-after-restore is implemented here too (the original tool's Python
  `tick_global` never had it, only its dead bash twin did -- plan §1.6; this is a deliberate
  fix, not bug-for-bug parity). A tab already titled correctly but untracked is left alone,
  never adopted -- faithfully preserving that specific quirk of the original.

Identity is id-keyed throughout (tmux `#{session_id}`), not name-keyed like `tick.py` -- since
a session's id and name are always 1:1 at any single tick this changes no spawn/retitle/reap
decision, it only makes state and registry intents survive a mid-flight rename instead of
looking like a kill+recreate.

`reattachGraceMs` unifies the original tool's two separately-named throttles
(`TMUX_CMUX_GRACE` for global mode, `TMUX_CMUX_REATTACH_GRACE` for windows mode) into one
config value.

### Wiring

Socket-gated like the ports watcher: window/tab listing and every actuator action go through
the `cmux` CLI, which needs the same cmux-shell auth `cmux rpc` does. Polls every 2s (matching
`tmux-cmux-sync`'s own `TMUX_CMUX_INTERVAL` default) on an unconditional timer -- like the
socket-recovery probe, the timer itself always runs; `pollTmux`'s own `config.tmux.enabled` and
socket-health checks are what actually gate it, so `tmux.enabled` is truly hot-reloadable with
no separate timer start/stop logic. `nextState` (window/global attachments + reattach-attempt
timestamps) is this poller's own in-memory cache, rebuilt fresh from live tmux+cmux state every
tick -- never persisted, same "cache not ledger" philosophy as the original's state files.

Self-event-loop: the actuator's own `new-workspace`/`workspace-action rename`/etc. calls
generate ordinary `workspace.created`/`workspace.action(rename)` lines in the SAME
`~/.cmuxterm/events.jsonl` the daemon already tails -- this is the exact reason the 500ms
created→selected suppression rule (Rules, above) exists; absorbing tmux-cmux-sync makes
metamuxd the direct cause of what used to be an external actor's side effect, not a new
problem.

### Config

`"tmux": {"enabled": false, "mirror": "partition"|"windows"|"global", "alphabetize": true,
"reattachGraceMs": 8000, "spawnCwd": "~/Documents/GitHub"}`. All five keys hot-reloadable.
`"partition"` is the default (see "Window pairing" below); `"windows"`/`"global"` remain for
compatibility but are deprecated.
Toggling `tmux.enabled` false->true live triggers the same one-time migration a fresh startup
gets (below), not just a resume.

### State migration (one-time, idempotent)

At startup (and on a live `tmux.enabled` false->true toggle), if tmux is enabled and socket
features are live: read `~/.local/state/tmux-cmux-sync.json` (windows-mode shape only --
`{windowUUID: {sessionName: cmuxWorkspaceUUID}}`; the global-mode shape parses to nothing to
migrate rather than erroring, since Zac's install has only ever run windows mode), resolve
each session NAME to its current live `#{session_id}`, then for each live session: reclassify
ONE of its cmux tabs (the one tmux-cmux-sync's own state names) into the tmux-sourced ref of
record via `Registry.reclassifyAsTmux` -- preserving that ref's `mw_` id, and therefore its
paired Chrome group -- and archive every OTHER cmux tab that mirrored the same session in a
different window via `Registry.archiveBySourceId` (the tab itself is untouched; it's no longer
an independent registry identity, it becomes an actuator-tracked attachment). Idempotent: a
second run finds nothing to reclassify (the ref's `source` is already `"tmux"`), so no separate
"already migrated" marker is needed -- this runs unconditionally every time the gate is true.

## Palette allocation (2026-08-27, colorMode: palette)

Replaces the title-hash fallback with a deliberately-ordered, distinguishable palette so colors
stop landing too close together (Zac). Config: `"colorMode": "palette"` (default) | `"hash"`
(the original title-hash-only behavior), hot-reloadable -- switching modes re-emits a `sync` to
every client. `colorFor` (the title hash) still exists and is still the ultimate fallback in
both modes; `registry.ts`'s `resolveColor` is the actual colorMode-aware precedence used
everywhere on the wire (`toActuator`, `GroupProjection`'s alias aggregation and workspace-mode
projection):

1. A genuinely user-set `cmuxColor` (`cmuxColor !== paintedColor` -- the same ownership check
   Color backflow, below, already uses) -- hue-mapped to the nearest Chrome color, exactly as
   before this feature.
2. In `colorMode: "palette"`, the identity's allocated palette entry (below) -- an EXPLICIT
   per-entry choice, never hue-mapped.
3. `colorFor`'s title hash -- the ultimate fallback, and the entire behavior in `colorMode:
   "hash"`.

### The palette (`daemon/src/palette.ts`)

A static, ordered list of `{name, chromeColor}` -- purely an allocation ORDER now (2026-08-27:
the per-entry brand hex this list used to also carry was dropped, see Color backflow below for
why). Ordered for maximal pairwise distinguishability going down: the first 9 entries use 9
DISTINCT Chrome `tabGroups` colors, so every identity gets a genuinely different color for as
long as possible; entries 10+ necessarily reuse `chromeColor`s (Chrome only has 9). No I/O left --
`buildPalette()` is a pure, argument-less copy of the static order; `loadPalette()` stays `async`
only so its existing `main.ts` call sites don't need to change. Full ordering + rationale lives in
`palette.ts`'s header comment.

### Allocation (`daemon/src/palette-allocator.ts`, pure + `Registry.claimPaletteColor`)

State is `WorkspaceRef.paletteIndex: number | null`, persisted (survives a restart -- a restart
re-stamps from the persisted value directly, it never re-claims). The pure allocator
(`claimPaletteIndex(identityKey, holders, paletteSize)`) resolves the index an identity should
hold, given every other current holder: idempotent and stable for an identity that already holds
a LIVE index (`!archived && attachedAt !== null`) -- never reshuffled by another identity's
claim or release, even once a lower index frees up -- otherwise claims the LOWEST index not held
by any OTHER live identity. `identityKey` is the allocation UNIT: a title in `groupBy: "title"`
(a whole alias shares one claim -- the first attaching member claims it, later members of the
same alias reuse it), a real workspace id in `groupBy: "workspace"`.

**Claimed at attachment time**, inside `Registry.markAttached` itself (not a separate call site):
the same instant a group is actually created, whether via `open_url` (`createGroups: "on-open"`)
or activation (`createGroups: "on-activate"`) -- this is why `server.ts`'s `pushOpenUrl` calls
`markAttached` BEFORE computing the wire identity/color, so the very first `open_url` for a
freshly-created group already carries its allocated color.

**Released** (paletteIndex set back to `null`) on:
- **Detach** (`Registry.clearAttached`, `userClosedGroup`) -- a later re-attach claims fresh and
  may land on a DIFFERENT color. This is by design (Zac: "frees back up"), not a bug.
- **Archive** (`applyEvent`'s `closed` branch, `applyTmuxIntent`'s archive branch,
  `archiveBySourceId`) -- released on the INDIVIDUAL ref's own archive, not gated on "every
  alias member archived": since a title alias's displayed color is "the first live member
  holding a non-null `paletteIndex`" (mirrors `cmuxColor`'s own aggregation rule), the alias's
  color persists automatically for as long as ANY sibling is still live and holding one, and only
  visibly releases once none are. Explicit per-ref release on archive (rather than relying solely
  on the `live` filter) closes a real edge case: `attachedAt` SURVIVES archive, so an
  unarchive-via-upsert (the same cmux workspace reopens with the same sourceId) would otherwise
  silently regain a stale claim someone else may hold by then, without ever going through
  `markAttached` again.
- **Prune** (`Registry.pruneArchived`) -- the ref is deleted outright, nothing to release.

### Wiring

`toActuator`/`GroupProjection` carry the resolved color on every `workspace.upserted` /
`.activated` / `.archived` event and the `sync` frame, exactly as `colorFor` always did -- no
separate wire concept, `resolveColor` just changed what feeds it. `GroupProjection` and
`Registry` each hold their own mutable `groupBy`/`colorMode`/palette state (mirrors the existing
`attachOnActivate` precedent), kept in lockstep by `main.ts` at startup and on hot-reload.

## Color backflow (2026-08-27, palette-aware 2026-08-27, swatch-hex-only 2026-08-27)

Paints a cmux tab's own color to match its Chrome group's color, so the two visually agree at a
glance ("a colored flag that matches the color of the browser tab the cmux tab relates to" --
Zac). Config: `"colorBackflow": true` (default), hot-reloadable. Socket-gated (needs `cmux
workspace-action set-color`); polls every 5s, same unconditional-timer-with-internal-gate shape
as the tmux poller above.

**The painted hex is ALWAYS `colors.ts`'s `CHROME_GROUP_REPRESENTATIVE_HEX` for the identity's
resolved `chromeColor` -- in BOTH `colorMode: "hash"` and `"palette"`.** This replaced an earlier
design (same day) that painted `colorMode: "palette"`'s own allocated brand hex directly: Zac
reported the painted cmux tab and its Chrome group visibly didn't match on the live system, even
though both were nominally the same `chromeColor` -- Chrome renders its 9 `tabGroups` colors from
its own internal swatches, not from any hex metamux supplies, so a distinct brand hex sharing a
color NAME with a Chrome swatch still reads as a different color next to it. Painting the swatch
hex itself is what makes them genuinely match. `palette.ts`'s per-entry hex became fully unused
by this change and was dropped (see "The palette" above) -- only `chromeColor` (via
`registry.ts`'s `resolveColor`) matters to backflow now; `colorMode` only ever changes WHICH
`chromeColor` an identity resolves to, never what hex gets painted for a given one.

**Only acts on a color that isn't the user's.** Backflow never invents a color for an identity
the user already colored -- for every identity (in `groupBy: "title"`, every member sharing a
title; in `"workspace"`, the ref itself), if ANY live member has a genuinely user-set `cmuxColor`
(`cmuxColor !== paintedColor`), that identity is untouched by backflow entirely. Otherwise it
paints EVERY member's cmux tab (not just one) to the identity's resolved color's swatch hex.

**Never overwrites a user-set color.** `WorkspaceRef.paintedColor` (Registry section, above)
tracks the hex backflow itself last painted. A ref is eligible for backflow to act on unless it
carries a real color that ISN'T what backflow last painted there (`cmuxColor !== null &&
cmuxColor !== paintedColor`) -- that specific combination is the only signature a user-set color
can produce, since backflow never writes `cmuxColor` directly (only the tailed `colored` event
does, whether it's reporting the user's action or backflow's own echo).

- **Never painted** (`cmuxColor: null, paintedColor: null`) -> paint.
- **User cleared a color backflow had painted** (`cmuxColor: null, paintedColor: <hex>`) ->
  repaint (treated the same as never-painted -- the eligibility check doesn't distinguish them).
- **Already matches the target** (`cmuxColor === target`) -> skip, no redundant `set-color` call.
- **Carries backflow's own stale paint** (`cmuxColor === paintedColor`, but the target changed
  since -- e.g. the identity gained/lost a member) -> repaint to the new target.
- **User set a real color** (`cmuxColor !== null && cmuxColor !== paintedColor`) -> skip,
  permanently, until the user clears it. Mirrors into Chrome exactly as any other `colored`
  event already does -- backflow doesn't change that pipeline at all, it only stops trying to
  paint that one tab.

**Loop safety.** `colors.ts`'s `CHROME_GROUP_REPRESENTATIVE_HEX` (all 9 Chrome colors, including
grey) is, by construction, a FIXED POINT of `nearestChromeGroupColor`: painting a ref with
`CHROME_GROUP_REPRESENTATIVE_HEX[X]` produces a `colored` event that resolves back to the same
`X` through the daemon's own color pipeline -- proven directly in `colors.test.ts`. This holds
unconditionally now, in both `colorMode`s, since backflow only ever paints swatch hexes: the
`colorMode: "palette"` ownership-trap this section used to describe (an allocated brand hex
hue-mapping to a DIFFERENT color than its own `chromeColor`) can no longer happen -- there's no
brand hex left to disagree with anything. `resolveColor`'s ownership check
(`cmuxColor === paintedColor` skips hue-mapping) is still what keeps a genuinely user-set color
from being reinterpreted, but it's no longer load-bearing for backflow's OWN paint converging
cleanly the way it was before this change. Dedupe (`already-matches`, above) additionally means a
converged identity issues zero `set-color` calls per poll, not just "eventually stops."

`WorkspaceRef.paintedColor` is persisted (survives a daemon restart) for the same reason
`attachedAt` is -- without it, every restart would forget what backflow owns and misclassify
every previously-painted tab as user-owned on the very next poll.

### Crosswin interplay (decision, not yet built)

tick.py's crosswindow-badge indicator (plan §1.8) also colors a tab -- if it's ever ported, it
and backflow would both want to own the same cmux tab's `custom_color`, and layering a
TRANSIENT signal ("this session is selected in another window right now") on top of backflow's
PERSISTENT one via the same field is fragile: it requires exact save/restore bookkeeping, and is
race-prone if a backflow poll fires while crosswin's override is active. **Decision: when
crosswin is eventually built, it must NOT use tab color.** It needs its own, different visual
channel -- `cmux set-status` (the original crosswin.py's approach, before it was informally
superseded by the tab-color version specifically because status pills weren't rendering in
Zac's sidebar config at the time -- worth re-verifying whether that's still true) or something
else entirely. Crosswin stays deferred (plan/BUILD-STATUS) until a non-color channel is
confirmed workable; it will never be built as a second writer of `custom_color`.

## Window-split recovery (2026-08-27)

Fixes a live incident: after an extension reload, TWO full group sets existed side by side --
cmux switching kept driving the ORIGINAL set, the new set grew in parallel, and the janitor
reported nothing. Root cause: `resolveMetamuxWindow` picked a DIFFERENT window than the one
holding Zac's real groups (the original marker tab was closed during manual cleanup). Chrome's
`tabGroups`/`tabs` APIs accept a groupId regardless of which window it actually lives in, so the
stale cached groupIds from the old window kept silently working for activation -- violating the
F3-adjacent hard rule that activation must never touch a group outside the managed window --
while `ensureGroup`'s windowId-scoped query rebuilt a second full set in the new window, and the
janitor (scoped to the new window only) never saw the old window's groups to merge or report.
Three fixes, all pure decision logic in `reducer.js` with `chrome-ops.js`/`sw.js` as thin
gathering glue (`extension/test/reducer.test.js` has the fixture coverage for all three):

- **Cache invalidation on window resolution** (`resolveGroupCache`): once `windowId` is
  resolved, every cached groupId for an unarchived entry is checked against a snapshot of every
  tab group chrome knows about (`chrome-ops.js`'s `allGroupsSnapshot`, ALL windows, not just the
  managed one). A groupId that doesn't belong to `windowId` -- or no longer exists at all -- is
  corrected by re-resolving by title WITHIN `windowId`; no match there either falls back to null,
  recreated by the next `ensureGroup`. This is the actual fix for the reported symptom: the old
  window's groupIds are caught and nulled instead of silently continuing to work cross-window.
- **Window adoption** (`chooseAdoptionWindow`): `resolveMetamuxWindow` no longer always creates a
  brand-new window when no marker tab is found. Zero markers: adopt the window with the most
  managed-title groups (by `byId`'s live titles), if any has at least one -- a marker tab is
  created there, unfocused. Only when no window has any managed-title group does it fall back to
  creating one, now a true last resort rather than the default. Multiple marker tabs (a leftover
  from a prior boot that never got cleaned up): keep the one in the group-richest window, close
  the rest.
- **Cross-window recovery merge** (`classifyJanitor`'s `foreignGroups` parameter, config
  `janitorCrossWindow`, default `true`, hot-reloadable, mirrored into the sync frame's `config`
  alongside `janitor`): the janitor scan is extended with every managed-title group living in a
  window OTHER than the metamux one (`sw.js` derives this from the same all-windows snapshot,
  filtered to `windowId !== windowId`). A match with an already-established in-window canonical
  group -> `recoverCrossWindow` (`tabs.move` into the metamux window, then `tabs.group` into the
  canonical -- `tabs.move` first because a tab must already be in the target window before
  `tabs.group` can add it to a group there; `markServerRemoval` on the source group so
  detach-echo-suppression doesn't mistake the recovery for the user closing it by hand). A
  managed title with no in-window canonical YET (the very first sync since a window switch,
  before `ensureGroup` has run) is left for a later sync -- self-healing, not a special case.
  **Foreign (unmanaged-title) groups in other windows are never touched**, matching the
  in-window janitor's own FOREIGN classification -- cross-window recovery only ever acts on
  titles the daemon actually manages.

## Workspace-scoped browser automation (2026-08-27)

Lets an agent (via the metamux MCP server) drive the CALLING workspace's own Chrome tab -- read
its content, screenshot it, navigate it, click and type into it -- scoped strictly to that
workspace's own tab group. Real Chrome 136+ blocks external CDP connections (Playwright, `--
remote-debugging-port`) on the user's real profile; the `chrome.debugger` EXTENSION API is
exempt, so the metamux extension itself is the automation actuator, reached through the daemon's
existing WS connection to it, exposed as new MCP tools.

### Config: `agentBrowser`

`"off" | "read" | "full"`, default `"read"`, allowlisted (`config-cli.ts`), hot-reloadable. `"off"`
refuses every automation op. `"read"` allows `metamux_tab_context` / `metamux_browser_snapshot` /
`metamux_browser_screenshot`. `"full"` adds `metamux_browser_navigate` / `_click` / `_type` --
real mouse/keyboard input and navigation on the user's live, cookied browser, so it's opt-in above
the default. Enforced once, server-side (`automation-policy.ts`'s pure `toolAllowed(opKind,
mode)`), in `POST /automation`, before a disallowed op ever reaches the extension.

### MCP tools (`daemon/src/mcp-server.ts`)

- `metamux_tab_context` -- list the calling workspace's group tabs (id/url/title/active). No
  `chrome.debugger` involved at all (just `chrome.tabs.query`) -- works under `"read"` and needs
  no new browser permission beyond what metamux already has.
- `metamux_browser_snapshot` -- a compact, agent-readable list of interactive elements (link/
  button/input/etc.) in the workspace's active tab, each with a stable `ref`, tag, role, and
  visible text (see "Element refs" below).
- `metamux_browser_screenshot` -- a PNG of the active tab, returned as an MCP `image` content
  block (`McpToolContent.content` now accepts `{type:"image", data, mimeType}` alongside `text`).
- `metamux_browser_navigate` -- `Page.navigate`, gated by the SSRF check below.
- `metamux_browser_click` -- click an element by a `ref` from a prior snapshot.
- `metamux_browser_type` -- `Input.insertText` into whatever currently has focus -- click a field
  first with `metamux_browser_click` to focus it; `_type` does not itself click anything.

Every automation tool accepts an optional `workspaceId` (metamux's own `mw_...` id) and, for the
browser tools, an optional `tabId` (defaults to the group's active tab). **Workspace resolution**
(`mcp-server.ts`'s `resolveAutomationWorkspaceId`): explicit `workspaceId` arg wins; else, if this
MCP server process inherited `$CMUX_WORKSPACE_ID` from its spawning shell (a cmux sourceId, not
metamux's own id -- resolved to the matching `mw_` id via `GET /state`), that; else the request
omits `workspaceId` and `POST /automation` falls back to the daemon's own `activeId` server-side.
**Caveat, not verified this round**: whether a spawned MCP server process actually inherits
`$CMUX_WORKSPACE_ID` varies by launching harness -- the chain above is best-effort, not guaranteed
for every caller.

### Wire: `POST /automation` + `automationRequest`/`automationResponse` WS frames

`POST /automation` body: `{token, workspaceId?, op: {kind, ...}}`. Server-side
(`server.ts`'s `handleAutomation`): auth -> `agentBrowser` gate -> resolve the target ref
(`workspaceId` else `activeId`; 404 if neither resolves) -> for `op.kind === "navigate"`, the SSRF
gate (below) -> if the check passes, resolve the ref's WIRE identity (`groupProjection.identityFor`
-- the extension's `byId` is keyed by identity, not the real ref id) -> if no extension client is
currently connected, an IMMEDIATE `503` (never a 15s wait for a peer that isn't there) -> send
`{type:"automationRequest", id, identityId, op}` over the WS to the extension client, and await
its `{type:"automationResponse", id, ok, result|error}` by `id`
(`automation-rpc.ts`'s `PendingRequestTable`: a pure-ish, injected-scheduler correlation map, same
shape as `gate.ts`/`ports.ts` -- `register(id, timeoutMs)` returns the promise the endpoint awaits,
`resolveRequest`/`rejectRequest` settle it by id, an unanswered request rejects on its own after
15s). The daemon tracks the MOST RECENTLY connected `client: "extension"` socket
(`ActuatorServer.extensionSocket`) and sends only to it -- a raw broadcast would also reach a
non-extension test client (`fake-extension.ts`-style) that could never answer.

### Extension: `automation.js` (thin, `chrome.debugger`-driven)

`sw.js` intercepts an incoming `automationRequest` frame BEFORE `dispatch()` -- this is a
request/response op, not a state fact, so it never touches the pure reducer, same as the janitor
group-enumeration enrichment already bypasses it for its own I/O. `resolveTarget` (pure, TDD'd in
`extension/test/automation.test.js`) is the scoping enforcement: refuses if the identity has no
live group (`byId[identityId].groupId == null`), the group has no tabs, or an explicit `tabId`
isn't actually among that group's tabs -- a `tabId` belonging to a DIFFERENT identity's group is
never found, since the caller only ever passes the ONE group's tab list being resolved. The daemon
already resolved `workspaceId` -> identity before sending; the extension re-checks independently
rather than trusting the frame -- belt and suspenders, cheap on both sides.

**Debugger lifecycle**: `chrome.debugger.attach` per request, `detach` in a `finally` (covers
both success and a thrown error) -- never left dangling. While attached, Chrome shows its own "metamux is debugging this browser" infobar on the target tab; it clears automatically on detach.
**Not verified this round** (couldn't observe live without a real automation call landing on a
tab mid-session): the exact infobar wording/behavior across repeated attach/detach cycles in quick
succession.

**Element refs** (`snapshot`/`click`): one injected `Runtime.evaluate` serializer walks a fixed
selector (`a[href], button, input, textarea, select, [role=button/link/textbox], [onclick],
[tabindex]`), skips zero-size (hidden) elements, and stamps each surviving one with a
`data-metamux-ref` DOM attribute plus a `{ref, tag, role, text}` snapshot entry. `click` resolves
`ref` -> coordinates at CLICK TIME, via a second `Runtime.evaluate` that re-queries the DOM
attribute and reads `getBoundingClientRect()` fresh -- deliberately NOT storing coordinates at
snapshot time, since the page can scroll/reflow between snapshot and click and a stale coordinate
click is the real failure mode. A full accessibility-tree (`Accessibility.getFullAXTree`)
correlation was considered and rejected as more CDP-domain plumbing for no agent-readability gain
over the DOM-attribute-ref approach here.

### SSRF gate for `navigate` (`daemon/src/navigate-gate.ts`, pure)

An agent driving the user's real, cookied Chrome profile must never be able to read an internal
host through those cookies. `decideNavigate(url, observedLocalhostPorts, resolvedIps)`:

1. Scheme must be `http`/`https` -- `file:`, `chrome:`, `chrome-extension:`, etc. are always
   blocked regardless of host.
2. A loopback hostname (`localhost`/`127.0.0.1`/`::1`) is allowed ONLY on a port in
   `observedLocalhostPorts` -- the TARGET WORKSPACE's own `PortsTracker.portsFor(sourceId)`
   (`server.ts`'s I/O wrapper, `decideNavigateForTarget`), so a dev server the human is already
   running in that workspace stays reachable without opening loopback access to every other
   workspace's automation calls.
3. Any other hostname: a real DNS lookup (`node:dns/promises`'s `lookup(hostname, {all:true})`)
   resolves it, and every resulting IP must be public -- blocking if ANY resolved IP is
   private/reserved defends against DNS rebinding (a hostname that resolves differently between
   this check and the browser's own later lookup). Covers RFC 1918 (`10/8`, `172.16/12`,
   `192.168/16`), loopback, link-local (`169.254/16`, which covers the `169.254.169.254` cloud
   metadata address), CGNAT (`100.64/10`), reserved/multicast ranges, and their IPv6 equivalents
   (`::1`, `fe80::/10`, `fc00::/7` unique-local, `::ffff:`-mapped v4 unwrapped and re-checked). An
   EMPTY resolved-IP list (DNS resolution itself failed) fails CLOSED, not open.

**Known limitation, not built this round**: a permitted URL can itself `Location:`-redirect to an
internal host post-navigate -- this gate only checks the URL handed to it, not every hop a
redirect chain might take. Catching that needs the CDP `Network` domain's request-intercept
(`Fetch.enable` + pausing on `Network.requestWillBeSent`), out of scope here.

## Testing conventions

- Runner: `bun test` (workspace root `bunfig.toml` not required; tests live in `daemon/test/*.test.ts` and `extension/test/*.test.js`).
- Pure modules get TDD: parser, registry, reducer(s), tail rotation (temp-file integration).
- `scripts/fake-extension.ts`: permanent WS client that connects, prints sync + every event human-readably. This is the debugging harness.
- `metamux doctor`: replays the last 200 real events through the parser+registry and prints what WOULD have happened (no side effects), plus flags selected-within-500ms-of-created clusters.
- `extension/chain.js` (`chainStep`): the pure sequencing primitive behind `sw.js`'s `dispatchChain` (serializes WS message dispatch so one message's ops finish before the next starts) -- isolates a rejecting task's failure (logged, dropped) instead of letting it propagate, since `.then(task)` on an already-rejected promise skips `task` forever after the first failure. `sw.js` itself has top-level `chrome.*`/`boot()` side effects and isn't unit-testable directly; this is why the resilience logic lives in its own chrome-free module with `extension/test/chain.test.js` covering it in isolation.
- `scripts/e2e-chromium.ts` forwards the extension service worker's own console output (and uncaught exceptions) to this script's stdout -- MV3 SW errors otherwise only show up in `chrome://extensions`, invisible to a scripted run.

## Window pairing (partition model, replaces mirroring — 2026-08-27 evening)

Zac's directive: mirroring dies. Each tmux session lives in EXACTLY ONE cmux tab and one
Chrome group. Chrome windows pair 1:1 with cmux windows (per-monitor fullscreen pairs).

### tmux reconcile: partition mode

- `tmux.mirror` gains value `"partition"` (new DEFAULT). "windows" (mirror) and "global"
  remain for compatibility but are deprecated.
- Partition: a session with NO cmux tab spawns ONE tab, in the FOCUSED cmux window
  (fallback: lowest-index window). A session with tabs in MULTIPLE windows (mirror-era
  legacy) keeps the most-recently-selected one (fallback lowest window index) and reaps
  the rest — one-time convergence, then steady-state is one tab each.
- A session's cmux tab MOVING between windows (user drag / move_to_window) is respected:
  the ref's window attachment updates; nothing moves it back.

### Chrome window pairing

- Registry tracks per cmux window a paired Chrome window (persisted map cmuxWindowId ->
  chromeWindowRef, resolved by marker tab: the marker becomes per-window, marker URL
  carries the cmuxWindowId as a query param, e.g. panel.html?win=<uuid>).
- A group's HOME window = the Chrome window paired to the cmux window hosting its
  session's tab. Group creation (on-open) happens in the home window, creating the
  paired Chrome window on demand (focused:false) if absent.
- Activation: switching cmux tabs in window W activates/collapses groups ONLY within
  W's paired Chrome window. Other pairs are untouched (per-monitor independence).
- `focus_window` focuses the pair of the currently focused cmux window.

### Placement ownership (the non-exclusive part)

- Initial placement = home window. If the user MOVES a group to another Chrome window
  (observed via tabGroups.onCreated-in-other-window with a managed title while a
  server-driven move marker is absent), record `placementOverride` on the identity
  (persisted). Overridden groups: activation still works (targeted by groupId wherever
  it lives), janitor cross-window recovery SKIPS them, home-window logic ignores them
  until the user closes the group (override clears with detach).
- janitorCrossWindow recovery only applies to groups with NO override whose title's
  home window disagrees with reality AND that were not observed as user-moved (default
  posture after a fresh boot with no observations: adopt reality as override rather
  than move things — never fight placement we didn't watch happen).

### Implementation notes (daemon half, 2026-08-27 evening)

- `WorkspaceRef.cmuxWindowId` is scoped to `source: "tmux"` refs only — stamped exclusively by
  partition-mode `tmux-reconcile.ts` via `RegistryIntent.upsertTmuxRef.cmuxWindowId`, carried
  through `Registry.upsert`'s `changed` check (so a tab MOVING between windows re-broadcasts).
  A cmux-sourced ref never carries one — its own activation/window-follow events report no
  window id at all. `Registry.windowPairings: Map<cmuxWindowId, chromeWindowId>` +
  `homeChromeWindowId()`/`setWindowPairing()` are the persisted pairing map. Both are
  per-ref/per-map fields, JSON-round-tripped in `registry.json` (`windowPairings` as a plain
  object, defensively `?? null`/`?? {}` backfilled for a pre-feature file).
- `homeChromeWindowId`/`placementOverride` deliberately follow the SAME wire pattern as `ports`
  (`server.ts`'s `portsForIdentity`): computed from the raw `Registry`/snapshot at serialization
  time (`buildSync`/`getState`/`pushOpenUrl`), never added to the core `ActuatorWorkspace` type
  or to `group-projection.ts`'s identity/dedup logic. In `groupBy: "title"`, the representative
  value is the first LIVE member carrying a non-null value (same "first live member wins" rule
  `representativeColorInputs` already uses for `cmuxColor`/`paletteIndex`) — unambiguous in
  partition mode's steady state (at most one live tmux-sourced member per title) and correctly
  `null` for legacy windows/global-mode sessions, which never stamp `cmuxWindowId` at all.
- `open_url` carries `homeChromeWindowId` (not just sync/state) because group CREATION happens
  at that exact moment ("Group creation (on-open) happens in the home window") — the extension
  needs the target window right then, not on the next sync.
- The `windowPairing` ext→daemon frame (Wire protocol, above) is NOT part of this section's
  original contract, which specifies only the persisted map and that it's "resolved by marker
  tab" — this frame is the reporting mechanism the marker-tab flow needs to actually populate
  that map. Shape mirrors `groupPlacement`'s.
- `Registry.clearAttached` (detach-on-close) also clears `placementOverride`, matching "override
  clears with detach" above.
- Partition mode keeps `config.tmux.alphabetize` (not in this section's original scope, but the
  existing windows/global-mode UX parity was cheap to preserve): a window that received one of
  our tabs this tick gets re-sorted the same way windows mode already does.
- `tmux.mirror`'s new DEFAULT of `"partition"` is NOT live-activated by this change alone —
  `config.tmux.enabled` still gates the whole tmux source/actuator subsystem and defaults to
  `false`; a fresh install or an existing `tmux.enabled: false` config sees no behavior change.
  An EXISTING `tmux.enabled: true` config with no explicit `tmux.mirror` key, however, picks up
  `"partition"` on its next daemon restart (or the next `TMUX_CMUX_MIRROR`-unset config reload)
  — see BUILD-STATUS.md for the runbook and why this daemon half stops short of activating it.

### Contract correction: `cmuxWindowId` on the wire (2026-08-27, extension-half prep)

The wire additions above (Wire protocol section) originally spread only `homeChromeWindowId` and
`placementOverride` onto sync/state workspace objects and `open_url`, following the `ports`
pattern exactly. That's a dead end for bootstrapping: `homeChromeWindowId` is null until a Chrome
pairing already exists, and a pairing can only be ESTABLISHED by the extension creating a
per-window marker tab at `panel.html?win=<cmuxWindowId>` — which requires knowing the cmux
window's uuid first. With no field ever carrying that uuid, the extension has no way to learn it,
so `windowPairings` can never be populated and the whole feature is dead on arrival.

Fix: `cmuxWindowId` (the raw id backing `homeChromeWindowId`, same representative-member
resolution) is now ALSO spread onto every sync/state workspace object and `open_url` event,
alongside `homeChromeWindowId`/`placementOverride`. `null` under the same conditions as
`homeChromeWindowId` (legacy windows/global-mode sessions, cmux-sourced refs). This is what the
extension half actually reads to know which cmux window a group's session lives in.

### Implementation notes (extension half — placement following, 2026-08-27 evening, finishing round)

Fixes the live gap the daemon/extension window-pairing halves above left open: a group MOVED by
hand (not just paired via `?win=`) stopped following, because cache invalidation only ever
compared a cached groupId against ONE legacy window and nulled anything else — silently dropping
tracking of a group that was simply somewhere else now, rather than gone.

- `reducer.js`'s `resolveGroupCache(byId, state, allGroups)` (signature changed — was
  `(byId, windowId, allGroups)`) resolves each entry against its OWN `targetWindowFor(entry,
  state)` instead of one global window. A cached groupId that still exists ANYWHERE is now
  authoritative regardless of window — a real move is reported as `placementObserved`, never
  invalidated. Only a groupId that's genuinely gone falls back to title re-resolution, which
  itself now also searches every window: found at the target, plain `groupCreated`; found
  elsewhere, `groupCreated` AND `placementObserved` together — the contract's fresh-boot "adopt
  reality" rule.
- New local fact `placementObserved` (id, chromeWindowId): sets the entry's `placementOverride`
  optimistically and emits a new op `reportGroupPlacement`, which `chrome-ops.js` sends as the
  `groupPlacement` frame (Wire protocol, above — daemon-side handling already existed).
- `chrome-ops.js`'s `watchGroupRemap` is REPLACED by `watchGroupPlacement`: listens to BOTH
  `tabGroups.onCreated` and `tabGroups.onMoved` (Chrome's cross-window group move mechanics
  aren't consistent — a drag typically mints a new group id in the target window via onCreated,
  per the original window-split incident's own finding, but some moves preserve the id and
  surface via onMoved instead) across ALL windows, debounced 400ms, and reruns the same
  `resolveGroupCache` decision boot uses.
- `watchGroupRemoved` (detach-on-close) no longer filters to one window, and no longer assumes
  every removal is a close: a cross-window drag fires `onRemoved` for the OLD group id
  indistinguishably from a genuine close at the instant it fires (there's no atomic Chrome signal
  for "this group's window changed"), so it now waits 500ms and re-checks whether a group with
  the same title exists anywhere before concluding it's really gone — `watchGroupPlacement`'s
  shorter debounce normally already re-established tracking by then if it was a move.
- `watchTabActivation` (F9 reverse sync) no longer filters to one window either — safe by
  construction, since the match lookup only ever fires for a groupId genuinely in `state.byId`.
- `classifyJanitor`'s cross-window recovery now skips any title with an active
  `placementOverride` (docs/protocol.md's own "SKIPS them" rule, above) — its "foreign" window IS
  its home now.
- **Known limitation, unchanged from the prior round**: the janitor's own duplicate-merging scan
  (`janitorGroups`/`scanTabGroups`) is still scoped to the single legacy window, not per-paired-
  window — a genuine duplicate spanning two non-legacy windows isn't resolved by this round
  either. `resolveGroupCache`'s "cached groupId is always authoritative once found to exist"
  priority means a coincidental same-titled group elsewhere is simply left alone rather than
  merged in that scenario.
