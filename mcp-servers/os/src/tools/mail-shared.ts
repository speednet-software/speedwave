import { teachingToolResult, type TeachingErrorParams } from '@speedwave/mcp-shared';
import { ToolResult } from './validation.js';
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

export const STANDARD_BUDGET = mailTimeBudget(30_000);

/** The most mails one batch tool acts on; mail-cli's `mailBatchLimit` holds the same number. */
export const MAIL_BATCH_LIMIT = 25;

/** Flag colors in the order of Mail's flag index, then `none`; mail-cli's `mailFlagColors` holds the same colors. */
export const MAIL_FLAG_VALUES = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'gray',
  'none',
];

export const SPLIT_BATCH_STEP = `Split the mail ids into batches of at most ${MAIL_BATCH_LIMIT} and confirm each batch with the user separately.`;

export const EXAMPLE_IDS = [
  'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0',
  'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxiQHg-Il0',
];

const MAIL_FAILURE = /\b(MAIL_[A-Z_]+): ([\s\S]*)$/;

const MAIL_FAILURE_TEACHING: Record<
  string,
  (detail: string, args: MailArgs, command: string) => TeachingErrorParams
> = {
  MAIL_TIMEOUT: (detail) => ({
    nextStep:
      `${detail} Retry once; for a list or a search pass a specific mailbox or a smaller limit. ` +
      'Before retrying a send or a reply, check the Sent mailbox, since Mail.app may have sent it anyway.',
  }),
  MAIL_AUTOMATION_DENIED: (detail) => ({
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
  MAIL_ACCOUNT_DISABLED: (detail, args, command) => ({
    paramName: 'account',
    received: args.account,
    nextStep:
      command === 'send_email'
        ? `${detail} Nothing was sent. Ask the user whether to turn the account on in Mail > Settings > Accounts ` +
          'or to send from another account; do not retry on your own. For another account, call again with that ' +
          'account, or without account for the default sender, and show the user the new from in the preview.'
        : `${detail} Ask the user to turn the account on in Mail > Settings > Accounts, ` +
          "or call again without account (it then goes from Mail's primary address) and show the user the new from.",
  }),
  MAIL_NO_SENDER: (detail) => ({
    nextStep: `${detail} Ask the user to add or turn on a mail account in Mail > Settings > Accounts; nothing was sent or saved.`,
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
    nextStep: `${detail} New mail arrived or messages moved during the read; retry the same call once.`,
  }),
  MAIL_SEND_FAILED: (detail) => ({
    nextStep:
      `${detail} Tell the user the message was not sent and ask them to check the Outbox in Mail.app; ` +
      'do not retry without asking.',
  }),
  MAIL_SIGNATURE_NOT_FOUND: (detail, args) => ({
    paramName: 'signature',
    received: args.signature,
    correctValueTool: 'listMailSignatures',
    nextStep: `${detail} Pass a name listMailSignatures returns, or leave signature out to add none.`,
  }),
  MAIL_BATCH_TOO_LARGE: (detail) => ({
    paramName: 'ids',
    nextStep: `${detail} ${SPLIT_BATCH_STEP}`,
  }),
  MAIL_MAILBOX_EXISTS: (detail, args) =>
    args.new_name === undefined
      ? {
          paramName: 'name',
          received: args.name,
          nextStep: `${detail} Do not create it again: pass it to moveEmails or copyEmails as it is.`,
        }
      : {
          paramName: 'new_name',
          received: args.new_name,
          nextStep: `${detail} Nothing was renamed. Ask the user for another name.`,
        },
  MAIL_SPECIAL_MAILBOX: (detail, args) => ({
    paramName: 'mailbox',
    received: args.mailbox,
    nextStep:
      `${detail} Tell the user that Mail's own mailboxes keep their names. ` +
      'If they want a mailbox with the new name, create it with createMailbox and move emails there.',
  }),
  MAIL_TARGET_IS_TRASH: (detail, args) => ({
    paramName: 'mailbox',
    received: args.mailbox,
    nextStep:
      `${detail} If the user wants these emails deleted, call deleteEmails with the same ids; ` +
      'it previews them and moves them to the Trash only after the user confirms.',
  }),
  MAIL_TARGET_IS_JUNK: (detail, args) => ({
    paramName: 'mailbox',
    received: args.mailbox,
    nextStep:
      `${detail} If the user wants these emails reported as spam, call markEmailsSpam with the same ids; ` +
      'it previews them and moves them to the Junk mailbox only after the user confirms.',
  }),
};

/**
 * Splits a hub timeout into the mail-cli process and script timeouts, each ending before the one above it.
 * @param toolMs - Hub timeout of the tool call.
 * @param scriptRuns - Scripts one call runs one after another, all within the process timeout.
 */
export function mailTimeBudget(toolMs: number, scriptRuns = 1): MailTimeBudget {
  const processMs = toolMs - PROCESS_HEADROOM_MS;
  return { toolMs, processMs, scriptMs: Math.floor((processMs - SCRIPT_HEADROOM_MS) / scriptRuns) };
}

/**
 * Runs a mail-cli command within a time budget; a failure mail-cli names comes back as a teaching error.
 * @param command - mail-cli command.
 * @param args - Tool arguments.
 * @param budget - Time budget of the call.
 */
export async function runMail(
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
    const failure = mailFailureResult(error, command, args);
    if (failure) return failure;
    throw error;
  }
}

/**
 * The teaching error for a mail-cli failure that starts with a known `MAIL_*` code, or undefined.
 * @param error - What runCommand threw.
 * @param command - mail-cli command of the failed call.
 * @param args - Tool arguments of the failed call.
 */
function mailFailureResult(
  error: unknown,
  command: string,
  args: MailArgs
): ToolResult | undefined {
  const match = error instanceof Error ? MAIL_FAILURE.exec(error.message) : null;
  const teaching = match ? MAIL_FAILURE_TEACHING[match[1]] : undefined;
  if (!match || !teaching) return undefined;
  return teachingToolResult(teaching(match[2].trim(), args, command), match[1]);
}

/**
 * The input schema of a confirmation gate's `confirm_*` flag.
 * @param action - What the confirmed call does.
 */
export function confirmProperty(action: string): Record<string, unknown> {
  return {
    type: 'boolean',
    description:
      `Set true only after the user saw the preview and agreed to ${action}. ` +
      'Without it nothing changes and the call returns the preview.',
  };
}
