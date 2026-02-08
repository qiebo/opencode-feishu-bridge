import { FeishuBot } from './bot/feishu-bot.js';
import { config } from './config.js';
import { OpencodeExecutor } from './executor/opencode-executor.js';
import { MessageHandler } from './relay/message-handler.js';
import type { FeishuMessageEvent, IntentHint, ModelCommandRequest, TaskInfo, TaskResponseMode } from './types.js';
import { logger } from './utils/logger.js';
import { constants as fsConstants } from 'fs';
import { access, mkdir, rm } from 'fs/promises';
import { basename, isAbsolute, join, resolve } from 'path';

export class OpenCodeFeishuBridge {
  private bot: FeishuBot;
  private executor: OpencodeExecutor;
  private handler: MessageHandler;
  private readonly STREAMING_INTERVAL = config.opencode.streamingInterval;
  private readonly uploadStagingDir = join(config.opencode.workingDir, '.feishu_uploads');
  private readonly MAX_PENDING_FILES = 5;
  private pendingProgress = new Map<string, string[]>();
  private pendingFilesBySession = new Map<string, string[]>();
  private taskAttachedFiles = new Map<string, string[]>();
  private taskResponseMode = new Map<string, TaskResponseMode>();
  private sessionModelByBridgeSession = new Map<string, string>();
  private opencodeSessionByBridgeSession = new Map<string, string>();
  private taskBridgeSession = new Map<string, string>();
  private lastUpdateTime = new Map<string, number>();
  private isStopping = false;

  constructor() {
    this.bot = new FeishuBot(config.feishu);
    this.executor = new OpencodeExecutor();
    this.handler = new MessageHandler();
  }

  async start(): Promise<void> {
    logger.info('Starting OpenCode Feishu Bridge...');

    this.bot.on('message', (event: FeishuMessageEvent) => {
      this.handleIncomingMessage(event).catch((error: unknown) => {
        logger.error('Unhandled message processing error:', error);
      });
    });

    this.setupEventListeners();
    await this.bot.start();

    logger.info(`Bridge started successfully (v${config.version})`);
    logger.info('Mode: WebSocket long connection (no webhook needed)');
    logger.info('Waiting for Feishu messages...');
  }

  private async handleIncomingMessage(event: FeishuMessageEvent): Promise<void> {
    const message = event.event?.message;
    const senderType = event.event?.sender?.sender_type || '';
    if (senderType !== 'user') {
      return;
    }

    const chatId = message?.chat_id || '';
    if (!chatId) {
      logger.warn('Incoming event missing chat_id; ignored');
      return;
    }

    const senderId = this.extractSenderId(event);
    const sessionId = this.findSessionId(senderId, chatId);

    try {
      if (message?.message_type === 'file') {
        await this.handleIncomingFileMessage(event, sessionId);
        return;
      }

      const response = await this.handler.handleMessage(event);
      if (!response) {
        return;
      }

      if (response.text) {
        await this.bot.sendMessage(chatId, response.text, 'text');
      }

      if (response.resetSession) {
        await this.resetBridgeSession(sessionId);
      }

      if (response.modelCommand) {
        await this.handleModelCommand(chatId, sessionId, response.modelCommand);
        return;
      }

      if (response.sendFilePath) {
        await this.handleSendFileCommand(chatId, response.sendFilePath);
        return;
      }

      if (response.executeCommand) {
        const filePaths = this.consumePendingFiles(sessionId);
        let responseMode: TaskResponseMode = 'verbose';
        const modelOverride = this.sessionModelByBridgeSession.get(sessionId);

        if (filePaths.length > 0) {
          const fileNames = filePaths.map(filePath => basename(filePath)).join(', ');
          await this.bot.sendMessage(chatId, `📎 已附带文件：${fileNames}`, 'text');
        } else {
          const hint = response.intentHint || 'task';
          responseMode = await this.resolveResponseMode(hint, response.executeCommand, modelOverride);
        }

        const opencodeSessionId = this.opencodeSessionByBridgeSession.get(sessionId);
        const task = await this.executor.execute({
          command: response.executeCommand,
          userId: senderId,
          chatId,
          messageId: message?.message_id || '',
          files: filePaths,
          opencodeSessionId,
          responseMode,
          model: modelOverride,
        });

        this.taskBridgeSession.set(task.id, sessionId);
        this.taskResponseMode.set(task.id, responseMode);
        if (task.opencodeSessionId) {
          this.opencodeSessionByBridgeSession.set(sessionId, task.opencodeSessionId);
        }

        if (filePaths.length > 0) {
          this.taskAttachedFiles.set(task.id, filePaths);
        }
        this.handler.addTaskToSession(sessionId, task);
      }
    } catch (error) {
      logger.error('Error handling message:', error);
      await this.bot.sendMessage(chatId, '❌ 处理消息失败，请稍后重试。', 'text');
    }
  }

  private setupEventListeners(): void {
    this.executor.on(
      'task:session',
      ({ task, opencodeSessionId }: { task: TaskInfo; opencodeSessionId: string }) => {
        const bridgeSessionId = this.taskBridgeSession.get(task.id);
        if (!bridgeSessionId) {
          return;
        }
        this.opencodeSessionByBridgeSession.set(bridgeSessionId, opencodeSessionId);
      },
    );

    this.executor.on('task:queued', async ({ task }: { task: TaskInfo }) => {
      this.handler.updateTask(task);
      if (this.getTaskResponseMode(task.id, task.responseMode) === 'silent') {
        return;
      }
      await this.bot.sendMessage(task.chatId, `⏳ 任务排队中\n任务 ID：\`${task.id}\``, 'text');
    });

    this.executor.on('task:started', async ({ task }: { task: TaskInfo }) => {
      this.handler.updateTask(task);
      if (this.getTaskResponseMode(task.id, task.responseMode) === 'silent') {
        return;
      }
      this.lastUpdateTime.set(task.id, Date.now());
      const response = this.handler.handleTaskStart(task);
      if (response.text) {
        await this.bot.sendMessage(task.chatId, response.text, 'text');
      }
    });

    this.executor.on(
      'task:progress',
      async ({ task, progress }: { task: TaskInfo; progress: string }) => {
        if (this.getTaskResponseMode(task.id, task.responseMode) === 'silent') {
          return;
        }
        this.queueProgress(task.id, progress);
        await this.flushProgress(task, false);
      },
    );

    this.executor.on('task:completed', async ({ task }: { task: TaskInfo }) => {
      const mode = this.getTaskResponseMode(task.id, task.responseMode);
      if (mode === 'verbose') {
        await this.flushProgress(task, true);
      }
      this.cleanupProgressState(task.id);
      await this.cleanupTaskFiles(task.id);
      this.taskResponseMode.delete(task.id);
      this.taskBridgeSession.delete(task.id);
      this.handler.updateTask(task);
      const response = this.handler.handleTaskComplete(task, { mode });
      if (response.text) {
        await this.bot.sendMessage(task.chatId, response.text, 'text');
      }
    });

    this.executor.on('task:error', async ({ task, error }: { task: TaskInfo; error: Error }) => {
      const mode = this.getTaskResponseMode(task.id, task.responseMode);
      if (mode === 'verbose') {
        await this.flushProgress(task, true);
      }
      this.cleanupProgressState(task.id);
      await this.cleanupTaskFiles(task.id);
      this.taskResponseMode.delete(task.id);
      this.taskBridgeSession.delete(task.id);
      this.handler.updateTask(task);
      const response = this.handler.handleTaskError(task, error, { mode });
      if (response.text) {
        await this.bot.sendMessage(task.chatId, response.text, 'text');
      }
    });

    this.executor.on('task:cancelled', async ({ task, reason }: { task: TaskInfo; reason: string }) => {
      const mode = this.getTaskResponseMode(task.id, task.responseMode);
      if (mode === 'verbose') {
        await this.flushProgress(task, true);
      }
      this.cleanupProgressState(task.id);
      await this.cleanupTaskFiles(task.id);
      this.taskResponseMode.delete(task.id);
      this.taskBridgeSession.delete(task.id);
      this.handler.updateTask(task);
      logger.info(`Task ${task.id} cancelled: ${reason}`);
      const response = this.handler.handleTaskUpdate(task, { mode });
      if (response.text) {
        await this.bot.sendMessage(task.chatId, response.text, 'text');
      }
    });

    process.on('SIGINT', () => {
      this.stop().catch((error: unknown) => {
        logger.error('Error during SIGINT shutdown:', error);
      });
    });

    process.on('SIGTERM', () => {
      this.stop().catch((error: unknown) => {
        logger.error('Error during SIGTERM shutdown:', error);
      });
    });
  }

  private queueProgress(taskId: string, progress: string): void {
    const chunks = this.pendingProgress.get(taskId) || [];
    chunks.push(progress);
    this.pendingProgress.set(taskId, chunks);
  }

  private async flushProgress(task: TaskInfo, force: boolean): Promise<void> {
    const chunks = this.pendingProgress.get(task.id) || [];
    if (chunks.length === 0) {
      return;
    }

    if (!force && !this.shouldSendUpdate(task.id)) {
      return;
    }

    this.pendingProgress.set(task.id, []);
    const merged = chunks.join('');
    if (merged.trim().length === 0) {
      return;
    }

    const response = this.handler.handleTaskProgress(task, merged);
    if (!response.text) {
      return;
    }

    await this.bot.sendMessage(task.chatId, response.text, 'text');
    this.lastUpdateTime.set(task.id, Date.now());
  }

  private cleanupProgressState(taskId: string): void {
    this.pendingProgress.delete(taskId);
    this.lastUpdateTime.delete(taskId);
  }

  private shouldSendUpdate(taskId: string): boolean {
    const lastTime = this.lastUpdateTime.get(taskId) || 0;
    return Date.now() - lastTime >= this.STREAMING_INTERVAL;
  }

  private getTaskResponseMode(taskId: string, fallback?: TaskResponseMode): TaskResponseMode {
    return this.taskResponseMode.get(taskId) || fallback || 'verbose';
  }

  private async resolveResponseMode(
    intentHint: IntentHint,
    command: string,
    modelOverride?: string,
  ): Promise<TaskResponseMode> {
    if (intentHint === 'task') {
      return 'verbose';
    }

    if (intentHint === 'chat') {
      return 'silent';
    }

    if (!config.opencode.intentRoutingEnabled) {
      return 'verbose';
    }

    const routing = await this.executor.classifyIntent(command, modelOverride);
    logger.info(`Intent routing result: label=${routing.label}, confidence=${routing.confidence.toFixed(2)}`);

    if (routing.label === 'chat' && routing.confidence >= config.opencode.intentRoutingConfidence) {
      return 'silent';
    }

    return 'verbose';
  }

  private async handleModelCommand(
    chatId: string,
    sessionId: string,
    modelCommand: ModelCommandRequest,
  ): Promise<void> {
    if (modelCommand.action === 'list') {
      const models = this.executor.listModels();
      if (models.length === 0) {
        await this.bot.sendMessage(chatId, '⚠️ 未获取到模型列表。可直接使用 `/model <model_id>` 设置。', 'text');
        return;
      }

      const shown = models.slice(0, 30);
      const lines = shown.map((model, index) => `${index + 1}. ${model}`);
      const truncated = models.length > shown.length
        ? `\n... 还有 ${models.length - shown.length} 个模型`
        : '';
      await this.bot.sendMessage(
        chatId,
        `📚 可用模型（${models.length}）\n${lines.join('\n')}${truncated}`,
        'text',
      );
      return;
    }

    if (modelCommand.action === 'current') {
      const current = this.sessionModelByBridgeSession.get(sessionId);
      const defaultModel = config.opencode.model
        ? config.opencode.model
        : '自动检测（opencode models 第一项）';

      if (current) {
        await this.bot.sendMessage(chatId, `🎯 当前会话模型：\`${current}\``, 'text');
      } else {
        await this.bot.sendMessage(chatId, `🎯 当前会话模型：默认（${defaultModel}）`, 'text');
      }
      return;
    }

    if (modelCommand.action === 'reset') {
      this.sessionModelByBridgeSession.delete(sessionId);
      this.opencodeSessionByBridgeSession.delete(sessionId);

      const defaultModel = config.opencode.model
        ? config.opencode.model
        : '自动检测（opencode models 第一项）';
      await this.bot.sendMessage(
        chatId,
        `♻️ 已恢复默认模型：${defaultModel}\n已自动新开会话上下文。`,
        'text',
      );
      return;
    }

    const model = modelCommand.model?.trim();
    if (!model) {
      await this.bot.sendMessage(chatId, '用法：`/model <model_id>`，或 `/model list` 查看可用模型。', 'text');
      return;
    }

    const models = this.executor.listModels();
    if (models.length > 0 && !models.includes(model)) {
      const suggestions = models
        .filter(item => item.toLowerCase().includes(model.toLowerCase()))
        .slice(0, 5);
      const suggestText = suggestions.length > 0
        ? `\n你可能想用：\n${suggestions.map(item => `- ${item}`).join('\n')}`
        : '';

      await this.bot.sendMessage(
        chatId,
        `❌ 模型不存在：\`${model}\`\n请先用 \`/model list\` 选择可用模型。${suggestText}`,
        'text',
      );
      return;
    }

    this.sessionModelByBridgeSession.set(sessionId, model);
    this.opencodeSessionByBridgeSession.delete(sessionId);
    await this.bot.sendMessage(chatId, `✅ 已切换会话模型为：\`${model}\`\n已自动新开会话上下文。`, 'text');
  }

  private extractSenderId(event: FeishuMessageEvent): string {
    const sender = event.event?.sender?.sender_id;
    return sender?.user_id || sender?.open_id || sender?.union_id || 'unknown';
  }

  private findSessionId(userId: string, chatId: string): string {
    return `${userId}:${chatId}`;
  }

  private async handleIncomingFileMessage(event: FeishuMessageEvent, sessionId: string): Promise<void> {
    const message = event.event?.message;
    const chatId = message?.chat_id || '';
    if (!message?.message_id || !chatId) {
      return;
    }

    const { fileKey, fileName } = this.parseFileContent(message.content);
    if (!fileKey) {
      await this.bot.sendMessage(chatId, '❌ 收到文件消息，但未解析到 file_key。', 'text');
      return;
    }

    await mkdir(this.uploadStagingDir, { recursive: true });
    const sessionDir = join(this.uploadStagingDir, this.normalizePathSegment(sessionId));
    await mkdir(sessionDir, { recursive: true });

    const safeName = this.sanitizeFileName(fileName || `feishu_file_${Date.now()}`);
    const localPath = join(sessionDir, `${Date.now()}_${safeName}`);

    await this.bot.downloadMessageFile({
      messageId: message.message_id,
      fileKey,
      targetPath: localPath,
      resourceType: 'file',
    });

    this.addPendingFile(sessionId, localPath);
    await this.bot.sendMessage(
      chatId,
      `📎 已接收文件：\`${safeName}\`\n请继续发送任务指令，我会将该文件传给 opencode。`,
      'text',
    );
  }

  private parseFileContent(rawContent: string): { fileKey?: string; fileName?: string } {
    try {
      const parsed = JSON.parse(rawContent) as Record<string, unknown>;
      const fileKey = this.asString(parsed.file_key) || this.asString(parsed.fileKey);
      const fileName = this.asString(parsed.file_name) || this.asString(parsed.fileName);
      return { fileKey, fileName };
    } catch {
      return {};
    }
  }

  private addPendingFile(sessionId: string, localPath: string): void {
    const files = this.pendingFilesBySession.get(sessionId) || [];
    files.push(localPath);

    while (files.length > this.MAX_PENDING_FILES) {
      const removed = files.shift();
      if (removed) {
        void rm(removed, { force: true });
      }
    }

    this.pendingFilesBySession.set(sessionId, files);
  }

  private consumePendingFiles(sessionId: string): string[] {
    const files = this.pendingFilesBySession.get(sessionId) || [];
    this.pendingFilesBySession.delete(sessionId);
    return files;
  }

  private async resetBridgeSession(sessionId: string): Promise<void> {
    this.opencodeSessionByBridgeSession.delete(sessionId);
    const pendingFiles = this.pendingFilesBySession.get(sessionId) || [];
    this.pendingFilesBySession.delete(sessionId);

    await Promise.all(pendingFiles.map(async (filePath) => {
      try {
        await rm(filePath, { force: true });
      } catch (error) {
        logger.warn(`Failed to cleanup pending file ${filePath}`, error);
      }
    }));
  }

  private async cleanupTaskFiles(taskId: string): Promise<void> {
    const files = this.taskAttachedFiles.get(taskId);
    if (!files || files.length === 0) {
      return;
    }

    this.taskAttachedFiles.delete(taskId);
    await Promise.all(files.map(async (filePath) => {
      try {
        await rm(filePath, { force: true });
      } catch (error) {
        logger.warn(`Failed to cleanup temp file ${filePath}`, error);
      }
    }));
  }

  private async handleSendFileCommand(chatId: string, filePathInput: string): Promise<void> {
    const resolvedPath = this.resolveFilePath(filePathInput);
    await access(resolvedPath, fsConstants.R_OK);
    await this.bot.sendFile(chatId, resolvedPath);
    await this.bot.sendMessage(chatId, `✅ 文件已发送：\`${basename(resolvedPath)}\``, 'text');
  }

  private resolveFilePath(inputPath: string): string {
    if (isAbsolute(inputPath)) {
      return inputPath;
    }
    return resolve(config.opencode.workingDir, inputPath);
  }

  private sanitizeFileName(fileName: string): string {
    const normalized = basename(fileName).replace(/[^\w.\-]/g, '_');
    return normalized || `file_${Date.now()}`;
  }

  private normalizePathSegment(value: string): string {
    const segment = value.replace(/[^a-zA-Z0-9_-]/g, '_');
    return segment || 'session';
  }

  private asString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    return undefined;
  }

  async stop(): Promise<void> {
    if (this.isStopping) {
      return;
    }
    this.isStopping = true;

    logger.info('Shutting down bridge...');

    this.executor.cleanup();
    await this.bot.stop();

    logger.info('Bridge stopped');
    process.exit(0);
  }
}

const bridge = new OpenCodeFeishuBridge();
bridge.start().catch((error: unknown) => {
  logger.error('Failed to start bridge:', error);
  process.exit(1);
});
