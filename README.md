# metamux

The metaharness multiplexer. One daemon makes your tmux sessions, cmux tabs, and real-Chrome
tab groups projections of the same thing: each tmux session gets one cmux tab and one
color-matched Chrome tab group (your real profile — real extensions, logins, and passkeys),
all switching in lockstep with where you're working. Agents in any harness (Claude Code,
Codex, Grok) can see which workspace they're in, put tabs in front of you, and drive their
own workspace's tabs — never anyone else's.

## What it actually does

**The core loop.** `metamuxd` (a Bun daemon, zero runtime deps) watches tmux and tails cmux's
event log into a workspace registry + event bus, then drives two actuators: the cmux CLI
(tabs) and a Chrome MV3 extension (tab groups over a local WebSocket). Switch cmux tabs and
the paired Chrome window's visible group follows in ~250ms without stealing focus. Create,
rename, color, or kill a tmux session and both sides track it.

**Groups exist on demand, and clean themselves.** A Chrome group is only born when something
real opens a tab for its session (`createGroups: "on-open"`) — an agent's `metamux open`, the
PR-URL hook, a dev-server port, or you. Close a group's last tab and the session detaches
until something opens there again. A sync-time janitor merges duplicate groups, closes blank
orphans, and never touches groups it doesn't recognize.

**Colors actually match.** Sessions claim colors from an ordered palette whose first nine
entries use all nine distinct Chrome group colors, so under ten open groups nothing is
ambiguous; colors free up when groups close. metamux paints each cmux tab with the exact
Chrome swatch hex its group displays — same color both sides. Set a color yourself in cmux
and it wins everywhere.

**One session, one tab, per-monitor pairs.** tmux partition mode (default) keeps exactly one
cmux tab per session, spawned in whichever cmux window you're focused on. Chrome windows pair
1:1 with cmux windows (per-window marker tabs), so two monitors can each run a fullscreen
cmux + Chrome pair whose tabs correspond — and switching in one pair never disturbs the
other. Drag a group to another window and metamux records the override instead of fighting you.

**Agents are first-class.** Via MCP (wired for Claude Code, Codex, and Grok), any agent gets:
`metamux_current` / `metamux_workspaces` (where am I, what exists), `metamux_open` (put a URL
in my group), `metamux_tab_context` (list my tabs), and workspace-scoped browser automation —
`metamux_browser_snapshot` / `_screenshot` / `_navigate` / `_click` / `_type` via
chrome.debugger, fenced to the calling workspace's group with a fail-closed SSRF gate
(`agentBrowser`: off / read / full, default read). A PostToolUse hook in each harness
auto-opens GitHub PR/compare URLs from any shell output into that session's group. The
`metamux` skill teaches agents to open their deliverables instead of printing links.

**You drive it without commands.** The SwiftBar menubar item (event-driven, no polling) shows
the active workspace, one-click Focus, open-clipboard-URL, and an Experimental features
submenu generated from the config — every new flag appears there automatically, applied live
via hot-reload (~300ms). Ports opened by a workspace's dev servers show as clickable pills
and can auto-open (guarded: baseline on first sight, ephemeral ports excluded, 2 per cycle).
Reverse sync (click a Chrome group → cmux switches) is available, default off.

## Setup (once)

```
./install.sh              # shell + menubar + opener + launchd-render
./install.sh --only shell # or one step at a time
```

Every step is idempotent, so re-running after a `git pull` is how you update. The installer
never starts a daemon, loads the LaunchAgent, or changes your default browser; it prints
those as explicit follow-ups.

1. **Shell + tmux** (`scripts/install-shell.sh`): writes one marker block into `~/.zshrc`
   that sources `shell/metamux.zsh`, and one into `~/.tmux.conf` that source-files
   `shell/metamux.tmux.conf`. Those two files hold everything metamux puts in your shell:
   the tmux session picker (`t`), remote-login auto-attach, the daemon ensure, and the
   F1-F4 / jumpnav navigation binds. Edit them and open a new shell; no reinstall needed.
2. **Daemon**: auto-ensured by the shell block in every cmux shell
   (`scripts/ensure-daemon.sh`); manual start is `bun run daemon` from a cmux shell (socket
   features need cmux's env).
3. **Extension**: `chrome://extensions` → Developer mode → Load unpacked →
   `~/Documents/GitHub/metamux/extension`. In its Options: port `8377`, secret from
   `bun cli/metamux.ts secret`, Test connection, Save.
4. **Harness wiring** (already done on this machine): Claude Code (`claude mcp add` +
   settings.json hook + `~/.claude/skills/metamux`), Codex (`~/.codex/config.toml` MCP +
   hook, `~/.codex/skills`), Grok (`grok mcp add`, `~/.grok/hooks/metamux-url-hook.json`,
   `~/.grok/skills`). Codex/Grok trust-gate user hooks: approve "metamux URL auto-open" once.
5. **Link routing** (optional): the `opener` step builds `metamux-opener.app`; its
   `--register` flag then makes it the default browser so a cmd-click on a link inside cmux
   routes there too, not just agent-driven opens. See "Link routing" below.

## Shell integration

`shell/metamux.zsh` is the single zsh entry point.

- `t` opens the fzf session picker: arrows browse, live pane preview, Enter attaches, a
  typed name that does not exist gets created, `r` renames, `d` kills. Falls back to a
  numbered menu with no fzf.
- `t <name>` jumps to that session and runs Claude in it. Other harnesses are not wired up
  yet; `t <name>` means Claude for now.
- `METAMUX_SPAWN_CWD` sets where new sessions start (default `~/Documents/GitHub`).
- SSH and mosh logins drop straight into the picker. The `-t 0`/`-t 1` guards keep invisible
  `zsh -ic` probes from hanging on it.

`shell/metamux.tmux.conf` holds F1/F2/F3 window and session navigation, plus F4 jumpnav and
the Left-arrow picker popup for phone clients. Its popup runs `zsh -ic _tmux_pick`, so the
`~/.zshrc` source line must stay unconditional for interactive shells. Prefix, copy-mode,
theming, and TPM stay in your own `~/.tmux.conf`.

## CLI

```
metamux open <url> [--active]  # open in the calling shell's workspace group
                                # (--active: the visually active workspace instead)
metamux current        # this shell's workspace (JSON)
metamux focus          # bring the paired Chrome window forward
metamux status|state   # daemon health / full registry
metamux config [--json | <key> <value>]   # view/set config, hot-reloads live
metamux prune          # drop archived workspaces from the registry
metamux doctor         # replay recent cmux events, show what would happen
metamux secret|mcp     # extension secret / stdio MCP server
```

Config lives at `~/.config/metamux/config.json`; every key is in `metamux config` and the
menubar. Notables: `groupBy` (title), `createGroups` (on-open), `colorMode` (palette),
`agentBrowser` (read), `reverseSync` (false), `janitor` (true), `tmux.mirror` (partition),
`ports.mode` (auto), `pruneArchivedAfterDays` (7).

## Link routing (default-browser shim)

cmux has no built-in link-handler setting -- a cmd-click on a link in a cmux terminal goes
through plain macOS default-browser handling, same as any other app. `metamux-opener`
(`opener/metamux-opener.swift`) makes metamux the default browser instead: it's a tiny
LSUIElement app (no Dock icon, no window) that registers for http/https URL events, and on
each one, routes to `metamux open` if the frontmost app was cmux, else passes straight
through to Chrome. See docs/protocol.md, "Link routing" for the full decision table.

```
bun scripts/install-opener.sh                              # compile + bundle + ad-hoc sign
~/Applications/metamux-opener.app/Contents/MacOS/metamux-opener --register   # make it default
```

`--register` requests the change via `LSSetDefaultHandlerForURLScheme`; macOS shows its own
confirmation dialog ("Do you want to make "metamux-opener" your default web browser?") --
click **Use "metamux-opener"**. If no dialog appears (varies by macOS version), set it
manually: **System Settings → Desktop & Dock → Default web browser → metamux-opener**. To
revert, pick Chrome/Safari/whatever the same way.

Verify either branch without touching the real default browser or needing to control which
app is actually frontmost:

```
metamux-opener --test cmux https://example.com          # forces the cmux branch
metamux-opener --test passthrough https://example.com   # forces the passthrough branch
```

## Architecture

```
  tmux sessions ──┐                                ┌── cmux tabs (create/rename/reap/color)
                  ├──► metamuxd: registry + bus ───┤
  cmux events ────┘    (WS/HTTP on 127.0.0.1:8377) ├── Chrome ext: groups, janitor, automation
                                                   ├── menubar (streamable SwiftBar)
  MCP / CLI / hooks (all harnesses) ───────────────┘
```

Contract: `docs/protocol.md` (change it first, code second). History: `BUILD-STATUS.md`.
Design rationale: the PRD in the Obsidian vault (`Metamux/metamux-prd.md`). Tests:
`bun test` (~700, TDD); `scripts/e2e-chromium.ts` is a fully isolated real-Chromium e2e
(own daemon/port/state; note it still tails the real events log, so background cmux
activity can flake assertions — run when quiet).

## Debugging

- Marker tab shows connection status + workspaces; SW console via `chrome://extensions`.
- `bun scripts/fake-extension.ts` — watch the event stream without Chrome.
- `metamux doctor`, `metamux status`, `~/.local/state/metamux/daemon.log`.
- Rollbacks: every activation step (tmux cutover, partition) has a documented rollback in
  BUILD-STATUS.md.

## Known gaps (honest list)

- Reverse sync and detach-on-close watchers are single-window; they don't yet fire for
  groups living in secondary paired windows.
- Janitor cross-window recovery doesn't yet distinguish a window-split leftover from a
  deliberate `placementOverride` on fresh boot (adopt-reality rule pending).
- Registry accumulates archived refs between prunes (auto-compact covers >7 days).
- Chrome shows its "debugging this browser" banner during automation operations (API-inherent).

## Future plans

The PRD's roadmap, in order (metamuxd is deliberately a metaharness kernel — sources and
actuators plug into the same registry/bus):

1. **Env actuator**: each workspace optionally binds an isolated environment (OrbStack /
   devcontainer / cmux remote workspaces), ports forwarded to the host so the real browser
   keeps real passkeys.
2. **Automations (Hermes-style)**: an automation = a registry entry with a trigger — bus
   subscriptions (cmux/GitHub/Linear/Slack via a webhook feed), a small scheduler, incident
   dedupe with acknowledge-to-silence, draft-only outward actions (e.g. review-requested →
   run a review flow → stage a draft, never auto-post).
3. **Factory workers**: persona workers (lens + harness config + entry/exit events + craft
   memory) composed into gated pipelines fed by tickets; bounded retry then human handback;
   responsibility never transfers.
4. **Chief-of-staff / multiplayer**: a project-scoped standing bot owning shared context
   (versioned, attributed, redactable memory files) and that project's factory — the
   metaharness endgame: multiplayer project management and context sharing between users.
5. **Optional custom shell**: only if cmux's limits ever bite; the kernel, extension, and
   actuators all carry over by swapping one source adapter.

Personal project by @zjdonhauser, built with Claude. Private until it proves itself.
