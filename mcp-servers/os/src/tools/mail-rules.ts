import { Tool, READ_ONLY_ANNOTATIONS, WRITE_ANNOTATIONS, META_KEYS } from '@speedwave/mcp-shared';
import { ToolResult, validateAll, asRecord, MAX_LENGTHS } from './validation.js';
import { STANDARD_BUDGET, runMail } from './mail-shared.js';

/** Input parameters for the listMailRules tool (no params required). */
type ListMailRulesParams = Record<string, never>;

/** Input parameters for the checkMail tool. */
interface CheckMailParams {
  /** Account to check; every account when omitted. */
  account?: string;
}

export const listMailRulesTool: Tool = {
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

export const checkMailTool: Tool = {
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
