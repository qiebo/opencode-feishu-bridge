# Deployment Guide

This guide is written for both humans and agents.  
Target OS: Linux with `systemd --user`.

## 1. Clone and Install

```bash
git clone <your-repo-url> opencode-feishu-bridge
cd opencode-feishu-bridge
npm install
```

## 2. Prepare Runtime Environment

```bash
cp .env.example .env.runtime
```

Edit `.env.runtime` and set at least:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `OPENCODE_PATH`
- `OPENCODE_WORKING_DIR`
- `OPENCODE_MODEL` (recommended)

## 3. Preflight Check

```bash
bash scripts/preflight.sh
```

If this fails, fix the reported item and rerun.

## 4. Build

```bash
npm run build
```

## 5. Install as user service

```bash
bash scripts/install-systemd-user.sh
```

The installer also tries to run `loginctl enable-linger <user>` so the service can start after reboot even before interactive login.

## 6. Verify Service

```bash
systemctl --user status opencode-feishu-bridge.service --no-pager
journalctl --user -u opencode-feishu-bridge.service -f
```

Expected signal in logs: `ws client ready`.

## 7. Optional: Enable Safe Auto Update for Opencode

Set these in `.env.runtime`:

- `OPENCODE_AUTO_UPDATE_ENABLED=true`
- `OPENCODE_UPDATE_ON_CALENDAR='*-*-* 04:20:00'` (example)
- `OPENCODE_UPDATE_RANDOMIZED_DELAY=15m` (example)

Then install timer:

```bash
bash scripts/install-opencode-auto-update.sh
```

Verify:

```bash
systemctl --user status opencode-update.timer --no-pager
systemctl --user list-timers --all | grep opencode-update
```

Manual trigger:

```bash
systemctl --user start opencode-update.service
tail -f logs/opencode-update.log
```

Trigger mechanism:

- scheduled trigger (`OnCalendar`)
- reboot compensation (`Persistent=true`)
- manual trigger (`systemctl --user start opencode-update.service`)
- safe gate: skip update if `opencode run` is active

## 8. Manual Upgrade Flow

```bash
cd opencode-feishu-bridge
git pull
npm install
npm run build
systemctl --user restart opencode-feishu-bridge.service
```

## 9. Security Rules

- Never commit `.env.runtime`
- Never store real secrets in `config.json`
- Rotate Feishu secrets immediately if leaked
