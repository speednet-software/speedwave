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

const BATCH_BUDGET = mailTimeBudget(120_000);

/** The most mails one batch tool acts on; mail-cli's `mailBatchLimit` holds the same number. */
const MAIL_BATCH_LIMIT = 25;

const SPLIT_BATCH_STEP = `Split the mail ids into batches of at most ${MAIL_BATCH_LIMIT} and confirm each batch with the user separately.`;

const RAW_TEXT_LIMIT = 100_000;

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
  MAIL_INVALID_ID: (detail, args) => ({
    paramName: 'id',
    received: args.id,
    correctValueTool: 'listEmails',
    nextStep: `${detail} Pass the id field of an email exactly as listEmails or searchEmails returns it.`,
  }),
  MAIL_NOT_FOUND: (detail, args) => ({
    paramName: 'id',
    received: args.id,
    correctValueTool: 'listEmails',
    nextStep: `${detail} List or search that mailbox again with listEmails or searchEmails and use a current id.`,
  }),
  MAIL_MAILBOX_CHANGED: (detail) => ({
    paramName: 'mailbox',
    nextStep: `${detail} New mail arrived or messages moved during the read; retry the same call once.`,
  }),
  MAIL_BATCH_TOO_LARGE: (detail) => ({
    paramName: 'ids',
    nextStep: `${detail} ${SPLIT_BATCH_STEP}`,
  }),
};

/** Input parameters for the detectMailClients tool (no params required). */
type DetectMailClientsParams = Record<string, never>;

/** Input parameters for the listMailboxes tool (no params required). */
type ListMailboxesParams = Record<string, never>;

/** Input parameters for the listEmails tool. */
interface ListEmailsParams {
  /** Mailbox path from listMailboxes. */
  mailbox: string;
  /** Account of the mailbox. */
  account?: string;
  /** Max emails to return. */
  limit?: number;
  /** Number of newest emails to skip. */
  offset?: number;
  /** List only unread emails. */
  unread_only?: boolean;
}

/** Input parameters for the getEmail tool. */
interface GetEmailParams {
  /** Mail id from listEmails or searchEmails. */
  id: string;
  /** Also return the full headers. */
  include_headers?: boolean;
  /** Also return the raw source. */
  include_source?: boolean;
}

/** Input parameters for the searchEmails tool. */
interface SearchEmailsParams {
  /** Search query string. */
  query: string;
  /** Mailbox path from listMailboxes. */
  mailbox: string;
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
  /** Mail id from listEmails or searchEmails. */
  id: string;
  /** Reply body in plain text. */
  body: string;
  /** Whether to reply to all recipients. */
  reply_all?: boolean;
  /** Safety check flag that must be true to send. */
  confirm_send: boolean;
}

/** Input parameters for the deleteEmails tool. */
interface DeleteEmailsParams {
  /** 1 to 25 mail ids from listEmails or searchEmails. */
  ids: string[];
  /** Must be true, after the user agreed to the preview, to move the emails to the Trash. */
  confirm_delete?: boolean;
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
    'List the mailboxes of every account, the On My Mac mailboxes under the account "On My Mac". Each mailbox\'s name is its path inside the account (Inbox/Clients for a nested one); pass it as listEmails/searchEmails\'s mailbox parameter (exact, case-sensitive) together with its account.',
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
  description:
    'List the emails of one mailbox, newest first. Page with offset and limit (default 10); total is the number of emails the page is cut from (unread ones only with unread_only). Each id is a mail id that getEmail and replyToEmail take.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'list', 'inbox', 'messages'],
  example: 'const { emails, total } = await os.listEmails({ mailbox: "INBOX", account: "iCloud" })',
  inputSchema: {
    type: 'object',
    properties: {
      mailbox: {
        type: 'string',
        description: "Mailbox path: the name field from listMailboxes' output.",
      },
      account: {
        type: 'string',
        description:
          'Account of the mailbox (the account field from listMailboxes); needed when the mailbox name exists in several accounts.',
      },
      limit: { type: 'number', description: 'Max emails to return (default 10)' },
      offset: {
        type: 'number',
        description: 'Number of newest emails to skip, for the next page (default 0)',
      },
      unread_only: { type: 'boolean', description: 'List only unread emails (default false)' },
    },
    required: ['mailbox'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      emails: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Mail id; pass it to getEmail or replyToEmail' },
            subject: { type: 'string' },
            sender: { type: 'string' },
            date: {
              type: 'string',
              description: 'Date received, ISO 8601 with the UTC offset; absent when Mail has none',
            },
            read: { type: 'boolean' },
            mailbox: { type: 'string' },
            account: { type: 'string' },
          },
        },
      },
      total: { type: 'number', description: 'Number of emails the page is cut from' },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: the newest emails of a mailbox',
      input: { mailbox: 'INBOX', account: 'iCloud' },
    },
    {
      description: 'Full: the second page of unread emails',
      input: { mailbox: 'Archive', account: 'Exchange', limit: 20, offset: 20, unread_only: true },
    },
  ],
};

const getEmailTool: Tool = {
  name: 'getEmail',
  description:
    'Get one email by the mail id listEmails or searchEmails returned, from any mailbox: sender, to, cc, ISO 8601 date, ' +
    'plain-text body and the list of attachments. Set include_headers or include_source to diagnose a suspicious ' +
    `email; headers or source longer than ${RAW_TEXT_LIMIT} characters are cut and flagged truncated.`,
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: [
    'os',
    'mail',
    'email',
    'get',
    'read',
    'detail',
    'body',
    'content',
    'cc',
    'attachments',
    'headers',
    'source',
  ],
  example: 'const { email } = await os.getEmail({ id: emails[0].id })',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Mail id from listEmails or searchEmails',
      },
      include_headers: {
        type: 'boolean',
        description: 'Also return every header of the email (default false)',
      },
      include_source: {
        type: 'boolean',
        description: 'Also return the raw RFC 822 source of the email (default false)',
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
          cc: { type: 'array', items: { type: 'string' } },
          date: {
            type: 'string',
            description:
              'Date received, ISO 8601 with the offset of the host; absent when Mail has none',
          },
          read: { type: 'boolean' },
          body: { type: 'string', description: 'Email body (plain text)' },
          mailbox: { type: 'string' },
          account: { type: 'string' },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: {
                  type: 'number',
                  description: 'Position of the attachment in the email, from 1',
                },
                name: { type: 'string' },
                size: {
                  type: 'number',
                  description: 'Size in bytes; absent when Mail does not know it',
                },
                mime_type: { type: 'string' },
              },
            },
          },
          headers: { type: 'string', description: 'Every header, only with include_headers' },
          headers_truncated: {
            type: 'boolean',
            description: `True when the headers were cut at ${RAW_TEXT_LIMIT} characters`,
          },
          source: { type: 'string', description: 'Raw source, only with include_source' },
          source_truncated: {
            type: 'boolean',
            description: `True when the source was cut at ${RAW_TEXT_LIMIT} characters`,
          },
        },
      },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: read an email by its mail id',
      input: { id: 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0' },
    },
    {
      description: 'Full: read a suspicious email with its headers and source',
      input: {
        id: 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
        include_headers: true,
        include_source: true,
      },
    },
  ],
};

const searchEmailsTool: Tool = {
  name: 'searchEmails',
  description:
    'Search the emails of one mailbox by subject or body content. If limit is omitted, defaults to 10. Each id is a mail id that getEmail and replyToEmail take.',
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
        description: "Mailbox path to search: the name field from listMailboxes' output.",
      },
      account: {
        type: 'string',
        description:
          'Account of the mailbox (the account field from listMailboxes); needed when the mailbox name exists in several accounts.',
      },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['query', 'mailbox'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      emails: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Mail id; pass it to getEmail or replyToEmail' },
            subject: { type: 'string' },
            sender: { type: 'string' },
            date: { type: 'string', description: 'Date received, as Apple Mail formats it' },
            mailbox: { type: 'string' },
            account: { type: 'string' },
          },
        },
      },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: search an inbox',
      input: { query: 'quarterly report', mailbox: 'INBOX', account: 'iCloud' },
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
    'Reply to an email in any mailbox, by the mail id listEmails or searchEmails returned. Requires confirm_send=true as safety check.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'reply', 'respond', 'answer'],
  example:
    'await os.replyToEmail({ id: emails[0].id, body: "Sounds good, let\'s proceed.", confirm_send: true })',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Mail id from listEmails or searchEmails',
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
      input: {
        id: 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
        body: 'Thanks, acknowledged.',
        confirm_send: true,
      },
    },
    {
      description: 'Full: reply all',
      input: {
        id: 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
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

const deleteEmailsTool: Tool = {
  name: 'deleteEmails',
  description:
    'Move 1 to 25 emails, by the mail ids listEmails or searchEmails returned, to the Trash of their own account; no tool deletes an email permanently. ' +
    'Without confirm_delete=true nothing changes: the call returns a preview of each email (sender, subject, date, mailbox), and you must show it and ask the user before calling again with confirm_delete=true. ' +
    'The confirmed call reports every email: ok, or the error that kept it where it is.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: BATCH_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'delete', 'remove', 'trash', 'bin'],
  example:
    'const preview = await os.deleteEmails({ ids: [emails[0].id] }); /* ask the user */ await os.deleteEmails({ ids: [emails[0].id], confirm_delete: true })',
  inputSchema: {
    type: 'object',
    properties: {
      ids: mailIdsProperty('Emails to move to the Trash'),
      confirm_delete: confirmProperty('move the emails to the Trash'),
    },
    required: ['ids'],
  },
  outputSchema: gatedBatchOutputSchema(),
  inputExamples: [
    {
      description: 'Minimal: preview one email before asking the user',
      input: { ids: ['mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0'] },
    },
    {
      description: 'Full: move two emails to the Trash after the user agreed',
      input: {
        ids: [
          'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
          'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxiQHg-Il0',
        ],
        confirm_delete: true,
      },
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
    required: ['mailbox'],
    booleans: ['unread_only'],
    strings: [
      ['mailbox', MAX_LENGTHS.short, false],
      ['account', MAX_LENGTHS.short, false],
    ],
    numbers: [
      ['limit', 1, 10_000],
      ['offset', 0, 1_000_000],
    ],
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
    booleans: ['include_headers', 'include_source'],
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
    required: ['query', 'mailbox'],
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
 * Moves emails to the Trash of their account; without confirm_delete mail-cli only previews them.
 * @param params - Tool input parameters.
 */
export async function handleDeleteEmails(params: DeleteEmailsParams): Promise<ToolResult> {
  const p = asRecord(params);
  const invalid = mailBatchError(p);
  if (invalid) return invalid;
  const v = validateAll(p, { booleans: ['confirm_delete'] });
  if (!v.valid) return v.error;
  return runMail('delete_emails', p, BATCH_BUDGET);
}

/**
 * The input schema of a batch tool's `ids`: 1 to {@link MAIL_BATCH_LIMIT} mail ids.
 * @param what - What the ids name.
 */
function mailIdsProperty(what: string): Record<string, unknown> {
  return {
    type: 'array',
    items: { type: 'string' },
    minItems: 1,
    maxItems: MAIL_BATCH_LIMIT,
    description: `${what}: 1 to ${MAIL_BATCH_LIMIT} mail ids from listEmails or searchEmails. ${SPLIT_BATCH_STEP}`,
  };
}

/**
 * The input schema of a confirmation gate's `confirm_*` flag.
 * @param action - What the confirmed call does.
 */
function confirmProperty(action: string): Record<string, unknown> {
  return {
    type: 'boolean',
    description:
      `Set true only after the user saw the preview and agreed to ${action}. ` +
      'Without it nothing changes and the call returns the preview.',
  };
}

/** The output schema of a gated batch tool: its preview, or its per-mail report. */
function gatedBatchOutputSchema(): Tool['outputSchema'] {
  return {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description:
          '"confirmation_required" (nothing changed: ask the user), or after confirmation "completed", "partial" or "failed"',
      },
      confirm_param: {
        type: 'string',
        description: 'Preview only: the flag to set true once the user agreed',
      },
      instruction: { type: 'string', description: 'Preview only: what to ask the user' },
      emails: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Mail id' },
            ok: {
              type: 'boolean',
              description: 'Preview: the email was found. Report: the action succeeded',
            },
            subject: { type: 'string' },
            sender: { type: 'string' },
            date: { type: 'string', description: 'Date received, ISO 8601 with the UTC offset' },
            mailbox: { type: 'string' },
            account: { type: 'string' },
            error: { type: 'string', description: 'Why this email was not found or not changed' },
          },
        },
      },
      succeeded: { type: 'number', description: 'Report only: emails the action succeeded on' },
      failed: { type: 'number', description: 'Report only: emails left unchanged' },
    },
  };
}

/**
 * The teaching error for a batch's `ids` that is not 1 to {@link MAIL_BATCH_LIMIT} mail ids, or undefined.
 * @param p - Tool arguments.
 */
function mailBatchError(p: Record<string, unknown>): ToolResult | undefined {
  const ids = p.ids;
  if (ids === undefined || ids === null) {
    return teachingToolResult(
      {
        paramName: 'ids',
        nextStep: 'Pass ids as an array of mail ids from listEmails or searchEmails.',
      },
      'MISSING_FIELDS'
    );
  }
  if (Array.isArray(ids) && ids.length === 0) {
    return teachingToolResult(
      { paramName: 'ids', received: ids, nextStep: 'Pass at least one mail id.' },
      'EMPTY_FIELDS'
    );
  }
  if (Array.isArray(ids) && ids.length > MAIL_BATCH_LIMIT) {
    return teachingToolResult(
      {
        paramName: 'ids',
        received: `${ids.length} mail ids`,
        nextStep: `One call takes at most ${MAIL_BATCH_LIMIT} mail ids. ${SPLIT_BATCH_STEP}`,
      },
      'MAIL_BATCH_TOO_LARGE'
    );
  }
  const v = validateAll(p, { stringArrays: [['ids', MAIL_BATCH_LIMIT, MAX_LENGTHS.id]] });
  return v.valid ? undefined : v.error;
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
    guardedTool(deleteEmailsTool, handleDeleteEmails),
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
