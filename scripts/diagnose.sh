#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ "${SESSION_PANELS_DIAG_SCOPED:-}" != 1 ]]; then
  exec systemd-run --user --scope -p MemoryMax=850M -- \
    env SESSION_PANELS_DIAG_SCOPED=1 bash "$root/scripts/diagnose.sh"
fi

mkdir -p /tmp/opencode
export TMUX_TMPDIR="$(mktemp -d /tmp/opencode/tmux-sessions-panel.XXXXXX)"
export TMUX=""
log="/tmp/opencode/tmux-sessions-panel-diagnose-$(date +%Y%m%d-%H%M%S).log"
session_id=""
monitor=""
pane_cgroup=""

cleanup() {
  if [[ -n "$monitor" ]]; then
    kill "$monitor" 2>/dev/null || true
    wait "$monitor" 2>/dev/null || true
  fi
  local pane_pid=""
  if [[ -n "$session_id" ]]; then
    pane_pid="$(tmux display-message -p -t "$session_id" '#{pane_pid}' 2>/dev/null || true)"
  fi
  tmux kill-server 2>/dev/null || true
  if [[ "$pane_pid" =~ ^[0-9]+$ ]]; then
    kill -TERM "$pane_pid" 2>/dev/null || true
  fi
  rmdir "$TMUX_TMPDIR" 2>/dev/null || true
}
trap cleanup EXIT

session_id="$(tmux new-session -d -P -F '#{session_id}' -s diagnosis -c "$root" \
  'while [ ! -e "$TMUX_TMPDIR/ready" ]; do sleep 0.1; done; exec opencode --continue')"

# tmux moves panes into independent tmux-spawn-*.scope units. A limit on this
# script or the tmux server does NOT limit OpenCode; limit the pane's own scope.
for attempt in {1..50}; do
  pane_pid="$(tmux display-message -p -t "$session_id" '#{pane_pid}')"
  if [[ "$pane_pid" =~ ^[0-9]+$ && -r "/proc/$pane_pid/cgroup" ]]; then
    pane_cgroup="$(cut -d: -f3 "/proc/$pane_pid/cgroup")"
    [[ "$pane_cgroup" == */tmux-spawn-*.scope ]] && break
  fi
  sleep 0.1
done

if [[ "$pane_cgroup" != */tmux-spawn-*.scope ]]; then
  echo "Could not identify the tmux pane's memory scope; refusing to start OpenCode." >&2
  exit 1
fi

pane_scope="${pane_cgroup##*/}"
systemctl --user set-property "$pane_scope" MemoryMax=850M
if [[ "$(cat "/sys/fs/cgroup$pane_cgroup/memory.max")" != 891289600 ]]; then
  echo "Could not verify the 850 MiB memory limit; refusing to start OpenCode." >&2
  exit 1
fi

echo "Diagnostic tmux socket: $TMUX_TMPDIR"
echo "Memory log: $log"
echo "OpenCode memory limit verified: $pane_scope (850 MiB)"
echo "The diagnostic tmux session will be removed when the app exits."
: > "$TMUX_TMPDIR/ready"

(
  while true; do
    pane_pid="$(tmux display-message -p -t "$session_id" '#{pane_pid}' 2>/dev/null || true)"
    pane_rss=""
    if [[ "$pane_pid" =~ ^[0-9]+$ && -r "/proc/$pane_pid/status" ]]; then
      pane_rss="$(awk '/^VmRSS:/ { print $2; exit }' "/proc/$pane_pid/status")"
    fi
    total="$(cat "/sys/fs/cgroup$pane_cgroup/memory.current" 2>/dev/null || true)"
    printf '%s pane_cgroup_bytes=%s pane_pid=%s pane_rss_kb=%s\n' \
      "$(date --iso-8601=seconds)" "$total" "$pane_pid" "$pane_rss" >> "$log"
    sleep 1
  done
) &
monitor=$!

bun run start
