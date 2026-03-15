/**
 * OS Tools Index
 *
 * Central registry for all OS tools following the domain-tools pattern.
 */

import { ToolDefinition } from '@speedwave/mcp-shared';
import type { OsDomain } from '../platform-runner.js';

export {
  withValidation,
  ToolResult,
  MAX_LENGTHS,
  validateStringFields,
  validateNumberFields,
  validateBooleanFields,
  validateAll,
  validateDateFields,
} from './validation.js';
export type { StringFieldSpec, NumberFieldSpec, ValidationSpec } from './validation.js';

import { createReminderTools } from './reminder-tools.js';
import { createCalendarTools } from './calendar-tools.js';
import { createMailTools } from './mail-tools.js';
import { createNoteTools } from './notes-tools.js';

/**
 * Allowlisted commands per OS domain.
 * Rejects any command not in this map before touching the filesystem or exec.
 */
export const ALLOWED_COMMANDS: Record<OsDomain, ReadonlySet<string>> = {
  reminders: new Set([
    'list_lists',
    'list_reminders',
    'get_reminder',
    'create_reminder',
    'complete_reminder',
  ]),
  calendar: new Set([
    'list_calendars',
    'list_events',
    'get_event',
    'create_event',
    'update_event',
    'delete_event',
  ]),
  mail: new Set([
    'detect_clients',
    'list_mailboxes',
    'list_emails',
    'get_email',
    'search_emails',
    'send_email',
    'reply_to_email',
  ]),
  notes: new Set([
    'list_folders',
    'list_notes',
    'get_note',
    'search_notes',
    'create_note',
    'update_note',
    'delete_note',
  ]),
};

/**
 * Creates complete tool definitions array for OS MCP server.
 */
export function createToolDefinitions(): ToolDefinition[] {
  return [
    ...createReminderTools(),
    ...createCalendarTools(),
    ...createMailTools(),
    ...createNoteTools(),
  ];
}
