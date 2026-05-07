#!/bin/sh
set -eu

ROOT_DIR=$(
  CDPATH= cd -- "$(dirname "$0")/.." && pwd
)
DATA_DIR="${ROOT_DIR}/.localclaw"
WORKSPACE_DIR="${DATA_DIR}/workspace"
POSTGRES_DATA_DIR="${DATA_DIR}/postgres"

mkdir -p "$WORKSPACE_DIR" "$POSTGRES_DATA_DIR"

compose_up() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker compose up -d postgres
    return
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose up -d postgres
    return
  fi

  echo "Docker Compose is required to start local PostgreSQL." >&2
  exit 1
}

# Environment defaults are handled by .env and src/config.js
cd "$ROOT_DIR"

compose_up
npm run migrate
exec node src/index.js
