#!/bin/sh
set -e

# Seed the default vault from the bundled test-vault on first run.
# VAULTS_DIR matches the env var read by server/config.js.
VAULTS_DIR="${VAULTS_DIR:-/app/data/vaults}"
DEFAULT_VAULT="$VAULTS_DIR/default"
if [ ! -d "$DEFAULT_VAULT" ]; then
  echo "[entrypoint] first run: seeding vault at $DEFAULT_VAULT"
  mkdir -p "$VAULTS_DIR"
  cp -r /app/test-vault "$DEFAULT_VAULT"
fi

exec "$@"
