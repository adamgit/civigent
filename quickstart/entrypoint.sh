#!/bin/sh
# Ensure the data directory exists and is writable by the container user.
# Docker Compose creates bind-mount directories as root when they don't exist,
# so we start as root, fix ownership, then drop to the target user.
DATA_DIR="${KS_DATA_ROOT:-/app/data}"
mkdir -p "$DATA_DIR"
chown -R "${RUN_UID:-1000}:${RUN_GID:-1000}" "$DATA_DIR"
exec su-exec "${RUN_UID:-1000}:${RUN_GID:-1000}" node dist/backend/src/server.js
