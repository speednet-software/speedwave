import {
  Tool,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  META_KEYS,
  teachingToolResult,
} from '@speedwave/mcp-shared';
import { ToolResult, validateAll, asRecord, MAX_LENGTHS } from './validation.js';
import {
  STANDARD_BUDGET,
  MAIL_BATCH_LIMIT,
  SPLIT_BATCH_STEP,
  EXAMPLE_IDS,
  mailTimeBudget,
  runMail,
  confirmProperty,
  MAIL_FLAG_VALUES,
} from './mail-shared.js';

const BATCH_BUDGET = mailTimeBudget(120_000);

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

export const deleteEmailsTool: Tool = {
  name: 'deleteEmails',
  description:
    'Move 1 to 25 emails, by the mail ids listEmails or searchEmails returned, to the Trash of their own account; no tool deletes an email permanently. ' +
    'Without confirm_delete=true nothing changes: the call returns a preview of each email (sender, subject, date, mailbox), and you must show it and ask the user before calling again with confirm_delete=true. ' +
    'The confirmed call reports every email: ok, or the error that kept it where it is.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_CLASS]: 'long',
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
      input: {
        ids: [
          'mail2.WyI1RjNBMkMxRS0wQjdELTRDMUEtOUUyRi03QTFCM0M0RDVFNkYiLCJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
        ],
      },
    },
    {
      description: 'Full: move two emails to the Trash after the user agreed',
      input: {
        ids: [
          'mail2.WyI1RjNBMkMxRS0wQjdELTRDMUEtOUUyRi03QTFCM0M0RDVFNkYiLCJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
          'mail2.WyI1RjNBMkMxRS0wQjdELTRDMUEtOUUyRi03QTFCM0M0RDVFNkYiLCJpQ2xvdWQiLCJJTkJPWCIsIjxiQHg-Il0',
        ],
        confirm_delete: true,
      },
    },
  ],
};

export const markEmailsReadTool: Tool = {
  name: 'markEmailsRead',
  description:
    'Mark 1 to 25 emails, by the mail ids listEmails or searchEmails returned, as read (read=true) or unread (read=false). ' +
    'Reversible, so no confirmation is needed. Reports every email: ok, or the error that left it unchanged.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_CLASS]: 'long',
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

export const flagEmailsTool: Tool = {
  name: 'flagEmails',
  description:
    'Flag 1 to 25 emails, by the mail ids listEmails or searchEmails returned, with a color, or take the flag off with flag "none". ' +
    'Reversible, so no confirmation is needed. Reports every email: ok, or the error that left it unchanged.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_CLASS]: 'long',
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

export const moveEmailsTool: Tool = {
  name: 'moveEmails',
  description:
    'Move 1 to 25 emails, by the mail ids listEmails or searchEmails returned, to a mailbox named together with its account (as listMailboxes returns them). ' +
    'Reversible, so no confirmation is needed; a target that does not exist fails the call and nothing moves. ' +
    "The account's Trash and Junk mailbox are refused: delete with deleteEmails and report spam with markEmailsSpam, which ask the user first. " +
    'Reports every email: ok, or the error that left it where it is. A moved email gets a new mail id: list the target mailbox to act on it again.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_CLASS]: 'long',
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

export const copyEmailsTool: Tool = {
  name: 'copyEmails',
  description:
    'Copy 1 to 25 emails, by the mail ids listEmails or searchEmails returned, to a mailbox named together with its account (as listMailboxes returns them); the originals stay where they are. ' +
    'No confirmation is needed; a target that does not exist fails the call and nothing is copied. ' +
    "The account's Trash and Junk mailbox are refused: delete with deleteEmails and report spam with markEmailsSpam, which ask the user first. " +
    'Reports every email: ok, or the error that kept it from being copied.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_CLASS]: 'long',
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

export const archiveEmailsTool: Tool = {
  name: 'archiveEmails',
  description:
    'Archive 1 to 25 emails, by the mail ids listEmails or searchEmails returned: each moves to the Archive mailbox of its own account (All Mail on Gmail). ' +
    'Reversible, so no confirmation is needed. An account without an archive mailbox leaves the email where it is and reports MAIL_ARCHIVE_NOT_FOUND for it; then ask the user where to keep it and use moveEmails.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_CLASS]: 'long',
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

export const createMailboxTool: Tool = {
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

export const markEmailsSpamTool: Tool = {
  name: 'markEmailsSpam',
  description:
    "Mark 1 to 25 emails, by the mail ids listEmails or searchEmails returned, as spam: Mail's junk filter learns from them and each moves to the Junk mailbox of its own account. " +
    'Without confirm_spam=true nothing changes: the call returns a preview of each email (sender, subject, date, mailbox), and you must show it and ask the user before calling again with confirm_spam=true. ' +
    'The confirmed call reports every email: ok, or the error that kept it where it is.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_CLASS]: 'long',
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

/** Input parameters for the markEmailsNotSpam tool. */
interface MarkEmailsNotSpamParams {
  /** 1 to 25 mail ids from listEmails or searchEmails. */
  ids: string[];
}

export const markEmailsNotSpamTool: Tool = {
  name: 'markEmailsNotSpam',
  description:
    "Mark 1 to 25 emails, by the mail ids listEmails or searchEmails returned, as not spam: Mail's junk filter learns from them, and an email in the Junk mailbox of its own account moves to the Inbox of that account. " +
    'Reversible, so no confirmation is needed. An email outside the Junk mailbox only loses its junk mark and stays where it is, and so does every email of On My Mac, which has no Inbox. ' +
    'Reports every email: ok with moved (true when it went to the Inbox), or the error that left it unchanged. A moved email gets a new mail id: list the Inbox to act on it again.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_CLASS]: 'long',
    [META_KEYS.TIMEOUT_MS]: BATCH_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'not spam', 'not junk', 'junk', 'restore', 'inbox', 'filter'],
  example: 'await os.markEmailsNotSpam({ ids: [emails[0].id] })',
  inputSchema: {
    type: 'object',
    properties: {
      ids: mailIdsProperty('Emails to mark as not spam'),
    },
    required: ['ids'],
  },
  outputSchema: batchReportOutputSchema({
    moved: {
      type: 'boolean',
      description:
        'Report only, for an email that was found: true when it moved from the Junk mailbox to the Inbox',
    },
  }),
  inputExamples: [
    { description: 'Minimal: one email back from Junk', input: { ids: [EXAMPLE_IDS[0]] } },
    { description: 'Full: two emails back from Junk', input: { ids: EXAMPLE_IDS } },
  ],
};

/** Input parameters for the renameMailbox tool. */
interface RenameMailboxParams {
  /** Path of the mailbox to rename. */
  mailbox: string;
  /** Account of the mailbox. */
  account: string;
  /** New name, one path component. */
  new_name: string;
}

export const renameMailboxTool: Tool = {
  name: 'renameMailbox',
  description:
    'Rename a mailbox of an account (mailbox and account exactly as listMailboxes returns them); it stays inside the same parent mailbox, so new_name is one name without /. ' +
    'Reversible, so no confirmation is needed: renaming it back undoes it. ' +
    "The account's own mailboxes keep their names: Inbox, Drafts, Sent, Junk, Trash, Outbox and the archive mailbox are refused with MAIL_SPECIAL_MAILBOX. " +
    'A name the parent already has is refused with MAIL_MAILBOX_EXISTS. Emails in the renamed mailbox get new mail ids: list it again to act on them.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: STANDARD_BUDGET.toolMs,
    [META_KEYS.OS_CATEGORY]: 'mail',
  },
  keywords: ['os', 'mail', 'email', 'mailbox', 'folder', 'rename', 'name'],
  example:
    'await os.renameMailbox({ mailbox: "Clients/Acme", account: "iCloud", new_name: "Acme Corp" })',
  inputSchema: {
    type: 'object',
    properties: {
      mailbox: {
        type: 'string',
        description: 'Path of the mailbox to rename: the name field from listMailboxes',
      },
      account: {
        type: 'string',
        description: 'Account of the mailbox: the account field from listMailboxes, or "On My Mac"',
      },
      new_name: {
        type: 'string',
        description: 'New name inside the same parent, without /, e.g. Acme Corp',
      },
    },
    required: ['mailbox', 'account', 'new_name'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"renamed"' },
      mailbox: {
        type: 'string',
        description: 'New path of the mailbox; pass it to the mail tools',
      },
      previous_mailbox: { type: 'string', description: 'Path the mailbox had before' },
      account: { type: 'string' },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: rename a mailbox of an account',
      input: { mailbox: 'Receipts', account: 'iCloud', new_name: 'Invoices' },
    },
    {
      description: 'Full: rename a nested mailbox on this Mac',
      input: { mailbox: 'Clients/Acme', account: 'On My Mac', new_name: 'Acme Corp' },
    },
  ],
};

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
 * Renames a mailbox of an account inside its parent.
 * @param params - Tool input parameters.
 */
export async function handleRenameMailbox(params: RenameMailboxParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['mailbox', 'account', 'new_name'],
    strings: [
      ['mailbox', MAX_LENGTHS.short, false],
      ['account', MAX_LENGTHS.short, false],
      ['new_name', MAX_LENGTHS.short, false],
    ],
  });
  if (!v.valid) return v.error;
  if ((p.new_name as string).includes('/')) {
    return teachingToolResult(
      {
        paramName: 'new_name',
        received: p.new_name,
        nextStep:
          'Pass one name without /: the mailbox stays in its parent. To move it elsewhere, create the new mailbox with createMailbox and move the emails with moveEmails.',
      },
      'INVALID_VALUE'
    );
  }
  return runMail('rename_mailbox', p);
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
 * Clears the junk mark of emails and moves those in their account's Junk mailbox to its Inbox.
 * @param params - Tool input parameters.
 */
export async function handleMarkEmailsNotSpam(
  params: MarkEmailsNotSpamParams
): Promise<ToolResult> {
  const p = asRecord(params);
  const invalid = mailBatchError(p);
  if (invalid) return invalid;
  return runMail('mark_emails_not_spam', p, BATCH_BUDGET);
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

/**
 * The output schema of a batch tool's per-mail report.
 * @param perMail - Keys the tool adds to each email of its report.
 */
function batchReportOutputSchema(perMail: Record<string, unknown> = {}): Tool['outputSchema'] & {
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
            ...perMail,
          },
        },
      },
      succeeded: { type: 'number', description: 'Report only: emails the action succeeded on' },
      failed: { type: 'number', description: 'Report only: emails left unchanged' },
    },
  };
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
