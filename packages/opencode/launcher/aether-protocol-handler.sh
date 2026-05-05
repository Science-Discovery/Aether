#!/usr/bin/env bash
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
portfile="${XDG_DATA_HOME:-$HOME/.local/share}/aether/serve-port"
port=""
if [ -f "$portfile" ]; then
  port="$(head -1 "$portfile" 2>/dev/null || true)"
fi
if [ -n "$port" ]; then
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/" >/dev/null 2>&1; then
    xdg-open "http://127.0.0.1:$port/" 2>/dev/null || sensible-browser "http://127.0.0.1:$port/" 2>/dev/null || true
    exit 0
  fi
fi
exec "$dir/Aether.sh"
