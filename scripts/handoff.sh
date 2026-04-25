#!/usr/bin/env bash
set -euo pipefail

CTI_HOME="${CTI_HOME:-$HOME/.claude-to-im}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="$CTI_HOME/config.env"
HELPER="${CTI_HANDOFF_HELPER:-$SKILL_DIR/scripts/codex-handoff.mjs}"
CLAUDE_HELPER="${CTI_CLAUDE_HANDOFF_HELPER:-$SKILL_DIR/scripts/claude-handoff.mjs}"
DAEMON_SH="${CTI_DAEMON_SH:-$SKILL_DIR/scripts/daemon.sh}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/handoff.sh weixin
  bash scripts/handoff.sh dingtalk
EOF
}

removed_command_error() {
  local command_name="$1"
  echo "The handoff command '$command_name' has been removed. Use 'handoff weixin' or 'handoff dingtalk' from the current Codex or Claude Code session." >&2
}

explicit_selection_removed_error() {
  echo "Explicit session/thread selection has been removed. Run 'handoff <channel>' from the current Codex or Claude Code session." >&2
}

daemon_is_running() {
  local output
  output="$("$DAEMON_SH" status 2>&1 || true)"
  printf '%s\n' "$output" >&2
  grep -q '^Bridge process is running' <<<"$output"
}

has_runtime_config() {
  [ -f "$CONFIG_FILE" ] && grep -q '^CTI_RUNTIME=' "$CONFIG_FILE"
}

read_runtime_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    return 0
  fi

  grep '^CTI_RUNTIME=' "$CONFIG_FILE" | head -1 | cut -d= -f2-
}

rewrite_runtime_config() {
  local mode="$1"
  local value="${2:-}"
  local tmp_file
  local config_dir

  config_dir="$(dirname "$CONFIG_FILE")"
  mkdir -p "$config_dir"
  tmp_file="$config_dir/.config.env.tmp.$$"

  if [ -f "$CONFIG_FILE" ]; then
    awk -v mode="$mode" -v value="$value" '
      BEGIN { updated = 0 }
      /^CTI_RUNTIME=/ {
        if (mode == "set") {
          print "CTI_RUNTIME=" value
          updated = 1
        }
        next
      }
      { print }
      END {
        if (mode == "set" && updated == 0) {
          print "CTI_RUNTIME=" value
        }
      }
    ' "$CONFIG_FILE" >"$tmp_file"
  elif [ "$mode" = "set" ]; then
    printf 'CTI_RUNTIME=%s\n' "$value" >"$tmp_file"
  else
    : >"$tmp_file"
  fi

  chmod 600 "$tmp_file" 2>/dev/null || true
  mv "$tmp_file" "$CONFIG_FILE"
}

restore_runtime_config() {
  local had_runtime="$1"
  local runtime_value="${2:-}"

  if [ "$had_runtime" -eq 1 ]; then
    rewrite_runtime_config set "$runtime_value"
  else
    rewrite_runtime_config remove
  fi
}

run_handoff_with_restart() {
  local target_runtime="$1"
  shift
  local bind_label="$1"
  shift
  local -a bind_cmd=("$@")
  local was_running=0
  local had_original_runtime=0
  local original_runtime=""
  local runtime_before_display="<unset>"
  local runtime_switched=0

  if daemon_is_running; then
    was_running=1
    echo "Restarting bridge to reload bindings. Pending permission requests will be lost." >&2
    "$DAEMON_SH" stop
  fi

  if has_runtime_config; then
    had_original_runtime=1
    original_runtime="$(read_runtime_config)"
    if [ -n "$original_runtime" ]; then
      runtime_before_display="$original_runtime"
    fi
  fi

  echo "Target runtime: $target_runtime" >&2

  if [ "$had_original_runtime" -ne 1 ] || [ "$original_runtime" != "$target_runtime" ]; then
    rewrite_runtime_config set "$target_runtime"
    runtime_switched=1
    echo "Global runtime switched: $runtime_before_display -> $target_runtime" >&2
  else
    echo "Global runtime already set to: $target_runtime" >&2
  fi

  echo "This is a global runtime switch. All enabled channels and bindings will use $target_runtime after restart." >&2

  if ! "${bind_cmd[@]}"; then
    if [ "$runtime_switched" -eq 1 ]; then
      restore_runtime_config "$had_original_runtime" "$original_runtime"
      echo "Bind failed. Restored global runtime to $runtime_before_display." >&2
    fi
    if [ "$was_running" -eq 1 ]; then
      echo "Restoring previous bridge process after failed handoff." >&2
      "$DAEMON_SH" start >/dev/null 2>&1 || true
    fi
    return 1
  fi

  if [ "$was_running" -eq 1 ]; then
    echo "Starting bridge with the updated binding." >&2
  else
    echo "Bridge was not running. Starting it now so the new binding is immediately available." >&2
  fi

  if ! "$DAEMON_SH" start; then
    echo "Handoff binding was written for $bind_label, but the bridge failed to start." >&2
    echo "Bind written: yes" >&2
    if [ "$runtime_switched" -eq 1 ]; then
      echo "Runtime switch applied: yes ($runtime_before_display -> $target_runtime)" >&2
    else
      echo "Runtime switch applied: no (already $target_runtime)" >&2
    fi
    echo "Bridge start: failed" >&2
    echo "Next steps: run 'bash \"$DAEMON_SH\" status', 'bash \"$DAEMON_SH\" logs 100', or 'bash \"$SKILL_DIR/scripts/doctor.sh\"'." >&2
    return 1
  fi

  "$DAEMON_SH" status
}

detect_current_runtime() {
  if [ -n "${CODEX_THREAD_ID:-}" ]; then
    printf 'codex\n'
    return 0
  fi

  local current_output
  current_output="$(node "$CLAUDE_HELPER" current --json 2>&1)" || {
    printf '%s\n' "$current_output" >&2
    return 1
  }

  if [ -n "$current_output" ]; then
    printf 'claude\n'
    return 0
  fi

  echo "Cannot detect the current Codex or Claude Code session. Run 'handoff weixin' or 'handoff dingtalk' from an active conversation." >&2
  return 1
}

select_binding_for_channel() {
  local helper="$1"
  local channel="$2"
  local bindings_json
  local count
  local selection
  local resolved

  bindings_json="$(node "$helper" bindings --channel "$channel" --json 2>&1)" || {
    printf '%s\n' "$bindings_json" >&2
    return 1
  }

  count="$(printf '%s' "$bindings_json" | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(raw);
  const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
  process.stdout.write(String(bindings.length));
});
')"

  if [ "$count" -le 1 ]; then
    return 0
  fi

  printf 'Multiple %s bindings found. Select the target chat:\n' "$channel" >&2
  printf '%s' "$bindings_json" | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(raw);
  const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
  for (const [index, entry] of bindings.entries()) {
    const summary = entry?.summary || {};
    const updatedAt = summary.updatedAt || "unknown";
    process.stderr.write(`[${index + 1}] ${summary.bindingId} | ${summary.typeLabel} | ${summary.displayName} | ${summary.chatId} | ${updatedAt}\n`);
  }
});
'

  while true; do
    printf 'Enter the number or binding id prefix: ' >&2
    if ! IFS= read -r selection; then
      echo "No selection received. Re-run 'handoff $channel' and choose one of the listed bindings." >&2
      return 1
    fi

    resolved="$(printf '%s' "$bindings_json" | node -e '
let raw = "";
const selection = (process.argv[1] || "").trim();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(raw);
  const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
  if (!selection) {
    process.stderr.write("Selection cannot be empty.\n");
    process.exit(1);
  }

  if (/^\d+$/.test(selection)) {
    const index = Number.parseInt(selection, 10) - 1;
    if (index >= 0 && index < bindings.length) {
      process.stdout.write(bindings[index].value.id);
      return;
    }
    process.stderr.write(`Selection ${selection} is out of range.\n`);
    process.exit(1);
  }

  const matches = bindings.filter((entry) => entry?.value?.id?.startsWith(selection));
  if (matches.length === 1) {
    process.stdout.write(matches[0].value.id);
    return;
  }
  if (matches.length > 1) {
    process.stderr.write(`Binding prefix "${selection}" is ambiguous. Use a longer prefix or enter the numeric index.\n`);
    process.exit(1);
  }

  process.stderr.write(`No binding matches "${selection}".\n`);
  process.exit(1);
});
' "$selection")" && {
      printf '%s\n' "$resolved"
      return 0
    }
  done
}

case "${1:-help}" in
  weixin|dingtalk)
    channel="$1"
    shift
    if [ $# -gt 0 ]; then
      explicit_selection_removed_error
      exit 1
    fi

    runtime="$(detect_current_runtime)" || exit 1
    helper="$HELPER"
    if [ "$runtime" = "claude" ]; then
      helper="$CLAUDE_HELPER"
    fi

    binding_prefix=""
    if [ "$channel" = "dingtalk" ]; then
      binding_prefix="$(select_binding_for_channel "$helper" "$channel")" || exit 1
    fi

    bind_args=(--channel "$channel")
    if [ -n "$binding_prefix" ]; then
      bind_args+=(--binding "$binding_prefix")
    fi

    case "$runtime" in
      codex)
        run_handoff_with_restart codex "Codex handoff ($channel)" node "$HELPER" bind "${bind_args[@]}"
        ;;
      claude)
        run_handoff_with_restart claude "Claude handoff ($channel)" node "$CLAUDE_HELPER" bind "${bind_args[@]}"
        ;;
      *)
        echo "Unsupported detected runtime: $runtime" >&2
        exit 1
        ;;
    esac
    ;;

  projects)
    removed_command_error "handoff projects"
    exit 1
    ;;

  threads)
    removed_command_error "handoff threads"
    exit 1
    ;;

  claude)
    removed_command_error "handoff claude"
    exit 1
    ;;

  help|--help|-h)
    usage
    ;;

  *)
    usage
    exit 1
    ;;
esac
