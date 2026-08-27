#!/bin/bash
# <bitbar.title>metamux</bitbar.title>
# <bitbar.version>2.0</bitbar.version>
# <bitbar.author>Zac Donhauser</bitbar.author>
# <bitbar.author.github>zjdonhauser</bitbar.author.github>
# <bitbar.desc>Event-driven metamux status + quick actions, streamed live from the daemon's WebSocket (see ~/Documents/GitHub/metamux).</bitbar.desc>
# <bitbar.dependencies>bun</bitbar.dependencies>
# <bitbar.abouturl>https://github.com/zjdonhauser/metamux</bitbar.abouturl>
# <swiftbar.type>streamable</swiftbar.type>
#
# This file exists so the plugin SwiftBar launches has the `.sh` name and
# metadata comments it scans for -- the actual logic lives in the sibling
# metamux-stream.ts and just gets exec'd. Why two files: bun picks its
# parser by file extension, and `.sh` isn't one it recognizes as JS/TS
# (`bun some-script.sh` fails to parse even plain JS), so the real
# implementation needs its own `.ts` extension for bun's loader (and for
# `tsc --noEmit`).
#
# Install: scripts/install-menubar.sh copies this file into SwiftBar's
# configured plugin directory (`defaults read com.ameba.SwiftBar
# PluginDirectory`; ~/.config/swiftbar-plugins on this machine) and removes
# any older metamux.5s.sh/metamux.30s.sh left there. metamux-stream.ts and
# metamux-open-clipboard.sh stay in the repo -- this wrapper and every
# click action reference them by absolute repo path, so nothing else needs
# copying. Re-run the install script after editing any of the three;
# SwiftBar reads its own copy of this file, not the repo's.

exec /Users/zachary/.bun/bin/bun /Users/zachary/Documents/GitHub/metamux/layout/metamux-stream.ts
