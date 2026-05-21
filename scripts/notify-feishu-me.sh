#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 MESSAGE" >&2
  exit 2
fi

lark-cli im +messages-send \
  --as bot \
  --user-id "ou_731b47962ce9e91ce3d1cbabeac3ba58" \
  --text "$*"
