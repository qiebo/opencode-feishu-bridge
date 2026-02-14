#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="${UPDATE_SERVICE_NAME:-opencode-update.service}"
TIMER_NAME="${UPDATE_TIMER_NAME:-opencode-update.timer}"

if [ -f "$PROJECT_DIR/.env.runtime" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env.runtime"
  set +a
fi

ON_CALENDAR="${OPENCODE_UPDATE_ON_CALENDAR:-*-*-* 04:20:00}"
RANDOMIZED_DELAY="${OPENCODE_UPDATE_RANDOMIZED_DELAY:-15m}"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERROR: systemctl not found"
  exit 1
fi

mkdir -p "$SYSTEMD_USER_DIR" "$PROJECT_DIR/logs"

cat > "$SYSTEMD_USER_DIR/$SERVICE_NAME" <<EOF
[Unit]
Description=Safe Opencode Auto Update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=-$PROJECT_DIR/.env.runtime
ExecStart=/usr/bin/env bash $PROJECT_DIR/scripts/opencode-safe-update.sh
StandardOutput=append:$PROJECT_DIR/logs/systemd-opencode-update.log
StandardError=append:$PROJECT_DIR/logs/systemd-opencode-update.log
EOF

cat > "$SYSTEMD_USER_DIR/$TIMER_NAME" <<EOF
[Unit]
Description=Schedule Safe Opencode Auto Update

[Timer]
OnCalendar=$ON_CALENDAR
RandomizedDelaySec=$RANDOMIZED_DELAY
Persistent=true
Unit=$SERVICE_NAME

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER_NAME"

if command -v loginctl >/dev/null 2>&1; then
  if loginctl enable-linger "$USER" >/dev/null 2>&1; then
    echo "Enabled linger for user: $USER"
  else
    echo "WARN: Failed to enable linger automatically."
    echo "Run manually if needed: loginctl enable-linger $USER"
  fi
fi

echo "Installed: $SERVICE_NAME"
echo "Installed: $TIMER_NAME"
echo "Timer: systemctl --user status $TIMER_NAME --no-pager"
echo "Next trigger: systemctl --user list-timers --all | grep $(basename "$TIMER_NAME" .timer)"
echo "Manual run: systemctl --user start $SERVICE_NAME"
