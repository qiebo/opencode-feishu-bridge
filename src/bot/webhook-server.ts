import http from 'http';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { FeishuMessageEvent, FeishuBotConfig } from '../types.js';
import { logger } from '../utils/logger.js';

interface MessageHandler {
  (message: FeishuMessageEvent): Promise<void>;
}

export class WebhookServer extends EventEmitter {
  private server: http.Server | null = null;
  private config: FeishuBotConfig;
  private messageHandler: MessageHandler | null = null;

  constructor(config: FeishuBotConfig) {
    super();
    this.config = config;
  }

  on(event: 'message', listener: MessageHandler): this;
  on(event: string, listener: (...args: any[]) => void): this {
    if (event === 'message') {
      this.messageHandler = listener as MessageHandler;
    }
    return super.on(event, listener);
  }

  start(port: number): void {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      
      if (req.method === 'GET' && url.pathname === '/webhook') {
        const challenge = url.searchParams.get('challenge');
        if (challenge) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(challenge);
          return;
        }
      }
      
      if (req.method === 'POST' && url.pathname === '/webhook') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const payload = JSON.parse(body);
            
            if (this.config.encryptKey) {
              const signature = req.headers['x-lark-signature'] as string;
              const timestamp = req.headers['x-lark-timestamp'] as string;
              
              if (!this.verifySignature(body, timestamp, signature)) {
                res.writeHead(401);
                res.end('Invalid signature');
                return;
              }
            }
            
            if (payload.type === 'url_verification') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ challenge: payload.challenge }));
              return;
            }
            
            if (payload.type === 'event_callback' && payload.event) {
              const eventType = payload.event.type;
              
              if (eventType === 'message') {
                const messageEvent: FeishuMessageEvent = {
                  schema: '2.0',
                  header: {
                    event_id: payload.event_id || '',
                    token: '',
                    create_time: payload.event.create_time || '',
                    event_type: payload.event.type,
                    tenant_key: payload.tenant_key || '',
                    app_id: '',
                  },
                  event: payload.event,
                };
                
                if (this.messageHandler) {
                  await this.messageHandler(messageEvent);
                }
              }
            }
            
            res.writeHead(200);
            res.end('OK');
          } catch (error) {
            logger.error('Webhook error:', error);
            res.writeHead(500);
            res.end('Internal server error');
          }
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    this.server.listen(port, () => {
      logger.info(`Webhook server listening on port ${port}`);
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('Webhook server stopped');
          resolve();
        });
      });
    }
  }

  private verifySignature(body: string, timestamp: string, signature: string): boolean {
    const { encryptKey } = this.config;
    if (!encryptKey) return true;
    
    const signStr = `${timestamp}${body}`;
    const expectedSignature = crypto
      .createHmac('sha256', encryptKey)
      .update(signStr)
      .digest('hex');
    
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }
}
