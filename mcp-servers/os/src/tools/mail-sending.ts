import {
  Tool,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import { ToolResult, validateAll, asRecord, MAX_LENGTHS } from './validation.js';
import { STANDARD_BUDGET, mailTimeBudget, runMail, confirmProperty } from './mail-shared.js';

const READ_THEN_SEND_BUDGET = mailTimeBudget(60_000, 2);

const PLAIN_TEXT_ONLY =
  'Plain text only: line breaks are kept, HTML is sent as literal text, and no file can be attached.';

const SIGNATURE_PROPERTY = {
  type: 'string',
  description:
    'Name of a Mail signature, exactly as listMailSignatures returns it; when omitted no signature is added, not even the account default',
};

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

export const sendEmailTool: Tool = {
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

export const replyToEmailTool: Tool = {
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

export const forwardEmailTool: Tool = {
  name: 'forwardEmail',
  description:
    'Forward an email in any mailbox, by the mail id listEmails or searchEmails returned, with its attachments, through Mail\'s own forward (Mail picks the "Fwd:" subject and quotes the email). No text can be added: any change to a forward leaves only the added text, without the quote and the attachments, so for a note send a separate email. ' +
    'Without confirm_send=true nothing is sent: the call returns a preview of the recipients, subject, the forwarded email and its attachment names, and you must show it and ask the user before calling again with the same arguments and confirm_send=true. ' +
    'Sending cannot be undone.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: READ_THEN_SEND_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'forward', 'fwd', 'share', 'pass on'],
  example:
    'const preview = await os.forwardEmail({ id: emails[0].id, to: "bob@example.com" }); /* ask the user */ await os.forwardEmail({ id: emails[0].id, to: "bob@example.com", confirm_send: true })',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Mail id from listEmails or searchEmails' },
      to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
      cc: { type: 'string', description: 'CC recipient(s), comma-separated' },
      confirm_send: confirmProperty('forward this email'),
    },
    required: ['id', 'to'],
  },
  outputSchema: passOnOutputSchema(),
  inputExamples: [
    {
      description: 'Minimal: preview a forward before asking the user',
      input: { id: 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0', to: 'bob@example.com' },
    },
    {
      description: 'Full: forward with CC after the user agreed',
      input: {
        id: 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
        to: 'bob@example.com',
        cc: 'carol@example.com',
        confirm_send: true,
      },
    },
  ],
};

export const redirectEmailTool: Tool = {
  name: 'redirectEmail',
  description:
    'Redirect an email in any mailbox, by the mail id listEmails or searchEmails returned: Mail sends it unchanged, with its attachments, and the recipients see it as coming from its original sender; no text can be added. ' +
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
  outputSchema: passOnOutputSchema(),
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

export const saveDraftTool: Tool = {
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

export const listMailSignaturesTool: Tool = {
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
 */
function passOnOutputSchema(): Tool['outputSchema'] {
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
