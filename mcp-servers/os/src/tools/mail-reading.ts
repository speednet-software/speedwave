import { Tool, READ_ONLY_ANNOTATIONS, META_KEYS, teachingToolResult } from '@speedwave/mcp-shared';
import { ToolResult, validateAll, asRecord, MAX_LENGTHS } from './validation.js';
import { STANDARD_BUDGET, MAIL_FLAG_VALUES, mailTimeBudget, runMail } from './mail-shared.js';

const BODY_SEARCH_BUDGET = mailTimeBudget(180_000);

const RAW_TEXT_LIMIT = 100_000;

const ATTACHMENT_COUNT_NOTE =
  'attachment_count is the number of attachments Mail lists for the email, which may include embedded images (pictures inside the text); getEmail gives the exact list.';

const SEARCH_FILTERS = [
  'query',
  'sender',
  'recipient',
  'since',
  'before',
  'unread_only',
  'flagged_only',
];

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
  /** List only flagged emails. */
  flagged_only?: boolean;
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
  query?: string;
  /** Mailbox path from listMailboxes; every mailbox when absent. */
  mailbox?: string;
  /** Account of the mailbox, or the account whose mailboxes to search. */
  account?: string;
  /** Also match the body; slow. */
  search_body?: boolean;
  /** Text the sender contains. */
  sender?: string;
  /** Address of a To or Cc recipient. */
  recipient?: string;
  /** Received at or after this ISO 8601 day or date-time. */
  since?: string;
  /** Received before this ISO 8601 day or date-time. */
  before?: string;
  /** Only unread emails. */
  unread_only?: boolean;
  /** Only flagged emails. */
  flagged_only?: boolean;
  /** Max results to return. */
  limit?: number;
  /** Number of newest results to skip. */
  offset?: number;
}

const FLAG_OUTPUT = {
  type: 'string',
  enum: MAIL_FLAG_VALUES,
  description: 'Flag color, or none when the email is not flagged',
};

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
          flag: FLAG_OUTPUT,
          attachment_count: {
            type: 'number',
            description: ATTACHMENT_COUNT_NOTE,
          },
          mailbox: { type: 'string' },
          account: { type: 'string' },
        },
      },
    },
    total: { type: 'number', description: 'Number of emails the page is cut from' },
  },
};

export const detectMailClientsTool: Tool = {
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

export const listMailboxesTool: Tool = {
  name: 'listMailboxes',
  description:
    'List the mailboxes of every account, the On My Mac mailboxes under the account "On My Mac". Each mailbox\'s name is its path inside the account (Inbox/Clients for a nested one); pass it as listEmails/searchEmails\'s mailbox parameter (exact, case-sensitive) together with its account. Each mailbox carries message_count and unread_count, so one call answers how many unread emails there are.',
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
            unread_count: { type: 'number', description: 'Unread message count in this mailbox' },
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

export const listEmailsTool: Tool = {
  name: 'listEmails',
  description:
    'List the emails of one mailbox, newest first. Page with offset and limit (default 10); total is the number of emails the page is cut from (unread ones only with unread_only, flagged ones only with flagged_only). Each email carries its flag color, or none. Each id is a mail id that getEmail and replyToEmail take. ' +
    ATTACHMENT_COUNT_NOTE,
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
      flagged_only: { type: 'boolean', description: 'List only flagged emails (default false)' },
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

export const getEmailTool: Tool = {
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
          flag: FLAG_OUTPUT,
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

export const searchEmailsTool: Tool = {
  name: 'searchEmails',
  description:
    "Search emails, newest first, for the ones every given filter matches: query (subject or sender contains it), sender, recipient (a To or Cc address), since/before (ISO 8601), unread_only and flagged_only. Give at least one filter; to list a whole mailbox use listEmails. With mailbox it searches that one mailbox; without mailbox it searches every mailbox of account, or of every account and On My Mac without account, leaving out each account's Trash and Junk (name one as mailbox to search it). Each row names its mailbox and account. Page with offset and limit (default 10); total is the number of matches the page is cut from. Fast even in a large mailbox. Set search_body only when the user asks to search the email text; it needs mailbox and query, and Mail then scans every body of that mailbox, which can take minutes. Each id is a mail id that getEmail and replyToEmail take. " +
    ATTACHMENT_COUNT_NOTE,
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
        description:
          "Mailbox path to search: the name field from listMailboxes' output. Leave it out to search every mailbox but Trash and Junk.",
      },
      account: {
        type: 'string',
        description:
          'Account of the mailbox (the account field from listMailboxes); needed when the mailbox name exists in several accounts. Without mailbox, the one account whose mailboxes to search ("On My Mac" for the local ones).',
      },
      search_body: {
        type: 'boolean',
        description:
          'Also match the query in the email text (default false; needs query and mailbox). Slow: Mail scans every body of the mailbox, which can take minutes; use only when the user asks to search the content.',
      },
      sender: { type: 'string', description: 'Only emails whose sender contains this text' },
      recipient: {
        type: 'string',
        description:
          'Only emails sent to this email address, as a To or Cc recipient (the whole address, e.g. anna@example.com)',
      },
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
      flagged_only: { type: 'boolean', description: 'Only flagged emails (default false)' },
      limit: { type: 'number', description: 'Max results (default 10)' },
      offset: {
        type: 'number',
        description: 'Number of newest matches to skip, for the next page (default 0)',
      },
    },
  },
  outputSchema: EMAIL_LISTING_OUTPUT,
  inputExamples: [
    {
      description: 'Minimal: subject or sender search in every mailbox',
      input: { query: 'quarterly report' },
    },
    {
      description: 'One mailbox: subject or sender search in an inbox',
      input: { query: 'quarterly report', mailbox: 'INBOX', account: 'iCloud' },
    },
    {
      description: 'No query: what was sent to one address since a day',
      input: {
        mailbox: 'Sent Items',
        account: 'Exchange',
        recipient: 'anna@example.com',
        since: '2026-10-13',
      },
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
    booleans: ['unread_only', 'flagged_only'],
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
 * Searches one mailbox, or every mailbox but Trash and Junk, by the filters given; the body only with search_body.
 * @param params - Tool input parameters.
 */
export async function handleSearchEmails(params: SearchEmailsParams): Promise<ToolResult> {
  const p = asRecord(params);
  const givenTexts = ['mailbox', 'query', 'sender', 'recipient'].filter(
    (name) => typeof p[name] === 'string'
  );
  const v = validateAll(p, {
    required: givenTexts,
    booleans: ['search_body', 'unread_only', 'flagged_only'],
    strings: [
      ['query', MAX_LENGTHS.short, false],
      ['mailbox', MAX_LENGTHS.short, false],
      ['account', MAX_LENGTHS.short, false],
      ['sender', MAX_LENGTHS.short, false],
      ['recipient', MAX_LENGTHS.short, false],
      ['since', MAX_LENGTHS.short, false],
      ['before', MAX_LENGTHS.short, false],
    ],
    numbers: [
      ['limit', 1, 10_000],
      ['offset', 0, 1_000_000],
    ],
  });
  if (!v.valid) return v.error;
  const filterError = searchFilterError(p);
  if (filterError) return filterError;
  return runMail('search_emails', p, p.search_body === true ? BODY_SEARCH_BUDGET : STANDARD_BUDGET);
}

/**
 * The teaching error for a search that no filter narrows, or a body search without a query or a mailbox.
 * @param p - Tool arguments.
 */
function searchFilterError(p: Record<string, unknown>): ToolResult | undefined {
  const given = SEARCH_FILTERS.filter((name) => p[name] !== undefined && p[name] !== false);
  if (given.length === 0) {
    return teachingToolResult(
      {
        paramName: SEARCH_FILTERS.join(', '),
        nextStep: `Give at least one of ${SEARCH_FILTERS.join(', ')}. To list a whole mailbox, call listEmails instead.`,
      },
      'MISSING_FIELDS'
    );
  }
  if (p.search_body === true && p.query === undefined) {
    return teachingToolResult(
      {
        paramName: 'query',
        nextStep:
          'search_body searches the email text for the query: pass query too, or leave search_body out.',
      },
      'MISSING_FIELDS'
    );
  }
  if (p.search_body === true && p.mailbox === undefined) {
    return teachingToolResult(
      {
        paramName: 'mailbox',
        nextStep:
          'A body search reads every email text of one mailbox: pass mailbox (and account) from listMailboxes, or leave search_body out to search every mailbox by subject and sender.',
      },
      'MISSING_FIELDS'
    );
  }
  return undefined;
}
