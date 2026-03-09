/**
 * OS: Search Emails
 *
 * Search emails by query string across subject, sender, and body.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'searchEmails',
  service: 'os',
  osCategory: 'mail',
  category: 'read',
  deferLoading: false,
  description: 'Search emails by query string across subject, sender, and body',
  keywords: ['os', 'mail', 'email', 'search', 'find', 'query'],
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      mailbox_id: { type: 'string', description: 'Limit search to mailbox (omit for all)' },
      limit: { type: 'number', description: 'Maximum results (default: 20)' },
      client: { type: 'string', description: 'Email client to use' },
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
            date: { type: 'string' },
            snippet: { type: 'string', description: 'Matching text snippet' },
          },
        },
      },
      total: { type: 'number' },
    },
  },
  example: `const { emails } = await os.searchEmails({ query: "quarterly report" })`,
  inputExamples: [
    {
      description: 'Minimal: search all mailboxes',
      input: { query: 'quarterly report' },
    },
    {
      description: 'Full: search specific mailbox with limit',
      input: { query: 'invoice', mailbox_id: 'inbox-work', limit: 10 },
    },
  ],
  timeoutMs: 30_000,
};
