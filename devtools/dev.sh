#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT="${DEV_DATA_ROOT:-$REPO_ROOT/dev-data}"
mkdir -p "$DATA_ROOT"
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
  # Send SIGTERM to process groups
  [ -n "$FRONT_PID" ] && kill -TERM -- "-$FRONT_PID" 2>/dev/null || true
  [ -n "$BACK_PID" ]  && kill -TERM -- "-$BACK_PID"  2>/dev/null || true

  # Give processes a moment to exit gracefully
  sleep 0.3

  # Force-kill anything still alive in those process groups
  [ -n "$FRONT_PID" ] && kill -KILL -- "-$FRONT_PID" 2>/dev/null || true
  [ -n "$BACK_PID" ]  && kill -KILL -- "-$BACK_PID"  2>/dev/null || true

  # Final fallback: kill anything still holding our port
  local port_pid
  port_pid="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  if [ -n "$port_pid" ]; then
    kill -KILL $port_pid 2>/dev/null || true
  fi

  wait 2>/dev/null || true
}
on_signal() {
  cleanup
  exit 130
}
trap on_signal INT TERM
trap cleanup EXIT

# ── Start backend (output stays on terminal) ─────────────────────
# KS_EXTERNAL_PORT tells the backend which port agents/users actually reach.
# In dev, that's always the Vite port (5173), not the backend's own PORT.
VITE_PORT=5173
setsid bash -lc "cd \"$REPO_ROOT/backend\" && KS_DATA_ROOT=\"$DATA_ROOT\" PORT=\"$PORT\" KS_EXTERNAL_PORT=\"$VITE_PORT\" npm run dev" &
BACK_PID=$!

# ── Wait for backend to be ready or die ──────────────────────────
BACKEND_READY=false
for _ in $(seq 1 50); do
  if port_open "$PORT"; then
    BACKEND_READY=true
    break
  fi
  if ! kill -0 "$BACK_PID" 2>/dev/null; then
    echo "" >&2
    echo "══════════════════════════════════════════════════════════" >&2
    echo "  BACKEND CRASHED — check compile/runtime errors above" >&2
    echo "══════════════════════════════════════════════════════════" >&2
    wait "$BACK_PID" 2>/dev/null
    exit 1
  fi
  sleep 0.1
done

if [ "$BACKEND_READY" = false ]; then
  echo "" >&2
  echo "══════════════════════════════════════════════════════════" >&2
  echo "  BACKEND TIMED OUT (5s) waiting for port $PORT" >&2
  echo "══════════════════════════════════════════════════════════" >&2
  cleanup
  exit 1
fi

# ── Watchdog: if backend port drops after startup, kill everything ─
# Nodemon swallows crashes ("app crashed — waiting for file changes") so
# the backend process group stays alive even after a fatal startup error.
# This loop detects the port closing and tears down the whole dev stack.
(
  sleep 2  # give startup recovery time to finish
  while sleep 1; do
    if ! port_open "$PORT"; then
      # Port dropped — but nodemon restarts briefly close the port too.
      # Wait up to 10s for it to come back (normal restart). If it stays
      # closed, it's a real crash.
      RECOVERED=false
      for _ in $(seq 1 10); do
        sleep 1
        if port_open "$PORT"; then
          RECOVERED=true
          break
        fi
      done
      if [ "$RECOVERED" = false ]; then
        echo "" >&2
        echo "══════════════════════════════════════════════════════════" >&2
        echo "  BACKEND PORT CLOSED — shutting down dev stack" >&2
        echo "══════════════════════════════════════════════════════════" >&2
        kill -TERM $$ 2>/dev/null
        break
      fi
    fi
  done
) &
WATCHDOG_PID=$!

# ── Start frontend (only after backend is confirmed alive) ───────
setsid bash -lc "cd \"$REPO_ROOT/frontend\" && VITE_BACKEND_TARGET=\"${VITE_BACKEND_TARGET:-http://localhost:$PORT}\" npm run dev" &
FRONT_PID=$!
wait -n "$BACK_PID" "$FRONT_PID" "$WATCHDOG_PID"
cleanup
exit 1