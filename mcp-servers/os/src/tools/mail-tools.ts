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

const BODY_SEARCH_BUDGET = mailTimeBudget(180_000);

const BATCH_BUDGET = mailTimeBudget(120_000);

const READ_THEN_SEND_BUDGET = mailTimeBudget(60_000, 2);

const PLAIN_TEXT_ONLY =
  'Plain text only: line breaks are kept, HTML is sent as literal text, and no file can be attached.';

/** The most mails one batch tool acts on; mail-cli's `mailBatchLimit` holds the same number. */
const MAIL_BATCH_LIMIT = 25;

const SIGNATURE_PROPERTY = {
  type: 'string',
  description:
    "Name of a Mail signature, exactly as listMailSignatures returns it; Mail's default signature for the account when omitted",
};

const SPLIT_BATCH_STEP = `Split the mail ids into batches of at most ${MAIL_BATCH_LIMIT} and confirm each batch with the user separately.`;

const RAW_TEXT_LIMIT = 100_000;

/** Flag colors in the order of Mail's flag index, then `none`; mail-cli's `mailFlagColors` holds the same colors. */
const MAIL_FLAG_VALUES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray', 'none'];

const EXAMPLE_IDS = [
  'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
  'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxiQHg-Il0',
];

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
    nextStep:
      `${detail} Pass the name and account of a mailbox exactly as listMailboxes returns them; ` +
      'a mailbox the user wants that does not exist yet is made with createMailbox.',
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
  MAIL_SEND_FAILED: (detail) => ({
    paramName: 'request',
    nextStep:
      `${detail} Tell the user the message was not sent and ask them to check the Outbox in Mail.app; ` +
      'do not retry without asking.',
  }),
  MAIL_SIGNATURE_NOT_FOUND: (detail, args) => ({
    paramName: 'signature',
    received: args.signature,
    correctValueTool: 'listMailSignatures',
    nextStep: `${detail} Pass a name listMailSignatures returns, or leave signature out for Mail's default.`,
  }),
  MAIL_BATCH_TOO_LARGE: (detail) => ({
    paramName: 'ids',
    nextStep: `${detail} ${SPLIT_BATCH_STEP}`,
  }),
  MAIL_MAILBOX_EXISTS: (detail, args) => ({
    paramName: 'name',
    received: args.name,
    nextStep: `${detail} Do not create it again: pass it to moveEmails or copyEmails as it is.`,
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
  /** Text the subject or the sender contains. */
  query: string;
  /** Mailbox path from listMailboxes. */
  mailbox: string;
  /** Account of the mailbox. */
  account?: string;
  /** Also match the body; slow. */
  search_body?: boolean;
  /** Text the sender contains. */
  sender?: string;
  /** Received at or after this ISO 8601 day or date-time. */
  since?: string;
  /** Received before this ISO 8601 day or date-time. */
  before?: string;
  /** Only unread emails. */
  unread_only?: boolean;
  /** Max results to return. */
  limit?: number;
  /** Number of newest results to skip. */
  offset?: number;
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
  /** Name of a Mail signature from listMailSignatures. */
  signature?: string;
  /** Must be true, after the user agreed to the preview, to send. */
  confirm_send?: boolean;
}

/** Input parameters for the saveDraft tool. */
interface SaveDraftParams {
  /** Email subject. */
  subject: string;
  /** Email body in plain text. */
  body?: string;
  /** Recipient email address(es), comma-separated. */
  to?: string;
  /** CC recipient(s), comma-separated. */
  cc?: string;
  /** BCC recipient(s), comma-separated. */
  bcc?: string;
  /** Account whose Drafts mailbox keeps the draft. */
  account?: string;
  /** Name of a Mail signature from listMailSignatures. */
  signature?: string;
}

/** Input parameters for the listMailSignatures tool (no params required). */
type ListMailSignaturesParams = Record<string, never>;

/** Input parameters for the replyToEmail tool. */
interface ReplyToEmailParams {
  /** Mail id from listEmails or searchEmails. */
  id: string;
  /** Reply body in plain text. */
  body: string;
  /** Whether to reply to all recipients. */
  reply_all?: boolean;
  /** Name of a Mail signature from listMailSignatures. */
  signature?: string;
  /** Must be true, after the user agreed to the preview, to send. */
  confirm_send?: boolean;
}

/** Input parameters for the forwardEmail tool. */
interface ForwardEmailParams {
  /** Mail id from listEmails or searchEmails. */
  id: string;
  /** Recipient(s), comma-separated. */
  to: string;
  /** CC recipient(s), comma-separated. */
  cc?: string;
  /** Plain text above the forwarded email. */
  comment?: string;
  /** Must be true, after the user agreed to the preview, to send. */
  confirm_send?: boolean;
}

/** Input parameters for the redirectEmail tool. */
interface RedirectEmailParams {
  /** Mail id from listEmails or searchEmails. */
  id: string;
  /** Recipient(s), comma-separated. */
  to: string;
  /** CC recipient(s), comma-separated. */
  cc?: string;
  /** Must be true, after the user agreed to the preview, to send. */
  confirm_send?: boolean;
}

/** Input parameters for the deleteEmails tool. */
interface DeleteEmailsParams {
  /** 1 to 25 mail ids from listEmails or searchEmails. */
  ids: string[];
  /** Must be true, after the user agreed to the preview, to move the emails to the Trash. */
  confirm_delete?: boolean;
}

/** Input parameters for the markEmailsRead tool. */
interface MarkEmailsReadParams {
  /** 1 to 25 mail ids from listEmails or searchEmails. */
  ids: string[];
  /** true marks the emails read, false unread. */
  read: boolean;
}

/** Input parameters for the flagEmails tool. */
interface FlagEmailsParams {
  /** 1 to 25 mail ids from listEmails or searchEmails. */
  ids: string[];
  /** Flag color, or none to take the flag off. */
  flag: string;
}

/** Input parameters for the moveEmails and copyEmails tools. */
interface TargetEmailsParams {
  /** 1 to 25 mail ids from listEmails or searchEmails. */
  ids: string[];
  /** Target mailbox path from listMailboxes. */
  mailbox: string;
  /** Account of the target mailbox. */
  account: string;
}

/** Input parameters for the archiveEmails tool. */
interface ArchiveEmailsParams {
  /** 1 to 25 mail ids from listEmails or searchEmails. */
  ids: string[];
}

/** Input parameters for the createMailbox tool. */
interface CreateMailboxParams {
  /** Mailbox path to create. */
  name: string;
  /** Account to create it in. */
  account: string;
}

/** Input parameters for the markEmailsSpam tool. */
interface MarkEmailsSpamParams {
  /** 1 to 25 mail ids from listEmails or searchEmails. */
  ids: string[];
  /** Must be true, after the user agreed to the preview, to mark the emails as spam. */
  confirm_spam?: boolean;
}

/** Input parameters for the listMailRules tool (no params required). */
type ListMailRulesParams = Record<string, never>;

/** Input parameters for the checkMail tool. */
interface CheckMailParams {
  /** Account to check; every account when omitted. */
  account?: string;
}

const EMAIL_LISTING_OUTPUT = {
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
};

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
  outputSchema: EMAIL_LISTING_OUTPUT,
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
    'Search one mailbox for emails whose subject or sender contains the query, newest first. Narrow with sender, since/before (ISO 8601) and unread_only; page with offset and limit (default 10); total is the number of matches the page is cut from. Fast even in a large mailbox. Set search_body only when the user asks to search the email text: Mail then scans every body, which can take minutes. Each id is a mail id that getEmail and replyToEmail take.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_CLASS]: 'long',
    [META_KEYS.TIMEOUT_MS]: BODY_SEARCH_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'search', 'find', 'query', 'sender', 'from'],
  example:
    'const { emails, total } = await os.searchEmails({ query: "invoice", mailbox: "INBOX", account: "iCloud" })',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text the subject or the sender contains (case-insensitive)',
      },
      mailbox: {
        type: 'string',
        description: "Mailbox path to search: the name field from listMailboxes' output.",
      },
      account: {
        type: 'string',
        description:
          'Account of the mailbox (the account field from listMailboxes); needed when the mailbox name exists in several accounts.',
      },
      search_body: {
        type: 'boolean',
        description:
          'Also match the email text (default false). Slow: Mail scans every body of the mailbox, which can take minutes; use only when the user asks to search the content.',
      },
      sender: { type: 'string', description: 'Only emails whose sender contains this text' },
      since: {
        type: 'string',
        description:
          'Only emails received at or after this ISO 8601 day (2026-10-01, local midnight) or date-time',
      },
      before: {
        type: 'string',
        description: 'Only emails received before this ISO 8601 day or date-time',
      },
      unread_only: { type: 'boolean', description: 'Only unread emails (default false)' },
      limit: { type: 'number', description: 'Max results (default 10)' },
      offset: {
        type: 'number',
        description: 'Number of newest matches to skip, for the next page (default 0)',
      },
    },
    required: ['query', 'mailbox'],
  },
  outputSchema: EMAIL_LISTING_OUTPUT,
  inputExamples: [
    {
      description: 'Minimal: subject or sender search in an inbox',
      input: { query: 'quarterly report', mailbox: 'INBOX', account: 'iCloud' },
    },
    {
      description: 'Full: unread mail from one sender this month, the email text included',
      input: {
        query: 'invoice',
        mailbox: 'Archive',
        account: 'Exchange',
        sender: 'billing@example.com',
        since: '2026-10-01',
        before: '2026-11-01',
        unread_only: true,
        search_body: true,
        limit: 20,
        offset: 0,
      },
    },
  ],
};

const sendEmailTool: Tool = {
  name: 'sendEmail',
  description:
    `Send a new plain-text email through Apple Mail. ${PLAIN_TEXT_ONLY} ` +
    'Without confirm_send=true nothing is sent: the call returns a preview of the recipients (to, cc, bcc), subject and text, and you must show it and ask the user before calling again with the same arguments and confirm_send=true. ' +
    'Sending cannot be undone.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'send', 'compose', 'write', 'new'],
  example:
    'const preview = await os.sendEmail({ to: "alice@example.com", subject: "Meeting notes", body: "Notes below." }); /* ask the user */ await os.sendEmail({ to: "alice@example.com", subject: "Meeting notes", body: "Notes below.", confirm_send: true })',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: `Email text. ${PLAIN_TEXT_ONLY}` },
      cc: { type: 'string', description: 'CC recipient(s), comma-separated' },
      bcc: { type: 'string', description: 'BCC recipient(s), comma-separated' },
      signature: SIGNATURE_PROPERTY,
      confirm_send: confirmProperty('send this email'),
    },
    required: ['to', 'subject', 'body'],
  },
  outputSchema: sendOutputSchema(true),
  inputExamples: [
    {
      description: 'Minimal: preview an email before asking the user',
      input: {
        to: 'alice@example.com',
        subject: 'Quick update',
        body: 'Everything looks good.',
      },
    },
    {
      description: 'Full: send with CC and BCC after the user agreed',
      input: {
        to: 'alice@example.com',
        subject: 'Q4 Report',
        body: 'The Q4 numbers are below.',
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
    'Reply to an email in any mailbox, by the mail id listEmails or searchEmails returned; Mail picks the recipients and the "Re:" subject, reply_all adds every recipient of the email. ' +
    `The text goes above the quoted original, separated by a blank line and an "On <date>, <sender> wrote:" line. ${PLAIN_TEXT_ONLY} ` +
    'Without confirm_send=true nothing is sent: the call returns a preview of the recipients, subject and the full text, and you must show it and ask the user before calling again with the same arguments and confirm_send=true. ' +
    'Sending cannot be undone.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: READ_THEN_SEND_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'reply', 'respond', 'answer'],
  example:
    'const preview = await os.replyToEmail({ id: emails[0].id, body: "Sounds good." }); /* ask the user */ await os.replyToEmail({ id: emails[0].id, body: "Sounds good.", confirm_send: true })',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Mail id from listEmails or searchEmails',
      },
      body: { type: 'string', description: `Reply text, without the quote. ${PLAIN_TEXT_ONLY}` },
      reply_all: { type: 'boolean', description: 'Reply to all recipients (default false)' },
      signature: SIGNATURE_PROPERTY,
      confirm_send: confirmProperty('send this reply'),
    },
    required: ['id', 'body'],
  },
  outputSchema: sendOutputSchema(false),
  inputExamples: [
    {
      description: 'Minimal: preview a reply to the sender before asking the user',
      input: {
        id: 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
        body: 'Thanks, acknowledged.',
      },
    },
    {
      description: 'Full: reply to all after the user agreed',
      input: {
        id: 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
        body: 'I agree with the proposed timeline.',
        reply_all: true,
        confirm_send: true,
      },
    },
  ],
};

const forwardEmailTool: Tool = {
  name: 'forwardEmail',
  description:
    'Forward an email in any mailbox, by the mail id listEmails or searchEmails returned, with its attachments, through Mail\'s own forward (Mail picks the "Fwd:" subject and quotes the email); an optional plain-text comment goes above it. ' +
    'Without confirm_send=true nothing is sent: the call returns a preview of the recipients, subject, comment, the forwarded email and its attachment names, and you must show it and ask the user before calling again with the same arguments and confirm_send=true. ' +
    'Sending cannot be undone.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: READ_THEN_SEND_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'forward', 'fwd', 'share', 'pass on'],
  example:
    'const preview = await os.forwardEmail({ id: emails[0].id, to: "bob@example.com", comment: "FYI" }); /* ask the user */ await os.forwardEmail({ id: emails[0].id, to: "bob@example.com", comment: "FYI", confirm_send: true })',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Mail id from listEmails or searchEmails' },
      to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
      cc: { type: 'string', description: 'CC recipient(s), comma-separated' },
      comment: {
        type: 'string',
        description: 'Text above the forwarded email. Plain text only: line breaks are kept.',
      },
      confirm_send: confirmProperty('forward this email'),
    },
    required: ['id', 'to'],
  },
  outputSchema: passOnOutputSchema(true),
  inputExamples: [
    {
      description: 'Minimal: preview a forward before asking the user',
      input: { id: 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0', to: 'bob@example.com' },
    },
    {
      description: 'Full: forward with a comment and CC after the user agreed',
      input: {
        id: 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
        to: 'bob@example.com',
        cc: 'carol@example.com',
        comment: 'Please handle this invoice.',
        confirm_send: true,
      },
    },
  ],
};

const redirectEmailTool: Tool = {
  name: 'redirectEmail',
  description:
    'Redirect an email in any mailbox, by the mail id listEmails or searchEmails returned: Mail sends it unchanged, with its attachments, and the recipients see it as coming from its original sender; no comment can be added (use forwardEmail for that). ' +
    'Without confirm_send=true nothing is sent: the call returns a preview of the recipients, the redirected email and its attachment names, and you must show it and ask the user before calling again with the same arguments and confirm_send=true. ' +
    'Sending cannot be undone.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: READ_THEN_SEND_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'redirect', 'bounce', 'resend', 'pass on'],
  example:
    'const preview = await os.redirectEmail({ id: emails[0].id, to: "bob@example.com" }); /* ask the user */ await os.redirectEmail({ id: emails[0].id, to: "bob@example.com", confirm_send: true })',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Mail id from listEmails or searchEmails' },
      to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
      cc: { type: 'string', description: 'CC recipient(s), comma-separated' },
      confirm_send: confirmProperty('redirect this email'),
    },
    required: ['id', 'to'],
  },
  outputSchema: passOnOutputSchema(false),
  inputExamples: [
    {
      description: 'Minimal: preview a redirect before asking the user',
      input: { id: 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0', to: 'bob@example.com' },
    },
    {
      description: 'Full: redirect with CC after the user agreed',
      input: {
        id: 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
        to: 'bob@example.com',
        cc: 'carol@example.com',
        confirm_send: true,
      },
    },
  ],
};

const saveDraftTool: Tool = {
  name: 'saveDraft',
  description:
    `Save a new plain-text email as a draft in Apple Mail without sending it, for the user to finish and send in Mail.app. ${PLAIN_TEXT_ONLY} ` +
    "The draft lands in the Drafts mailbox of account (Mail's default account when omitted). No confirmation is needed: nothing is sent and the user can delete the draft. " +
    'Recipients and text are optional.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'draft', 'compose', 'write', 'save'],
  example:
    'await os.saveDraft({ to: "alice@example.com", subject: "Meeting notes", body: "Notes below." })',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: `Email text. ${PLAIN_TEXT_ONLY}` },
      to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
      cc: { type: 'string', description: 'CC recipient(s), comma-separated' },
      bcc: { type: 'string', description: 'BCC recipient(s), comma-separated' },
      account: {
        type: 'string',
        description:
          "Account the draft is written from and whose Drafts keep it (the account field from listMailboxes); Mail's default account when omitted",
      },
      signature: SIGNATURE_PROPERTY,
    },
    required: ['subject'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"saved": the draft is in Drafts, nothing was sent' },
      to: { type: 'array', items: { type: 'string' }, description: 'To addresses' },
      cc: { type: 'array', items: { type: 'string' }, description: 'CC addresses' },
      bcc: { type: 'array', items: { type: 'string' }, description: 'BCC addresses' },
      subject: { type: 'string' },
      body: { type: 'string', description: 'The plain text saved' },
      account: { type: 'string', description: 'The account given; absent for the default account' },
      signature: { type: 'string', description: 'The signature chosen; absent when none was' },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: a draft with only a subject',
      input: { subject: 'Ideas for Q1' },
    },
    {
      description: 'Full: a draft in one account with recipients and a signature',
      input: {
        subject: 'Q4 Report',
        body: 'The Q4 numbers are below.',
        to: 'alice@example.com',
        cc: 'bob@example.com',
        bcc: 'carol@example.com',
        account: 'Work',
        signature: 'Work',
      },
    },
  ],
};

const listMailSignaturesTool: Tool = {
  name: 'listMailSignatures',
  description:
    "List the names of the user's Apple Mail signatures; pass one as signature to sendEmail, replyToEmail or saveDraft.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'signature', 'signatures'],
  example: 'const { signatures } = await os.listMailSignatures()',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      signatures: {
        type: 'array',
        items: { type: 'string' },
        description: 'Signature names, as Mail lists them',
      },
    },
  },
  inputExamples: [
    {
      description: 'List all signatures (no params)',
      input: {},
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

const markEmailsReadTool: Tool = {
  name: 'markEmailsRead',
  description:
    'Mark 1 to 25 emails, by the mail ids listEmails or searchEmails returned, as read (read=true) or unread (read=false). ' +
    'Reversible, so no confirmation is needed. Reports every email: ok, or the error that left it unchanged.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: BATCH_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'read', 'unread', 'mark', 'seen'],
  example: 'await os.markEmailsRead({ ids: [emails[0].id], read: true })',
  inputSchema: {
    type: 'object',
    properties: {
      ids: mailIdsProperty('Emails to mark'),
      read: { type: 'boolean', description: 'true: mark read; false: mark unread' },
    },
    required: ['ids', 'read'],
  },
  outputSchema: batchReportOutputSchema(),
  inputExamples: [
    { description: 'Minimal: mark one email read', input: { ids: [EXAMPLE_IDS[0]], read: true } },
    { description: 'Full: mark two emails unread', input: { ids: EXAMPLE_IDS, read: false } },
  ],
};

const flagEmailsTool: Tool = {
  name: 'flagEmails',
  description:
    'Flag 1 to 25 emails, by the mail ids listEmails or searchEmails returned, with a color, or take the flag off with flag "none". ' +
    'Reversible, so no confirmation is needed. Reports every email: ok, or the error that left it unchanged.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: BATCH_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'flag', 'unflag', 'color', 'mark', 'follow up'],
  example: 'await os.flagEmails({ ids: [emails[0].id], flag: "red" })',
  inputSchema: {
    type: 'object',
    properties: {
      ids: mailIdsProperty('Emails to flag'),
      flag: {
        type: 'string',
        enum: MAIL_FLAG_VALUES,
        description: 'Flag color, or "none" to take the flag off',
      },
    },
    required: ['ids', 'flag'],
  },
  outputSchema: batchReportOutputSchema(),
  inputExamples: [
    { description: 'Minimal: flag one email red', input: { ids: [EXAMPLE_IDS[0]], flag: 'red' } },
    {
      description: 'Full: take the flag off two emails',
      input: { ids: EXAMPLE_IDS, flag: 'none' },
    },
  ],
};

const moveEmailsTool: Tool = {
  name: 'moveEmails',
  description:
    'Move 1 to 25 emails, by the mail ids listEmails or searchEmails returned, to a mailbox named together with its account (as listMailboxes returns them). ' +
    'Reversible, so no confirmation is needed; a target that does not exist fails the call and nothing moves. ' +
    'Reports every email: ok, or the error that left it where it is. A moved email gets a new mail id: list the target mailbox to act on it again.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: BATCH_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'move', 'file', 'folder', 'sort', 'organize'],
  example:
    'await os.moveEmails({ ids: [emails[0].id], mailbox: "Clients/Acme", account: "iCloud" })',
  inputSchema: {
    type: 'object',
    properties: {
      ids: mailIdsProperty('Emails to move'),
      mailbox: targetMailboxProperty(),
      account: targetAccountProperty(),
    },
    required: ['ids', 'mailbox', 'account'],
  },
  outputSchema: batchReportOutputSchema(),
  inputExamples: [
    {
      description: 'Minimal: move one email',
      input: { ids: [EXAMPLE_IDS[0]], mailbox: 'Receipts', account: 'iCloud' },
    },
    {
      description: 'Full: move two emails to a nested mailbox on this Mac',
      input: { ids: EXAMPLE_IDS, mailbox: 'Clients/Acme', account: 'On My Mac' },
    },
  ],
};

const copyEmailsTool: Tool = {
  name: 'copyEmails',
  description:
    'Copy 1 to 25 emails, by the mail ids listEmails or searchEmails returned, to a mailbox named together with its account (as listMailboxes returns them); the originals stay where they are. ' +
    'No confirmation is needed; a target that does not exist fails the call and nothing is copied. Reports every email: ok, or the error that kept it from being copied.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: BATCH_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'copy', 'duplicate', 'folder'],
  example:
    'await os.copyEmails({ ids: [emails[0].id], mailbox: "Clients/Acme", account: "iCloud" })',
  inputSchema: {
    type: 'object',
    properties: {
      ids: mailIdsProperty('Emails to copy'),
      mailbox: targetMailboxProperty(),
      account: targetAccountProperty(),
    },
    required: ['ids', 'mailbox', 'account'],
  },
  outputSchema: batchReportOutputSchema(),
  inputExamples: [
    {
      description: 'Minimal: copy one email',
      input: { ids: [EXAMPLE_IDS[0]], mailbox: 'Receipts', account: 'iCloud' },
    },
    {
      description: 'Full: copy two emails to a mailbox on this Mac',
      input: { ids: EXAMPLE_IDS, mailbox: 'Clients/Acme', account: 'On My Mac' },
    },
  ],
};

const archiveEmailsTool: Tool = {
  name: 'archiveEmails',
  description:
    'Archive 1 to 25 emails, by the mail ids listEmails or searchEmails returned: each moves to the Archive mailbox of its own account (All Mail on Gmail). ' +
    'Reversible, so no confirmation is needed. An account without an archive mailbox leaves the email where it is and reports MAIL_ARCHIVE_NOT_FOUND for it; then ask the user where to keep it and use moveEmails.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: BATCH_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'archive', 'clean', 'inbox zero'],
  example: 'await os.archiveEmails({ ids: [emails[0].id] })',
  inputSchema: {
    type: 'object',
    properties: {
      ids: mailIdsProperty('Emails to archive'),
    },
    required: ['ids'],
  },
  outputSchema: batchReportOutputSchema(),
  inputExamples: [
    { description: 'Minimal: archive one email', input: { ids: [EXAMPLE_IDS[0]] } },
    { description: 'Full: archive two emails', input: { ids: EXAMPLE_IDS } },
  ],
};

const createMailboxTool: Tool = {
  name: 'createMailbox',
  description:
    'Create a mailbox in an account (the account field from listMailboxes, "On My Mac" for a local one). ' +
    'name is its path inside the account; Clients/Acme makes Acme inside Clients. An existing mailbox is refused (MAIL_MAILBOX_EXISTS), never reused. ' +
    'No tool deletes a mailbox.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'mailbox', 'folder', 'create', 'new'],
  example: 'await os.createMailbox({ name: "Clients/Acme", account: "iCloud" })',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Path of the new mailbox inside the account, e.g. Receipts or Clients/Acme',
      },
      account: {
        type: 'string',
        description:
          'Account to create it in: the account field from listMailboxes, or "On My Mac"',
      },
    },
    required: ['name', 'account'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"created"' },
      mailbox: { type: 'string', description: 'Path of the new mailbox; pass it to moveEmails' },
      account: { type: 'string' },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: a mailbox in an account',
      input: { name: 'Receipts', account: 'iCloud' },
    },
    {
      description: 'Full: a nested mailbox on this Mac',
      input: { name: 'Clients/Acme', account: 'On My Mac' },
    },
  ],
};

const markEmailsSpamTool: Tool = {
  name: 'markEmailsSpam',
  description:
    "Mark 1 to 25 emails, by the mail ids listEmails or searchEmails returned, as spam: Mail's junk filter learns from them and each moves to the Junk mailbox of its own account. " +
    'Without confirm_spam=true nothing changes: the call returns a preview of each email (sender, subject, date, mailbox), and you must show it and ask the user before calling again with confirm_spam=true. ' +
    'The confirmed call reports every email: ok, or the error that kept it where it is.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: BATCH_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'spam', 'junk', 'phishing', 'filter'],
  example:
    'const preview = await os.markEmailsSpam({ ids: [emails[0].id] }); /* ask the user */ await os.markEmailsSpam({ ids: [emails[0].id], confirm_spam: true })',
  inputSchema: {
    type: 'object',
    properties: {
      ids: mailIdsProperty('Emails to mark as spam'),
      confirm_spam: confirmProperty('mark the emails as spam'),
    },
    required: ['ids'],
  },
  outputSchema: gatedBatchOutputSchema(),
  inputExamples: [
    {
      description: 'Minimal: preview one email before asking the user',
      input: { ids: [EXAMPLE_IDS[0]] },
    },
    {
      description: 'Full: mark two emails as spam after the user agreed',
      input: { ids: EXAMPLE_IDS, confirm_spam: true },
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
 * Searches one mailbox by subject and sender, and by body only when search_body is set.
 * @param params - Tool input parameters.
 */
export async function handleSearchEmails(params: SearchEmailsParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['query', 'mailbox'],
    booleans: ['search_body', 'unread_only'],
    strings: [
      ['query', MAX_LENGTHS.short, false],
      ['mailbox', MAX_LENGTHS.short, false],
      ['account', MAX_LENGTHS.short, false],
      ['sender', MAX_LENGTHS.short, false],
      ['since', MAX_LENGTHS.short, false],
      ['before', MAX_LENGTHS.short, false],
    ],
    numbers: [
      ['limit', 1, 10_000],
      ['offset', 0, 1_000_000],
    ],
  });
  if (!v.valid) return v.error;
  return runMail('search_emails', p, p.search_body === true ? BODY_SEARCH_BUDGET : STANDARD_BUDGET);
}

/**
 * Sends a new email; without confirm_send mail-cli only previews it.
 * @param params - Tool input parameters.
 */
export async function handleSendEmail(params: SendEmailParams): Promise<ToolResult> {
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
      ['signature', MAX_LENGTHS.short, false],
    ],
  });
  if (!v.valid) return v.error;
  return runMail('send_email', p);
}

/**
 * Saves a new email as a draft without sending it.
 * @param params - Tool input parameters.
 */
export async function handleSaveDraft(params: SaveDraftParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['subject'],
    strings: [
      ['subject', MAX_LENGTHS.short, false],
      ['body', MAX_LENGTHS.body, true],
      ['to', MAX_LENGTHS.short, false],
      ['cc', MAX_LENGTHS.short, false],
      ['bcc', MAX_LENGTHS.short, false],
      ['account', MAX_LENGTHS.short, false],
      ['signature', MAX_LENGTHS.short, false],
    ],
  });
  if (!v.valid) return v.error;
  return runMail('save_draft', p);
}

/**
 * Lists the names of the user's Mail signatures.
 * @param _params - Unused tool input parameters.
 */
export async function handleListMailSignatures(
  _params: ListMailSignaturesParams
): Promise<ToolResult> {
  return runMail('list_signatures');
}

/**
 * Replies to an email; without confirm_send mail-cli only previews the reply.
 * @param params - Tool input parameters.
 */
export async function handleReplyToEmail(params: ReplyToEmailParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id', 'body'],
    booleans: ['confirm_send', 'reply_all'],
    strings: [
      ['id', MAX_LENGTHS.id, false],
      ['body', MAX_LENGTHS.body, true],
      ['signature', MAX_LENGTHS.short, false],
    ],
  });
  if (!v.valid) return v.error;
  return runMail('reply_to_email', p, READ_THEN_SEND_BUDGET);
}

/**
 * Forwards an email with its attachments; without confirm_send mail-cli only previews the forward.
 * @param params - Tool input parameters.
 */
export async function handleForwardEmail(params: ForwardEmailParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id', 'to'],
    booleans: ['confirm_send'],
    strings: [
      ['id', MAX_LENGTHS.id, false],
      ['to', MAX_LENGTHS.short, false],
      ['cc', MAX_LENGTHS.short, false],
      ['comment', MAX_LENGTHS.body, true],
    ],
  });
  if (!v.valid) return v.error;
  return runMail('forward_email', p, READ_THEN_SEND_BUDGET);
}

/**
 * Redirects an email unchanged; without confirm_send mail-cli only previews the redirect.
 * @param params - Tool input parameters.
 */
export async function handleRedirectEmail(params: RedirectEmailParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id', 'to'],
    booleans: ['confirm_send'],
    strings: [
      ['id', MAX_LENGTHS.id, false],
      ['to', MAX_LENGTHS.short, false],
      ['cc', MAX_LENGTHS.short, false],
    ],
  });
  if (!v.valid) return v.error;
  return runMail('redirect_email', p, READ_THEN_SEND_BUDGET);
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
 * Marks emails read or unread.
 * @param params - Tool input parameters.
 */
export async function handleMarkEmailsRead(params: MarkEmailsReadParams): Promise<ToolResult> {
  const p = asRecord(params);
  const invalid = mailBatchError(p);
  if (invalid) return invalid;
  const v = validateAll(p, { booleans: ['read'] });
  if (!v.valid) return v.error;
  return runMail('mark_emails_read', p, BATCH_BUDGET);
}

/**
 * Flags emails with a color, or takes the flag off.
 * @param params - Tool input parameters.
 */
export async function handleFlagEmails(params: FlagEmailsParams): Promise<ToolResult> {
  const p = asRecord(params);
  const invalid = mailBatchError(p);
  if (invalid) return invalid;
  const v = validateAll(p, { strings: [['flag', MAX_LENGTHS.short, false]] });
  if (!v.valid) return v.error;
  if (!MAIL_FLAG_VALUES.includes(p.flag as string)) {
    return teachingToolResult(
      {
        paramName: 'flag',
        received: p.flag,
        nextStep: `Pass one of ${MAIL_FLAG_VALUES.join(', ')}.`,
      },
      'INVALID_VALUE'
    );
  }
  return runMail('flag_emails', p, BATCH_BUDGET);
}

/**
 * Moves emails to a mailbox of an account.
 * @param params - Tool input parameters.
 */
export async function handleMoveEmails(params: TargetEmailsParams): Promise<ToolResult> {
  return runTargetBatch('move_emails', asRecord(params));
}

/**
 * Copies emails to a mailbox of an account.
 * @param params - Tool input parameters.
 */
export async function handleCopyEmails(params: TargetEmailsParams): Promise<ToolResult> {
  return runTargetBatch('copy_emails', asRecord(params));
}

/**
 * Moves emails to the archive mailbox of their own account.
 * @param params - Tool input parameters.
 */
export async function handleArchiveEmails(params: ArchiveEmailsParams): Promise<ToolResult> {
  const p = asRecord(params);
  const invalid = mailBatchError(p);
  if (invalid) return invalid;
  return runMail('archive_emails', p, BATCH_BUDGET);
}

/**
 * Creates a mailbox in an account.
 * @param params - Tool input parameters.
 */
export async function handleCreateMailbox(params: CreateMailboxParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['name', 'account'],
    strings: [
      ['name', MAX_LENGTHS.short, false],
      ['account', MAX_LENGTHS.short, false],
    ],
  });
  if (!v.valid) return v.error;
  return runMail('create_mailbox', p);
}

/**
 * Marks emails as spam and moves them to the Junk mailbox; without confirm_spam mail-cli only previews them.
 * @param params - Tool input parameters.
 */
export async function handleMarkEmailsSpam(params: MarkEmailsSpamParams): Promise<ToolResult> {
  const p = asRecord(params);
  const invalid = mailBatchError(p);
  if (invalid) return invalid;
  const v = validateAll(p, { booleans: ['confirm_spam'] });
  if (!v.valid) return v.error;
  return runMail('mark_emails_spam', p, BATCH_BUDGET);
}

/**
 * Validates a move or copy to a target mailbox of an account and runs it.
 * @param command - mail-cli command.
 * @param p - Tool arguments.
 */
async function runTargetBatch(command: string, p: Record<string, unknown>): Promise<ToolResult> {
  const invalid = mailBatchError(p);
  if (invalid) return invalid;
  const v = validateAll(p, {
    required: ['mailbox', 'account'],
    strings: [
      ['mailbox', MAX_LENGTHS.short, false],
      ['account', MAX_LENGTHS.short, false],
    ],
  });
  if (!v.valid) return v.error;
  return runMail(command, p, BATCH_BUDGET);
}

/** The input schema of a move or copy's target `mailbox`. */
function targetMailboxProperty(): Record<string, unknown> {
  return {
    type: 'string',
    description:
      'Target mailbox path: the name field from listMailboxes. Create a missing one with createMailbox first.',
  };
}

/** The input schema of a move or copy's target `account`. */
function targetAccountProperty(): Record<string, unknown> {
  return {
    type: 'string',
    description:
      'Account of the target mailbox: the account field from listMailboxes, or "On My Mac"',
  };
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
  const report = batchReportOutputSchema();
  return {
    type: 'object',
    properties: {
      ...report.properties,
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
    },
  };
}

/** The output schema of a batch tool's per-mail report. */
function batchReportOutputSchema(): Tool['outputSchema'] & {
  properties: Record<string, unknown>;
} {
  return {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: '"completed" (every email), "partial" or "failed" (no email)',
      },
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
 * The output schema of a gated send: its preview, or what was sent.
 * @param withBcc - Whether the tool takes bcc recipients.
 */
function sendOutputSchema(withBcc: boolean): Tool['outputSchema'] {
  const addresses = (what: string) => ({
    type: 'array',
    items: { type: 'string' },
    description: `${what} addresses`,
  });
  return {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description:
          '"confirmation_required" (nothing sent: ask the user), or "sent" after confirmation',
      },
      confirm_param: {
        type: 'string',
        description: 'Preview only: the flag to set true once the user agreed',
      },
      instruction: { type: 'string', description: 'Preview only: what to ask the user' },
      to: addresses('To'),
      cc: addresses('CC'),
      ...(withBcc ? { bcc: addresses('BCC') } : {}),
      subject: { type: 'string' },
      body: { type: 'string', description: 'The full plain text that is sent' },
      signature: {
        type: 'string',
        description: 'The signature Mail adds below the text; absent when none was chosen',
      },
    },
  };
}

/**
 * The output schema of a gated forward or redirect: its preview, or what was sent.
 * @param withComment - Whether the tool takes a comment.
 */
function passOnOutputSchema(withComment: boolean): Tool['outputSchema'] {
  const addresses = (what: string) => ({
    type: 'array',
    items: { type: 'string' },
    description: `${what} addresses`,
  });
  return {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description:
          '"confirmation_required" (nothing sent: ask the user), or "sent" after confirmation',
      },
      confirm_param: {
        type: 'string',
        description: 'Preview only: the flag to set true once the user agreed',
      },
      instruction: { type: 'string', description: 'Preview only: what to ask the user' },
      to: addresses('To'),
      cc: addresses('CC'),
      subject: { type: 'string', description: 'Subject of the message that is sent' },
      ...(withComment
        ? { comment: { type: 'string', description: 'Text above the forwarded email' } }
        : {}),
      original: {
        type: 'object',
        description: 'The email that is passed on',
        properties: {
          id: { type: 'string', description: 'Mail id' },
          subject: { type: 'string' },
          sender: { type: 'string' },
          date: { type: 'string', description: 'Date received, ISO 8601 with the UTC offset' },
          mailbox: { type: 'string' },
          account: { type: 'string' },
        },
      },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Names of the attachments that go along',
      },
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
 * @param scriptRuns - Scripts one call runs one after another, all within the process timeout.
 */
function mailTimeBudget(toolMs: number, scriptRuns = 1): MailTimeBudget {
  const processMs = toolMs - PROCESS_HEADROOM_MS;
  return { toolMs, processMs, scriptMs: Math.floor((processMs - SCRIPT_HEADROOM_MS) / scriptRuns) };
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
    guardedTool(forwardEmailTool, handleForwardEmail),
    guardedTool(redirectEmailTool, handleRedirectEmail),
    guardedTool(listMailRulesTool, handleListMailRules),
    guardedTool(checkMailTool, handleCheckMail),
    guardedTool(deleteEmailsTool, handleDeleteEmails),
    guardedTool(markEmailsReadTool, handleMarkEmailsRead),
    guardedTool(flagEmailsTool, handleFlagEmails),
    guardedTool(moveEmailsTool, handleMoveEmails),
    guardedTool(copyEmailsTool, handleCopyEmails),
    guardedTool(archiveEmailsTool, handleArchiveEmails),
    guardedTool(createMailboxTool, handleCreateMailbox),
    guardedTool(markEmailsSpamTool, handleMarkEmailsSpam),
    guardedTool(saveDraftTool, handleSaveDraft),
    guardedTool(listMailSignaturesTool, handleListMailSignatures),
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
