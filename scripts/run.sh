#!/usr/bin/env bash
# token-tool launcher (macOS / Linux). Windows users run: node src/server.js
#
# Starts the local-only server and opens the authenticated URL in a browser.
# node:sqlite (used only for optional OpenCode local usage) is experimental on
# some Node builds; pass --experimental-sqlite when available without error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE="${NODE:-node}"
NODE_ARGS=()
# Enable node:sqlite if the running Node accepts the flag (silent otherwise).
if "$NODE" --help 2>&1 | grep -q -- '--experimental-sqlite'; then
  NODE_ARGS+=('--experimental-sqlite')
fi

cd "$APP_DIR"
exec "$NODE" "${NODE_ARGS[@]}" src/server.js "$@"
