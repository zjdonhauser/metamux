#!/usr/bin/env bash
# Renders scripts/com.metamux.daemon.plist with this machine's bun path and
# repo path, and writes it to ~/Library/LaunchAgents/. Does NOT load it --
# that's a manual step, printed at the end, so the daemon isn't silently
# started under launchd without you choosing to.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_PATH="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$SCRIPT_DIR/com.metamux.daemon.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DEST="$LAUNCH_AGENTS_DIR/com.metamux.daemon.plist"

BUN_PATH="$(command -v bun || true)"
if [[ -z "$BUN_PATH" ]]; then
  echo "error: bun not found on PATH. Install bun first (https://bun.sh)." >&2
  exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "error: template not found at $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR"
mkdir -p "$HOME/.local/state/metamux"

sed \
  -e "s#__BUN_PATH__#$BUN_PATH#g" \
  -e "s#__REPO_PATH__#$REPO_PATH#g" \
  -e "s#__HOME__#$HOME#g" \
  "$TEMPLATE" > "$DEST"

echo "Wrote $DEST"
echo "bun resolved to: $BUN_PATH"
echo "repo path: $REPO_PATH"
echo ""
echo "This script does NOT load the agent. To start it (now, and on every"
echo "login) run:"
echo ""
echo "  launchctl load $DEST"
echo ""
echo "To stop and unload it later:"
echo ""
echo "  launchctl unload $DEST"
echo ""
echo "Note: under launchd there is no cmux-spawned shell env, so socket"
echo "features (ports watcher, reverse sync, window follow) will be"
echo "disabled -- the daemon logs this and runs tail-only. That's expected."
