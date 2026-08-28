#!/usr/bin/env bash
# One entry point for every metamux install step. Each step is its own script
# under scripts/ and stays runnable on its own; this just runs them in order
# and reports what happened.
#
# Every step is idempotent, so re-running after a `git pull` is the normal way
# to update. Nothing here starts a daemon, flips your default browser, or loads
# a LaunchAgent -- those stay deliberate, manual follow-ups, and the steps that
# have one print the command at the end.
#
# Usage:
#   ./install.sh                       run every step
#   ./install.sh --skip-opener         run every step but that one
#   ./install.sh --only shell          run exactly one step
#
# Steps: shell, menubar, opener, launchd
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STEPS=(shell menubar opener launchd)
ONLY=""
declare -a SKIP=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      ONLY="${2:-}"
      [[ -n "$ONLY" ]] || { echo "error: --only needs a step name" >&2; exit 1; }
      shift 2
      ;;
    --skip-*)
      SKIP+=("${1#--skip-}")
      shift
      ;;
    -h|--help)
      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument '$1'. Steps: ${STEPS[*]}" >&2
      exit 1
      ;;
  esac
done

is_step() {
  local candidate="$1" step
  for step in "${STEPS[@]}"; do
    [[ "$step" == "$candidate" ]] && return 0
  done
  return 1
}

if [[ -n "$ONLY" ]] && ! is_step "$ONLY"; then
  echo "error: '$ONLY' is not a step. Steps: ${STEPS[*]}" >&2
  exit 1
fi

for skipped in ${SKIP+"${SKIP[@]}"}; do
  is_step "$skipped" || { echo "error: '$skipped' is not a step. Steps: ${STEPS[*]}" >&2; exit 1; }
done

should_run() {
  local step="$1" skipped
  [[ -n "$ONLY" ]] && { [[ "$step" == "$ONLY" ]]; return; }
  for skipped in ${SKIP+"${SKIP[@]}"}; do
    [[ "$skipped" == "$step" ]] && return 1
  done
  return 0
}

declare -a RAN=() FAILED=()

for step in "${STEPS[@]}"; do
  should_run "$step" || continue
  echo "=== $step ==="
  if bash "$REPO_DIR/scripts/install-$step.sh"; then
    RAN+=("$step")
  else
    # Keep going: a missing swiftc should not block the shell integration.
    FAILED+=("$step")
    echo "step '$step' failed, continuing" >&2
  fi
  echo ""
done

echo "=== summary ==="
echo "installed: ${RAN[*]:-none}"
[[ ${#FAILED[@]} -gt 0 ]] && echo "failed: ${FAILED[*]}"
echo ""
echo "Manual follow-ups this script deliberately does not do:"
echo "  launchctl load ~/Library/LaunchAgents/com.metamux.daemon.plist   (see scripts/install-launchd.sh notes first)"
echo "  ~/Applications/metamux-opener.app/Contents/MacOS/metamux-opener --register"
echo "  Load the Chrome extension: chrome://extensions -> Load unpacked -> $REPO_DIR/extension"

[[ ${#FAILED[@]} -gt 0 ]] && exit 1
exit 0
