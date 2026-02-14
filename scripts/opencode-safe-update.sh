#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-feishu-bridge"
LOCK_FILE="$STATE_DIR/opencode-update.lock"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/opencode-update.log"

mkdir -p "$STATE_DIR" "$LOG_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date -Iseconds)] opencode auto-update is already running, skip." | tee -a "$LOG_FILE"
  exit 0
fi

if [ -f "$PROJECT_DIR/.env.runtime" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env.runtime"
  set +a
fi

enabled="${OPENCODE_AUTO_UPDATE_ENABLED:-false}"
if [ "$enabled" != "true" ]; then
  echo "[$(date -Iseconds)] OPENCODE_AUTO_UPDATE_ENABLED is not true, skip." | tee -a "$LOG_FILE"
  exit 0
fi

if [ -z "${OPENCODE_PATH:-}" ]; then
  echo "[$(date -Iseconds)] OPENCODE_PATH is empty, abort." | tee -a "$LOG_FILE"
  exit 1
fi

if [ ! -x "$OPENCODE_PATH" ]; then
  echo "[$(date -Iseconds)] OPENCODE_PATH is not executable: $OPENCODE_PATH" | tee -a "$LOG_FILE"
  exit 1
fi

bridge_service="${OPENCODE_UPDATE_BRIDGE_SERVICE:-opencode-feishu-bridge.service}"
restart_bridge="${OPENCODE_UPDATE_RESTART_BRIDGE:-true}"
update_method="${OPENCODE_UPDATE_METHOD:-}"
update_target="${OPENCODE_UPDATE_TARGET:-}"
max_backups="${OPENCODE_UPDATE_MAX_BACKUPS:-3}"

sanitize_stream() {
  tr -d '\000' | sed -r 's/\x1B\[[0-9;?]*[A-Za-z]//g'
}

echo "[$(date -Iseconds)] starting safe update (path=$OPENCODE_PATH, service=$bridge_service)" | tee -a "$LOG_FILE"

if pgrep -f -- "$OPENCODE_PATH run" >/dev/null 2>&1; then
  echo "[$(date -Iseconds)] running task detected (opencode run), skip this round." | tee -a "$LOG_FILE"
  exit 0
fi

current_version="$("$OPENCODE_PATH" --version 2>/dev/null || echo unknown)"
backup_file="$STATE_DIR/opencode.backup.$(date +%Y%m%d%H%M%S)"
cp -f "$OPENCODE_PATH" "$backup_file"
chmod +x "$backup_file" || true

service_was_active="false"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active --quiet "$bridge_service"; then
    service_was_active="true"
  fi
fi

if [ "$restart_bridge" = "true" ] && [ "$service_was_active" = "true" ]; then
  echo "[$(date -Iseconds)] stopping bridge service: $bridge_service" | tee -a "$LOG_FILE"
  systemctl --user stop "$bridge_service"
fi

update_cmd=("$OPENCODE_PATH" "upgrade")
if [ -n "$update_target" ]; then
  update_cmd+=("$update_target")
fi
if [ -n "$update_method" ]; then
  update_cmd+=("--method" "$update_method")
fi

upgrade_ok="false"
if "${update_cmd[@]}" 2>&1 | sanitize_stream >>"$LOG_FILE"; then
  upgrade_ok="true"
fi

if [ "$upgrade_ok" != "true" ]; then
  echo "[$(date -Iseconds)] upgrade command failed, restoring backup." | tee -a "$LOG_FILE"
  cp -f "$backup_file" "$OPENCODE_PATH"
  chmod +x "$OPENCODE_PATH" || true

  if [ "$restart_bridge" = "true" ] && [ "$service_was_active" = "true" ]; then
    systemctl --user start "$bridge_service" || true
  fi
  exit 1
fi

new_version="$("$OPENCODE_PATH" --version 2>/dev/null || true)"
if [ -z "$new_version" ]; then
  echo "[$(date -Iseconds)] updated binary failed health check (--version empty), rolling back." | tee -a "$LOG_FILE"
  cp -f "$backup_file" "$OPENCODE_PATH"
  chmod +x "$OPENCODE_PATH" || true

  if [ "$restart_bridge" = "true" ] && [ "$service_was_active" = "true" ]; then
    systemctl --user restart "$bridge_service" || true
  fi
  exit 1
fi

if [ "$restart_bridge" = "true" ] && [ "$service_was_active" = "true" ]; then
  echo "[$(date -Iseconds)] starting bridge service: $bridge_service" | tee -a "$LOG_FILE"
  systemctl --user start "$bridge_service"
  if ! systemctl --user is-active --quiet "$bridge_service"; then
    echo "[$(date -Iseconds)] bridge service health check failed, rolling back." | tee -a "$LOG_FILE"
    cp -f "$backup_file" "$OPENCODE_PATH"
    chmod +x "$OPENCODE_PATH" || true
    systemctl --user restart "$bridge_service" || true
    exit 1
  fi
fi

if [ "$current_version" = "$new_version" ]; then
  echo "[$(date -Iseconds)] no version change ($current_version)." | tee -a "$LOG_FILE"
else
  echo "[$(date -Iseconds)] updated opencode: $current_version -> $new_version" | tee -a "$LOG_FILE"
fi

if [[ "$max_backups" =~ ^[0-9]+$ ]] && [ "$max_backups" -gt 0 ]; then
  mapfile -t backups < <(ls -1t "$STATE_DIR"/opencode.backup.* 2>/dev/null || true)
  if [ "${#backups[@]}" -gt "$max_backups" ]; then
    for old_backup in "${backups[@]:$max_backups}"; do
      rm -f "$old_backup"
    done
  fi
fi

echo "[$(date -Iseconds)] safe update finished." | tee -a "$LOG_FILE"
