/**
 * OS: Detect Mail Clients
 *
 * Detect available email clients on the system.
 * macOS: Apple Mail, Outlook. Linux: Thunderbird, Evolution. Windows: Outlook.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'detectMailClients',
  service: 'os',
  osCategory: 'mail',
  category: 'read',
  deferLoading: false,
  description:
    'Detect available email clients on the system (Apple Mail, Outlook, Thunderbird, etc.)',
  keywords: ['os', 'mail', 'email', 'detect', 'clients', 'outlook', 'thunderbird'],
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      clients: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Client name (e.g., "Apple Mail", "Outlook")' },
            available: { type: 'boolean' },
          },
        },
      },
    },
  },
  example: `const { clients } = await os.detectMailClients()`,
  inputExamples: [
    {
      description: 'Detect mail clients (no params)',
      input: {},
    },
  ],
  timeoutMs: 30_000,
};
