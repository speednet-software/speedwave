/**
 * OS: List Emails
 *
 * List emails from a specific mailbox with pagination.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listEmails',
  service: 'os',
  osCategory: 'mail',
  category: 'read',
  deferLoading: false,
  description: 'List emails from a mailbox with optional pagination (subject, sender, date)',
  keywords: ['os', 'mail', 'email', 'list', 'inbox', 'messages'],
  inputSchema: {
    type: 'object',
    properties: {
      mailbox_id: { type: 'string', description: 'Mailbox ID (default: Inbox)' },
      limit: { type: 'number', description: 'Maximum emails to return (default: 20)' },
      offset: { type: 'number', description: 'Skip first N emails (for pagination)' },
      client: { type: 'string', description: 'Email client to use' },
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
  example: `const { emails } = await os.listEmails({ limit: 10 })`,
  inputExamples: [
    {
      description: 'Minimal: list recent inbox emails',
      input: { limit: 10 },
    },
    {
      description: 'Full: paginated from specific mailbox',
      input: { mailbox_id: 'inbox-work', limit: 20, offset: 40 },
    },
  ],
  timeoutMs: 30_000,
};
