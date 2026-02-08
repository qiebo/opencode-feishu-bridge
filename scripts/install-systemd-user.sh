#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${SERVICE_NAME:-opencode-feishu-bridge.service}"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SYSTEMD_USER_DIR/$SERVICE_NAME"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERROR: systemctl not found"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found in PATH"
  exit 1
fi

NODE_BIN="${NODE_BIN:-$(command -v node)}"

mkdir -p "$SYSTEMD_USER_DIR"
mkdir -p "$PROJECT_DIR/logs"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=OpenCode Feishu Bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$PROJECT_DIR/.env.runtime
ExecStart=$NODE_BIN $PROJECT_DIR/dist/index.js
Restart=always
RestartSec=3
StandardOutput=append:$PROJECT_DIR/logs/systemd-bridge.log
StandardError=append:$PROJECT_DIR/logs/systemd-bridge.log

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

if command -v loginctl >/dev/null 2>&1; then
  if loginctl enable-linger "$USER" >/dev/null 2>&1; then
    echo "Enabled linger for user: $USER"
  else
    echo "WARN: Failed to enable linger automatically."
    echo "Run manually if needed: loginctl enable-linger $USER"
  fi
fi

echo "Installed and started: $SERVICE_NAME"
echo "Service file: $SERVICE_FILE"
echo "Check status: systemctl --user status $SERVICE_NAME --no-pager"
echo "Tail logs: journalctl --user -u $SERVICE_NAME -f"
