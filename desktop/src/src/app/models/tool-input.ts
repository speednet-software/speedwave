import type { NormalizedToolInput } from './chat';

const META_START = /export\s+const\s+meta\s*=\s*\{/;
const META_NAME_AT = /name\s*:\s*(['"])(.*?)\1/sy;
const QUOTES = new Set(['"', "'", '`']);

function metaName(script: string): string | undefined {
  const start = META_START.exec(script);
  if (!start) {
    return undefined;
  }
  let depth = 1;
  for (let i = start.index + start[0].length; i < script.length && depth > 0; i++) {
    const ch = script[i];
    if (QUOTES.has(ch)) {
      i = closingQuote(script, i);
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    } else if (depth === 1 && ch === 'n' && !/\w/.test(script[i - 1] ?? '')) {
      META_NAME_AT.lastIndex = i;
      const found = META_NAME_AT.exec(script);
      if (found) {
        return found[2];
      }
    }
  }
  return undefined;
}

function closingQuote(script: string, open: number): number {
  const quote = script[open];
  let i = open + 1;
  while (i < script.length && script[i] !== quote) {
    i += script[i] === '\\' ? 2 : 1;
  }
  return i;
}

function usableString(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function workflowArgs(value: unknown): Array<{ key: string; value: string }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).map(([key, v]) => ({
    key,
    value: typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)),
  }));
}

function normalizeWorkflow(parsed: Record<string, unknown>): NormalizedToolInput | undefined {
  const name = optionalString(parsed['name']);
  const description = optionalString(parsed['description']);
  const script = optionalString(parsed['script']);
  const scriptPath = optionalString(parsed['scriptPath']);
  const resumeFromRunId = optionalString(parsed['resumeFromRunId']);
  const args = workflowArgs(parsed['args']);
  if (![name, script, scriptPath].some(usableString)) {
    return undefined;
  }
  const scriptName = script === undefined ? undefined : metaName(script);
  return {
    kind: 'workflow',
    title: (usableString(name) ? name : scriptName) || 'workflow',
    description,
    args,
    script,
    scriptPath,
    resumeFromRunId,
  };
}

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
      case 'Task':
        return {
          kind: 'agent',
          description: parsed.description ?? '',
          subagent_type: optionalString(parsed.subagent_type),
          run_in_background: parsed.run_in_background === true ? true : undefined,
        };
      case 'Workflow':
        return normalizeWorkflow(parsed) ?? { kind: 'generic', raw_json: inputJson };
      default:
        return { kind: 'generic', raw_json: inputJson };
    }
  } catch {
    return { kind: 'generic', raw_json: inputJson };
  }
}
