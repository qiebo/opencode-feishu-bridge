import type { LogLevel, NotificationMode } from './types.js';

export interface Config {
  version: string;
  port: number;
  logging: {
    level: LogLevel;
    file?: string;
  };
  feishu: {
    appId: string;
    appSecret: string;
    encryptKey?: string;
    verificationToken?: string;
    connectionMode: 'websocket' | 'webhook';
    webhookPort?: number;
    receiveMessage: boolean;
  };
  opencode: {
    path: string;
    workingDir: string;
    maxConcurrentTasks: number;
    timeout: number;
    streamingEnabled: boolean;
    streamingInterval: number;
    model?: string;
    autoDetectModel: boolean;
    intentRoutingEnabled: boolean;
    intentRoutingTimeout: number;
    intentRoutingConfidence: number;
    progressStatusOnly: boolean;
    resultCardEnabled: boolean;
    notifyDefaultMode: NotificationMode;
    normalProgressInterval: number;
  };
  session: {
    timeout: number;
    maxHistory: number;
  };
  security: {
    allowedUsers: string[];
    requireMention: boolean;
  };
}

const parseNotificationMode = (value: string | undefined): NotificationMode => {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'quiet' || normalized === 'normal' || normalized === 'debug') {
    return normalized;
  }
  return 'quiet';
};

const defaultConfig: Config = {
  version: '1.0.0',
  port: 3000,
  logging: {
    level: 'info',
  },
  feishu: {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    encryptKey: process.env.FEISHU_ENCRYPT_KEY,
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
    connectionMode: 'websocket',
    webhookPort: parseInt(process.env.FEISHU_WEBHOOK_PORT || '3000'),
    receiveMessage: true,
  },
  opencode: {
    path: process.env.OPENCODE_PATH || 'opencode',
    workingDir: process.env.OPENCODE_WORKING_DIR || process.cwd(),
    maxConcurrentTasks: parseInt(process.env.OPENCODE_MAX_CONCURRENT || '5'),
    timeout: parseInt(process.env.OPENCODE_TIMEOUT || '300000'),
    streamingEnabled: process.env.OPENCODE_STREAMING_ENABLED !== 'false',
    streamingInterval: parseInt(process.env.OPENCODE_STREAMING_INTERVAL || '5000'),
    model: process.env.OPENCODE_MODEL || undefined,
    autoDetectModel: process.env.OPENCODE_AUTO_MODEL_DETECT !== 'false',
    intentRoutingEnabled: process.env.OPENCODE_INTENT_ROUTING_ENABLED !== 'false',
    intentRoutingTimeout: parseInt(process.env.OPENCODE_INTENT_ROUTING_TIMEOUT || '8000'),
    intentRoutingConfidence: parseFloat(process.env.OPENCODE_INTENT_CONFIDENCE || '0.75'),
    progressStatusOnly: process.env.OPENCODE_PROGRESS_STATUS_ONLY !== 'false',
    resultCardEnabled: process.env.OPENCODE_RESULT_CARD_ENABLED !== 'false',
    notifyDefaultMode: parseNotificationMode(process.env.OPENCODE_NOTIFY_DEFAULT),
    normalProgressInterval: parseInt(process.env.OPENCODE_PROGRESS_NORMAL_INTERVAL || '480000'),
  },
  session: {
    timeout: parseInt(process.env.SESSION_TIMEOUT || '3600000'),
    maxHistory: parseInt(process.env.SESSION_MAX_HISTORY || '20'),
  },
  security: {
    allowedUsers: process.env.ALLOWED_USERS?.split(',') || [],
    requireMention: process.env.REQUIRE_MENTION !== 'false',
  },
};

export const config = defaultConfig;
