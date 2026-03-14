import { Injectable } from '@angular/core';
import type { NormalizedToolInput } from '../models/chat';

/** Parses raw tool input JSON into typed display models based on tool name. */
@Injectable({ providedIn: 'root' })
export class ToolNormalizerService {
  /**
   * Parses raw tool input JSON into a typed discriminated union for display.
   * Recognizes: Bash, Read, Edit, Write, Glob, Grep, TodoWrite, WebSearch, WebFetch, Agent.
   * Unknown tool names and unparseable JSON fall back to `{ kind: 'generic', raw_json }`.
   * @param toolName - The Claude tool name (e.g. "Bash", "Read").
   * @param inputJson - The raw JSON string of tool input parameters.
   */
  normalize(toolName: string, inputJson: string): NormalizedToolInput {
    try {
      const parsed = JSON.parse(inputJson);
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
    } catch (err) {
      console.warn(`Failed to parse tool input for "${toolName}":`, inputJson, err);
      return { kind: 'generic', raw_json: inputJson };
    }
  }
}
