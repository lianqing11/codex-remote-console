#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PORT="${1:-3027}"

declare -A PIDS=()

add_pid() {
  local pid="$1"
  [[ -n "$pid" && "$pid" != "$$" && -d "/proc/$pid" ]] || return 0
  PIDS["$pid"]=1
}

proc_cwd() {
  readlink -f "/proc/$1/cwd" 2>/dev/null || true
}

proc_cmd() {
  tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null || true
}

same_project_process() {
  local pid="$1"
  local cwd cmd
  cwd="$(proc_cwd "$pid")"
  cmd="$(proc_cmd "$pid")"

  [[ "$cmd" == *"server/index.ts"* ]] || return 1
  [[ "$cwd" == "$ROOT" || "$cmd" == *"$ROOT"* ]]
}

add_children() {
  local pid="$1"
  local child
  while read -r child; do
    [[ -n "$child" ]] || continue
    add_pid "$child"
    add_children "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
}

while read -r pid; do
  same_project_process "$pid" && add_pid "$pid"
done < <(pgrep -f "server/index.ts" 2>/dev/null || true)

if command -v ss >/dev/null 2>&1; then
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    local_cwd="$(proc_cwd "$pid")"
    local_cmd="$(proc_cmd "$pid")"
    if [[ "$local_cwd" == "$ROOT" || "$local_cmd" == *"$ROOT"* ]]; then
      add_pid "$pid"
    fi
  done < <(ss -ltnp 2>/dev/null | awk -v port=":$PORT" '$4 ~ port {print}' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
fi

for pid in "${!PIDS[@]}"; do
  add_children "$pid"
done

if ((${#PIDS[@]} == 0)); then
  echo "No codex_remote_console process found for $ROOT on port $PORT."
  exit 0
fi

mapfile -t SORTED_PIDS < <(printf '%s\n' "${!PIDS[@]}" | sort -n)

echo "Stopping codex_remote_console processes:"
for pid in "${SORTED_PIDS[@]}"; do
  echo "  $pid $(proc_cmd "$pid")"
done

kill -TERM "${SORTED_PIDS[@]}" 2>/dev/null || true
sleep 2

ALIVE=()
for pid in "${SORTED_PIDS[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    ALIVE+=("$pid")
  fi
done

if ((${#ALIVE[@]} > 0)); then
  echo "Force killing remaining processes: ${ALIVE[*]}"
  kill -KILL "${ALIVE[@]}" 2>/dev/null || true
fi

echo "Done."
