#!/bin/bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBRETV_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

# This is a private, shell-compatible file; quote JSON and passwords with single quotes.
if [[ -f "$LIBRETV_ROOT/.env.macos.local" ]]; then
  set -a
  source "$LIBRETV_ROOT/.env.macos.local"
  set +a
fi

if [[ -z "${NODE_BINARY:-}" ]]; then
  NODE_BINARY="$(command -v node || true)"
fi
if [[ -z "$NODE_BINARY" || ! -x "$NODE_BINARY" ]]; then
  echo '找不到 Node.js，请在 .env.macos.local 中设置 NODE_BINARY 为完整可执行文件路径。' >&2
  exit 1
fi
