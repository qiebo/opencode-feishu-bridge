#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [ -f ".env.runtime" ]; then
  set -a
  # shellcheck disable=SC1091
  source ".env.runtime"
  set +a
fi

echo "OpenCode Feishu Bridge"
echo "======================"

required_vars=(
  FEISHU_APP_ID
  FEISHU_APP_SECRET
  OPENCODE_PATH
  OPENCODE_WORKING_DIR
)

missing=false
for var in "${required_vars[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "Missing required env: $var"
    missing=true
  fi
done

if [ "$missing" = true ]; then
  echo "Please export required env vars before starting."
  exit 1
fi

if [ ! -d "dist" ]; then
  echo "Building project..."
  npm run build
fi

mkdir -p logs
echo "Starting bridge..."
exec node dist/index.js
