import { FeishuBot } from './bot/feishu-bot.js';
import { config } from './config.js';
import { OpencodeExecutor } from './executor/opencode-executor.js';
import { MessageHandler } from './relay/message-handler.js';
import type {
  BotResponse,
  FeishuMessageEvent,
  IntentHint,
  ModelCommandRequest,
  NotificationMode,
  NotifyCommandRequest,
  TaskInfo,
  TaskResponseMode,
} from './types.js';
import { logger } from './utils/logger.js';
import { constants as fsConstants } from 'fs';
import { access, mkdir, rm } from 'fs/promises';
import { basename, isAbsolute, join, resolve } from 'path';

export class OpenCodeFeishuBridge {
  private bot: FeishuBot;
  private executor: OpencodeExecutor;
  private handler: MessageHandler;
  private readonly DEBUG_PROGRESS_INTERVAL = config.opencode.streamingInterval;
  private readonly NORMAL_PROGRESS_INTERVAL = Math.max(
    config.opencode.streamingInterval,
    config.opencode.normalProgressInterval,
  );
  private readonly DEFAULT_NOTIFY_MODE = config.opencode.notifyDefaultMode;
  private readonly uploadStagingDir = join(config.opencode.workingDir, '.feishu_uploads');
  private readonly MAX_PENDING_FILES = 5;
  private readonly MAX_RESULT_IMAGES = 3;
  private readonly MAX_TEXT_CHUNK_LENGTH = 2800;
  private pendingProgress = new Map<string, string[]>();
  private pendingFilesBySession = new Map<string, string[]>();
  private taskAttachedFiles = new Map<string, string[]>();
  private taskResponseMode = new Map<string, TaskResponseMode>();
  private sessionNotifyMode = new Map<string, NotificationMode>();
  private sessionModelByBridgeSession = new Map<string, string>();
  private lastKnownModelByBridgeSession = new Map<string, string>();
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

      await this.sendBotResponse(chatId, response);

      if (response.resetSession) {
        await this.resetBridgeSession(sessionId);
      }

      if (response.modelCommand) {
        await this.handleModelCommand(chatId, sessionId, response.modelCommand);
        return;
      }

      if (response.notifyCommand) {
        await this.handleNotifyCommand(chatId, sessionId, response.notifyCommand);
        return;
      }

      if (response.sendFilePath) {
        await this.handleSendFileCommand(chatId, response.sendFilePath);
        return;
      }

      if (response.executeCommand) {
        const filePaths = this.consumePendingFiles(sessionId);
        let responseMode: TaskResponseMode = this.getSessionTaskMode(sessionId);
        const modelOverride = this.resolvePreferredModelForSession(sessionId);

        if (filePaths.length > 0) {
          const fileNames = filePaths.map(filePath => basename(filePath)).join(', ');
          await this.bot.sendMessage(chatId, `📎 已附带文件：${fileNames}`, 'text');
        } else {
          const hint = response.intentHint || 'task';
          responseMode = await this.resolveResponseMode(sessionId, hint, response.executeCommand, modelOverride);
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
      const mode = this.getTaskResponseMode(task.id, task.responseMode);
      this.handler.updateTask(task);
      if (mode === 'silent') {
        return;
      }
      this.lastUpdateTime.set(task.id, Date.now());
      const response = this.handler.handleTaskStart(task);
      await this.sendBotResponse(task.chatId, response);
    });

    this.executor.on(
      'task:progress',
      async ({ task, progress }: { task: TaskInfo; progress: string }) => {
        const mode = this.getTaskResponseMode(task.id, task.responseMode);
        if (mode === 'silent' || mode === 'quiet') {
          return;
        }
        this.queueProgress(task.id, progress, mode);
        await this.flushProgress(task, false, mode);
      },
    );

    this.executor.on('task:completed', async ({ task }: { task: TaskInfo }) => {
      const mode = this.getTaskResponseMode(task.id, task.responseMode);
      if (mode === 'normal' || mode === 'debug') {
        await this.flushProgress(task, true, mode);
      }
      this.cleanupProgressState(task.id);
      await this.cleanupTaskFiles(task.id);
      this.taskResponseMode.delete(task.id);
      this.rememberTaskModel(task);
      this.taskBridgeSession.delete(task.id);
      this.handler.updateTask(task);
      const response = this.handler.handleTaskComplete(task, { mode });
      await this.sendBotResponse(task.chatId, response);

      const images = this.extractImagesFromOutput(task.output.join(''));
      if (images.length > 0) {
        await this.bot.sendMessage(task.chatId, `🖼️ 附带参考图片（${images.length} 张）`, 'text');
      }
      for (const image of images) {
        try {
          await this.bot.sendImage(task.chatId, image);
        } catch (error) {
          logger.warn(`Failed to send image ${image}`, error);
        }
      }
    });

    this.executor.on('task:error', async ({ task, error }: { task: TaskInfo; error: Error }) => {
      const mode = this.getTaskResponseMode(task.id, task.responseMode);
      if (mode === 'normal' || mode === 'debug') {
        await this.flushProgress(task, true, mode);
      }
      this.cleanupProgressState(task.id);
      await this.cleanupTaskFiles(task.id);
      this.taskResponseMode.delete(task.id);
      this.rememberTaskModel(task);
      this.taskBridgeSession.delete(task.id);
      this.handler.updateTask(task);
      const response = this.handler.handleTaskError(task, error, { mode });
      await this.sendBotResponse(task.chatId, response);
    });

    this.executor.on('task:cancelled', async ({ task, reason }: { task: TaskInfo; reason: string }) => {
      const mode = this.getTaskResponseMode(task.id, task.responseMode);
      if (mode === 'normal' || mode === 'debug') {
        await this.flushProgress(task, true, mode);
      }
      this.cleanupProgressState(task.id);
      await this.cleanupTaskFiles(task.id);
      this.taskResponseMode.delete(task.id);
      this.rememberTaskModel(task);
      this.taskBridgeSession.delete(task.id);
      this.handler.updateTask(task);
      logger.info(`Task ${task.id} cancelled: ${reason}`);
      const response = this.handler.handleTaskUpdate(task, { mode, reason });
      await this.sendBotResponse(task.chatId, response);
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

  private queueProgress(taskId: string, progress: string, mode: TaskResponseMode): void {
    const chunks = this.pendingProgress.get(taskId) || [];

    const lines = progress
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (mode === 'normal' && this.isLowValueProgress(line)) {
        continue;
      }
      if (!chunks.includes(line)) {
        chunks.push(line);
      }
    }

    while (chunks.length > 12) {
      chunks.shift();
    }

    this.pendingProgress.set(taskId, chunks);
  }

  private async flushProgress(task: TaskInfo, force: boolean, mode: TaskResponseMode): Promise<void> {
    const chunks = this.pendingProgress.get(task.id) || [];
    if (chunks.length === 0) {
      return;
    }

    if (!force && !this.shouldSendUpdate(task.id, mode)) {
      return;
    }

    this.pendingProgress.set(task.id, []);
    const merged = chunks.join('\n');
    if (merged.trim().length === 0) {
      return;
    }

    const response = this.handler.handleTaskProgress(task, merged);
    if (!response.text && !response.card) {
      return;
    }

    await this.sendBotResponse(task.chatId, response);
    this.lastUpdateTime.set(task.id, Date.now());
  }

  private async sendBotResponse(chatId: string, response: BotResponse): Promise<void> {
    let cardSent = false;

    if (response.card) {
      try {
        await this.bot.sendMessage(chatId, JSON.stringify(response.card), 'interactive');
        cardSent = true;
      } catch (error) {
        logger.warn('Failed to send interactive card, fallback to text', error);
      }
    }

    if (cardSent) {
      if (response.followupText && response.followupText.trim().length > 0) {
        await this.sendTextInChunks(chatId, response.followupText);
      }
      return;
    }

    if (response.text && response.text.trim().length > 0) {
      await this.sendTextInChunks(chatId, response.text);
      return;
    }

    if (response.followupText && response.followupText.trim().length > 0) {
      await this.sendTextInChunks(chatId, response.followupText);
    }
  }

  private async sendTextInChunks(chatId: string, text: string): Promise<void> {
    const chunks = this.splitTextIntoChunks(text, this.MAX_TEXT_CHUNK_LENGTH);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }
      if (chunks.length === 1) {
        await this.bot.sendMessage(chatId, chunk, 'text');
      } else {
        await this.bot.sendMessage(chatId, `（${index + 1}/${chunks.length}）\n${chunk}`, 'text');
      }
    }
  }

  private splitTextIntoChunks(text: string, maxLength: number): string[] {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) {
      return [];
    }

    if (normalized.length <= maxLength) {
      return [normalized];
    }

    const chunks: string[] = [];
    const lines = normalized.split('\n');
    let current = '';

    const pushCurrent = (): void => {
      const candidate = current.trim();
      if (candidate) {
        chunks.push(candidate);
      }
      current = '';
    };

    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length <= maxLength) {
        current = candidate;
        continue;
      }

      if (current) {
        pushCurrent();
      }

      if (line.length <= maxLength) {
        current = line;
        continue;
      }

      let start = 0;
      while (start < line.length) {
        chunks.push(line.slice(start, start + maxLength));
        start += maxLength;
      }
    }

    if (current) {
      pushCurrent();
    }

    return chunks;
  }

  private cleanupProgressState(taskId: string): void {
    this.pendingProgress.delete(taskId);
    this.lastUpdateTime.delete(taskId);
  }

  private shouldSendUpdate(taskId: string, mode: TaskResponseMode): boolean {
    if (mode === 'silent' || mode === 'quiet') {
      return false;
    }

    const lastTime = this.lastUpdateTime.get(taskId) || 0;
    const interval = mode === 'debug' ? this.DEBUG_PROGRESS_INTERVAL : this.NORMAL_PROGRESS_INTERVAL;
    return Date.now() - lastTime >= interval;
  }

  private isLowValueProgress(line: string): boolean {
    return /(阶段执行完成|工具步骤完成|分析完成，正在整理结果|正在处理步骤)/.test(line);
  }

  private getSessionTaskMode(sessionId: string): NotificationMode {
    return this.sessionNotifyMode.get(sessionId) || this.DEFAULT_NOTIFY_MODE;
  }

  private resolvePreferredModelForSession(sessionId: string): string | undefined {
    return this.sessionModelByBridgeSession.get(sessionId) || this.lastKnownModelByBridgeSession.get(sessionId);
  }

  private rememberTaskModel(task: TaskInfo): void {
    if (!task.model) {
      return;
    }

    const bridgeSessionId = this.taskBridgeSession.get(task.id);
    if (!bridgeSessionId) {
      return;
    }

    this.lastKnownModelByBridgeSession.set(bridgeSessionId, task.model);
  }

  private extractImagesFromOutput(rawOutput: string): string[] {
    const sources: string[] = [];

    const markdownImageRegex = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi;
    let markdownMatch = markdownImageRegex.exec(rawOutput);
    while (markdownMatch) {
      const url = markdownMatch[1];
      if (url) {
        sources.push(url);
      }
      markdownMatch = markdownImageRegex.exec(rawOutput);
    }

    const directUrlRegex = /(https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|webp|gif|bmp|tiff|ico)(?:\?[^\s)"'<>]*)?)/gi;
    let directMatch = directUrlRegex.exec(rawOutput);
    while (directMatch) {
      const url = directMatch[1];
      if (url) {
        sources.push(url);
      }
      directMatch = directUrlRegex.exec(rawOutput);
    }

    const unique: string[] = [];
    for (const source of sources) {
      if (!unique.includes(source)) {
        unique.push(source);
      }
      if (unique.length >= this.MAX_RESULT_IMAGES) {
        break;
      }
    }

    return unique;
  }

  private getTaskResponseMode(taskId: string, fallback?: TaskResponseMode): TaskResponseMode {
    return this.taskResponseMode.get(taskId) || fallback || this.DEFAULT_NOTIFY_MODE;
  }

  private async resolveResponseMode(
    sessionId: string,
    intentHint: IntentHint,
    command: string,
    modelOverride?: string,
  ): Promise<TaskResponseMode> {
    const defaultMode = this.getSessionTaskMode(sessionId);

    if (intentHint === 'task') {
      return defaultMode;
    }

    if (intentHint === 'chat') {
      return 'silent';
    }

    if (!config.opencode.intentRoutingEnabled) {
      return defaultMode;
    }

    const routing = await this.executor.classifyIntent(command, modelOverride);
    logger.info(`Intent routing result: label=${routing.label}, confidence=${routing.confidence.toFixed(2)}`);

    if (routing.label === 'chat' && routing.confidence >= config.opencode.intentRoutingConfidence) {
      return 'silent';
    }

    return defaultMode;
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
      const current = this.resolvePreferredModelForSession(sessionId);
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
      this.lastKnownModelByBridgeSession.delete(sessionId);
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
    this.lastKnownModelByBridgeSession.set(sessionId, model);
    this.opencodeSessionByBridgeSession.delete(sessionId);
    await this.bot.sendMessage(chatId, `✅ 已切换会话模型为：\`${model}\`\n已自动新开会话上下文。`, 'text');
  }

  private async handleNotifyCommand(
    chatId: string,
    sessionId: string,
    notifyCommand: NotifyCommandRequest,
  ): Promise<void> {
    const defaultMode = this.DEFAULT_NOTIFY_MODE;

    if (notifyCommand.action === 'current') {
      const current = this.getSessionTaskMode(sessionId);
      await this.bot.sendMessage(
        chatId,
        `🔔 当前推送模式：\`${current}\`\n${this.describeNotifyMode(current)}\n默认模式：\`${defaultMode}\``,
        'text',
      );
      return;
    }

    const mode = notifyCommand.mode;
    if (!mode) {
      await this.bot.sendMessage(chatId, '用法：`/notify quiet|normal|debug` 或 `/notify current`', 'text');
      return;
    }

    this.sessionNotifyMode.set(sessionId, mode);
    await this.bot.sendMessage(chatId, `✅ 已切换推送模式为：\`${mode}\`\n${this.describeNotifyMode(mode)}`, 'text');
  }

  private describeNotifyMode(mode: NotificationMode): string {
    if (mode === 'quiet') {
      return '开始 + 最终结果，执行中不推送。';
    }
    if (mode === 'normal') {
      return '低频里程碑推送，自动过滤重复/低价值状态。';
    }
    return '详细推送（调试模式）。';
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
