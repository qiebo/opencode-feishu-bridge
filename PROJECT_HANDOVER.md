# OpenCode Feishu Bridge - 项目交接文档

## 项目概述

- 项目路径：`/home/peanut/opencode-feishu-bridge`
- 目标：通过飞书机器人远程驱动 `opencode`，并实时回传执行输出
- 最新状态（`2026-02-08`）：**主链路已打通，可用**

## 本轮已完成修复

### 1) 飞书长连接接入修复（关键）

- 问题：之前错误地把 `WSClient` 当作 `EventEmitter` 使用，导致启动失败或收不到事件
- 修复：改为官方模式 `wsClient.start({ eventDispatcher })`
- 文件：`src/bot/feishu-ws-client.ts`

### 2) 消息能收到但不执行任务

- 问题：旧逻辑只返回“任务已排队”，没有真实调用执行器
- 修复：在 `index.ts` 收到可执行消息后调用 `executor.execute(...)`
- 文件：`src/index.ts`

### 3) 执行器事件模型不一致

- 问题：`executor.emit(...)` 与 `index.ts` 监听 payload 不匹配
- 修复：统一事件 payload（全部携带 `task`），并补齐进度/完成/失败链路
- 文件：`src/executor/opencode-executor.ts`

### 4) 实时回传链路补齐

- 对 stdout/stderr 做 `task:progress` 事件上报
- 在桥接层按间隔聚合并推送到飞书，结束时强制 flush
- 文件：`src/executor/opencode-executor.ts`、`src/index.ts`

### 5) opencode 模型不可用时的兜底

- 支持 `OPENCODE_MODEL` 显式指定
- 未指定时可自动尝试探测 `opencode models` 的首个可用模型
- 文件：`src/config.ts`、`src/executor/opencode-executor.ts`

### 6) 消息解析与命令策略优化

- 私聊：直接文本可执行
- 群聊：默认需 `@机器人`（可用 `REQUIRE_MENTION=false` 关闭）
- 保留内置命令：`!help`、`!status`、`!history`、`!clear`
- 文件：`src/relay/message-handler.ts`

### 7) 文件传输能力补齐

- 支持接收飞书文件消息并下载到本地暂存目录
- 用户后续发送任务文本时，自动将待处理文件通过 `opencode run --file` 附带执行
- 新增 `!sendfile <path>` 命令：将服务器本地文件回传到当前飞书会话
- 文件：`src/index.ts`、`src/bot/feishu-bot.ts`、`src/bot/feishu-ws-client.ts`、`src/executor/opencode-executor.ts`、`src/relay/message-handler.ts`

### 8) 回复文案与可读性优化

- 去掉执行前“已收到，准备执行”的重复回显
- 开始/进度/完成文案改为状态导向，减少任务原文重复
- 进度消息中完全隐藏任务 ID
- 输出内容新增 ANSI 清洗，减少终端控制字符噪音
- 文件：`src/relay/message-handler.ts`、`src/index.ts`

### 9) 会话复用策略升级

- 同一用户 + 同一聊天会话复用同一个 opencode session
- 支持 `/new`、`!new` 显式新开会话
- 支持自然语言触发新会话（如“新开一个session”“重置会话”）
- 执行器改为 `--format json` 解析 `sessionID` 并自动追踪
- 文件：`src/relay/message-handler.ts`、`src/index.ts`、`src/executor/opencode-executor.ts`

## 运行方式（当前有效）

> 当前代码读取环境变量，不读取 `config.json`。

```bash
cd /home/peanut/opencode-feishu-bridge
npm run build

export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export OPENCODE_PATH=/home/peanut/.opencode/bin/opencode
export OPENCODE_WORKING_DIR=/home/peanut/workspace
export OPENCODE_MODEL=opencode/gpt-5-nano

node dist/index.js
```

后台模式：

```bash
mkdir -p logs
nohup node dist/index.js > logs/bridge.log 2>&1 &
tail -f logs/bridge.log
```

## 飞书侧配置要求（必须）

1. 应用启用机器人能力并已发布
2. 订阅方式使用“长连接模式”
3. 订阅事件：`im.message.receive_v1`
4. 具备消息接收与发送权限（至少包含发送权限 `im:message:send`，接收权限按单聊/群聊场景开通）
5. 若需文件传输，需具备“获取消息中的资源文件”相关权限

## 验证结果

- `npm run build`：通过
- 本地启动服务：通过，日志可见 `ws client ready`
- 本地执行器联调：通过，`opencode run` 可返回结果并触发进度/完成事件

## 仍需关注的事项

1. 生产部署建议使用 `pm2` 或 `systemd` 保活
2. 建议配置日志轮转（避免 `bridge.log` 无限增长）
3. 若飞书侧收不到消息，优先核查事件订阅与权限
4. 若执行时报 `ProviderModelNotFoundError`，请显式设置 `OPENCODE_MODEL`
5. 文件暂存目录位于 `OPENCODE_WORKING_DIR/.feishu_uploads`，建议按需定期清理

## 本次主要改动文件

- `src/bot/feishu-ws-client.ts`
- `src/executor/opencode-executor.ts`
- `src/index.ts`
- `src/relay/message-handler.ts`
- `src/config.ts`
- `src/types.ts`
- `README.md`
- `PROJECT_HANDOVER.md`
- `DEPLOYMENT.md`
- `SECURITY.md`
- `.gitignore`
- `.env.example`
- `scripts/preflight.sh`
- `scripts/install-systemd-user.sh`

## 10) GitHub 发布与可部署性增强（2026-02-08）

### 安全治理

- 新增 `.gitignore`，默认忽略：
  - `.env.runtime` / `.env.*`
  - `config.json`
  - `logs/`、`node_modules/`、`dist/`
- 新增 `.env.example`，统一公开配置模板
- `config.json` 与 `test-run.sh` 已去除真实密钥

### 部署可复制性

- 新增 `scripts/preflight.sh`：部署前自动检查环境变量与依赖
- 新增 `scripts/install-systemd-user.sh`：自动安装并启动 user-level systemd 服务
- `start.sh` 支持自动加载 `.env.runtime`

### 对外发布建议

1. 上传前再次确认 `.env.runtime` 未被提交
2. 若历史中出现过真实密钥，务必先在飞书后台轮换
3. 首次部署按 README 的“systemd 一键部署”流程执行
