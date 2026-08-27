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
    "debounceMs": 200
  }
  ```
  All fields optional; defaults above. `~` expansion required.

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
  source: "cmux";
  sourceId: string;      // cmux workspace UUID (per-boot stable)
  archived: boolean;
  cmuxColor: string | null;  // resolved "#RRGGBB" hex, or null if never set/cleared
  updatedAt: string;     // ISO
}
```

Re-bind on upsert: match by (source, sourceId); else by (title, cwd) among archived+live; else create new.
`workspace.closed` sets `archived: true` (never delete). `workspace.renamed`/`selected` refresh title/cwd. Selected also sets registry-level `activeId`.
A `colored` event resolves its raw color (hex or named cmux.json slot, via a `namedSlots` table injected into the Registry at construction, read once from `~/.config/cmux/cmux.json`) and sets `cmuxColor` on the matching ref (found by sourceId only -- a color change carries no title/cwd to re-bind against); no-op if the workspace is unknown. Either way, `workspace.upserted` fires so the extension re-applies the group color (it already updates color on `ensureGroup`).
Startup backfill: `set_color`/`clear_color` only appear in the JSONL log from whenever the daemon started tailing, so a color set earlier never shows up as an event. When socket features are on, right after seeding the daemon asks cmux directly (`cmux rpc window.list` + `workspace.list` per window) for every workspace's current `custom_color` and applies it once via the same path.

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
{"type":"event","seq":127,"name":"open_url","workspace":{...},"url":"https://..."}
```
Client MAY send `{"type":"state","groups":[{"title":"...","tabCount":3}]}` reports; server logs them.

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

## Extension behavior (Chrome MV3)

- Permissions: `tabs`, `tabGroups`, `storage`, `alarms`. No host permissions, no content scripts.
- **The metamux window** is identified by a marker tab pointing at the extension's own `panel.html`. On startup: find a tab with that URL → that window is THE window; else create a new window with `panel.html` as its only tab. Never manage groups in other windows.
- Mapping in `chrome.storage.local`: `{ byId: { [metamuxId]: { title, color, groupId|null, lastActiveTabId|null } }, lastSeq }`.
  `groupId` is a cache, never trusted across restarts: re-resolve by `tabGroups.query({title, windowId})` on startup, and handle `tabGroups.onCreated` remaps (cross-window moves change groupId).
- `workspace.upserted`: ensure a group exists (create one background `chrome://newtab` tab, `tabs.group` it, set title+color, collapse). Rename = `tabGroups.update({title})` and mapping key update.
- `workspace.activated`: expand the group, activate `lastActiveTabId` (fallback: first tab in group) via `tabs.update(tabId, {active:true})`. If `collapseOthers`, collapse every other managed group. **NEVER call `chrome.windows.update({focused:true})`** (F3, hard rule).
- `workspace.archived`: `closeBehavior === "archive"` → collapse + `tabGroups.move({index:-1})`; `"close"` → remove the group's tabs.
- `open_url`: `tabs.create({windowId, url, active:true})` then group into target group. Do not focus the window.
- Track `lastActiveTabId` per group via `tabs.onActivated` (only for tabs in the metamux window).
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

## Testing conventions

- Runner: `bun test` (workspace root `bunfig.toml` not required; tests live in `daemon/test/*.test.ts` and `extension/test/*.test.js`).
- Pure modules get TDD: parser, registry, reducer(s), tail rotation (temp-file integration).
- `scripts/fake-extension.ts`: permanent WS client that connects, prints sync + every event human-readably. This is the debugging harness.
- `metamux doctor`: replays the last 200 real events through the parser+registry and prints what WOULD have happened (no side effects), plus flags selected-within-500ms-of-created clusters.
