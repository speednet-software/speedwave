/**
 * Mail Tools — OS Mail integration
 */

import { Tool, ToolDefinition } from '@speedwave/mcp-shared';
import { withValidation, ToolResult, validateAll, asRecord, MAX_LENGTHS } from './validation.js';
import { runCommand } from '../platform-runner.js';

//=============================================================================
// Types
//=============================================================================

/** Input parameters for the detectMailClients tool (no params required). */
type DetectMailClientsParams = Record<string, never>;

/** Input parameters for the listMailboxes tool. */
interface ListMailboxesParams {
  /** Mail client to use. */
  client?: string;
}

/** Input parameters for the listEmails tool. */
interface ListEmailsParams {
  /** Mailbox/folder name. */
  mailbox?: string;
  /** Max emails to return. */
  limit?: number;
  /** Skip first N emails for pagination. */
  offset?: number;
  /** Only return unread emails. */
  unread_only?: boolean;
}

/** Input parameters for the getEmail tool. */
interface GetEmailParams {
  /** Email message ID. */
  id: string;
}

/** Input parameters for the searchEmails tool. */
interface SearchEmailsParams {
  /** Search query string. */
  query: string;
  /** Limit search to specific mailbox. */
  mailbox?: string;
  /** Max results to return. */
  limit?: number;
}

/** Input parameters for the sendEmail tool. */
interface SendEmailParams {
  /** Recipient email address(es), comma-separated. */
  to: string;
  /** Email subject. */
  subject: string;
  /** Email body in plain text. */
  body: string;
  /** CC recipient(s), comma-separated. */
  cc?: string;
  /** BCC recipient(s), comma-separated. */
  bcc?: string;
  /** Safety check flag that must be true to send. */
  confirm_send: boolean;
}

/** Input parameters for the replyToEmail tool. */
interface ReplyToEmailParams {
  /** Email message ID to reply to. */
  id: string;
  /** Reply body in plain text. */
  body: string;
  /** Whether to reply to all recipients. */
  reply_all?: boolean;
  /** Safety check flag that must be true to send. */
  confirm_send: boolean;
}

//=============================================================================
// Tool Definitions
//=============================================================================

const detectMailClientsTool: Tool = {
  name: 'detectMailClients',
  description: 'Detect available mail clients on this device (Apple Mail, Outlook, etc.)',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const listMailboxesTool: Tool = {
  name: 'listMailboxes',
  description: 'List mail accounts and mailboxes/folders',
  inputSchema: {
    type: 'object',
    properties: {
      client: { type: 'string', description: 'Mail client to use (auto-detected if omitted)' },
    },
  },
};

const listEmailsTool: Tool = {
  name: 'listEmails',
  description: 'List emails in a mailbox',
  inputSchema: {
    type: 'object',
    properties: {
      mailbox: { type: 'string', description: 'Mailbox/folder name (default: INBOX)' },
      limit: { type: 'number', description: 'Max emails to return (default 20)' },
      offset: { type: 'number', description: 'Skip first N emails (for pagination)' },
      unread_only: { type: 'boolean', description: 'Only return unread emails' },
    },
  },
};

const getEmailTool: Tool = {
  name: 'getEmail',
  description: 'Get a specific email by ID with full body',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Email message ID' },
    },
    required: ['id'],
  },
};

const searchEmailsTool: Tool = {
  name: 'searchEmails',
  description: 'Search emails by query string',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (searches subject, body, sender)' },
      mailbox: { type: 'string', description: 'Limit search to specific mailbox' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['query'],
  },
};

const sendEmailTool: Tool = {
  name: 'sendEmail',
  description: 'Send a new email. Requires confirm_send=true as safety check.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body (plain text)' },
      cc: { type: 'string', description: 'CC recipient(s), comma-separated' },
      bcc: { type: 'string', description: 'BCC recipient(s), comma-separated' },
      confirm_send: {
        type: 'boolean',
        description: 'Must be true to actually send (safety check)',
      },
    },
    required: ['to', 'subject', 'body', 'confirm_send'],
  },
};

const replyToEmailTool: Tool = {
  name: 'replyToEmail',
  description: 'Reply to an existing email. Requires confirm_send=true as safety check.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Email message ID to reply to' },
      body: { type: 'string', description: 'Reply body (plain text)' },
      reply_all: { type: 'boolean', description: 'Reply to all recipients (default false)' },
      confirm_send: {
        type: 'boolean',
        description: 'Must be true to actually send (safety check)',
      },
    },
    required: ['id', 'body', 'confirm_send'],
  },
};

//=============================================================================
// Handlers
//=============================================================================

/**
 * Detects available mail clients on this device.
 * @param _params - Unused tool input parameters.
 */
export async function handleDetectMailClients(
  _params: DetectMailClientsParams
): Promise<ToolResult> {
  const result = await runCommand('mail', 'detect_clients');
  return { success: true, data: result.parsed };
}

/**
 * Lists mail accounts and mailboxes/folders.
 * @param params - Tool input parameters.
 */
export async function handleListMailboxes(params: ListMailboxesParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    strings: [['client', MAX_LENGTHS.short, false]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('mail', 'list_mailboxes', p);
  return { success: true, data: result.parsed };
}

/**
 * Lists emails in a mailbox.
 * @param params - Tool input parameters.
 */
export async function handleListEmails(params: ListEmailsParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    booleans: ['unread_only'],
    strings: [['mailbox', MAX_LENGTHS.short, false]],
    numbers: [
      ['limit', 1, 10_000],
      ['offset', 0, 1_000_000],
    ],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('mail', 'list_emails', p);
  return { success: true, data: result.parsed };
}

/**
 * Gets a specific email by ID with full body.
 * @param params - Tool input parameters.
 */
export async function handleGetEmail(params: GetEmailParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id'],
    strings: [['id', MAX_LENGTHS.id, false]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('mail', 'get_email', p);
  return { success: true, data: result.parsed };
}

/**
 * Searches emails by query string.
 * @param params - Tool input parameters.
 */
export async function handleSearchEmails(params: SearchEmailsParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['query'],
    strings: [
      ['query', MAX_LENGTHS.short, false],
      ['mailbox', MAX_LENGTHS.short, false],
    ],
    numbers: [['limit', 1, 10_000]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('mail', 'search_emails', p);
  return { success: true, data: result.parsed };
}

/**
 * Sends a new email. Requires confirm_send=true as safety check.
 * @param params - Tool input parameters.
 */
export async function handleSendEmail(params: SendEmailParams): Promise<ToolResult> {
  if (!params.confirm_send) {
    return {
      success: false,
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message:
          'confirm_send must be true to send email. This is a safety check to prevent accidental sends.',
      },
    };
  }
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['to', 'subject', 'body'],
    booleans: ['confirm_send'],
    strings: [
      ['to', MAX_LENGTHS.short, false],
      ['subject', MAX_LENGTHS.short, false],
      ['body', MAX_LENGTHS.body, true],
      ['cc', MAX_LENGTHS.short, false],
      ['bcc', MAX_LENGTHS.short, false],
    ],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('mail', 'send_email', p);
  return { success: true, data: result.parsed };
}

/**
 * Replies to an existing email. Requires confirm_send=true as safety check.
 * @param params - Tool input parameters.
 */
export async function handleReplyToEmail(params: ReplyToEmailParams): Promise<ToolResult> {
  if (!params.confirm_send) {
    return {
      success: false,
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message:
          'confirm_send must be true to send reply. This is a safety check to prevent accidental sends.',
      },
    };
  }
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id', 'body'],
    booleans: ['confirm_send', 'reply_all'],
    strings: [
      ['id', MAX_LENGTHS.id, false],
      ['body', MAX_LENGTHS.body, true],
    ],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('mail', 'reply_to_email', p);
  return { success: true, data: result.parsed };
}

//=============================================================================
// Export
//=============================================================================

/** Creates tool definitions for all mail operations. */
export function createMailTools(): ToolDefinition[] {
  return [
    { tool: detectMailClientsTool, handler: withValidation(handleDetectMailClients) },
    { tool: listMailboxesTool, handler: withValidation(handleListMailboxes) },
    { tool: listEmailsTool, handler: withValidation(handleListEmails) },
    { tool: getEmailTool, handler: withValidation(handleGetEmail) },
    { tool: searchEmailsTool, handler: withValidation(handleSearchEmails) },
    { tool: sendEmailTool, handler: withValidation(handleSendEmail) },
    { tool: replyToEmailTool, handler: withValidation(handleReplyToEmail) },
  ];
}
