#!/bin/bash
# Helper invoked by the SwiftBar "Open clipboard URL" action in metamux.5s.sh.
# A separate script because SwiftBar's bash= actions exec the target directly
# (no shell in between), so `$(pbpaste)` can't be inlined into the action's
# param list -- it needs an actual shell to expand it at click time.
exec /Users/zachary/.bun/bin/bun /Users/zachary/Documents/GitHub/metamux/cli/metamux.ts open "$(pbpaste)"
