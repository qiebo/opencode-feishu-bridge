#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [ -f ".env.runtime" ]; then
  set -a
  # shellcheck disable=SC1091
  source ".env.runtime"
  set +a
else
  echo "Missing .env.runtime. Copy .env.example and fill your values first."
  exit 1
fi

mkdir -p logs
node dist/index.js 2>&1 | tee "logs/test-$(date +%Y%m%d-%H%M%S).log"
