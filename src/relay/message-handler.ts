import { config } from '../config.js';
import type {
  BotResponse,
  FeishuMessageEvent,
  IntentHint,
  ModelCommandRequest,
  SessionInfo,
  TaskInfo,
  TaskResponseMode,
} from '../types.js';

export class MessageHandler {
  private sessions: Map<string, SessionInfo> = new Map();
  private taskSessionIndex: Map<string, string> = new Map();
  private readonly MAX_HISTORY = Math.max(1, config.session.maxHistory || 10);

  async handleMessage(event: FeishuMessageEvent): Promise<BotResponse | null> {
    const message = event.event?.message;
    if (!message) {
      return null;
    }

    const senderId = this.extractSenderId(event);
    const chatId = message.chat_id || '';
    if (!senderId || !chatId) {
      return null;
    }

    const chatType = message.chat_type === 'p2p' ? 'p2p' : 'group';
    const content = this.parseMessageContent(event);
    const extracted = this.extractCommand(content, message.mentions || [], chatType);
    if (!extracted) {
      return null;
    }

    const sessionId = this.findSessionId(senderId, chatId);
    const session = this.getOrCreateSession(sessionId, senderId, chatId);
    session.lastActivityAt = new Date();

    const builtin = extracted.startsWith('!') ? extracted.toLowerCase() : '';
    if (builtin.startsWith('!sendfile')) {
      return this.handleSendFile(extracted);
    }
    if (builtin === '!help' || builtin === '!h') {
      return this.handleHelp();
    }
    if (builtin === '!status' || builtin === '!s') {
      return this.handleStatus();
    }
    if (builtin === '!history' || builtin === '!hist') {
      return this.handleHistory(session);
    }
    if (builtin === '!clear' || builtin === '!c') {
      return this.handleClear(session);
    }

    const sessionReset = this.extractSessionResetIntent(extracted);
    if (sessionReset.shouldReset) {
      if (sessionReset.command) {
        return {
          text: '🆕 已切换到新会话，开始执行新任务。',
          resetSession: true,
          executeCommand: sessionReset.command,
          intentHint: this.inferIntentHint(sessionReset.command),
        };
      }

      return {
        text: '🆕 已新开会话。请发送下一条任务。',
        resetSession: true,
      };
    }

    const modelCommand = this.extractModelCommand(extracted);
    if (modelCommand) {
      return { modelCommand };
    }

    const executeCommand = extracted.startsWith('!')
      ? extracted.substring(1).trim()
      : extracted.trim();

    if (!executeCommand) {
      return {
        text: '请输入要执行的任务，例如：`@机器人 帮我修复这个报错`',
      };
    }

    return {
      executeCommand,
      intentHint: this.inferIntentHint(executeCommand),
    };
  }

  handleTaskStart(task: TaskInfo): BotResponse {
    this.updateTask(task);
    return {
      text: `🚀 任务已开始\n任务 ID：\`${task.id}\``,
    };
  }

  handleTaskProgress(task: TaskInfo, progress: string): BotResponse {
    this.updateTask(task);
    const compact = this.normalizeOutput(progress);
    const truncatedOutput = compact.length > 500
      ? `${compact.substring(0, 500)}...`
      : compact;

    return {
      text: `📝 执行中\n${truncatedOutput || '(处理中...)'}`,
    };
  }

  handleTaskComplete(task: TaskInfo, options?: { mode?: TaskResponseMode }): BotResponse {
    this.updateTask(task);
    const output = this.normalizeOutput(task.output.join(''));
    const mode = options?.mode || 'verbose';

    if (mode === 'silent') {
      const compactText = output.length > 1800 ? `${output.substring(0, 1800)}...` : output;
      return {
        text: compactText || '（无回复）',
      };
    }

    const truncated = output.length > 1200 ? output.substring(output.length - 1200) : output;
    const duration = task.duration ? `（${(task.duration / 1000).toFixed(2)}s）` : '';

    return {
      text: `✅ 任务完成${duration}\n任务 ID：\`${task.id}\`\n\`\`\`\n${truncated || '(无输出)'}\n\`\`\``,
    };
  }

  handleTaskError(task: TaskInfo, error: Error, options?: { mode?: TaskResponseMode }): BotResponse {
    this.updateTask(task);
    const mode = options?.mode || 'verbose';
    if (mode === 'silent') {
      return {
        text: `❌ ${error.message}`,
      };
    }
    return {
      text: `❌ 任务失败\n任务 ID：\`${task.id}\`\n原因：${error.message}`,
    };
  }

  handleTaskUpdate(task: TaskInfo, options?: { mode?: TaskResponseMode }): BotResponse {
    this.updateTask(task);
    const mode = options?.mode || 'verbose';
    if (mode === 'silent') {
      return {
        text: `⚠️ 状态：${task.status}`,
      };
    }
    return {
      text: `任务 \`${task.id}\` 状态：${task.status}`,
    };
  }

  addTaskToSession(sessionId: string, task: TaskInfo): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const existingIndex = session.taskHistory.findIndex(item => item.id === task.id);
    if (existingIndex >= 0) {
      session.taskHistory[existingIndex] = task;
    } else {
      session.taskHistory.push(task);
    }

    if (session.taskHistory.length > this.MAX_HISTORY) {
      session.taskHistory = session.taskHistory.slice(-this.MAX_HISTORY);
    }

    this.taskSessionIndex.set(task.id, sessionId);
    session.lastActivityAt = new Date();
  }

  updateTask(task: TaskInfo): void {
    const sessionId = this.taskSessionIndex.get(task.id);
    if (!sessionId) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const existingIndex = session.taskHistory.findIndex(item => item.id === task.id);
    if (existingIndex >= 0) {
      session.taskHistory[existingIndex] = task;
    } else {
      session.taskHistory.push(task);
      if (session.taskHistory.length > this.MAX_HISTORY) {
        session.taskHistory = session.taskHistory.slice(-this.MAX_HISTORY);
      }
    }
  }

  private extractSenderId(event: FeishuMessageEvent): string {
    const sender = event.event?.sender?.sender_id;
    return sender?.user_id || sender?.open_id || sender?.union_id || '';
  }

  private parseMessageContent(event: FeishuMessageEvent): string {
    const message = event.event?.message;
    if (!message) {
      return '';
    }

    try {
      const content = typeof message.content === 'string'
        ? JSON.parse(message.content)
        : message.content;
      if (typeof content === 'object' && content && 'text' in content) {
        const text = (content as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    } catch {
      return message.content || '';
    }
  }

  private extractCommand(
    content: string,
    mentions: Array<{ key: string }>,
    chatType: 'p2p' | 'group',
  ): string | null {
    let text = content.trim();
    if (!text) {
      return null;
    }

    const hasMention = mentions.length > 0
      || /<at\b[^>]*>.*?<\/at>/i.test(text)
      || /@(?:opencode|bot|机器人)/i.test(text);

    if (chatType === 'group' && config.security.requireMention && !hasMention) {
      return null;
    }

    text = text.replace(/<at\b[^>]*>.*?<\/at>/gi, ' ');
    for (const mention of mentions) {
      if (mention.key) {
        text = text.split(mention.key).join(' ');
      }
    }
    text = text.replace(/@(?:opencode|bot|机器人)/gi, ' ');
    text = text.replace(/\s+/g, ' ').trim();

    if (!text) {
      return null;
    }

    if (text.startsWith('!')) {
      return text;
    }

    const prefixed = text.match(/^\/?(?:opencode|oc)\s+(.+)$/i);
    if (prefixed?.[1]) {
      return `!${prefixed[1].trim()}`;
    }

    return text;
  }

  private handleHelp(): BotResponse {
    return {
      text: [
        '📖 指令帮助',
        '• `!help` / `!h` 查看帮助',
        '• `!status` / `!s` 查看系统状态',
        '• `!history` / `!hist` 查看历史任务',
        '• `!clear` / `!c` 清空会话历史',
        '• `/new` 或 `!new` 新开会话',
        '• `/model list|current|reset|<model>` 切换会话模型',
        '• `!sendfile <path>` 发送本地文件到当前会话',
        '• 直接发任务文本（群聊请 @机器人）',
      ].join('\n'),
    };
  }

  private handleSendFile(rawCommand: string): BotResponse {
    const pathArg = rawCommand.replace(/^!sendfile\s*/i, '').trim();
    if (!pathArg) {
      return {
        text: '用法：`!sendfile <本地文件路径>`',
      };
    }

    const normalizedPath = this.trimSurroundingQuotes(pathArg);

    return {
      text: `📤 准备发送文件：\`${normalizedPath}\``,
      sendFilePath: normalizedPath,
    };
  }

  private trimSurroundingQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.substring(1, value.length - 1);
    }
    return value;
  }

  private extractSessionResetIntent(input: string): { shouldReset: boolean; command?: string } {
    const text = input.trim();
    if (!text) {
      return { shouldReset: false };
    }

    const explicitOnly = /^[/!]new(?:\s+session)?$/i;
    if (explicitOnly.test(text)) {
      return { shouldReset: true };
    }

    const explicitWithCommand = text.match(/^[/!]new(?:\s+session)?\s+(.+)$/i);
    if (explicitWithCommand?.[1]) {
      return { shouldReset: true, command: explicitWithCommand[1].trim() };
    }

    const naturalPattern = /(新开|新建|重新开|重新开始|重置)\s*(一个|一下|本次|当前)?\s*(session|会话|上下文)/i;
    if (!naturalPattern.test(text)) {
      return { shouldReset: false };
    }

    const remainder = text
      .replace(naturalPattern, ' ')
      .replace(/^[，,。.!！？:：;；\s-]+/, '')
      .trim();

    if (!remainder) {
      return { shouldReset: true };
    }

    return { shouldReset: true, command: remainder };
  }

  private extractModelCommand(input: string): ModelCommandRequest | null {
    const text = input.trim();
    if (!text) {
      return null;
    }

    const match = text.match(/^[/!]model(?:\s+(.+))?$/i);
    if (!match) {
      return null;
    }

    const arg = (match[1] || '').trim();
    if (!arg || /^current$/i.test(arg)) {
      return { action: 'current' };
    }

    if (/^list$/i.test(arg)) {
      return { action: 'list' };
    }

    if (/^reset$/i.test(arg)) {
      return { action: 'reset' };
    }

    return { action: 'set', model: arg };
  }

  private inferIntentHint(command: string): IntentHint {
    const text = command.trim();
    if (!text) {
      return 'ambiguous';
    }

    if (this.looksLikeTask(text)) {
      return 'task';
    }

    if (this.looksLikeChat(text)) {
      return 'chat';
    }

    return 'ambiguous';
  }

  private looksLikeTask(text: string): boolean {
    if (text.length >= 90) {
      return true;
    }

    if (text.includes('\n')) {
      return true;
    }

    const structuralTaskPattern = /```|`[^`]+`|\/[\w.\-]+|\.[a-z0-9]{1,6}\b/i;
    if (structuralTaskPattern.test(text)) {
      return true;
    }

    const taskKeywordPattern = /(修复|实现|编写|写一个|创建|生成|搜索|查找|分析|总结|整理|翻译|运行|执行|部署|安装|调试|测试|重构|报错|错误|异常|review|fix|implement|create|generate|search|analy[sz]e|summari[sz]e|refactor|write|run|execute|deploy|install|debug|test|command|script|file|bug|issue)/i;
    if (taskKeywordPattern.test(text)) {
      return true;
    }

    if (/^(请|帮我|麻烦|给我)/.test(text) && text.length > 20) {
      return true;
    }

    return false;
  }

  private looksLikeChat(text: string): boolean {
    const normalized = text.trim();
    const shortText = normalized.length <= 50;

    const chatGreetingPattern = /^(在吗|在线吗|你在吗|你好|嗨|hello|hi|hey|早上好|晚上好|午安|谢谢|感谢|收到|ok|好的|辛苦了)[!?？。！\s]*$/i;
    if (chatGreetingPattern.test(normalized)) {
      return true;
    }

    const chatQuestionPattern = /(你是谁|你叫什么|你会什么|你能做什么|当前(使用)?模型|用的.*模型|什么模型|哪个模型|状态如何|status|health|还在吗|忙吗|你在吗|在线吗|在吗|在不在|在嘛)/i;
    if (shortText && chatQuestionPattern.test(normalized)) {
      return true;
    }

    const smallTalkMixedPattern = /(hello|hi|hey|你好|嗨|哈喽|在吗|在线吗|你在吗|在不在|忙吗|在嘛)/i;
    const explicitTaskPattern = /(修复|实现|编写|创建|生成|搜索|查找|分析|运行|执行|部署|安装|调试|测试|报错|错误|异常|代码|文件|命令|fix|implement|create|generate|search|run|execute|debug|test|file|command|bug|issue)/i;
    if (shortText && smallTalkMixedPattern.test(normalized) && !explicitTaskPattern.test(normalized)) {
      return true;
    }

    if (shortText && /[?？]$/.test(normalized) && !this.looksLikeTask(normalized)) {
      return true;
    }

    return false;
  }

  private normalizeOutput(output: string): string {
    const withoutAnsi = output
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');

    return withoutAnsi
      .split(/\r?\n/)
      .map(line => line.trimEnd())
      .filter(line => line.trim().length > 0)
      .join('\n')
      .trim();
  }

  private handleStatus(): BotResponse {
    return {
      text: [
        '✅ 系统状态：正常',
        `• 活跃会话：${this.sessions.size}`,
        `• 内存占用：${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      ].join('\n'),
    };
  }

  private handleHistory(session: SessionInfo): BotResponse {
    const recentTasks = session.taskHistory.slice(-5);
    if (recentTasks.length === 0) {
      return { text: '暂无历史任务。' };
    }

    const history = recentTasks.map((task) => {
      const statusEmoji = task.status === 'completed'
        ? '✅'
        : task.status === 'failed'
          ? '❌'
          : task.status === 'cancelled'
            ? '⏹️'
            : '⏳';
      return `${statusEmoji} \`${task.command}\`（${task.status}）`;
    }).join('\n');

    return {
      text: `📜 最近任务：\n${history}`,
    };
  }

  private handleClear(session: SessionInfo): BotResponse {
    session.taskHistory = [];
    session.context = {};
    return { text: '🗑️ 会话历史已清空。' };
  }

  private findSessionId(userId: string, chatId: string): string {
    return `${userId}:${chatId}`;
  }

  private getOrCreateSession(id: string, userId: string, chatId: string): SessionInfo {
    const existing = this.sessions.get(id);
    if (existing) {
      return existing;
    }

    const session: SessionInfo = {
      id,
      userId,
      chatId,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      taskHistory: [],
      context: {},
    };
    this.sessions.set(id, session);
    return session;
  }
}
