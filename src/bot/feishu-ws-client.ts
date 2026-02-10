import { EventEmitter } from 'events';
import { createReadStream } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, extname } from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuBotConfig, FeishuMessage, FeishuMessageEvent, FeishuSender } from '../types.js';
import { Logger } from '../utils/logger.js';

interface LarkMessageEventData {
  event_id?: string;
  token?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  app_id?: string;
  sender?: FeishuSender;
  message?: FeishuMessage;
}

const EMPTY_SENDER: FeishuSender = {
  sender_id: {},
  sender_type: 'unknown',
};

const EMPTY_MESSAGE: FeishuMessage = {
  message_id: '',
  chat_id: '',
  chat_type: 'group',
  message_type: 'text',
  content: '',
};

export class FeishuWSClient extends EventEmitter {
  private readonly config: FeishuBotConfig;
  private readonly client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private eventDispatcher: lark.EventDispatcher | null = null;

  constructor(config: FeishuBotConfig) {
    super();
    this.config = config;

    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
  }

  async start(): Promise<void> {
    Logger.info('FeishuWSClient', 'Starting WebSocket client...');

    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: LarkMessageEventData) => {
        await this.handleReceiveMessage(data);
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher,
    });

    Logger.info('FeishuWSClient', 'WebSocket client started');
  }

  private async handleReceiveMessage(data: LarkMessageEventData): Promise<void> {
    const messageEvent: FeishuMessageEvent = {
      schema: '2.0',
      header: {
        event_id: data.event_id || '',
        token: data.token || '',
        create_time: data.create_time || '',
        event_type: data.event_type || 'im.message.receive_v1',
        tenant_key: data.tenant_key || '',
        app_id: data.app_id || '',
      },
      event: {
        sender: data.sender || EMPTY_SENDER,
        message: data.message || EMPTY_MESSAGE,
      },
    };

    if (!messageEvent.event.message.message_id || !messageEvent.event.message.chat_id) {
      Logger.warn('FeishuWSClient', 'Ignoring malformed message event');
      return;
    }

    this.emit('message', messageEvent);
  }

  async sendMessage(chatId: string, content: string, msgType: string = 'text'): Promise<void> {
    Logger.info('FeishuWSClient', `Sending message to chat ${chatId}`);

    try {
      const payloadContent = this.formatMessageContent(content, msgType);
      const resp = await this.client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: msgType,
          content: payloadContent,
        },
      });

      if (resp.code !== 0) {
        throw new Error(`Failed to send message: ${resp.msg}`);
      }
    } catch (error) {
      Logger.error('FeishuWSClient', `Failed to send message: ${this.getErrorMessage(error)}`);
      throw error;
    }
  }

  async sendFile(chatId: string, filePath: string): Promise<void> {
    const fileName = basename(filePath);
    const fileType = this.guessUploadFileType(fileName);

    Logger.info('FeishuWSClient', `Uploading file ${fileName} to Feishu`);

    try {
      const uploadResp = await this.client.im.v1.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: createReadStream(filePath),
        },
      });

      const fileKey = uploadResp?.file_key;
      if (!fileKey) {
        throw new Error('File upload succeeded but no file_key returned');
      }

      const sendResp = await this.client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({
            file_key: fileKey,
          }),
        },
      });

      if (sendResp.code !== 0) {
        throw new Error(`Failed to send file message: ${sendResp.msg}`);
      }
    } catch (error) {
      Logger.error('FeishuWSClient', `Failed to send file: ${this.getErrorMessage(error)}`);
      throw error;
    }
  }

  async sendImage(chatId: string, imageInput: string): Promise<void> {
    Logger.info('FeishuWSClient', `Uploading image to chat ${chatId}`);

    const tempDir = await mkdtemp(`${tmpdir()}/feishu-image-`);
    let localImagePath = imageInput;
    try {
      if (this.isHttpUrl(imageInput)) {
        localImagePath = await this.downloadImageToTemp(imageInput, tempDir);
      }

      const uploadResp = await this.client.im.v1.image.create({
        data: {
          image_type: 'message',
          image: createReadStream(localImagePath),
        },
      });

      const imageKey = uploadResp?.image_key;
      if (!imageKey) {
        throw new Error('Image upload succeeded but no image_key returned');
      }

      const sendResp = await this.client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({
            image_key: imageKey,
          }),
        },
      });

      if (sendResp.code !== 0) {
        throw new Error(`Failed to send image message: ${sendResp.msg}`);
      }
    } catch (error) {
      Logger.error('FeishuWSClient', `Failed to send image: ${this.getErrorMessage(error)}`);
      throw error;
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {
        // ignore cleanup errors
      });
    }
  }

  async downloadMessageFile(params: {
    messageId: string;
    fileKey: string;
    targetPath: string;
    resourceType?: string;
  }): Promise<void> {
    const { messageId, fileKey, targetPath, resourceType = 'file' } = params;

    Logger.info('FeishuWSClient', `Downloading resource from message ${messageId}`);

    try {
      const fileResp = await this.client.im.v1.messageResource.get({
        params: {
          type: resourceType,
        },
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
      });

      await fileResp.writeFile(targetPath);
    } catch (error) {
      Logger.error('FeishuWSClient', `Failed to download message file: ${this.getErrorMessage(error)}`);
      throw error;
    }
  }

  async replyToMessage(messageId: string, content: string, msgType: string = 'text'): Promise<void> {
    if (!messageId) {
      throw new Error('messageId is required when replying to message');
    }

    Logger.info('FeishuWSClient', `Replying to message ${messageId}`);

    try {
      const payloadContent = this.formatMessageContent(content, msgType);
      const resp = await this.client.im.v1.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          content: payloadContent,
          msg_type: msgType,
        },
      });

      if (resp.code !== 0) {
        throw new Error(`Failed to reply to message: ${resp.msg}`);
      }
    } catch (error) {
      Logger.error('FeishuWSClient', `Failed to reply to message: ${this.getErrorMessage(error)}`);
      throw error;
    }
  }

  async stop(): Promise<void> {
    Logger.info('FeishuWSClient', 'Stopping WebSocket client...');

    if (this.wsClient) {
      this.wsClient.close({ force: true });
      this.wsClient = null;
    }

    this.eventDispatcher = null;
    Logger.info('FeishuWSClient', 'WebSocket client stopped');
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private guessUploadFileType(fileName: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
    const ext = extname(fileName).toLowerCase();

    if (ext === '.opus') {
      return 'opus';
    }
    if (ext === '.mp4') {
      return 'mp4';
    }
    if (ext === '.pdf') {
      return 'pdf';
    }
    if (ext === '.doc' || ext === '.docx') {
      return 'doc';
    }
    if (ext === '.xls' || ext === '.xlsx' || ext === '.csv') {
      return 'xls';
    }
    if (ext === '.ppt' || ext === '.pptx') {
      return 'ppt';
    }
    return 'stream';
  }

  private isHttpUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
  }

  private async downloadImageToTemp(url: string, tempDir: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image (${response.status})`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error('Downloaded image is empty');
    }

    const ext = this.resolveImageExt(url, response.headers.get('content-type'));
    const filePath = `${tempDir}/image${ext}`;
    await writeFile(filePath, bytes);
    return filePath;
  }

  private resolveImageExt(url: string, contentType: string | null): string {
    const urlExt = extname(new URL(url).pathname || '').toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.ico'].includes(urlExt)) {
      return urlExt;
    }

    const type = (contentType || '').toLowerCase();
    if (type.includes('png')) return '.png';
    if (type.includes('webp')) return '.webp';
    if (type.includes('gif')) return '.gif';
    if (type.includes('bmp')) return '.bmp';
    if (type.includes('tiff')) return '.tiff';
    if (type.includes('x-icon') || type.includes('icon')) return '.ico';
    return '.jpg';
  }

  private formatMessageContent(content: string, msgType: string): string {
    if (msgType === 'text') {
      return JSON.stringify({ text: content });
    }

    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(parsed);
      }
    } catch {
      // fallback to text wrapper
    }

    return JSON.stringify({ text: content });
  }
}
