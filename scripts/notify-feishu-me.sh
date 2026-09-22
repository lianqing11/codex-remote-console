#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 MESSAGE" >&2
  exit 2
fi

if [[ -z "${CODEX_WEB_FEISHU_USER_OPEN_ID:-}" ]]; then
  echo "CODEX_WEB_FEISHU_USER_OPEN_ID is required" >&2
  exit 2
fi

feishu_cli="${CODEX_WEB_FEISHU_CLI:-lark-cli}"

"$feishu_cli" im +messages-send \
  --as bot \
  --user-id "$CODEX_WEB_FEISHU_USER_OPEN_ID" \
  --text "$*"
