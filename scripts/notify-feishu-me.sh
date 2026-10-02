#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 MESSAGE" >&2
  exit 2
fi

# Agent processes do not inherit the console's CODEX_WEB_* settings; read them locally.
env_file="$(dirname "$0")/../.env.local"
if [[ -z "${CODEX_WEB_FEISHU_USER_OPEN_ID:-}" && -f "$env_file" ]]; then
  CODEX_WEB_FEISHU_USER_OPEN_ID="$(sed -n 's/^CODEX_WEB_FEISHU_USER_OPEN_ID=//p' "$env_file" | tail -n 1)"
fi

if [[ -z "${CODEX_WEB_FEISHU_USER_OPEN_ID:-}" ]]; then
  echo "CODEX_WEB_FEISHU_USER_OPEN_ID is required (environment or .env.local)" >&2
  exit 2
fi

feishu_cli="${CODEX_WEB_FEISHU_CLI:-lark-cli}"

"$feishu_cli" im +messages-send \
  --as bot \
  --user-id "$CODEX_WEB_FEISHU_USER_OPEN_ID" \
  --text "$*"
