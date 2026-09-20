#!/bin/sh
# dsh-undo-savepoint 守卫启动器（macOS）。右键运行，或 ./launch-dsh-guard.command
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "[guard] 未找到 Node.js。请先安装 Node.js >= 20（https://nodejs.org）。" >&2
  read -r _p </dev/tty || true
  exit 1
fi
exec node "$DIR/guard.mjs" "$@"
