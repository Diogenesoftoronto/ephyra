#!/bin/sh
# Railway mounts volumes owned by root. Fix ownership of the data dir as root,
# then run the server as the unprivileged `bun` user.
set -eu
DATA_DIR="${EPHYRA_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown bun:bun "$DATA_DIR"
  exec su-exec bun "$@"
fi
exec "$@"
