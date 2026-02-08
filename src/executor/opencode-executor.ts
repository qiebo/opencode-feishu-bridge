import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { ExecutionResult, TaskInfo } from '../types.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

interface RunningTask {
  process: ChildProcess;
  info: TaskInfo;
  output: string[];
  startTime: number;
  timeoutHandle: NodeJS.Timeout;
  finalized: boolean;
  stdoutBuffer: string;
}

interface QueuedTask {
  taskInfo: TaskInfo;
  workingDir?: string;
  files?: string[];
  opencodeSessionId?: string;
  model?: string;
}

export interface IntentClassificationResult {
  label: 'chat' | 'task';
  confidence: number;
  raw: string;
}

export class OpencodeExecutor extends EventEmitter {
  private runningTasks = new Map<string, RunningTask>();
  private taskStore = new Map<string, TaskInfo>();
  private taskQueue: QueuedTask[] = [];
  private runningCount = 0;
  private maxConcurrent: number;
  private detectedModel: string | undefined;
  private hasTriedModelDetection = false;
  private readonly MAX_TASK_STORE = 500;

  constructor() {
    super();
    this.maxConcurrent = config.opencode.maxConcurrentTasks || 5;
  }

  async execute(params: {
    command: string;
    userId: string;
    chatId: string;
    messageId: string;
    workingDir?: string;
    files?: string[];
    opencodeSessionId?: string;
    responseMode?: TaskInfo['responseMode'];
    model?: string;
  }): Promise<TaskInfo> {
    const {
      command,
      userId,
      chatId,
      messageId,
      workingDir,
      files,
      opencodeSessionId,
      responseMode,
      model,
    } = params;

    const taskId = this.generateTaskId();
    const taskInfo: TaskInfo = {
      id: taskId,
      status: 'pending',
      responseMode,
      model,
      command,
      userId,
      chatId,
      messageId,
      opencodeSessionId,
      createdAt: new Date(),
      output: [],
    };

    this.taskStore.set(taskId, taskInfo);
    this.pruneTaskStore();

    if (this.runningCount >= this.maxConcurrent) {
      logger.info(`Task ${taskId} queued (concurrent limit reached)`);
      this.taskQueue.push({ taskInfo, workingDir, files, opencodeSessionId, model });
      this.emit('task:queued', { task: taskInfo });
      return taskInfo;
    }

    await this.startTask(taskInfo, workingDir, files, opencodeSessionId, model);
    return taskInfo;
  }

  async classifyIntent(command: string, modelOverride?: string): Promise<IntentClassificationResult> {
    const cwd = config.opencode.workingDir || process.cwd();
    const opencodePath = config.opencode.path;
    const model = modelOverride || await this.resolveModel();
    const prompt = this.buildIntentRoutingPrompt(command);
    const args = this.buildOpencodeArgs(prompt, model);
    const timeout = Math.max(3000, config.opencode.intentRoutingTimeout || 15000);

    logger.info(`Classifying intent with opencode (model=${model || 'default'})`);

    return await new Promise<IntentClassificationResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const finalize = (result: IntentClassificationResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        resolve(result);
      };

      let child: ChildProcess;
      try {
        child = spawn(opencodePath, args, {
          cwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Intent classification spawn failed: ${message}`);
        finalize({
          label: 'task',
          confidence: 0,
          raw: message,
        });
        return;
      }

      timeoutHandle = setTimeout(() => {
        logger.warn(`Intent classification timed out after ${timeout}ms`);
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            try {
              if (!child.killed) {
                child.kill('SIGKILL');
              }
            } catch {
              // ignore forced kill errors
            }
          }, 2000);
        } catch {
          // ignore timeout kill errors
        }
        finalize({
          label: 'task',
          confidence: 0,
          raw: 'timeout',
        });
      }, timeout);

      child.stdout?.on('data', (data: Buffer | string) => {
        stdout += typeof data === 'string' ? data : data.toString();
      });

      child.stderr?.on('data', (data: Buffer | string) => {
        stderr += typeof data === 'string' ? data : data.toString();
      });

      child.on('error', (error: Error) => {
        if (settled) {
          return;
        }
        logger.warn(`Intent classification process error: ${error.message}`);
        finalize({
          label: 'task',
          confidence: 0,
          raw: error.message,
        });
      });

      child.on('close', (code: number | null) => {
        if (settled) {
          return;
        }

        const extractedText = this.extractTextFromJsonEvents(stdout);
        const parsed = this.parseIntentClassification(extractedText);
        if (parsed) {
          finalize(parsed);
          return;
        }

        if (code !== 0) {
          logger.warn(
            `Intent classification exited with code ${code}: ${stderr.trim().substring(0, 300)}`,
          );
        } else {
          logger.warn(`Intent classification parse failed: ${extractedText.substring(0, 300)}`);
        }

        finalize({
          label: 'task',
          confidence: 0,
          raw: extractedText || stderr.trim(),
        });
      });
    });
  }

  private async startTask(
    taskInfo: TaskInfo,
    workingDir?: string,
    files?: string[],
    opencodeSessionId?: string,
    modelOverride?: string,
  ): Promise<void> {
    const { id, command } = taskInfo;
    const cwd = workingDir || config.opencode.workingDir || process.cwd();
    const opencodePath = config.opencode.path;
    const model = modelOverride || taskInfo.model || await this.resolveModel();
    taskInfo.model = model;
    const args = this.buildOpencodeArgs(command, model, files, opencodeSessionId);

    taskInfo.status = 'running';
    taskInfo.startedAt = new Date();
    this.runningCount++;
    this.emit('task:started', { task: taskInfo });

    logger.info(`Starting task ${id}: ${opencodePath} ${args.join(' ')}`);

    let child: ChildProcess;
    try {
      child = spawn(opencodePath, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const taskError = error instanceof Error ? error : new Error(String(error));
      taskInfo.status = 'failed';
      taskInfo.error = taskError.message;
      taskInfo.completedAt = new Date();
      taskInfo.duration = taskInfo.createdAt
        ? taskInfo.completedAt.getTime() - taskInfo.createdAt.getTime()
        : 0;
      this.runningCount = Math.max(0, this.runningCount - 1);
      this.emit('task:error', { task: taskInfo, error: taskError });
      return;
    }

    const timeout = config.opencode.timeout || 300000;
    const timeoutHandle = setTimeout(() => {
      if (this.runningTasks.has(id)) {
        logger.warn(`Task ${id} timed out after ${timeout}ms`);
        this.cancelTask(id, 'timeout');
      }
    }, timeout);

    const runningTask: RunningTask = {
      process: child,
      info: taskInfo,
      output: [],
      startTime: Date.now(),
      timeoutHandle,
      finalized: false,
      stdoutBuffer: '',
    };

    this.runningTasks.set(id, runningTask);

    child.stdout?.on('data', (data: Buffer | string) => {
      this.handleTaskStdout(runningTask, data);
    });

    child.stderr?.on('data', (data: Buffer | string) => {
      this.handleTaskOutput(runningTask, data, true);
    });

    child.on('error', (error: Error) => {
      this.finalizeTask(runningTask, {
        status: 'failed',
        error,
      });
    });

    child.on('close', (code: number | null) => {
      this.flushStdoutBuffer(runningTask);

      if (taskInfo.status === 'cancelled') {
        this.finalizeTask(runningTask, {
          status: 'cancelled',
          code,
        });
        return;
      }

      if (code === 0) {
        this.finalizeTask(runningTask, {
          status: 'completed',
          code,
        });
        return;
      }

      this.finalizeTask(runningTask, {
        status: 'failed',
        code,
        error: new Error(`Process exited with code ${code}`),
      });
    });
  }

  cancelTask(taskId: string, reason = 'user_request'): void {
    const runningTask = this.runningTasks.get(taskId);
    if (!runningTask) {
      return;
    }

    logger.info(`Cancelling task ${taskId}: ${reason}`);
    runningTask.info.status = 'cancelled';
    runningTask.info.error = `Cancelled: ${reason}`;
    this.emit('task:cancelled', { task: runningTask.info, reason });

    try {
      runningTask.process.kill('SIGTERM');
      setTimeout(() => {
        if (!runningTask.process.killed) {
          runningTask.process.kill('SIGKILL');
        }
      }, 5000);
    } catch (error) {
      logger.error(`Failed to kill task ${taskId}:`, error);
    }
  }

  private finalizeTask(
    runningTask: RunningTask,
    params: {
      status: 'completed' | 'failed' | 'cancelled';
      code?: number | null;
      error?: Error;
    },
  ): void {
    if (runningTask.finalized) {
      return;
    }
    runningTask.finalized = true;

    clearTimeout(runningTask.timeoutHandle);

    const taskInfo = runningTask.info;
    taskInfo.completedAt = new Date();
    taskInfo.duration = Date.now() - runningTask.startTime;
    if (typeof params.code === 'number') {
      taskInfo.exitCode = params.code;
    }

    if (params.status === 'completed') {
      taskInfo.status = 'completed';
      this.emit('task:completed', {
        task: taskInfo,
        result: this.buildResult(taskInfo),
      });
    } else if (params.status === 'failed') {
      taskInfo.status = 'failed';
      const error = params.error || new Error('Unknown task error');
      taskInfo.error = error.message;
      this.emit('task:error', { task: taskInfo, error });
    } else {
      taskInfo.status = 'cancelled';
    }

    this.cleanupTask(taskInfo.id);
    this.processQueue();
  }

  private handleTaskStdout(runningTask: RunningTask, data: Buffer | string): void {
    const chunk = typeof data === 'string' ? data : data.toString();
    if (!chunk) {
      return;
    }

    runningTask.stdoutBuffer += chunk;
    let newlineIndex = runningTask.stdoutBuffer.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = runningTask.stdoutBuffer.slice(0, newlineIndex);
      runningTask.stdoutBuffer = runningTask.stdoutBuffer.slice(newlineIndex + 1);
      this.handleStdoutLine(runningTask, line);
      newlineIndex = runningTask.stdoutBuffer.indexOf('\n');
    }
  }

  private flushStdoutBuffer(runningTask: RunningTask): void {
    const remaining = runningTask.stdoutBuffer.trim();
    if (remaining.length > 0) {
      this.handleStdoutLine(runningTask, remaining);
    }
    runningTask.stdoutBuffer = '';
  }

  private handleStdoutLine(runningTask: RunningTask, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.handleTaskOutput(runningTask, trimmed, false);
      return;
    }

    const sessionId = this.extractSessionId(parsed);
    if (sessionId && runningTask.info.opencodeSessionId !== sessionId) {
      runningTask.info.opencodeSessionId = sessionId;
      this.emit('task:session', { task: runningTask.info, opencodeSessionId: sessionId });
    }

    const text = this.extractTextPart(parsed);
    if (text) {
      this.handleTaskOutput(runningTask, text, false);
    }
  }

  private handleTaskOutput(runningTask: RunningTask, data: Buffer | string, isError: boolean): void {
    const output = typeof data === 'string' ? data : data.toString();
    if (!output) {
      return;
    }

    runningTask.output.push(output);
    runningTask.info.output.push(output);
    runningTask.info.progress = output.length > 500 ? `${output.substring(0, 500)}...` : output;

    this.emit('task:progress', {
      task: runningTask.info,
      progress: output,
      isError,
    });
  }

  private extractSessionId(parsed: Record<string, unknown>): string | undefined {
    const direct = parsed.sessionID;
    if (typeof direct === 'string' && direct.trim()) {
      return direct.trim();
    }

    const part = parsed.part;
    if (part && typeof part === 'object') {
      const nested = (part as Record<string, unknown>).sessionID;
      if (typeof nested === 'string' && nested.trim()) {
        return nested.trim();
      }
    }

    return undefined;
  }

  private extractTextPart(parsed: Record<string, unknown>): string | undefined {
    const type = parsed.type;
    if (type !== 'text') {
      return undefined;
    }

    const part = parsed.part;
    if (!part || typeof part !== 'object') {
      return undefined;
    }

    const text = (part as Record<string, unknown>).text;
    if (typeof text === 'string' && text.trim()) {
      return text;
    }

    return undefined;
  }

  private extractTextFromJsonEvents(rawOutput: string): string {
    const lines = rawOutput
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return '';
    }

    const textChunks: string[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const text = this.extractTextPart(parsed);
        if (text) {
          textChunks.push(text);
        }
      } catch {
        textChunks.push(line);
      }
    }

    return textChunks.join('\n').trim();
  }

  private parseIntentClassification(rawText: string): IntentClassificationResult | null {
    if (!rawText) {
      return null;
    }

    const cleaned = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const candidate = jsonMatch?.[0] || cleaned;

    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const labelRaw = typeof parsed.label === 'string' ? parsed.label.toLowerCase() : '';
      if (labelRaw !== 'chat' && labelRaw !== 'task') {
        return null;
      }

      const confidenceRaw = parsed.confidence;
      const confidenceValue = typeof confidenceRaw === 'number'
        ? confidenceRaw
        : parseFloat(String(confidenceRaw ?? '0.5'));
      const confidence = Number.isFinite(confidenceValue)
        ? Math.max(0, Math.min(1, confidenceValue))
        : 0.5;

      return {
        label: labelRaw,
        confidence,
        raw: cleaned,
      };
    } catch {
      const lower = cleaned.toLowerCase();
      if (lower.includes('chat') && !lower.includes('task')) {
        return {
          label: 'chat',
          confidence: 0.6,
          raw: cleaned,
        };
      }
      if (lower.includes('task') || lower.includes('任务')) {
        return {
          label: 'task',
          confidence: 0.6,
          raw: cleaned,
        };
      }
      return null;
    }
  }

  private buildIntentRoutingPrompt(userMessage: string): string {
    return [
      '你只做意图分类，不执行任务。',
      '输出且仅输出一行 JSON：{"label":"chat|task","confidence":0.00}',
      'chat=闲聊问答/状态询问；task=需要实际操作（改代码、分析、搜索、处理文件、运行命令等）。',
      `用户消息：${userMessage}`,
    ].join('\n');
  }

  private cleanupTask(taskId: string): void {
    this.runningTasks.delete(taskId);
    this.runningCount = Math.max(0, this.runningCount - 1);
  }

  private processQueue(): void {
    if (this.taskQueue.length === 0 || this.runningCount >= this.maxConcurrent) {
      return;
    }

    const next = this.taskQueue.shift();
    if (!next) {
      return;
    }

    this.startTask(next.taskInfo, next.workingDir, next.files, next.opencodeSessionId, next.model).catch((error: unknown) => {
      const taskError = error instanceof Error ? error : new Error(String(error));
      next.taskInfo.status = 'failed';
      next.taskInfo.error = taskError.message;
      next.taskInfo.completedAt = new Date();
      this.emit('task:error', { task: next.taskInfo, error: taskError });
      this.processQueue();
    });
  }

  private buildOpencodeArgs(
    prompt: string,
    model?: string,
    files?: string[],
    opencodeSessionId?: string,
  ): string[] {
    const args = ['run', prompt, '--format', 'json'];
    if (model) {
      args.push('--model', model);
    }
    if (opencodeSessionId) {
      args.push('--session', opencodeSessionId);
    }
    if (files) {
      for (const filePath of files) {
        args.push('--file', filePath);
      }
    }
    return args;
  }

  private async resolveModel(): Promise<string | undefined> {
    if (config.opencode.model) {
      return config.opencode.model;
    }
    if (!config.opencode.autoDetectModel) {
      return undefined;
    }
    if (this.detectedModel) {
      return this.detectedModel;
    }
    if (this.hasTriedModelDetection) {
      return undefined;
    }

    this.hasTriedModelDetection = true;
    this.detectedModel = this.detectModelFromCLI();

    if (this.detectedModel) {
      logger.info(`Auto-detected opencode model: ${this.detectedModel}`);
    } else {
      logger.warn('Unable to auto-detect opencode model; fallback to opencode default');
    }

    return this.detectedModel;
  }

  private detectModelFromCLI(): string | undefined {
    try {
      const result = spawnSync(config.opencode.path, ['models'], {
        cwd: config.opencode.workingDir || process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 20000,
      });

      if (result.status !== 0) {
        logger.warn('opencode models command failed', result.stderr?.toString() || '');
        return undefined;
      }

      const lines = result.stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

      return lines[0];
    } catch (error) {
      logger.warn('Failed to detect opencode model automatically', error);
      return undefined;
    }
  }

  listModels(): string[] {
    try {
      const result = spawnSync(config.opencode.path, ['models'], {
        cwd: config.opencode.workingDir || process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 20000,
      });

      if (result.status !== 0) {
        logger.warn('opencode models command failed', result.stderr?.toString() || '');
        return [];
      }

      return result.stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    } catch (error) {
      logger.warn('Failed to list opencode models', error);
      return [];
    }
  }

  private pruneTaskStore(): void {
    while (this.taskStore.size > this.MAX_TASK_STORE) {
      const oldestTaskId = this.taskStore.keys().next().value;
      if (!oldestTaskId) {
        break;
      }
      this.taskStore.delete(oldestTaskId);
    }
  }

  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private buildResult(taskInfo: TaskInfo): ExecutionResult {
    return {
      success: taskInfo.status === 'completed',
      output: taskInfo.output.join(''),
      error: taskInfo.error,
      exitCode: taskInfo.exitCode,
      duration: taskInfo.duration || 0,
    };
  }

  getTask(taskId: string): TaskInfo | undefined {
    return this.taskStore.get(taskId);
  }

  getAllTasks(): TaskInfo[] {
    return Array.from(this.taskStore.values());
  }

  getQueueLength(): number {
    return this.taskQueue.length;
  }

  getRunningCount(): number {
    return this.runningCount;
  }

  cleanup(): void {
    logger.info('Cleaning up executor...');

    for (const [, runningTask] of this.runningTasks) {
      try {
        if (!runningTask.process.killed) {
          runningTask.process.kill('SIGTERM');
        }
      } catch {
        // ignore cleanup kill errors
      }
      clearTimeout(runningTask.timeoutHandle);
    }

    this.runningTasks.clear();
    this.taskQueue = [];
    this.runningCount = 0;

    logger.info('Executor cleaned up');
  }
}
