import type { NormalizedToolInput } from './chat';

/**
 * Parses raw tool input JSON into a typed display model by tool name.
 * @param toolName - The Claude tool name (e.g. "Bash", "TaskCreate").
 * @param inputJson - The raw JSON string of tool input parameters.
 */
export function normalizeToolInput(toolName: string, inputJson: string): NormalizedToolInput {
  try {
    const parsed = JSON.parse(inputJson);
    if (parsed === null || typeof parsed !== 'object') {
      return { kind: 'generic', raw_json: inputJson };
    }
    switch (toolName) {
      case 'Bash':
        return { kind: 'bash', command: parsed.command ?? '' };
      case 'Read':
        return {
          kind: 'read',
          file_path: parsed.file_path ?? '',
          offset: parsed.offset,
          limit: parsed.limit,
        };
      case 'Edit':
        return {
          kind: 'edit',
          file_path: parsed.file_path ?? '',
          old_string: parsed.old_string ?? '',
          new_string: parsed.new_string ?? '',
        };
      case 'Write':
        return {
          kind: 'write',
          file_path: parsed.file_path ?? '',
          content: parsed.content ?? '',
        };
      case 'Glob':
        return { kind: 'glob', pattern: parsed.pattern ?? '', path: parsed.path };
      case 'Grep':
        return {
          kind: 'grep',
          pattern: parsed.pattern ?? '',
          path: parsed.path,
          include: parsed.include,
        };
      case 'TodoWrite':
        return { kind: 'todo_write', todos: parsed.todos ?? [] };
      case 'TaskCreate':
        return {
          kind: 'task_create',
          subject: parsed.subject ?? '',
          description: parsed.description ?? '',
          activeForm: parsed.activeForm,
        };
      case 'TaskUpdate':
        return {
          kind: 'task_update',
          task_id: String(parsed.taskId ?? ''),
          status: parsed.status,
          subject: parsed.subject,
          activeForm: parsed.activeForm,
        };
      case 'TaskList':
        return { kind: 'task_list' };
      case 'TaskGet':
        return { kind: 'task_get', task_id: String(parsed.taskId ?? '') };
      case 'WebSearch':
        return { kind: 'web_search', query: parsed.query ?? '' };
      case 'WebFetch':
        return { kind: 'web_fetch', url: parsed.url ?? '' };
      case 'Agent':
        return {
          kind: 'agent',
          description: parsed.description ?? '',
        };
      default:
        return { kind: 'generic', raw_json: inputJson };
    }
  } catch {
    return { kind: 'generic', raw_json: inputJson };
  }
}
