#!/usr/bin/env bash
# Serializes anything that starts the Firebase emulators (fixed ports). Usage: with-emulator-lock.sh <command...>
# The lock is a directory holding the owner's PID; a lock whose owner is gone is reclaimed.
set -euo pipefail
LOCK=/tmp/faangin-emulator.lock
for _ in $(seq 1 240); do
  if mkdir "$LOCK" 2>/dev/null; then
    echo $$ > "$LOCK/pid"
    trap 'rm -rf "$LOCK" 2>/dev/null || true' EXIT
    "$@"
    exit $?
  fi
  owner=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -z "$owner" ] || ! kill -0 "$owner" 2>/dev/null; then
    # Stale: no live owner. Reclaim it on the next loop.
    rm -rf "$LOCK" 2>/dev/null || true
    continue
  fi
  sleep 5
done
echo "timed out waiting for $LOCK" >&2; exit 1
