# metamux

The metaharness multiplexer. v1: every cmux workspace gets a tab group in your REAL Chrome
(real profile, real extensions, real passkeys) that switches in lockstep with the active
workspace. No focus theft, no syncing, no fork of cmux.

## QUICKSTART (do these 4 steps)

1. **Start the daemon:**
   ```sh
   cd ~/Documents/GitHub/metamux && bun run daemon
   ```
   You should see `tailing ~/.cmuxterm/events.jsonl ✓` and a seeded workspace count.

2. **Load the extension:** Chrome → `chrome://extensions` → enable *Developer mode* (top right)
   → *Load unpacked* → select `~/Documents/GitHub/metamux/extension`.

3. **Connect it:** click the metamux extension → *Options* → port `8377`, secret = output of
   ```sh
   bun cli/metamux.ts secret
   ```
   → Save → *Test connection* (expect `ok`). The daemon terminal prints `extension connected ✓`,
   and a Chrome window appears with a "metamux" marker tab. That window is yours to place;
   metamux only manages tab groups inside it.

4. **Switch cmux tabs.** The Chrome window's visible tab group follows within ~200ms.
   `bun cli/metamux.ts open https://example.com` from any cmux shell drops a URL into the
   current workspace's group.

Optional layout: append `layout/metamux-dock.lua` to your Hammerspoon config, then
`hs -c 'metamuxDock()'` tiles cmux left / the paired Chrome window right.

## Zero-command integrations

No metamux commands to type -- a button or a hook runs them for you.

- **cmux Dock button**: `layout/dock.json.example` is a ready-to-copy `~/.config/cmux/dock.json`
  control that focuses the paired Chrome window. Dock controls are seeded panes, not
  per-click buttons (cmux only re-runs a control's command when its pane is freshly created,
  e.g. a brand-new workspace/window with no saved Dock snapshot), so treat this as "focus on
  open" rather than a repeatable menu action -- use the SwiftBar menu bar item below for a
  real per-click button. Back up any existing `dock.json` before copying this in.
- **SwiftBar menubar plugin**: `layout/metamux.30s.sh` shows the active workspace title and a
  dropdown (focus browser, open clipboard URL, toggle reverse sync, status line). Install with
  `scripts/install-menubar.sh`; re-run it after editing the plugin.
- **Claude Code URL hook**: `scripts/claude-url-hook.ts` is a `PostToolUse` hook for the `Bash`
  matcher. When a Bash command's output contains a GitHub PR or compare URL, it opens that URL
  in the active cmux workspace's Chrome tab group. Wire it up in `~/.claude/settings.json`
  yourself (this repo doesn't touch that file):
  ```json
  {"hooks": {"PostToolUse": [{"matcher": "Bash",
    "hooks": [{"type": "command", "command": "bun /Users/zachary/Documents/GitHub/metamux/scripts/claude-url-hook.ts"}]}]}}
  ```

## Phase 2 features (also ready)

- **Port auto-open**: when a dev server STARTS in the active workspace (new port appearing
  while the daemon watches, below 49152, max 2 per cycle), its `http://localhost:PORT` opens
  in that workspace's group. Config `ports.mode`: `auto` (default) / `notify` / `off` in
  `~/.config/metamux/config.json`. All ports show as clickable pills in the marker tab.
- **Reverse sync (default OFF)**: click a tab group in Chrome → cmux switches to that
  workspace. Enable with `"reverseSync": true` in the config. Echo-suppressed both ways so
  it cannot loop.
- **Window follow**: focusing a different cmux window activates that window's selected
  workspace's group.
- **`metamux focus`**: explicitly brings the paired Chrome window forward (the only thing
  allowed to focus it).
- **MCP server**: `claude mcp add metamux -- bun ~/Documents/GitHub/metamux/cli/metamux.ts mcp`
  gives any harness `metamux_current` / `metamux_workspaces` / `metamux_open` tools.
- **Agent skill**: `skills/metamux/SKILL.md`, personal-installable via plugin-builder.
- **launchd**: `scripts/install-launchd.sh` renders a plist into `~/Library/LaunchAgents`
  (you run `launchctl load` yourself). Note: under launchd the daemon is tail-only; socket
  features (ports, reverse sync, window follow) need a daemon started from a cmux shell.

Note: `cmux rpc`-backed features require the daemon to be started from a cmux shell
(the QUICKSTART's step 1 already does this). The daemon says which mode it's in at startup.

## What's what

| Piece | Path | Job |
|---|---|---|
| Daemon (`metamuxd`) | `daemon/` | Tails cmux's event log, owns the workspace registry, serves WS+HTTP on 127.0.0.1:8377 |
| Chrome extension | `extension/` | One tab group per workspace in the metamux window; pure reducer + thin chrome glue |
| CLI | `cli/metamux.ts` | `open <url>` / `status` / `state` / `secret` / `doctor` |
| Fake extension | `scripts/fake-extension.ts` | Debugging harness: prints everything the extension would receive |
| Contract | `docs/protocol.md` | The protocol. Change it first, code second. |
| PRD | `~/Documents/Obsidian/Vault/Metamux/metamux-prd.md` | Why everything is the way it is |

## Debugging

- `bun cli/metamux.ts status` — daemon health, connected clients, last seq.
- `bun cli/metamux.ts config` — prints the effective config, marking each value `(file)` or
  `(default)`; `bun cli/metamux.ts config <key> <value>` sets one (e.g. `reverseSync true`,
  `ports.mode notify`) in `~/.config/metamux/config.json`, restart the daemon to pick it up.
- `bun cli/metamux.ts doctor` — replays the last 200 real cmux events, shows what would happen.
- `bun scripts/fake-extension.ts` — watch the event stream live without Chrome.
- Extension side: the "metamux" marker tab shows connection status; service worker logs in
  `chrome://extensions` → metamux → *service worker*.

## Design notes

- Trigger: `~/.cmuxterm/events.jsonl` tail (auth-free, survives daemon restarts via cursor).
- `workspace.selected` is debounced 200ms, and a selection within 500ms of a programmatic
  `workspace.created` (tmux-cmux-sync churn) is suppressed.
- Chrome `groupId`/`windowId` are never trusted across restarts; groups re-resolve by title.
- The daemon never focuses Chrome and the extension never focuses the window (hard rule).
