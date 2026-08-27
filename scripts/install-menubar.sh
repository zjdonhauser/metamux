#!/bin/bash
# Installs the metamux SwiftBar plugin. Copies (never symlinks -- SwiftBar
# sometimes ignores plugins loaded through a symlink) layout/metamux.sh
# into SwiftBar's configured plugin directory. The plugin's own actions
# reference layout/metamux-stream.ts and layout/metamux-open-clipboard.sh
# by absolute repo path, so neither needs to be copied too.
#
# Also removes any earlier-generation plugin left in that directory
# (metamux.5s.sh, metamux.30s.sh -- superseded by the streamable
# metamux.sh) so SwiftBar doesn't show a stale duplicate menu bar item.
#
# Re-run this after editing layout/metamux.sh; SwiftBar reads its own
# copy, not the repo file.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="${SWIFTBAR_PLUGIN_DIR:-$HOME/.config/swiftbar-plugins}"

mkdir -p "$PLUGIN_DIR"

for stale in metamux.5s.sh metamux.30s.sh; do
  if [ -e "$PLUGIN_DIR/$stale" ]; then
    rm -f "$PLUGIN_DIR/$stale"
    echo "removed superseded plugin -> $PLUGIN_DIR/$stale"
  fi
done

cp "$REPO_DIR/layout/metamux.sh" "$PLUGIN_DIR/metamux.sh"
chmod +x "$PLUGIN_DIR/metamux.sh" "$REPO_DIR/layout/metamux-stream.ts" "$REPO_DIR/layout/metamux-open-clipboard.sh"

echo "installed metamux SwiftBar plugin -> $PLUGIN_DIR/metamux.sh"
echo "SwiftBar picks it up automatically (polls its plugin directory); refresh manually via its menu if it doesn't appear within a few seconds."
