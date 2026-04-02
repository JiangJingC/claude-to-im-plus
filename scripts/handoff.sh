#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="${CTI_HANDOFF_HELPER:-$SKILL_DIR/scripts/codex-handoff.mjs}"
CLAUDE_HELPER="${CTI_CLAUDE_HANDOFF_HELPER:-$SKILL_DIR/scripts/claude-handoff.mjs}"
DAEMON_SH="${CTI_DAEMON_SH:-$SKILL_DIR/scripts/daemon.sh}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/handoff.sh projects
  bash scripts/handoff.sh threads <project-id> [limit]
  bash scripts/handoff.sh weixin [thread-id] [binding-id-prefix]

  bash scripts/handoff.sh claude projects
  bash scripts/handoff.sh claude sessions <project-id> [limit]
  bash scripts/handoff.sh claude
  bash scripts/handoff.sh claude <session-id>
  bash scripts/handoff.sh claude <session-id> <binding-id-prefix>
EOF
}

daemon_is_running() {
  local output
  output="$("$DAEMON_SH" status 2>&1 || true)"
  printf '%s\n' "$output" >&2
  grep -q '^Bridge process is running' <<<"$output"
}

run_bind_with_restart() {
  local channel="$1"
  local thread_id="${2:-}"
  local binding_prefix="${3:-}"
  local was_running=0
  local -a bind_cmd=(node "$HELPER" bind --channel "$channel")

  if daemon_is_running; then
    was_running=1
    echo "Restarting bridge to reload bindings. Pending permission requests will be lost." >&2
    "$DAEMON_SH" stop
  fi

  if [ -n "$thread_id" ]; then
    bind_cmd+=(--thread-id "$thread_id")
  fi
  if [ -n "$binding_prefix" ]; then
    bind_cmd+=(--binding "$binding_prefix")
  fi

  if ! "${bind_cmd[@]}"; then
    if [ "$was_running" -eq 1 ]; then
      echo "Restoring previous bridge process after failed handoff." >&2
      "$DAEMON_SH" start >/dev/null 2>&1 || true
    fi
    return 1
  fi

  if [ "$was_running" -eq 1 ]; then
    "$DAEMON_SH" start
  fi

  "$DAEMON_SH" status
}

# Claude-specific bind: uses claude-handoff.mjs with --session-id
run_claude_bind_with_restart() {
  local channel="$1"
  local session_id="${2:-}"
  local binding_prefix="${3:-}"
  local was_running=0
  local -a bind_cmd=(node "$CLAUDE_HELPER" bind --channel "$channel")

  if daemon_is_running; then
    was_running=1
    echo "Restarting bridge to reload bindings. Pending permission requests will be lost." >&2
    "$DAEMON_SH" stop
  fi

  if [ -n "$session_id" ]; then
    bind_cmd+=(--session-id "$session_id")
  fi
  if [ -n "$binding_prefix" ]; then
    bind_cmd+=(--binding "$binding_prefix")
  fi

  if ! "${bind_cmd[@]}"; then
    if [ "$was_running" -eq 1 ]; then
      echo "Restoring previous bridge process after failed handoff." >&2
      "$DAEMON_SH" start >/dev/null 2>&1 || true
    fi
    return 1
  fi

  if [ "$was_running" -eq 1 ]; then
    "$DAEMON_SH" start
  fi

  "$DAEMON_SH" status
}

case "${1:-help}" in
  projects)
    shift
    node "$HELPER" projects "$@"
    ;;

  threads)
    shift
    if [ $# -lt 1 ]; then
      usage
      exit 1
    fi
    node "$HELPER" threads "$@"
    ;;

  weixin)
    shift
    run_bind_with_restart weixin "${1:-}" "${2:-}"
    ;;

  claude)
    shift
    sub="${1:-}"
    case "$sub" in
      projects)
        shift
        node "$CLAUDE_HELPER" projects "$@"
        ;;

      sessions)
        shift
        if [ $# -lt 1 ]; then
          echo "Usage: handoff claude sessions <project-id> [limit]" >&2
          exit 1
        fi
        node "$CLAUDE_HELPER" sessions "$@"
        ;;

      "")
        # Auto-detect current session
        run_claude_bind_with_restart weixin "" ""
        ;;

      *)
        # First positional arg is a session id (or could be a session id with prefix)
        session_id="$1"
        binding_prefix="${2:-}"
        run_claude_bind_with_restart weixin "$session_id" "$binding_prefix"
        ;;
    esac
    ;;

  help|--help|-h)
    usage
    ;;

  *)
    usage
    exit 1
    ;;
esac
