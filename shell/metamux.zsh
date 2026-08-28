# metamux shell integration -- the single zsh-side entry point.
#
# Installed by scripts/install-shell.sh, which writes ONE marker block into
# ~/.zshrc that sources this file. Everything metamux touches in your shell
# lives here: the tmux session picker, remote-login auto-attach, and the
# daemon ensure. Edit this file and open a new shell; no reinstall needed.
#
# Sourced unconditionally for interactive shells. Do not gate the source line
# on CMUX_WORKSPACE_ID: ~/.tmux.conf's jumpnav Left bind runs
# `zsh -ic _tmux_pick` from a plain client, and that needs these functions.

# Repo root, resolved from this file so the integration is path-independent.
# %x is the file currently being sourced; :h twice walks shell/ -> repo root.
typeset -g METAMUX_REPO="${METAMUX_REPO:-${${(%):-%x}:A:h:h}}"

# Where new tmux sessions start. Mirrors the daemon's tmux.spawnCwd config,
# kept as a plain variable so the picker never has to reach the daemon.
typeset -g METAMUX_SPAWN_CWD="${METAMUX_SPAWN_CWD:-$HOME/Documents/GitHub}"

# --- tmux session picker (shared by SSH login and the `t` shortcut) ---
# fzf picker: arrows to browse, live preview of each session's active pane,
# Enter attaches (a typed name that doesn't exist gets created), `r` renames
# the hovered session. Falls back to the numbered menu when fzf is missing.
# No `exec`, so on detach you return to your shell (right for on-demand use).

# Attach or create session $1, from inside or outside tmux.
# New sessions start in $METAMUX_SPAWN_CWD; -c is ignored when attaching.
_tmux_go() {
  local s=$1
  if [[ -n $TMUX ]]; then
    tmux has-session -t "=$s" 2>/dev/null || tmux new -d -s "$s" -c "$METAMUX_SPAWN_CWD"
    tmux switch-client -t "=$s"
  else
    tmux new -A -s "$s" -c "$METAMUX_SPAWN_CWD"
  fi
}

_tmux_pick() {
  local out rc sel
  local -a lines
  if ! command -v fzf >/dev/null 2>&1; then _tmux_menu; return; fi
  if ! tmux ls >/dev/null 2>&1; then
    print "no tmux sessions yet — creating 'main'"
    _tmux_go main
    return
  fi
  # Nav-flag file: arrow keys set it, typing clears it. `d` deletes the
  # hovered session only when the flag is set AND the query is empty;
  # otherwise it types a literal d. fzf child processes inherit these
  # env vars, so the bind strings can stay single-quoted.
  export TMUX_PICKER_NAV="${TMPDIR:-/tmp}/tmux-picker-nav.$$"
  export TMUX_PICKER_CUR=""
  [[ -n $TMUX ]] && TMUX_PICKER_CUR=$(tmux display -p '#S')
  rm -f "$TMUX_PICKER_NAV"
  # Arrow shortcuts for phone use: Right opens the highlighted session (SSH
  # or popup); Left closes the picker (popup only — over SSH login, abort
  # would drop the connection).
  local -a arrowbinds
  arrowbinds=()
  [[ -n $REMOTE_SESSION || -n $TMUX_PICKER_ARROWS ]] && arrowbinds+=(--bind 'right:accept')
  [[ -n $TMUX_PICKER_ARROWS ]] && arrowbinds+=(--bind 'left:abort')
  out=$({ print '[ new session ]'; tmux ls -F '#{session_name}' } | fzf \
    "${arrowbinds[@]}" \
    --prompt='tmux> ' --print-query --reverse \
    --header='enter: attach (typed name = create) · ↓ then r: rename / d: delete' \
    --preview='tmux capture-pane -ep -t {} 2>/dev/null || echo "create a new session"' \
    --preview-window='right:60%,<100(down:45%)' \
    --bind='down:down+execute-silent(touch "$TMUX_PICKER_NAV")' \
    --bind='up:up+execute-silent(touch "$TMUX_PICKER_NAV")' \
    --bind='change:execute-silent(rm -f "$TMUX_PICKER_NAV")' \
    --bind='r:transform:if [ -e "$TMUX_PICKER_NAV" ] && [ -z "$FZF_QUERY" ] && [ "$FZF_MATCH_COUNT" -gt 0 ]; then echo "execute(clear > /dev/tty; printf \"rename %s to: \" {} > /dev/tty; read n < /dev/tty && [ -n \"\$n\" ] && tmux rename-session -t {} \"\$n\")+reload(tmux ls -F \"#{session_name}\")"; else echo "put(r)"; fi' \
    --bind='d:transform:if [ -e "$TMUX_PICKER_NAV" ] && [ -z "$FZF_QUERY" ] && [ "$FZF_MATCH_COUNT" -gt 0 ]; then if [ {} = "$TMUX_PICKER_CUR" ]; then echo "execute-silent(tmux switch-client -n 2>/dev/null; tmux kill-session -t {})+reload(tmux ls -F \"#{session_name}\")"; else echo "execute-silent(tmux kill-session -t {})+reload(tmux ls -F \"#{session_name}\")"; fi; else echo "put(d)"; fi')
  rc=$?
  rm -f "$TMUX_PICKER_NAV"
  unset TMUX_PICKER_NAV TMUX_PICKER_CUR
  (( rc == 130 )) && return  # Esc / Ctrl-C
  # --print-query output: query line, then selection line (if any). zsh (f)
  # splitting drops the empty query line, so the last element is the winner.
  # Must go through an array assignment: subscripting the substitution
  # directly indexes characters when the result is a single line.
  lines=(${(f)out})
  sel=${lines[-1]}
  if [[ $sel == '[ new session ]' ]]; then
    print -n "new session name: "
    read -r sel
  fi
  [[ -z $sel ]] && return
  _tmux_go "${sel//[.: ]/-}"
}

# Numbered-menu fallback (no fzf).
_tmux_menu() {
  local names pick s info i=1
  names=(${(f)"$(tmux ls -F '#{session_name}' 2>/dev/null)"})
  if (( ${#names} == 0 )); then
    print "no tmux sessions yet — creating 'main'"
    tmux new -s main -c "$METAMUX_SPAWN_CWD"
    return
  fi
  print "tmux sessions:"
  for s in $names; do
    info=$(tmux display-message -p -t "$s" '#{session_windows} win#{?session_attached, (attached),}' 2>/dev/null)
    printf '  %d) %-14s %s\n' $i "$s" "$info"
    (( i++ ))
  done
  print -n "attach [number/name, Enter=${names[1]}, n=new]: "
  read -r pick
  if [[ -z $pick ]]; then tmux attach -t ${names[1]}
  elif [[ $pick == (n|N) ]]; then tmux new -c "$METAMUX_SPAWN_CWD"
  elif [[ $pick == <-> ]] && (( pick >= 1 && pick <= ${#names} )); then tmux attach -t ${names[pick]}
  else
    pick=${pick//[.: ]/-}
    if tmux has-session -t "$pick" 2>/dev/null; then tmux attach -t "$pick"
    else tmux new -s "$pick" -c "$METAMUX_SPAWN_CWD"; fi
  fi
}

# t            -> open the tmux session picker (attach existing / make new)
# t foo        -> jump into tmux session 'foo' if it exists, else create it
#                 running Claude; both the tmux and Claude sessions are 'foo'
# t foo --args -> extra args passed through to claude
t() {
  if [[ -z $1 ]]; then
    _tmux_pick
    return
  fi
  local s=${1//[.: ]/-}; shift
  if [[ -n $TMUX ]]; then
    claude --name "$s" "$@"
  else
    tmux new -A -s "$s" -c "$METAMUX_SPAWN_CWD" claude --name "$s" "$@"
  fi
}

# Keep one cmux tab per unattached tmux session (see ~/bin/tmux-cmux-sync).
# cmux-only + interactive; the singleton no-ops if a watcher already runs.
# [superseded by metamux tmux-absorption] if [[ -n $CMUX_SOCKET_CAPABILITY && -o interactive && -x $HOME/bin/tmux-cmux-sync ]]; then
# [superseded by metamux tmux-absorption]   "$HOME/bin/tmux-cmux-sync" --ensure
# [superseded by metamux tmux-absorption] fi

# Remote logins: SSH sets SSH_CONNECTION; mosh doesn't reliably, so also
# detect the mosh-server parent directly.
typeset -g REMOTE_SESSION=""
if [[ -n $SSH_CONNECTION ]] || [[ "$(ps -o comm= -p $PPID 2>/dev/null)" == *mosh-server* ]]; then
  REMOTE_SESSION=1
fi

# Remote login (ssh or mosh): drop straight into the t menu; detaching ends
# the connection. The -t guards skip invisible `zsh -ic` shells (VS Code /
# Claude env probes) that would otherwise hang on the picker.
if [[ -n $REMOTE_SESSION && -z $TMUX && -o interactive && -t 0 && -t 1 ]]; then
  t
  exit
fi

# New local terminal: auto tmux picker DISABLED (was eating pasted commands /
# .command scripts). Type `t` to open the picker manually. Remote SSH/mosh
# still auto-opens below/above. Restore from .zshrc.bak-tmux-picker-* if needed.
# if [[ -z $REMOTE_SESSION && -z $TMUX && -o interactive && -t 0 && -t 1 ]]; then
#   t
# fi

# Ensure the daemon is running (cmux shells only, keeps socket features on).
[ -n "$CMUX_WORKSPACE_ID" ] && (bash "$METAMUX_REPO/scripts/ensure-daemon.sh" >/dev/null 2>&1 &)
