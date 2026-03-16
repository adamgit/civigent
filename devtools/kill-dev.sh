#!/usr/bin/env bash
# Kill orphaned dev-app processes (node/tsx) still LISTENING on ports 3000/5173.
# Safe: only targets node processes that are listeners, not VS Code or other clients.
set -euo pipefail

PORTS="${*:-3000 5173}"
killed=0

for port in $PORTS; do
  # Find only LISTEN-state sockets held by node processes
  pids="$(lsof -i tcp:"$port" -sTCP:LISTEN 2>/dev/null \
    | awk 'NR>1 && $1 == "node" { print $2 }' \
    | sort -u || true)"

  if [ -z "$pids" ]; then
    echo "Port $port: clear"
    continue
  fi

  echo "Port $port: killing node PIDs $pids"
  kill -TERM $pids 2>/dev/null || true
  sleep 0.5

  # Force-kill anything that didn't exit
  still="$(lsof -i tcp:"$port" -sTCP:LISTEN 2>/dev/null \
    | awk 'NR>1 && $1 == "node" { print $2 }' \
    | sort -u || true)"
  if [ -n "$still" ]; then
    echo "Port $port: force-killing node PIDs $still"
    kill -KILL $still 2>/dev/null || true
  fi

  killed=1
done

if [ "$killed" -eq 1 ]; then
  echo "Done — orphaned node processes killed."
else
  echo "No orphaned node dev-servers found on ports $PORTS."
fi
