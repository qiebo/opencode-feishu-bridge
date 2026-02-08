export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ConnectionMode = 'websocket' | 'webhook';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface FeishuBotConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  connectionMode: 'webhook' | 'websocket';
  webhookPort?: number;
}

export interface FeishuSender {
  sender_id?: {
    open_id?: string;
    union_id?: string;
    user_id?: string;
  };
  sender_type: string;
  tenant_key?: string;
}

export interface FeishuMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  chat_id: string;
  chat_type: 'p2p' | 'group' | string;
  message_type: 'text' | 'post' | 'image' | 'file' | 'audio' | 'media' | 'sticker' | 'interactive' | string;
  content: string;
  mentions?: Array<{
    key: string;
    id: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    name: string;
    tenant_key?: string;
  }>;
}

export interface FeishuMessageEvent {
  schema: string;
  header: {
    event_id: string;
    token: string;
    create_time: string;
    event_type: string;
    tenant_key: string;
    app_id: string;
  };
  event: {
    sender: FeishuSender;
    message: FeishuMessage;
  };
}

export interface BotResponse {
  text?: string;
  card?: Record<string, unknown>;
  executeCommand?: string;
  sendFilePath?: string;
  resetSession?: boolean;
}

export interface SessionInfo {
  id: string;
  userId: string;
  chatId: string;
  createdAt: Date;
  lastActivityAt: Date;
  taskHistory: TaskInfo[];
  context: Record<string, unknown>;
}

export interface TaskInfo {
  id: string;
  status: TaskStatus;
  command: string;
  userId: string;
  chatId: string;
  messageId: string;
  opencodeSessionId?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  output: string[];
  error?: string;
  exitCode?: number;
  duration?: number;
  progress?: string;
}

export interface TaskResult {
  success: boolean;
  output: string[];
  error?: string;
  exitCode?: number;
  duration: number;
  messageId?: string;
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
  duration: number;
}

export interface SendMessageOptions {
  chatId?: string;
  userId?: string;
  messageId?: string;
  content: {
    text: string;
    card?: Record<string, unknown>;
  };
}

export interface WebhookPayload {
  challenge?: string;
  token?: string;
  type?: string;
  schema?: string;
  header?: {
    event_id: string;
    event_type: string;
    token: string;
    create_time: string;
  };
  event?: unknown;
}
