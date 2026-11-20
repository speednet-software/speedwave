import type { NormalizedToolInput } from '../../models/chat';

/**
 * One-line summary of a tool call, shown after the tool name in a tool block header.
 * @param n - The normalized tool input.
 */
export function toolSummary(n: NormalizedToolInput): string {
  switch (n.kind) {
    case 'bash':
      return `$ ${n.command}`;
    case 'read':
    case 'write':
    case 'edit':
      return n.file_path;
    case 'glob':
    case 'grep':
      return n.pattern;
    case 'web_search':
      return n.query;
    case 'web_fetch':
      return n.url;
    case 'agent':
      return n.description || n.subagent_type || '';
    case 'workflow':
      return n.title;
    case 'todo_write':
      return `${n.todos.length} ${n.todos.length === 1 ? 'task' : 'tasks'}`;
    case 'task_create':
      return n.subject;
    case 'task_update': {
      const change = n.status ?? n.subject;
      return change === undefined ? `#${n.task_id}` : `#${n.task_id} → ${change}`;
    }
    case 'task_get':
      return `#${n.task_id}`;
    case 'task_list':
    case 'generic':
      return '';
  }
}
