/**
 * Mail Tools — OS Mail integration
 */

import {
  Tool,
  ToolDefinition,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  META_KEYS,
  withDeclaredParams,
  teachingToolResult,
  type TeachingErrorParams,
} from '@speedwave/mcp-shared';
import { withValidation, ToolResult, validateAll, asRecord, MAX_LENGTHS } from './validation.js';
import { runCommand } from '../platform-runner.js';

/** Time budget of one mail tool call: the script ends before mail-cli is killed, mail-cli before the hub gives up. */
interface MailTimeBudget {
  /** Hub timeout of the tool call (`_meta` TIMEOUT_MS). */
  toolMs: number;
  /** Timeout of the mail-cli process. */
  processMs: number;
  /** Timeout of the AppleScript inside mail-cli, passed as `script_timeout_ms`. */
  scriptMs: number;
}

/** Arguments of a mail tool call, as mail-cli receives them. */
type MailArgs = Record<string, unknown>;

const PROCESS_HEADROOM_MS = 2_000;

const SCRIPT_HEADROOM_MS = 3_000;

const STANDARD_BUDGET = mailTimeBudget(30_000);

const MAIL_FAILURE = /\b(MAIL_[A-Z_]+): ([\s\S]*)$/;

const MAIL_FAILURE_TEACHING: Record<
  string,
  (detail: string, args: MailArgs) => TeachingErrorParams
> = {
  MAIL_TIMEOUT: (detail) => ({
    paramName: 'request',
    nextStep:
      `${detail} Retry once; for a list or a search pass a specific mailbox or a smaller limit. ` +
      'Before retrying a send or a reply, check the Sent mailbox, since Mail.app may have sent it anyway.',
  }),
  MAIL_AUTOMATION_DENIED: (detail) => ({
    paramName: 'Mail automation permission',
    nextStep:
      `${detail} Ask the user to allow Speedwave to control Mail in ` +
      'System Settings > Privacy & Security > Automation, then retry.',
  }),
  MAIL_MAILBOX_NOT_FOUND: (detail, args) => ({
    paramName: 'mailbox',
    received: args.mailbox,
    correctValueTool: 'listMailboxes',
    nextStep: `${detail} Pass the name and account of a mailbox exactly as listMailboxes returns them.`,
  }),
  MAIL_ACCOUNT_NOT_FOUND: (detail, args) => ({
    paramName: 'account',
    received: args.account,
    correctValueTool: 'listMailboxes',
    nextStep: `${detail} Pass the account field of a mailbox listMailboxes returns.`,
  }),
  MAIL_MAILBOX_AMBIGUOUS: (detail, args) => ({
    paramName: 'account',
    received: args.account,
    correctValueTool: 'listMailboxes',
    nextStep: `${detail} Pass account together with mailbox to pick one of them.`,
  }),
};

/** Input parameters for the detectMailClients tool (no params required). */
type DetectMailClientsParams = Record<string, never>;

/** Input parameters for the listMailboxes tool (no params required). */
type ListMailboxesParams = Record<string, never>;

/** Input parameters for the listEmails tool. */
interface ListEmailsParams {
  /** Mailbox path from listMailboxes. */
  mailbox?: string;
  /** Account of the mailbox. */
  account?: string;
  /** Max emails to return. */
  limit?: number;
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
  /** Mailbox path from listMailboxes (default: Inbox). */
  mailbox?: string;
  /** Account of the mailbox. */
  account?: string;
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

/** Input parameters for the listMailRules tool (no params required). */
type ListMailRulesParams = Record<string, never>;

/** Input parameters for the checkMail tool. */
interface CheckMailParams {
  /** Account to check; every account when omitted. */
  account?: string;
}

const detectMailClientsTool: Tool = {
  name: 'detectMailClients',
  description:
    'Report the mail clients the mail tools can drive. Apple Mail is the only supported client; an installed Microsoft Outlook is listed as unsupported, with instructions for adding its account to Apple Mail.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'detect', 'clients', 'outlook', 'apple mail'],
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
            name: { type: 'string', description: '"Apple Mail" or "Microsoft Outlook"' },
            supported: {
              type: 'boolean',
              description: 'Whether the mail tools can drive this client',
            },
            instructions: {
              type: 'string',
              description: 'For an unsupported client: how to reach its account through Apple Mail',
            },
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
    "List mail accounts and mailboxes. Each mailbox's name is its path inside the account (Inbox/Clients for a nested one); pass it as listEmails/searchEmails's mailbox parameter (exact, case-sensitive) together with its account when the name exists in several accounts.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'mailboxes', 'accounts', 'inbox', 'folders'],
  example: 'const { mailboxes } = await os.listMailboxes()',
  inputSchema: {
    type: 'object',
    properties: {},
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
              description: 'Mailbox path inside the account; pass this to listEmails/searchEmails',
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
      description: 'List all mailboxes (no params)',
      input: {},
    },
  ],
};

const listEmailsTool: Tool = {
  name: 'listEmails',
  description: 'List emails in a mailbox. If limit is omitted, defaults to 10.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
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
          "Mailbox path (default: the Inbox of every account). Use the name field from listMailboxes' output.",
      },
      account: {
        type: 'string',
        description:
          'Account of the mailbox (the account field from listMailboxes); needed when the mailbox name exists in several accounts. Requires mailbox.',
      },
      limit: { type: 'number', description: 'Max emails to return (default 10)' },
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
            date: { type: 'string', description: 'Date received, as Apple Mail formats it' },
            read: { type: 'boolean' },
          },
        },
      },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: list recent inbox emails',
      input: { limit: 10 },
    },
    {
      description: 'Full: recent emails of a mailbox in one account',
      input: { mailbox: 'Archive', account: 'Exchange', limit: 20 },
    },
  ],
};

const getEmailTool: Tool = {
  name: 'getEmail',
  description:
    'Get a specific email by ID with full body. Only searches the Inbox: ids from other mailboxes are not resolvable.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'get', 'read', 'detail', 'body', 'content'],
  example: 'const { email } = await os.getEmail({ id: "msg-456" })',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Email message ID (must be from the Inbox)',
      },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      email: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          subject: { type: 'string' },
          sender: { type: 'string' },
          to: { type: 'array', items: { type: 'string' } },
          date: { type: 'string', description: 'Date received, as Apple Mail formats it' },
          read: { type: 'boolean' },
          body: { type: 'string', description: 'Email body (plain text)' },
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
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
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
          "Mailbox path to search (default: the Inbox of every account). Use the name field from listMailboxes' output.",
      },
      account: {
        type: 'string',
        description:
          'Account of the mailbox (the account field from listMailboxes); needed when the mailbox name exists in several accounts. Requires mailbox.',
      },
      limit: { type: 'number', description: 'Max results (default 10)' },
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
            date: { type: 'string', description: 'Date received, as Apple Mail formats it' },
          },
        },
      },
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
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
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
      status: { type: 'string', description: '"sent"' },
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

const replyToEmailTool: Tool = {
  name: 'replyToEmail',
  description:
    'Reply to an existing email. Requires confirm_send=true as safety check. Only searches the Inbox: ids from other mailboxes are not resolvable.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
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
        description: 'Email message ID to reply to (must be from the Inbox)',
      },
      body: { type: 'string', description: 'Reply body (plain text)' },
      reply_all: { type: 'boolean', description: 'Reply to all recipients (default false)' },
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

const listMailRulesTool: Tool = {
  name: 'listMailRules',
  description:
    "Read the user's Mail rules: name, whether each is enabled, its conditions and its actions. Use it to explain why mail lands in a mailbox, is marked read or is forwarded. Rules are read-only: no tool creates, changes or deletes a rule.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'rules', 'filters', 'forwarding', 'sorting'],
  example: 'const { rules } = await os.listMailRules()',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      rules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            enabled: { type: 'boolean' },
            match_all: {
              type: 'boolean',
              description: 'true: every condition must match; false: any one condition is enough',
            },
            conditions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: {
                    type: 'string',
                    description:
                      "What Mail tests, as Mail names it (e.g. 'from header', 'any recipient')",
                  },
                  header: {
                    type: 'string',
                    description: "The header name, present only when field is 'header key'",
                  },
                  qualifier: {
                    type: 'string',
                    description:
                      "How it is compared (e.g. 'does contain value', 'begins with value')",
                  },
                  expression: { type: 'string', description: 'The value compared against' },
                },
              },
            },
            actions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    description:
                      'move, copy, mark_read, mark_flagged, delete, forward, redirect, reply, run_script or stop_evaluating_rules',
                  },
                  mailbox: {
                    type: 'string',
                    description: 'Target mailbox path of a move or copy',
                  },
                  account: { type: 'string', description: 'Account of that mailbox' },
                  address: { type: 'string', description: 'Recipient of a forward or redirect' },
                  text: {
                    type: 'string',
                    description: 'Reply text of a reply, or the script path of run_script',
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  inputExamples: [
    {
      description: 'List all rules (no params)',
      input: {},
    },
  ],
};

const checkMailTool: Tool = {
  name: 'checkMail',
  description:
    'Ask Mail.app to fetch new mail for every account, or for one account. Mail fetches in the background: list or search again after a few seconds to see the new messages.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'check', 'fetch', 'refresh', 'new mail', 'sync'],
  example: 'await os.checkMail()',
  inputSchema: {
    type: 'object',
    properties: {
      account: {
        type: 'string',
        description:
          'Account to check (the account field from listMailboxes); every account when omitted.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: '"started": Mail is fetching in the background',
      },
      account: {
        type: 'string',
        description: 'The account checked; absent when every account was',
      },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: check every account',
      input: {},
    },
    {
      description: 'Full: check one account',
      input: { account: 'Exchange' },
    },
  ],
};

/**
 * Detects available mail clients on this device.
 * @param _params - Unused tool input parameters.
 */
export async function handleDetectMailClients(
  _params: DetectMailClientsParams
): Promise<ToolResult> {
  return runMail('detect_clients');
}

/**
 * Lists mail accounts and mailboxes/folders.
 * @param _params - Unused tool input parameters.
 */
export async function handleListMailboxes(_params: ListMailboxesParams): Promise<ToolResult> {
  return runMail('list_mailboxes');
}

/**
 * Lists emails in a mailbox.
 * @param params - Tool input parameters.
 */
export async function handleListEmails(params: ListEmailsParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    strings: [
      ['mailbox', MAX_LENGTHS.short, false],
      ['account', MAX_LENGTHS.short, false],
    ],
    numbers: [['limit', 1, 10_000]],
  });
  if (!v.valid) return v.error;
  return runMail('list_emails', p);
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
  return runMail('get_email', p);
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
      ['account', MAX_LENGTHS.short, false],
    ],
    numbers: [['limit', 1, 10_000]],
  });
  if (!v.valid) return v.error;
  return runMail('search_emails', p);
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
  return runMail('send_email', p);
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
  return runMail('reply_to_email', p);
}

/**
 * Reads the user's Mail rules.
 * @param _params - Unused tool input parameters.
 */
export async function handleListMailRules(_params: ListMailRulesParams): Promise<ToolResult> {
  return runMail('list_rules');
}

/**
 * Asks Mail.app to fetch new mail for every account or for one account.
 * @param params - Tool input parameters.
 */
export async function handleCheckMail(params: CheckMailParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    strings: [['account', MAX_LENGTHS.short, false]],
  });
  if (!v.valid) return v.error;
  return runMail('check_mail', p);
}

/**
 * Splits a hub timeout into the mail-cli process and script timeouts, each ending before the one above it.
 * @param toolMs - Hub timeout of the tool call.
 */
function mailTimeBudget(toolMs: number): MailTimeBudget {
  const processMs = toolMs - PROCESS_HEADROOM_MS;
  return { toolMs, processMs, scriptMs: processMs - SCRIPT_HEADROOM_MS };
}

/**
 * Runs a mail-cli command within a time budget; a failure mail-cli names comes back as a teaching error.
 * @param command - mail-cli command.
 * @param args - Tool arguments.
 * @param budget - Time budget of the call.
 */
async function runMail(
  command: string,
  args: MailArgs = {},
  budget: MailTimeBudget = STANDARD_BUDGET
): Promise<ToolResult> {
  try {
    const result = await runCommand(
      'mail',
      command,
      { ...args, script_timeout_ms: budget.scriptMs },
      budget.processMs
    );
    return { success: true, data: result.parsed };
  } catch (error) {
    const failure = mailFailureResult(error, args);
    if (failure) return failure;
    throw error;
  }
}

/**
 * The teaching error for a mail-cli failure that starts with a known `MAIL_*` code, or undefined.
 * @param error - What runCommand threw.
 * @param args - Tool arguments of the failed call.
 */
function mailFailureResult(error: unknown, args: MailArgs): ToolResult | undefined {
  const match = error instanceof Error ? MAIL_FAILURE.exec(error.message) : null;
  const teaching = match ? MAIL_FAILURE_TEACHING[match[1]] : undefined;
  if (!match || !teaching) return undefined;
  return teachingToolResult(teaching(match[2].trim(), args), match[1]);
}

/** Creates tool definitions for all mail operations. */
export function createMailTools(): ToolDefinition[] {
  return [
    guardedTool(detectMailClientsTool, handleDetectMailClients),
    guardedTool(listMailboxesTool, handleListMailboxes),
    guardedTool(listEmailsTool, handleListEmails),
    guardedTool(getEmailTool, handleGetEmail),
    guardedTool(searchEmailsTool, handleSearchEmails),
    guardedTool(sendEmailTool, handleSendEmail),
    guardedTool(replyToEmailTool, handleReplyToEmail),
    guardedTool(listMailRulesTool, handleListMailRules),
    guardedTool(checkMailTool, handleCheckMail),
  ];
}

/**
 * Pairs a tool with its validated handler, rejecting any argument its inputSchema does not declare.
 * @param tool - Tool definition.
 * @param handler - Handler returning a ToolResult.
 */
function guardedTool<T>(
  tool: Tool,
  handler: (params: T) => ToolResult | Promise<ToolResult>
): ToolDefinition {
  return { tool, handler: withDeclaredParams(tool, withValidation(handler)) };
}
