/**
 * OS: Reply to Email
 *
 * Reply to an existing email. Requires explicit confirmation.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'replyToEmail',
  service: 'os',
  osCategory: 'mail',
  category: 'write',
  deferLoading: false,
  description: 'Reply to an existing email (requires confirm_send: true to actually send)',
  keywords: ['os', 'mail', 'email', 'reply', 'respond', 'answer'],
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'ID of the email to reply to' },
      body: { type: 'string', description: 'Reply body (plain text)' },
      reply_all: { type: 'boolean', description: 'Reply to all recipients (default: false)' },
      confirm_send: {
        type: 'boolean',
        description: 'Must be true to actually send (safety guard)',
      },
      client: { type: 'string', description: 'Email client to use' },
    },
    required: ['id', 'body', 'confirm_send'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"sent"' },
      message_id: { type: 'string' },
    },
  },
  example: `await os.replyToEmail({ id: "msg-456", body: "Sounds good, let's proceed.", confirm_send: true })`,
  inputExamples: [
    {
      description: 'Minimal: reply to sender only',
      input: { id: 'msg-456', body: 'Thanks, acknowledged.', confirm_send: true },
    },
    {
      description: 'Full: reply all',
      input: {
        id: 'msg-456',
        body: 'I agree with the proposed timeline.',
        reply_all: true,
        confirm_send: true,
      },
    },
  ],
  timeoutMs: 30_000,
};
