#!/usr/bin/env bash
set -euo pipefail
DATA_ROOT="${DEV_DATA_ROOT:-/workspace/dev-data}"
if [ ! -d "$DATA_ROOT/content" ] || [ ! -d "$DATA_ROOT/proposals" ]; then
  mkdir -p "$DATA_ROOT"
  cp -a /workspace/sample-wiki/. "$DATA_ROOT"/
fi

PORT="${PORT:-3000}"
BACK_PID=""
FRONT_PID=""

port_open() {
  (echo >/dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1
}

if port_open "$PORT"; then
  echo "Port $PORT already in use. Stop existing backend or set PORT." >&2
  exit 1
fi

cleanup() {
  if [ -n "$FRONT_PID" ]; then
    kill -TERM -- "-$FRONT_PID" 2>/dev/null || true
  fi
  if [ -n "$BACK_PID" ]; then
    kill -TERM -- "-$BACK_PID" 2>/dev/null || true
  fi

  if [ -n "$FRONT_PID" ]; then
    wait "$FRONT_PID" 2>/dev/null || true
  fi
  if [ -n "$BACK_PID" ]; then
    wait "$BACK_PID" 2>/dev/null || true
  fi
}

on_signal() {
  cleanup
  exit 130
}

trap on_signal INT TERM
trap cleanup EXIT

setsid bash -lc "cd /workspace && KS_DATA_ROOT=\"$DATA_ROOT\" PORT=\"$PORT\" npm run dev -w @ks/backend" &
BACK_PID=$!

for _ in $(seq 1 50); do
  if port_open "$PORT"; then
    break
  fi
  if ! kill -0 "$BACK_PID" 2>/dev/null; then
    wait "$BACK_PID"
    exit $?
  fi
  sleep 0.1
done

setsid bash -lc "cd /workspace && VITE_BACKEND_TARGET=\"${VITE_BACKEND_TARGET:-http://localhost:$PORT}\" npm run dev -w @ks/frontend" &
FRONT_PID=$!

wait -n "$BACK_PID" "$FRONT_PID"
exit $?
