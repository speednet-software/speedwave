/**
 * Mail Tools — OS Mail integration
 */

import {
  Tool,
  ToolDefinition,
  READ_ONLY_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
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
  /** Mail client to use. */
  client?: string;
}

/** Input parameters for the getEmail tool. */
interface GetEmailParams {
  /** Email message ID. */
  id: string;
  /** Mail client to use. */
  client?: string;
}

/** Input parameters for the searchEmails tool. */
interface SearchEmailsParams {
  /** Search query string. */
  query: string;
  /** Mailbox/folder name to search (default: Inbox). */
  mailbox?: string;
  /** Max results to return. */
  limit?: number;
  /** Mail client to use. */
  client?: string;
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
  /** Mail client to use. */
  client?: string;
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
  /** Mail client to use. */
  client?: string;
  /** Safety check flag that must be true to send. */
  confirm_send: boolean;
}

//=============================================================================
// Tool Definitions
//=============================================================================

const detectMailClientsTool: Tool = {
  name: 'detectMailClients',
  description: 'Detect available mail clients on this device (Apple Mail, Outlook, etc.)',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'detect', 'clients', 'outlook', 'thunderbird'],
  example: 'const { clients } = await os.detectMailClients()',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      clients: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Client name (e.g., "Apple Mail", "Outlook")' },
            available: { type: 'boolean' },
          },
        },
      },
    },
  },
  inputExamples: [
    {
      description: 'Detect mail clients (no params)',
      input: {},
    },
  ],
};

const listMailboxesTool: Tool = {
  name: 'listMailboxes',
  description:
    "List mail accounts and mailboxes/folders. Use each mailbox's name field (not id, which is not returned) as listEmails/searchEmails's mailbox parameter — exact case-sensitive match.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'mailboxes', 'accounts', 'inbox', 'folders'],
  example: 'const { mailboxes } = await os.listMailboxes()',
  inputSchema: {
    type: 'object',
    properties: {
      client: { type: 'string', description: 'Mail client to use (auto-detected if omitted)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      mailboxes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Mailbox name; pass this to listEmails/searchEmails',
            },
            account: { type: 'string', description: 'Account this mailbox belongs to' },
            message_count: { type: 'number', description: 'Total message count in this mailbox' },
          },
        },
      },
    },
  },
  inputExamples: [
    {
      description: 'List all mailboxes (auto-detect client)',
      input: {},
    },
    {
      description: 'List from specific client',
      input: { client: 'apple_mail' },
    },
  ],
};

const listEmailsTool: Tool = {
  name: 'listEmails',
  description: 'List emails in a mailbox. If limit is omitted, defaults to 10.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'list', 'inbox', 'messages'],
  example: 'const { emails } = await os.listEmails({ limit: 10 })',
  inputSchema: {
    type: 'object',
    properties: {
      mailbox: {
        type: 'string',
        description:
          "Mailbox/folder name (default: INBOX). Use the name field from listMailboxes' output.",
      },
      limit: { type: 'number', description: 'Max emails to return (default 10)' },
      offset: { type: 'number', description: 'Skip first N emails (for pagination)' },
      unread_only: { type: 'boolean', description: 'Only return unread emails' },
      client: { type: 'string', description: 'Mail client to use (auto-detected if omitted)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      emails: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            subject: { type: 'string' },
            sender: { type: 'string' },
            date: { type: 'string', description: 'ISO8601' },
            read: { type: 'boolean' },
          },
        },
      },
      total: { type: 'number' },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: list recent inbox emails',
      input: { limit: 10 },
    },
    {
      description: 'Full: paginated from specific mailbox',
      input: { mailbox: 'Archive', limit: 20, offset: 40 },
    },
  ],
};

const getEmailTool: Tool = {
  name: 'getEmail',
  description:
    'Get a specific email by ID with full body. On Apple Mail (the default client), only searches the Inbox — ids from other mailboxes are not resolvable. On Outlook (client: "outlook"), any id in the account is resolvable regardless of mailbox.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'get', 'read', 'detail', 'body', 'content'],
  example: 'const email = await os.getEmail({ id: "msg-456" })',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Email message ID (must be from the Inbox on Apple Mail; any mailbox on Outlook)',
      },
      client: { type: 'string', description: 'Mail client to use (auto-detected if omitted)' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      subject: { type: 'string' },
      sender: { type: 'string' },
      to: { type: 'array', items: { type: 'string' } },
      cc: { type: 'array', items: { type: 'string' } },
      date: { type: 'string' },
      body: { type: 'string', description: 'Email body (plain text)' },
      html_body: { type: 'string', description: 'Email body (HTML)' },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            size: { type: 'number' },
          },
        },
      },
    },
  },
  inputExamples: [
    {
      description: 'Get email by ID',
      input: { id: 'msg-456' },
    },
  ],
};

const searchEmailsTool: Tool = {
  name: 'searchEmails',
  description:
    'Search emails by subject or body content. Scopes to the named mailbox/folder, or the Inbox when mailbox is omitted. If limit is omitted, defaults to 10.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'search', 'find', 'query'],
  example: 'const { emails } = await os.searchEmails({ query: "quarterly report" })',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (matches subject and body)' },
      mailbox: {
        type: 'string',
        description:
          "Mailbox/folder name to search (default: Inbox). Use the name field from listMailboxes' output.",
      },
      limit: { type: 'number', description: 'Max results (default 10)' },
      client: { type: 'string', description: 'Mail client to use (auto-detected if omitted)' },
    },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      emails: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            subject: { type: 'string' },
            sender: { type: 'string' },
            date: { type: 'string' },
            snippet: { type: 'string', description: 'Matching text snippet' },
          },
        },
      },
      total: { type: 'number' },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: search the inbox',
      input: { query: 'quarterly report' },
    },
    {
      description: 'Full: search a named mailbox with a result limit',
      input: { query: 'invoice', mailbox: 'Archive', limit: 10 },
    },
  ],
};

const sendEmailTool: Tool = {
  name: 'sendEmail',
  description: 'Send a new email. Requires confirm_send=true as safety check.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'send', 'compose', 'write', 'new'],
  example:
    'await os.sendEmail({ to: "alice@example.com", subject: "Meeting notes", body: "See attached.", confirm_send: true })',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body (plain text)' },
      cc: { type: 'string', description: 'CC recipient(s), comma-separated' },
      bcc: { type: 'string', description: 'BCC recipient(s), comma-separated' },
      client: { type: 'string', description: 'Mail client to use (auto-detected if omitted)' },
      confirm_send: {
        type: 'boolean',
        description: 'Must be true to actually send (safety check)',
      },
    },
    required: ['to', 'subject', 'body', 'confirm_send'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"sent" or "draft_created"' },
      message_id: { type: 'string' },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: send to one recipient',
      input: {
        to: 'alice@example.com',
        subject: 'Quick update',
        body: 'Everything looks good.',
        confirm_send: true,
      },
    },
    {
      description: 'Full: send with CC and BCC',
      input: {
        to: 'alice@example.com',
        subject: 'Q4 Report',
        body: 'Please review the attached report.',
        cc: 'bob@example.com',
        bcc: 'carol@example.com',
        confirm_send: true,
      },
    },
  ],
};

// Email reply is irreversible (destructive operation)
const replyToEmailTool: Tool = {
  name: 'replyToEmail',
  description:
    'Reply to an existing email. Requires confirm_send=true as safety check. On Apple Mail (the default client), only searches the Inbox — ids from other mailboxes are not resolvable. On Outlook (client: "outlook"), any id in the account is resolvable regardless of mailbox.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'reply', 'respond', 'answer'],
  example:
    'await os.replyToEmail({ id: "msg-456", body: "Sounds good, let\'s proceed.", confirm_send: true })',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Email message ID to reply to (must be from the Inbox on Apple Mail; any mailbox on Outlook)',
      },
      body: { type: 'string', description: 'Reply body (plain text)' },
      reply_all: { type: 'boolean', description: 'Reply to all recipients (default false)' },
      client: { type: 'string', description: 'Mail client to use (auto-detected if omitted)' },
      confirm_send: {
        type: 'boolean',
        description: 'Must be true to actually send (safety check)',
      },
    },
    required: ['id', 'body', 'confirm_send'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"sent"' },
      message_id: { type: 'string' },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: reply to sender only',
      input: { id: 'msg-456', body: 'Thanks, acknowledged.', confirm_send: true },
    },
    {
      description: 'Full: reply all',
      input: {
        id: 'msg-456',
        body: 'I agree with the proposed timeline.',
        reply_all: true,
        confirm_send: true,
      },
    },
  ],
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
    strings: [
      ['mailbox', MAX_LENGTHS.short, false],
      ['client', MAX_LENGTHS.short, false],
    ],
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
    strings: [
      ['id', MAX_LENGTHS.id, false],
      ['client', MAX_LENGTHS.short, false],
    ],
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
      ['client', MAX_LENGTHS.short, false],
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
      ['client', MAX_LENGTHS.short, false],
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
      ['client', MAX_LENGTHS.short, false],
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
