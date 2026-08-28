#!/usr/bin/env bash
# Installs the metamux shell integration:
#   ~/.config/metamux/shell/   gets copies of shell/metamux.{zsh,tmux.conf}
#   ~/.zshrc                   sources the installed metamux.zsh
#   ~/.tmux.conf               source-files the installed metamux.tmux.conf
#
# The dotfiles point at COPIES under ~/.config, never at the repo. macOS gates
# ~/Documents behind a TCC grant the tmux server does not inherit, so a shell
# started inside tmux cannot read anything under it -- sourcing from the repo
# put an "operation not permitted" error in every tmux pane. ~/.config is
# ungated. This is why editing shell/metamux.zsh needs a reinstall to take
# effect; install-menubar.sh copies for a related reason.
#
# Idempotent. Re-running when everything already matches makes no writes and
# takes no backup.
#
# One-time migration: the picker functions, remote auto-attach, daemon-ensure
# line, and tmux navigation binds used to live inline in the dotfiles. This
# script removes those legacy regions by their anchor comments, the same way
# install-menubar.sh removes superseded SwiftBar plugins. Removal is skipped
# silently once the anchors are gone.
#
# Honors $HOME and $ZDOTDIR, so the test suite can run it against a temp home.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZSHRC="${ZDOTDIR:-$HOME}/.zshrc"
TMUX_CONF="$HOME/.tmux.conf"
STAMP="$(date +%Y%m%d-%H%M%S)"
SHELL_DIR="$HOME/.config/metamux/shell"

BEGIN_MARK="# >>> metamux >>>"
END_MARK="# <<< metamux <<<"

# Drops the inclusive line range from the first START match through the next
# END match, plus one blank line trailing it. END is only tested once START has
# matched, so an END-shaped line earlier in the file (~/.zshrc has one) can
# never be mistaken for the terminator.
#
# Anchors must contain no backslashes: `awk -v` runs escape processing over the
# value before awk ever sees it as a regex, so `\[` arrives as a bare `[` and
# turns the pattern into a character class. Pick anchor text without regex
# metacharacters instead of escaping them.
strip_region() {
  awk -v start="$1" -v end="$2" '
    !seen && !skip && $0 ~ start { skip = 1 }
    skip && $0 ~ end { skip = 0; seen = 1; eat = 1; next }
    eat && $0 == "" { eat = 0; next }
    { eat = 0 }
    !skip
  '
}

# Removes trailing blank lines so the appended block lands at a fixed offset
# from the last real line. Without this the block drifts down by one blank
# line on every run and the install stops being idempotent.
trim_trailing_blanks() {
  awk '
    { lines[NR] = $0 }
    END {
      last = NR
      while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--
      for (i = 1; i <= last; i++) print lines[i]
    }
  '
}

# Replaces the existing marker block, or appends one when absent.
upsert_block() {
  local body="$1" existing
  existing="$(
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
      $0 == b { skip = 1; next }
      $0 == e { skip = 0; next }
      !skip
    ' | trim_trailing_blanks
  )"
  [[ -n "$existing" ]] && printf '%s\n\n' "$existing"
  printf '%s\n%s\n%s' "$BEGIN_MARK" "$body" "$END_MARK"
}

# Writes only on a real change, and backs the file up immediately before.
apply() {
  local file="$1" new="$2" label="$3"
  if [[ -f "$file" ]] && diff -q "$file" <(printf '%s\n' "$new") >/dev/null 2>&1; then
    echo "$label already current -> $file"
    return
  fi
  if [[ -f "$file" ]]; then
    cp "$file" "$file.metamux-bak-$STAMP"
    echo "backed up -> $file.metamux-bak-$STAMP"
  fi
  printf '%s\n' "$new" > "$file"
  echo "installed $label -> $file"
}

# Copy the templates into the ungated location, substituting the repo path the
# way install-launchd.sh templates the plist.
mkdir -p "$SHELL_DIR"
for f in metamux.zsh metamux.tmux.conf; do
  rendered="$(sed "s#__METAMUX_REPO__#$REPO_DIR#g" "$REPO_DIR/shell/$f")"
  if [[ -f "$SHELL_DIR/$f" ]] && diff -q "$SHELL_DIR/$f" <(printf '%s\n' "$rendered") >/dev/null 2>&1; then
    echo "$f already current -> $SHELL_DIR/$f"
  else
    printf '%s\n' "$rendered" > "$SHELL_DIR/$f"
    echo "installed $f -> $SHELL_DIR/$f"
  fi
done

zshrc_src="$(cat "$ZSHRC" 2>/dev/null || true)"
zshrc_new="$(
  printf '%s\n' "$zshrc_src" \
    | strip_region '^# --- tmux session picker' '^# fi$' \
    | strip_region '^# metamux: ensure the daemon is running' 'ensure-daemon' \
    | upsert_block "source \"$SHELL_DIR/metamux.zsh\""
)"
apply "$ZSHRC" "$zshrc_new" "zsh integration"

tmux_src="$(cat "$TMUX_CONF" 2>/dev/null || true)"
tmux_new="$(
  printf '%s\n' "$tmux_src" \
    | strip_region '^# Touch-only switching' "^  'send-keys Left'\$" \
    | upsert_block "source-file \"$SHELL_DIR/metamux.tmux.conf\""
)"
apply "$TMUX_CONF" "$tmux_new" "tmux integration"

echo ""
echo "Open a new shell to pick up the zsh side."
echo "Edited shell/*? Re-run this script -- the dotfiles read the installed copies."
echo "Reload tmux with: tmux source-file $TMUX_CONF"
