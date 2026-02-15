import { config } from '../config.js';
import type {
  BotResponse,
  FeishuMessageEvent,
  IntentHint,
  ModelCommandRequest,
  NotificationMode,
  NotifyCommandRequest,
  SessionInfo,
  TaskInfo,
  TaskResponseMode,
} from '../types.js';

export class MessageHandler {
  private readonly SESSION_EXECUTE_FIRST_KEY = 'executeFirst';
  private sessions: Map<string, SessionInfo> = new Map();
  private taskSessionIndex: Map<string, string> = new Map();
  private readonly MAX_HISTORY = Math.max(1, config.session.maxHistory || 10);
  private readonly SILENT_CARD_MIN_LENGTH = 260;
  private readonly CARD_DETAIL_MAX_LENGTH = 2400;
  private readonly CARD_HIGHLIGHT_MAX_COUNT = 5;
  private readonly CONCISE_MAX_LENGTH = 900;
  private readonly CONCISE_MAX_LINES = 6;

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
          executeFirst: this.getSessionExecuteFirst(session),
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

    const notifyCommand = this.extractNotifyCommand(extracted);
    if (notifyCommand) {
      return { notifyCommand };
    }

    const agentPreferenceResponse = this.handleAgentPreferenceCommand(session, extracted);
    if (agentPreferenceResponse) {
      return agentPreferenceResponse;
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
      executeFirst: this.getSessionExecuteFirst(session),
      intentHint: this.inferIntentHint(executeCommand),
    };
  }

  handleTaskStart(task: TaskInfo): BotResponse {
    this.updateTask(task);
    return {
      text: '🚀 任务已开始',
    };
  }

  handleTaskProgress(task: TaskInfo, progress: string): BotResponse {
    this.updateTask(task);
    const compact = this.normalizeOutput(progress);
    const lines = compact
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const uniqueLines: string[] = [];

    for (const line of lines) {
      if (!uniqueLines.includes(line)) {
        uniqueLines.push(line);
      }
    }

    const displayLines = uniqueLines.slice(-4);
    const body = displayLines.length > 0
      ? displayLines.map(line => `• ${line}`).join('\n')
      : '• 正在处理...';

    return {
      text: `📝 执行进度\n${body}`,
    };
  }

  handleTaskComplete(task: TaskInfo, options?: { mode?: TaskResponseMode }): BotResponse {
    this.updateTask(task);
    const rawOutput = task.output.join('');
    const detailed = this.shouldReturnDetailedResult(task.command);
    const output = this.formatFinalOutput(rawOutput, detailed);
    const mode = options?.mode || 'debug';
    const fallbackText = this.buildCompletionFallbackText(task, output, mode);
    const shouldUseCard = this.shouldUseCompletionCard(mode, output);
    const card = shouldUseCard ? this.buildCompletionCard(task, output, mode) : undefined;
    const followupText = shouldUseCard ? this.buildCardFollowupText(output) : undefined;

    return {
      text: fallbackText,
      card,
      followupText,
    };
  }

  handleTaskError(task: TaskInfo, error: Error, options?: { mode?: TaskResponseMode }): BotResponse {
    this.updateTask(task);
    const mode = options?.mode || 'debug';
    if (mode === 'silent') {
      return {
        text: `❌ ${error.message}`,
      };
    }
    return {
      text: `❌ 任务失败\n原因：${error.message}`,
    };
  }

  handleTaskUpdate(task: TaskInfo, options?: { mode?: TaskResponseMode; reason?: string }): BotResponse {
    this.updateTask(task);
    const mode = options?.mode || 'debug';
    const reasonText = options?.reason ? this.formatCancelReason(options.reason) : '';

    if (mode === 'silent') {
      return {
        text: reasonText
          ? `⚠️ 状态：${task.status}（${reasonText}）`
          : `⚠️ 状态：${task.status}`,
      };
    }

    return {
      text: reasonText
        ? `⚠️ 任务状态：${task.status}\n原因：${reasonText}`
        : `⚠️ 任务状态：${task.status}`,
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
        '• `/notify current|quiet|normal|debug` 设置推送模式',
        '• `/agent current|execute|guide` 设置“代执行优先”偏好',
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

  private extractNotifyCommand(input: string): NotifyCommandRequest | null {
    const text = input.trim();
    if (!text) {
      return null;
    }

    const match = text.match(/^[/!]notify(?:\s+(.+))?$/i);
    if (!match) {
      return null;
    }

    const arg = (match[1] || '').trim().toLowerCase();
    if (!arg || arg === 'current') {
      return { action: 'current' };
    }

    if (arg === 'quiet' || arg === 'normal' || arg === 'debug') {
      return { action: 'set', mode: arg as NotificationMode };
    }

    return { action: 'set' };
  }

  private handleAgentPreferenceCommand(session: SessionInfo, input: string): BotResponse | null {
    const text = input.trim();
    if (!text) {
      return null;
    }

    const match = text.match(/^[/!]agent(?:\s+(.+))?$/i);
    if (!match) {
      return null;
    }

    const arg = (match[1] || '').trim().toLowerCase();
    if (!arg || arg === 'current') {
      const current = this.getSessionExecuteFirst(session);
      return {
        text: current
          ? '🤖 当前执行偏好：`execute`（代执行优先）'
          : '🤖 当前执行偏好：`guide`（说明步骤优先）',
      };
    }

    if (arg === 'execute' || arg === 'on' || arg === 'auto' || arg === 'run') {
      this.setSessionExecuteFirst(session, true);
      return {
        text: '✅ 已设置为 `execute`：后续会优先代你执行本机查询与操作任务。',
      };
    }

    if (arg === 'guide' || arg === 'manual' || arg === 'off') {
      this.setSessionExecuteFirst(session, false);
      return {
        text: '✅ 已设置为 `guide`：后续会优先给步骤说明，不强制代执行。',
      };
    }

    return {
      text: '用法：`/agent current|execute|guide`',
    };
  }

  private getSessionExecuteFirst(session: SessionInfo): boolean {
    const value = session.context[this.SESSION_EXECUTE_FIRST_KEY];
    if (typeof value === 'boolean') {
      return value;
    }

    const defaultValue = config.opencode.executeFirstDefault;
    session.context[this.SESSION_EXECUTE_FIRST_KEY] = defaultValue;
    return defaultValue;
  }

  private setSessionExecuteFirst(session: SessionInfo, enabled: boolean): void {
    session.context[this.SESSION_EXECUTE_FIRST_KEY] = enabled;
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

    const localOperationPattern = /(本机|系统信息|系统状态|cpu|内存|磁盘|硬盘|网络|ip|端口|进程|服务|环境变量|软件版本|安装包|包管理|apt|yum|dnf|pacman|brew|choco|scoop|npm|pnpm|yarn|pip|conda)/i;
    if (localOperationPattern.test(text)) {
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
    const explicitTaskPattern = /(修复|实现|编写|创建|生成|搜索|查找|分析|运行|执行|部署|安装|调试|测试|报错|错误|异常|代码|文件|命令|本机|系统|内存|磁盘|端口|进程|服务|软件|包管理|fix|implement|create|generate|search|run|execute|debug|test|file|command|bug|issue)/i;
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

  private formatFinalOutput(output: string, detailed: boolean): string {
    const normalized = this.normalizeOutput(output);
    if (!normalized) {
      return '';
    }

    const deduped = this.dedupeAdjacentLines(normalized);
    const readable = this.isStructuredMarkdown(deduped)
      ? deduped
      : this.segmentPlainText(deduped);

    if (detailed) {
      return readable;
    }

    return this.toConciseResult(readable);
  }

  private dedupeAdjacentLines(text: string): string {
    const lines = text.split('\n');
    const result: string[] = [];
    let previous = '';

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line && line === previous) {
        continue;
      }
      result.push(line);
      previous = line;
    }

    return result.join('\n').trim();
  }

  private isStructuredMarkdown(text: string): boolean {
    return /(^|\n)(#{1,6}\s|[-*]\s|\d+\.\s|```|>\s)/.test(text);
  }

  private segmentPlainText(text: string): string {
    const compact = text.replace(/[ \t]+/g, ' ').trim();
    if (compact.length < 240) {
      return compact;
    }

    const sentences = compact
      .split(/(?<=[。！？!?\.])\s+/)
      .map(item => item.trim())
      .filter(Boolean);

    if (sentences.length < 4) {
      return compact;
    }

    const paragraphs: string[] = [];
    for (let i = 0; i < sentences.length; i += 2) {
      paragraphs.push(sentences.slice(i, i + 2).join(' '));
    }

    return paragraphs.join('\n\n');
  }

  private shouldReturnDetailedResult(command: string): boolean {
    if (!config.opencode.conciseResultDefault) {
      return true;
    }

    const text = command.trim();
    if (!text) {
      return false;
    }

    const negativePattern = /(不要|不用|无需|别|不需要)\s*(详细|解释|过程|步骤|报告|点验|分析)/i;
    if (negativePattern.test(text)) {
      return false;
    }

    const detailedPattern = /([/!]detail\b|详细|展开|完整报告|点验报告|详细报告|详细解释|原因分析|过程说明|步骤拆解|原理说明|why|how|explain|analysis|report|breakdown|walkthrough|step\s*by\s*step)/i;
    return detailedPattern.test(text);
  }

  private toConciseResult(text: string): string {
    const normalized = text.trim();
    if (!normalized) {
      return '';
    }

    const lines = normalized
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    if (normalized.length <= this.CONCISE_MAX_LENGTH && lines.length <= this.CONCISE_MAX_LINES) {
      return normalized;
    }

    const highlights = this.extractHighlights(normalized, this.CONCISE_MAX_LINES);
    if (highlights.length > 0) {
      return highlights.map((line, index) => `${index + 1}. ${line}`).join('\n');
    }

    const uniqueLines: string[] = [];
    for (const line of lines) {
      if (!uniqueLines.includes(line)) {
        uniqueLines.push(line);
      }
      if (uniqueLines.length >= this.CONCISE_MAX_LINES) {
        break;
      }
    }

    const fallback = uniqueLines.join('\n').trim();
    if (!fallback) {
      return normalized.length > this.CONCISE_MAX_LENGTH
        ? `${normalized.substring(0, this.CONCISE_MAX_LENGTH)}...`
        : normalized;
    }
    return fallback.length > this.CONCISE_MAX_LENGTH
      ? `${fallback.substring(0, this.CONCISE_MAX_LENGTH)}...`
      : fallback;
  }

  private shouldUseCompletionCard(mode: TaskResponseMode, output: string): boolean {
    if (!config.opencode.resultCardEnabled) {
      return false;
    }

    if (mode !== 'silent') {
      return true;
    }

    if (output.length >= this.SILENT_CARD_MIN_LENGTH) {
      return true;
    }

    if (this.isStructuredMarkdown(output)) {
      return true;
    }

    if (/(https?:\/\/\S+)/i.test(output)) {
      return true;
    }

    return output.split('\n').length >= 5;
  }

  private buildCompletionFallbackText(task: TaskInfo, output: string, mode: TaskResponseMode): string {
    if (mode === 'silent') {
      return output || '（无回复）';
    }

    const duration = task.duration ? `（${(task.duration / 1000).toFixed(2)}s）` : '';
    const modelInfo = task.model ? `\n模型：\`${task.model}\`` : '';
    const readable = output || '（无输出）';
    return `✅ 任务完成${duration}${modelInfo}\n\n${readable}`;
  }

  private buildCardFollowupText(output: string): string | undefined {
    if (!output || output.length <= this.CARD_DETAIL_MAX_LENGTH) {
      return undefined;
    }

    let start = this.CARD_DETAIL_MAX_LENGTH;
    const nextLineBreak = output.indexOf('\n', this.CARD_DETAIL_MAX_LENGTH);
    if (nextLineBreak >= 0 && nextLineBreak - this.CARD_DETAIL_MAX_LENGTH <= 120) {
      start = nextLineBreak + 1;
    }

    const overflow = output.substring(start).trim();
    if (!overflow) {
      return undefined;
    }

    return `📄 详细结果（续）\n\n${overflow}`;
  }

  private buildCompletionCard(
    task: TaskInfo,
    output: string,
    mode: TaskResponseMode,
  ): Record<string, unknown> {
    const title = mode === 'silent' ? '回答完成' : '任务完成';
    const duration = task.duration ? `${(task.duration / 1000).toFixed(2)}s` : '未知';
    const model = task.model || '默认';
    const resultType = this.detectResultType(task.command, output);

    const highlights = this.extractHighlights(output, this.CARD_HIGHLIGHT_MAX_COUNT);
    const highlightMarkdown = highlights.length > 0
      ? highlights.map((line, index) => `${index + 1}. ${line}`).join('\n')
      : '1. 已完成，本次回复以“详细结果”为准。';

    const truncatedDetail = this.truncateText(output || '（无输出）', this.CARD_DETAIL_MAX_LENGTH);
    const detailMarkdown = this.toCardMarkdown(truncatedDetail.text);

    const elements: Array<Record<string, unknown>> = [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**类型**：${resultType}  \n**耗时**：${duration}  \n**模型**：${model}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**核心结论**\n${highlightMarkdown}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**详细结果**\n${detailMarkdown}`,
        },
      },
    ];

    if (truncatedDetail.truncated) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '_结果较长，卡片内已截断。可继续追问“继续展开第 X 点”。_',
        },
      });
    }

    return {
      config: {
        wide_screen_mode: true,
      },
      header: {
        template: 'green',
        title: {
          tag: 'plain_text',
          content: `✅ ${title}`,
        },
      },
      elements,
    };
  }

  private detectResultType(command: string, output: string): string {
    const source = `${command}\n${output}`;
    if (/(调研|研究|对比|分析|盘点|评估|research|investigate|survey|benchmark)/i.test(source)) {
      return '调研结果';
    }
    if (/(问答|问题|回答|解释|说明|什么|如何|为什么|why|how|what)/i.test(command)) {
      return '问答结果';
    }
    if (/(总结|结论|summary)/i.test(source)) {
      return '总结结果';
    }
    return '任务结果';
  }

  private extractHighlights(output: string, maxCount: number): string[] {
    if (!output) {
      return [];
    }

    const highlights: string[] = [];
    const push = (value: string): void => {
      const normalized = this.normalizeHighlightLine(value);
      if (!normalized) {
        return;
      }
      if (!highlights.includes(normalized)) {
        highlights.push(normalized);
      }
    };

    const lines = output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (highlights.length >= maxCount) {
        return highlights;
      }
      if (/^(\d+[.)]|[-*•])\s+/.test(line) || /^#{1,3}\s+/.test(line)) {
        push(line);
      }
    }

    if (highlights.length >= maxCount) {
      return highlights;
    }

    const compact = output.replace(/\s+/g, ' ').trim();
    const sentences = compact
      .split(/(?<=[。！？!?\.])\s+/)
      .map(sentence => sentence.trim())
      .filter(Boolean);

    for (const sentence of sentences) {
      if (highlights.length >= maxCount) {
        break;
      }
      push(sentence);
    }

    return highlights;
  }

  private normalizeHighlightLine(line: string): string {
    const stripped = line
      .replace(/^(\d+[.)]|[-*•])\s+/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!stripped) {
      return '';
    }

    if (stripped.length <= 140) {
      return stripped;
    }

    return `${stripped.substring(0, 140)}...`;
  }

  private toCardMarkdown(text: string): string {
    const escaped = text
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped.length > 0 ? escaped : '（无详细内容）';
  }

  private truncateText(text: string, maxLength: number): { text: string; truncated: boolean } {
    if (text.length <= maxLength) {
      return { text, truncated: false };
    }
    return {
      text: `${text.substring(0, maxLength)}\n\n（内容较长，已截断）`,
      truncated: true,
    };
  }

  private formatCancelReason(reason: string): string {
    if (reason === 'timeout_no_progress') {
      return '长时间无进度，已自动取消';
    }
    if (reason === 'timeout') {
      return '执行超时，已自动取消';
    }
    if (reason === 'user_request') {
      return '用户取消';
    }
    return reason;
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
    const executeFirst = this.getSessionExecuteFirst(session);
    session.taskHistory = [];
    session.context = {
      [this.SESSION_EXECUTE_FIRST_KEY]: executeFirst,
    };
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
      context: {
        [this.SESSION_EXECUTE_FIRST_KEY]: config.opencode.executeFirstDefault,
      },
    };
    this.sessions.set(id, session);
    return session;
  }
}
