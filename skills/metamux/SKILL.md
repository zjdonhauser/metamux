---
name: metamux
description: Interact with the human's metamux setup - the daemon that pairs each cmux workspace with a tab group in their real Chrome browser. Use when the human should SEE a URL (a PR, a preview, a dashboard, docs) in their own browser next to this terminal, when you need to know which workspace/project context you are running in, or when a dev server port should open for the human. Commands run from any cmux shell.
license: MIT
metadata:
  version: 0.1.0
---

# metamux

metamux pairs every cmux workspace with a tab group in the human's REAL Chrome window
(their profile, extensions, logins, passkeys). A daemon tails cmux's event log and drives
a Chrome extension; you interact with it through a small CLI (and optionally MCP tools).

## When to use

- The human should look at a URL: open it in THEIR browser, grouped with this workspace,
  instead of printing a bare link they have to copy.
- You need workspace context: which workspace this shell belongs to, its cwd, its ports.
- A dev server you started should be visible to the human.

## CLI (run from any cmux shell)

```sh
metamux open <url>      # open URL in the CURRENT workspace's Chrome tab group
metamux open <url> --active   # ...or in whichever workspace the human is looking at
metamux current         # print this shell's workspace (uses $CMUX_WORKSPACE_ID)
metamux status          # daemon health: clients, last seq, active workspace
metamux state           # full workspace registry JSON (includes ports when available)
metamux focus           # bring the paired Chrome window forward (explicit human hand-off)
metamux doctor          # replay recent cmux events, show what the daemon would do
```

If `metamux` is not on PATH, use `bun ~/Documents/GitHub/metamux/cli/metamux.ts <cmd>`.

## MCP tools (when the `metamux` MCP server is registered)

- `metamux_open` {url, workspaceId?, active?} - open a URL in a workspace's group.
  Defaults to the calling shell's workspace; pass `active: true` for the visible one.
- `metamux_workspaces` - list of live workspaces
- `metamux_tab_context` - list the tabs in this workspace's own group
- `metamux_current` - **the ACTIVE workspace, not necessarily yours.** To learn which
  workspace *this shell* is in, use the `metamux current` CLI, which reads
  `$CMUX_WORKSPACE_ID`.
- `metamux_browser_snapshot` / `_screenshot` / `_navigate` / `_click` / `_type` - browser
  automation fenced to your own workspace's group, gated by `agentBrowser`
  (off / read / full, default read). Never reaches another workspace's tabs.

## Rules

- `metamux open` targets the workspace of the SHELL you run it from, not the visually
  focused one. That is usually what you want (your work lands in your workspace's group).
- Never spam opens: one URL per meaningful artifact (the PR, the preview), not every link.
- `metamux focus` steals the human's screen focus - use it only when they asked to be
  shown something right now.
- If the daemon is down (`metamux status` fails), fall back to printing the URL and say
  the daemon is not running.
- A pane with no `$CMUX_WORKSPACE_ID` cannot target itself, so every open silently lands
  in the active group instead. If your links keep appearing in the wrong place, check
  `echo $CMUX_WORKSPACE_ID` before assuming the daemon is wrong.
