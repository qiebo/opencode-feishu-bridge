#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if [ ! -f ".env.runtime" ]; then
  echo "ERROR: .env.runtime not found."
  echo "Run: cp .env.example .env.runtime"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source ".env.runtime"
set +a

required_vars=(
  FEISHU_APP_ID
  FEISHU_APP_SECRET
  OPENCODE_PATH
  OPENCODE_WORKING_DIR
)

missing=0
for var in "${required_vars[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: missing required env: $var"
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found in PATH"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found in PATH"
  exit 1
fi

if [ ! -x "$OPENCODE_PATH" ]; then
  echo "ERROR: OPENCODE_PATH is not executable: $OPENCODE_PATH"
  exit 1
fi

if [ ! -d "$OPENCODE_WORKING_DIR" ]; then
  echo "ERROR: OPENCODE_WORKING_DIR does not exist: $OPENCODE_WORKING_DIR"
  exit 1
fi

echo "OK: required env variables present"
echo "OK: node=$(command -v node)"
echo "OK: npm=$(command -v npm)"
echo "OK: opencode=$OPENCODE_PATH"
echo "OK: working_dir=$OPENCODE_WORKING_DIR"

if [ -n "${OPENCODE_MODEL:-}" ]; then
  echo "INFO: OPENCODE_MODEL=$OPENCODE_MODEL"
else
  echo "INFO: OPENCODE_MODEL not set (will auto-detect if enabled)"
fi
