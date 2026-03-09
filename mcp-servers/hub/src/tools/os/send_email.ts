/**
 * OS: Send Email
 *
 * Send a new email. Requires explicit confirmation to prevent accidental sends.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'sendEmail',
  service: 'os',
  osCategory: 'mail',
  category: 'write',
  deferLoading: false,
  description: 'Send a new email (requires confirm_send: true to actually send)',
  keywords: ['os', 'mail', 'email', 'send', 'compose', 'write', 'new'],
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body (plain text)' },
      cc: { type: 'array', items: { type: 'string' }, description: 'CC recipients' },
      bcc: { type: 'array', items: { type: 'string' }, description: 'BCC recipients' },
      confirm_send: {
        type: 'boolean',
        description: 'Must be true to actually send (safety guard)',
      },
      client: { type: 'string', description: 'Email client to use' },
    },
    required: ['to', 'subject', 'body', 'confirm_send'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"sent" or "draft_created"' },
      message_id: { type: 'string' },
    },
  },
  example: `await os.sendEmail({ to: ["alice@example.com"], subject: "Meeting notes", body: "See attached.", confirm_send: true })`,
  inputExamples: [
    {
      description: 'Minimal: send to one recipient',
      input: {
        to: ['alice@example.com'],
        subject: 'Quick update',
        body: 'Everything looks good.',
        confirm_send: true,
      },
    },
    {
      description: 'Full: send with CC',
      input: {
        to: ['alice@example.com'],
        subject: 'Q4 Report',
        body: 'Please review the attached report.',
        cc: ['bob@example.com'],
        confirm_send: true,
      },
    },
  ],
  timeoutMs: 30_000,
};
