/**
 * OS: List Mailboxes
 *
 * List all mailboxes/accounts from the email client.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listMailboxes',
  service: 'os',
  osCategory: 'mail',
  category: 'read',
  deferLoading: false,
  description: 'List all mailboxes and accounts from the email client',
  keywords: ['os', 'mail', 'email', 'mailboxes', 'accounts', 'inbox', 'folders'],
  inputSchema: {
    type: 'object',
    properties: {
      client: {
        type: 'string',
        description:
          'Email client to use (e.g., "apple_mail", "outlook"). Auto-detected if omitted.',
      },
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
            id: { type: 'string' },
            name: { type: 'string' },
            account_name: { type: 'string' },
            unread_count: { type: 'number' },
          },
        },
      },
    },
  },
  example: `const { mailboxes } = await os.listMailboxes()`,
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
  timeoutMs: 30_000,
};
