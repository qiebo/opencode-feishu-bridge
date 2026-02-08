interface CardElement {
  tag: string;
  [key: string]: unknown;
}

export class CardBuilder {
  private card: Record<string, unknown> = {};
  private elements: CardElement[] = [];

  constructor(header?: { title: string; subtitle?: string }) {
    this.card = {
      config: { wide_screen_mode: true },
      header: header ? {
        title: { tag: 'plain_text', content: header.title },
        subtitle: header.subtitle ? { tag: 'plain_text', content: header.subtitle } : undefined,
      } : undefined,
      elements: this.elements,
    };
  }

  addMarkdown(content: string): this {
    this.elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content },
    });
    return this;
  }

  addSection(title: string, content: string): this {
    this.elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${title}**\n${content}`,
      },
    });
    return this;
  }

  addDivider(): this {
    this.elements.push({ tag: 'hr' });
    return this;
  }

  addNote(content: string): this {
    this.elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content }],
    });
    return this;
  }

  addButton(text: string, url: string, type: 'primary' | 'default' = 'default'): this {
    this.elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: text },
        url,
        type,
      }],
    });
    return this;
  }

  addCodeBlock(code: string, _language?: string): this {
    this.elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: code,
      },
    });
    return this;
  }

  build(): Record<string, unknown> {
    return this.card;
  }
}

export function buildTaskProgressCard(task: {
  id: string;
  command: string;
  status: string;
  output: string[];
  duration?: number;
}): Record<string, unknown> {
  const statusEmoji = {
    pending: '⏳',
    running: '▶️',
    completed: '✅',
    failed: '❌',
    cancelled: '⏹️',
  };

  const recentOutput = task.output.slice(-5).join('\n');
  
  return new CardBuilder({
    title: `${statusEmoji[task.status as keyof typeof statusEmoji] || '❓'} Task Status`,
    subtitle: `ID: ${task.id}`,
  })
    .addSection('Command', `\`\`\`\n${task.command}\n\`\`\``)
    .addDivider()
    .addSection('Output', recentOutput || '(No output yet)')
    .addNote(`Status: ${task.status}${task.duration ? ` | Duration: ${task.duration}ms` : ''}`)
    .build();
}

export function buildSystemStatusCard(data: {
  version: string;
  uptime: number;
  activeSessions: number;
  runningTasks: number;
  queuedTasks: number;
  connectionMode: string;
}): Record<string, unknown> {
  const formatUptime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  return new CardBuilder({
    title: '📊 System Status',
    subtitle: `OpenCode Feishu Bridge v${data.version}`,
  })
    .addMarkdown(`
**Runtime Info**
- Uptime: ${formatUptime(data.uptime)}
- Connection Mode: ${data.connectionMode}

**Statistics**
- Active Sessions: ${data.activeSessions}
- Running Tasks: ${data.runningTasks}
- Queued Tasks: ${data.queuedTasks}
    `.trim())
    .build();
}
