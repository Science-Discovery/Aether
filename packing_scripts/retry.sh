#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: retry.sh <attempts> <delay-seconds> <cmd> [args...]" >&2
  exit 2
fi

n="$1"
delay="$2"
shift 2

for i in $(seq 1 "$n"); do
  code=0
  "$@" || code=$?
  if [ "$code" = 0 ]; then
    exit 0
  fi
  if [ "$i" = "$n" ]; then
    echo "retry.sh: '$*' failed after $n attempts (exit $code)" >&2
    exit "$code"
  fi
  echo "retry.sh: '$*' failed (attempt $i/$n), retrying in ${delay}s" >&2
  sleep "$delay"
done
