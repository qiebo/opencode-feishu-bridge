import { EventEmitter } from 'events';
import { FeishuBotConfig, FeishuMessageEvent } from '../types.js';
import { Logger } from '../utils/logger.js';
import { FeishuWSClient } from './feishu-ws-client.js';

interface MessageHandler {
  (message: FeishuMessageEvent): Promise<void>;
}

export class FeishuBot extends EventEmitter {
  private wsClient: FeishuWSClient;
  private messageHandler: MessageHandler | null = null;

  constructor(config: FeishuBotConfig) {
    super();
    this.wsClient = new FeishuWSClient(config);
  }

  async start(): Promise<void> {
    Logger.info('FeishuBot', 'Starting Feishu bot with WebSocket...');

    this.wsClient.on('message', (event: FeishuMessageEvent) => {
      this.handleMessage(event);
    });

    await this.wsClient.start();
    
    Logger.info('FeishuBot', 'Feishu bot started successfully');
  }

  onMessage(callback: MessageHandler): void {
    this.messageHandler = callback;
  }

  private async handleMessage(event: FeishuMessageEvent): Promise<void> {
    try {
      Logger.info('FeishuBot', `Received message from ${event.event?.sender?.sender_id?.user_id}`);
      
      if (this.messageHandler) {
        await this.messageHandler(event);
      }
      
      this.emit('message', event);
    } catch (error) {
      Logger.error('FeishuBot', 'Error handling message:', error);
    }
  }

  async sendMessage(chatId: string, content: string, msgType: string = 'text'): Promise<void> {
    await this.wsClient.sendMessage(chatId, content, msgType);
  }

  async sendFile(chatId: string, filePath: string): Promise<void> {
    await this.wsClient.sendFile(chatId, filePath);
  }

  async sendImage(chatId: string, imageInput: string): Promise<void> {
    await this.wsClient.sendImage(chatId, imageInput);
  }

  async downloadMessageFile(params: {
    messageId: string;
    fileKey: string;
    targetPath: string;
    resourceType?: string;
  }): Promise<void> {
    await this.wsClient.downloadMessageFile(params);
  }

  async replyToMessage(messageId: string, content: string, msgType: string = 'text'): Promise<void> {
    await this.wsClient.replyToMessage(messageId, content, msgType);
  }

  async stop(): Promise<void> {
    Logger.info('FeishuBot', 'Stopping Feishu bot...');
    await this.wsClient.stop();
    Logger.info('FeishuBot', 'Feishu bot stopped');
  }
}
