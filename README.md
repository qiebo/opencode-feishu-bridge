# OpenCode Feishu Bridge

通过飞书机器人实时驱动 `opencode` 执行任务，并将进度/结果回传到飞书会话。

补充文档：

- 部署说明：`DEPLOYMENT.md`
- 安全说明：`SECURITY.md`

## 功能概览

- 飞书长连接（WebSocket）接收消息
- 私聊/群聊命令解析（群聊可要求 `@机器人`）
- 调用 `opencode run` 执行任务并流式回传
- 接收飞书文件并通过 `--file` 传给 opencode
- 会话复用：同一用户 + 同一聊天默认复用上下文
- 支持 `/new` 或 `!new` 强制新建会话

## GitHub 发布前检查（重要）

1. 确保以下文件不会提交：
   - `.env.runtime`
   - `logs/`
   - `node_modules/`
   - 本地 `config.json`
2. 所有密钥仅放在 `.env.runtime`，不要写进源码/脚本。
3. 如果密钥曾在不安全位置暴露，先在飞书后台轮换后再发布。

本仓库已提供 `.gitignore` 和 `.env.example`，默认可避免以上内容被提交。

## 环境要求

- Node.js >= 18
- npm >= 9
- 已安装并可执行 `opencode`
- `opencode` 已登录并可访问可用模型
- 飞书应用已开通机器人能力并发布

## 飞书后台配置

1. 订阅方式：`长连接模式`
2. 事件：`im.message.receive_v1`
3. 权限至少包括：
   - `im:message:send`
   - 接收机器人会话消息相关权限（按单聊/群聊场景开通）
   - 获取消息资源文件权限（若使用文件传输）

## 配置说明

运行时仅读取环境变量，不读取 `config.json`。

### 必填变量

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `OPENCODE_PATH`
- `OPENCODE_WORKING_DIR`

### 推荐变量

- `OPENCODE_MODEL`（建议显式设置，避免默认模型不可用）

### 可选变量

- `OPENCODE_TIMEOUT`（默认 `300000`）
- `OPENCODE_STREAMING_INTERVAL`（默认 `5000`）
- `OPENCODE_MAX_CONCURRENT`（默认 `5`）
- `OPENCODE_AUTO_MODEL_DETECT`（默认 `true`）
- `REQUIRE_MENTION`（默认 `true`）
- `SESSION_TIMEOUT`（默认 `3600000`）
- `SESSION_MAX_HISTORY`（默认 `20`）
- `ALLOWED_USERS`（逗号分隔）

## 本地启动（手动）

```bash
cd /path/to/opencode-feishu-bridge
npm install
cp .env.example .env.runtime
# 编辑 .env.runtime，填入真实值

bash scripts/preflight.sh
npm run build
./start.sh
```

## 一键部署为 systemd 用户服务（推荐）

```bash
cd /path/to/opencode-feishu-bridge
npm install
cp .env.example .env.runtime
# 编辑 .env.runtime，填入真实值

bash scripts/preflight.sh
npm run build
bash scripts/install-systemd-user.sh
```

部署后常用命令：

```bash
systemctl --user status opencode-feishu-bridge.service --no-pager
systemctl --user restart opencode-feishu-bridge.service
journalctl --user -u opencode-feishu-bridge.service -f
```

脚本会自动尝试执行 `loginctl enable-linger <user>`，保证重启后无需登录也能拉起用户服务。

## 飞书内使用方式

- 私聊机器人：直接发送任务文本
- 群聊：`@机器人` 后发送任务文本（当 `REQUIRE_MENTION=true`）
- 发送文件后再发任务文本：文件会自动附带到下一条任务

内置命令：

- `!help` / `!h`
- `!status` / `!s`
- `!history` / `!hist`
- `!clear` / `!c`
- `!sendfile <path>`（将服务器本地文件发回飞书）
- `/new` 或 `!new`（新开 opencode 会话）

## 会话策略

- 同一用户 + 同一聊天会话默认复用同一个 opencode session
- 发送 `/new` 或 `!new` 时重置会话
- 发送“新开/重置 会话(session/上下文)”这类自然语言也会触发新会话

## 常见问题

### 1) 收不到飞书消息

- 检查是否已启用长连接模式
- 检查是否订阅 `im.message.receive_v1`
- 检查机器人是否在当前会话中
- 查看日志是否有 `ws client ready`

### 2) 报模型不存在（`ProviderModelNotFoundError`）

```bash
$OPENCODE_PATH models
```

将可用模型写入 `.env.runtime` 的 `OPENCODE_MODEL` 后重启服务。

### 3) 群聊发消息无响应

- `REQUIRE_MENTION=true` 时必须 `@机器人`
- 或改成 `REQUIRE_MENTION=false` 后重启

### 4) 文件消息无法附带执行

- 检查飞书应用是否有“获取消息资源文件”权限
- 检查机器人是否在该会话
- 查看日志中是否有 `Failed to download message file`

## 给二次开发者 / Agent 的建议流程

1. `npm install`
2. `cp .env.example .env.runtime`
3. 填写 `.env.runtime`
4. `bash scripts/preflight.sh`
5. `npm run build`
6. `bash scripts/install-systemd-user.sh`
7. 在飞书发送 `!status` 验证联通

## 上传到 GitHub（首次）

```bash
cd /path/to/opencode-feishu-bridge
git init
git add .
git status
git commit -m "feat: opencode feishu bridge with deployment docs and security hygiene"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

推送前务必再次确认 `git status` 中没有 `.env.runtime`、`logs/`、`node_modules/`、本地 `config.json`。

## 许可证

MIT
