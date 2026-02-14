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

### 10) 简单对话静默回复 + 歧义意图路由

- 新增三态意图提示：`chat` / `task` / `ambiguous`
- 明确 `chat`：只发送最终结果（不发送开始/执行中/完成）
- 明确 `task`：保持原有状态流回复
- `ambiguous`：额外调用一次 opencode 进行意图分类，返回 JSON 标签后决定回复模式
- 可调环境变量：
  - `OPENCODE_INTENT_ROUTING_ENABLED`
  - `OPENCODE_INTENT_ROUTING_TIMEOUT`
  - `OPENCODE_INTENT_CONFIDENCE`
- 文件：`src/relay/message-handler.ts`、`src/index.ts`、`src/executor/opencode-executor.ts`、`src/config.ts`、`src/types.ts`

### 11) 会话内模型切换（/model）

- 新增 `/model` 指令：
  - `/model list`
  - `/model current`
  - `/model <model_id>`
  - `/model reset`
- 模型设置按“同一用户 + 同一聊天会话”隔离
- 切换模型后自动清理当前 opencode session，避免模型与旧上下文混用
- 执行器支持任务级 model override，确保会话覆盖模型可透传到 `opencode run --model`
- 文件：`src/relay/message-handler.ts`、`src/index.ts`、`src/executor/opencode-executor.ts`、`src/types.ts`

### 12) 长结果可读性与进度降噪优化（2026-02-10）

- 执行中进度改为“状态/工具调用”模式：
  - 只推送阶段状态（分析中、调用工具中、阶段完成等）
  - 不再推送半成品正文，避免中间消息大段重复
- 完成消息改为结构化输出：
  - 去除相邻重复行
  - 对纯长文本按句分段，提升可读性
  - 显示耗时与模型信息（不再展示任务 ID）
- 图片增强：
  - 从最终输出自动提取图片链接（Markdown 图片 / 常见图片 URL）
  - 自动上传并发送到飞书（最多 3 张，失败不影响主流程）
- 新增配置项：
  - `OPENCODE_PROGRESS_STATUS_ONLY=true`（默认开启）
  - `OPENCODE_RESULT_CARD_ENABLED=true`（默认开启）
- 完成消息卡片化（适配调研/问答场景）：
  - 完成后优先发送飞书 `interactive` 卡片（类型/耗时/模型/核心结论/详细结果）
  - `silent` 模式下短答复仍可走纯文本，长答复和结构化答复优先卡片
  - 卡片发送失败自动回退到纯文本，不影响主流程
  - 长结果自动分段推送：不再硬截断，文本会按顺序拆分为多条消息
  - 卡片内容超长时自动补发“详细结果（续）”分段文本，确保最终结果完整
- `/new` 与模型保持策略：
  - `/new` 仅重置 opencode session 上下文，不清空会话模型偏好
  - 新增“最近已知模型”记忆，避免新会话回落到默认模型
  - 仅 `/model reset` 会清空会话模型并恢复默认
- 超时策略升级（适配复杂任务）：
  - `OPENCODE_TIMEOUT` 改为“无进度超时”而不是“总时长超时”
  - 只要持续有 stdout/stderr 进度，就会自动续期，不会因为任务总时长被取消
  - 设置 `OPENCODE_TIMEOUT=0` 可禁用自动超时
  - 任务取消消息会附带具体原因（如“长时间无进度，已自动取消”）
- 推送策略分级（降噪）：
  - 新增 `/notify current|quiet|normal|debug` 会话级推送开关
  - 默认 `quiet`：仅开始 + 最终结果，执行中不推送
  - `normal`：低频推送里程碑，并过滤“阶段执行完成”等低价值消息
  - `debug`：保留高频详细推送
  - 新增配置：`OPENCODE_NOTIFY_DEFAULT`、`OPENCODE_PROGRESS_NORMAL_INTERVAL`
- 文件：`src/executor/opencode-executor.ts`、`src/relay/message-handler.ts`、`src/index.ts`、`src/bot/feishu-ws-client.ts`、`src/bot/feishu-bot.ts`、`src/config.ts`、`README.md`、`.env.example`

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

## 13) GitHub 发布与可部署性增强（2026-02-08）

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

## 14) Opencode 安全自动更新触发机制（2026-02-14）

- 新增脚本：
  - `scripts/opencode-safe-update.sh`：安全更新执行器（备份、健康检查、失败回滚、任务运行中跳过）
  - `scripts/install-opencode-auto-update.sh`：安装 user-level `systemd` 更新服务与定时器
- 触发机制：
  - 定时触发：`OnCalendar`（默认 `*-*-* 04:20:00`）
  - 开机补偿：`Persistent=true`
  - 手动触发：`systemctl --user start opencode-update.service`
- 安全门控：
  - 检测到 `opencode run` 在执行任务时，本轮跳过更新
  - 更新前备份当前二进制，升级失败自动回滚
  - 可选更新前后自动停启桥接服务并检查服务状态
- 相关新增环境变量：
  - `OPENCODE_AUTO_UPDATE_ENABLED`
  - `OPENCODE_UPDATE_ON_CALENDAR`
  - `OPENCODE_UPDATE_RANDOMIZED_DELAY`
  - `OPENCODE_UPDATE_METHOD`
  - `OPENCODE_UPDATE_TARGET`
  - `OPENCODE_UPDATE_BRIDGE_SERVICE`
  - `OPENCODE_UPDATE_RESTART_BRIDGE`
  - `OPENCODE_UPDATE_MAX_BACKUPS`
