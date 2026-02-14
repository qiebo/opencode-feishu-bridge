# OpenCode Feishu Bridge

通过飞书机器人实时驱动 `opencode` 执行任务，并将进度/结果回传到飞书会话。

补充文档：

- 部署说明：`DEPLOYMENT.md`
- 安全说明：`SECURITY.md`

## 功能概览

- 飞书长连接（WebSocket）接收消息
- 私聊/群聊命令解析（群聊可要求 `@机器人`）
- 调用 `opencode run` 执行任务并流式回传（执行中仅状态/工具，不推送半成品正文）
- 接收飞书文件并通过 `--file` 传给 opencode
- 会话复用：同一用户 + 同一聊天默认复用上下文
- 支持 `/new` 或 `!new` 强制新建会话
- 支持 `/model` 会话内切换模型
- 任务完成后自动提取并发送结果中的图片链接（最多 3 张）

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

- `OPENCODE_TIMEOUT`（默认 `300000`，按“无进度超时”计算；`0` 表示禁用自动超时）
- `OPENCODE_STREAMING_INTERVAL`（默认 `5000`）
- `OPENCODE_MAX_CONCURRENT`（默认 `5`）
- `OPENCODE_AUTO_MODEL_DETECT`（默认 `true`）
- `OPENCODE_INTENT_ROUTING_ENABLED`（默认 `true`，仅对歧义消息启用意图分类）
- `OPENCODE_INTENT_ROUTING_TIMEOUT`（默认 `8000`）
- `OPENCODE_INTENT_CONFIDENCE`（默认 `0.75`，分类为 `chat` 且高于阈值才静默模式）
- `OPENCODE_PROGRESS_STATUS_ONLY`（默认 `true`，执行中仅发送状态/工具调用）
- `OPENCODE_RESULT_CARD_ENABLED`（默认 `true`，完成结果优先用飞书卡片展示）
- `OPENCODE_NOTIFY_DEFAULT`（默认 `quiet`，任务推送默认模式）
- `OPENCODE_PROGRESS_NORMAL_INTERVAL`（默认 `480000`，`normal` 模式推送间隔，毫秒）
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
- `/model list|current|reset|<model_id>`（会话内模型切换）
- `/notify current|quiet|normal|debug`（设置任务推送模式）
- `!sendfile <path>`（将服务器本地文件发回飞书）
- `/new` 或 `!new`（新开 opencode 会话）

## 会话策略

- 同一用户 + 同一聊天会话默认复用同一个 opencode session
- 发送 `/new` 或 `!new` 时重置会话
- 发送“新开/重置 会话(session/上下文)”这类自然语言也会触发新会话
- `/new` 只重置上下文，不会重置当前会话模型（模型重置请用 `/model reset`）

## 模型切换

- `/model list`：查看可用模型
- `/model current`：查看当前会话模型
- `/model <model_id>`：切换当前会话模型
- `/model reset`：恢复默认模型

说明：

- 模型切换是“会话级”设置（同一用户 + 同一聊天会话生效）
- 切换模型后会自动清理当前 opencode session，上下文从新会话开始

## 回复策略（聊天 vs 任务）

- 明确任务指令：走会话推送模式（默认 `quiet`）
- 明确闲聊问答：走 `silent`（仅最终结果）
- 歧义消息：先调用一次 opencode 做意图分类，再决定 `silent` 或会话推送模式

### 任务消息显示策略

- 执行中：只显示状态和工具调用摘要，例如“正在调用 read 工具”“工具步骤完成”
- `quiet`：只发“开始 + 最终结果”，执行中不推送
- `normal`：低频里程碑推送，过滤“阶段执行完成”等低价值消息
- `debug`：高频详细推送（调试用）
- 执行完成：优先发送结构化卡片（摘要 + 详细结果），发送失败自动回退纯文本
- 长结果自动分段推送：不再在桥接层硬截断，超长内容会按顺序拆分为多条消息
- 卡片模式下若“详细结果”超出卡片容量，会自动补发“详细结果（续）”分段文本
- 若结果中包含图片 URL（Markdown 图片或常见图片后缀链接），会自动附图发送（默认最多 3 张）

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

推送前务必再次确认 `git status` 中没有 `.env.runtime`、`logs/`、`node_modules/`、本地 `config.json`。

## 许可证

MIT
