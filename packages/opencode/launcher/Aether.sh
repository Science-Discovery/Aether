#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
pkill -f 'aether web' >/dev/null 2>&1 || true
pkill -f 'aether serve' >/dev/null 2>&1 || true
sleep 1
"$DIR/aether" web
