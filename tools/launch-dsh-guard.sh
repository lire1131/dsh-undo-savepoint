#!/bin/sh
# dsh-undo-savepoint 守卫启动器（Linux）。桌面 .desktop 文件与命令行共用。
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "[guard] 未找到 Node.js，请先安装 Node.js >= 20。" >&2
  exit 1
fi
exec node "$DIR/guard.mjs" "$@"
