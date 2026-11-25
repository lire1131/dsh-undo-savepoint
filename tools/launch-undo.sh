#!/bin/sh
# dsh-undo-savepoint 局外 WebUI 启动器（Linux）。
# Node 解析顺序：DSH_UNDO_NODE 显式覆盖 > DSH 自带 Node（安装根记录）> PATH 里的 node。
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
PRINT_NODE=0
for a in "$@"; do
  if [ "$a" = "--print-node" ]; then PRINT_NODE=1; fi
done
NODE_EXE=""
if [ -n "${DSH_UNDO_NODE:-}" ] && [ -x "${DSH_UNDO_NODE}" ]; then NODE_EXE="$DSH_UNDO_NODE"; fi
if [ -z "$NODE_EXE" ]; then
  if [ -n "${DSH_UNDO_SETTINGS:-}" ]; then UNDO_DIR="$(dirname "$DSH_UNDO_SETTINGS")"
  elif [ -n "${DSH_HOME:-}" ]; then UNDO_DIR="$DSH_HOME/undo"
  else UNDO_DIR="$HOME/.dsh/undo"; fi
  if [ -f "$UNDO_DIR/dsh-root.txt" ]; then
    DSHROOT="$(head -n 1 "$UNDO_DIR/dsh-root.txt" | tr -d "\r")"
    CAND="$DSHROOT/resources/runtime/primary-runtime/dependencies/node/bin/node"
    if [ -n "$DSHROOT" ] && [ -x "$CAND" ]; then NODE_EXE="$CAND"; fi
  fi
fi
if [ -z "$NODE_EXE" ]; then NODE_EXE="$(command -v node 2>/dev/null || true)"; fi
if [ -z "$NODE_EXE" ]; then
  echo "[undo] 未找到 Node.js。请安装 Node.js >= 20，或用 DSH_UNDO_NODE 指定一个 node 可执行文件。" >&2
  exit 1
fi
if [ "$PRINT_NODE" = "1" ]; then echo "$NODE_EXE"; exit 0; fi
PATH="$(dirname "$NODE_EXE"):$PATH"
export PATH
# 环境自检（0.5.3 起从 package 安装钩子移到这里）：只提示，不阻断启动。
"$NODE_EXE" "$DIR/install-preflight.mjs" || true
exec "$NODE_EXE" "$DIR/undo-server.mjs" "$@"
