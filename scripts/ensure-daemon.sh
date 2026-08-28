#!/bin/bash
# Singleton daemon launcher, mirroring the tmux-cmux-sync --ensure pattern.
# Safe to call from every shell: exits fast when the daemon already answers.
# A lost race is self-resolving (the second instance fails to bind and exits).
PORT=$(jq -r '.port // 8377' ~/.config/metamux/config.json 2>/dev/null)
[ -z "$PORT" ] || [ "$PORT" = "null" ] && PORT=8377
curl -s -m 0.3 -o /dev/null "http://127.0.0.1:${PORT}/status" && exit 0
mkdir -p ~/.local/state/metamux
# Redirect to daemon.stdout.log, NOT daemon.log: the daemon's own log() already
# appends every line to daemon.log AND echoes it to stdout, so pointing stdout
# at the same file wrote every line twice. This file keeps the startup output
# that happens before log() exists, plus anything that bypasses it.
nohup /Users/zachary/.bun/bin/bun /Users/zachary/Documents/GitHub/metamux/daemon/src/main.ts \
  >> ~/.local/state/metamux/daemon.stdout.log 2>&1 &
disown 2>/dev/null || true
