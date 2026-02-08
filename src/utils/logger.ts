import { config } from '../config.js';
import type { LogLevel } from '../types.js';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private level: LogLevel;
  private static instance?: Logger;

  constructor() {
    this.level = config?.logging?.level || 'info';
    Logger.instance = this;
  }

  private static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[this.level];
  }

  private format(level: LogLevel, message: string, ...args: unknown[]): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    const argString = args.length > 0 ? ' ' + args.map(a => 
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ') : '';
    return `${prefix} ${message}${argString}`;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.log(this.format('debug', message, ...args));
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.log(this.format('info', message, ...args));
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.warn(this.format('warn', message, ...args));
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(this.format('error', message, ...args));
    }
  }

  static debug(message: string, ...args: unknown[]): void {
    Logger.getInstance().debug(message, ...args);
  }

  static info(message: string, ...args: unknown[]): void {
    Logger.getInstance().info(message, ...args);
  }

  static warn(message: string, ...args: unknown[]): void {
    Logger.getInstance().warn(message, ...args);
  }

  static error(message: string, ...args: unknown[]): void {
    Logger.getInstance().error(message, ...args);
  }
}

export const logger = new Logger();
