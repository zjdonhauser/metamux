#!/bin/bash
# Singleton daemon launcher, mirroring the tmux-cmux-sync --ensure pattern.
# Safe to call from every shell: exits fast when the daemon already answers.
# A lost race is self-resolving (the second instance fails to bind and exits).
PORT=$(jq -r '.port // 8377' ~/.config/metamux/config.json 2>/dev/null)
[ -z "$PORT" ] || [ "$PORT" = "null" ] && PORT=8377
curl -s -m 0.3 -o /dev/null "http://127.0.0.1:${PORT}/status" && exit 0
mkdir -p ~/.local/state/metamux
nohup /Users/zachary/.bun/bin/bun /Users/zachary/Documents/GitHub/metamux/daemon/src/main.ts \
  >> ~/.local/state/metamux/daemon.log 2>&1 &
disown 2>/dev/null || true
