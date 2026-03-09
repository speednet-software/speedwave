/**
 * OS: Get Email
 *
 * Get full content of a specific email by ID.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'getEmail',
  service: 'os',
  osCategory: 'mail',
  category: 'read',
  deferLoading: false,
  description:
    'Get the full content of a specific email including body, attachments list, and headers',
  keywords: ['os', 'mail', 'email', 'get', 'read', 'detail', 'body', 'content'],
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Email ID' },
      client: { type: 'string', description: 'Email client to use' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      subject: { type: 'string' },
      sender: { type: 'string' },
      to: { type: 'array', items: { type: 'string' } },
      cc: { type: 'array', items: { type: 'string' } },
      date: { type: 'string' },
      body: { type: 'string', description: 'Email body (plain text)' },
      html_body: { type: 'string', description: 'Email body (HTML)' },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            size: { type: 'number' },
          },
        },
      },
    },
  },
  example: `const email = await os.getEmail({ id: "msg-456" })`,
  inputExamples: [
    {
      description: 'Get email by ID',
      input: { id: 'msg-456' },
    },
  ],
  timeoutMs: 30_000,
};
