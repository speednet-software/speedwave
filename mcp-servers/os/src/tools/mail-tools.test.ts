/**
 * Mail Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleDetectMailClients,
  handleListMailboxes,
  handleListEmails,
  handleGetEmail,
  handleSearchEmails,
  handleSendEmail,
  handleReplyToEmail,
  createMailTools,
} from './mail-tools.js';

vi.mock('../platform-runner.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../platform-runner.js';

describe('mail-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleDetectMailClients', () => {
    it('returns detected clients', async () => {
      const mockData = {
        clients: [
          { name: 'Apple Mail', supported: true },
          { name: 'Microsoft Outlook', supported: false, instructions: 'Add the account…' },
        ],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleDetectMailClients({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(runCommand).toHaveBeenCalledWith('mail', 'detect_clients');
    });
  });

  describe('handleListMailboxes', () => {
    it('returns mailboxes on success', async () => {
      const mockData = {
        mailboxes: [{ name: 'INBOX', account: 'john@example.com', message_count: 5 }],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListMailboxes({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });
  });

  describe('handleListEmails', () => {
    it('returns emails of the inbox', async () => {
      const mockData = {
        emails: [{ id: 'msg-1', subject: 'Hello', sender: 'alice@example.com' }],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListEmails({ limit: 10 });

      expect(result.success).toBe(true);
      expect(runCommand).toHaveBeenCalledWith('mail', 'list_emails', { limit: 10 });
    });
  });

  describe('handleGetEmail', () => {
    it('returns email by ID', async () => {
      const mockData = {
        email: { id: 'msg-1', subject: 'Hello', sender: 'alice@example.com', body: 'Hello world' },
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleGetEmail({ id: 'msg-1' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('fails when id is empty', async () => {
      const result = await handleGetEmail({ id: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
    });
  });

  describe('handleSearchEmails', () => {
    it('searches emails by query', async () => {
      const mockData = {
        emails: [{ id: 'msg-2', subject: 'Invoice', sender: 'billing@example.com' }],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleSearchEmails({ query: 'invoice' });

      expect(result.success).toBe(true);
      expect(runCommand).toHaveBeenCalledWith('mail', 'search_emails', { query: 'invoice' });
    });

    it('fails when query is empty', async () => {
      const result = await handleSearchEmails({ query: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
      expect(result.error?.message).toContain('query');
    });
  });

  describe('handleSendEmail', () => {
    it('sends email when confirm_send is true', async () => {
      const mockData = { status: 'sent' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleSendEmail({
        to: 'bob@example.com',
        subject: 'Test',
        body: 'Hello Bob',
        confirm_send: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('rejects when confirm_send is false', async () => {
      const result = await handleSendEmail({
        to: 'bob@example.com',
        subject: 'Test',
        body: 'Hello Bob',
        confirm_send: false,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
    });

    it('fails when required fields are empty', async () => {
      const result = await handleSendEmail({
        to: '',
        subject: 'Test',
        body: 'Hello',
        confirm_send: true,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
      expect(result.error?.message).toContain('to');
    });

    it('passes bcc through to the native CLI', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { status: 'sent' } });

      await handleSendEmail({
        to: 'bob@example.com',
        subject: 'Test',
        body: 'Hello Bob',
        bcc: 'carol@example.com',
        confirm_send: true,
      });

      expect(runCommand).toHaveBeenCalledWith('mail', 'send_email', {
        to: 'bob@example.com',
        subject: 'Test',
        body: 'Hello Bob',
        bcc: 'carol@example.com',
        confirm_send: true,
      });
    });
  });

  describe('handleReplyToEmail', () => {
    it('replies when confirm_send is true', async () => {
      const mockData = { status: 'sent' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleReplyToEmail({
        id: 'msg-1',
        body: 'Thanks!',
        confirm_send: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('rejects when confirm_send is false', async () => {
      const result = await handleReplyToEmail({
        id: 'msg-1',
        body: 'Thanks!',
        confirm_send: false,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
    });

    it('fails when required fields are empty', async () => {
      const result = await handleReplyToEmail({
        id: '',
        body: 'Thanks!',
        confirm_send: true,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
    });
  });

  describe('createMailTools', () => {
    it('returns 7 tool definitions', () => {
      const tools = createMailTools();

      expect(tools).toHaveLength(7);
      expect(tools.map((t) => t.tool.name)).toEqual([
        'detectMailClients',
        'listMailboxes',
        'listEmails',
        'getEmail',
        'searchEmails',
        'sendEmail',
        'replyToEmail',
      ]);
    });

    it('all tools have handlers', () => {
      const tools = createMailTools();
      for (const t of tools) {
        expect(t.handler).toBeTypeOf('function');
      }
    });
  });

  describe('mail client choice', () => {
    it('no mail tool offers a client parameter', () => {
      for (const t of createMailTools()) {
        expect(Object.keys(t.tool.inputSchema.properties), t.tool.name).not.toContain('client');
      }
    });

    it('listEmails rejects the pagination and unread filters mail-cli does not apply', async () => {
      const tool = createMailTools().find((t) => t.tool.name === 'listEmails')!;

      for (const extra of [{ offset: 10 }, { unread_only: true }]) {
        const result = await tool.handler({ limit: 5, ...extra });
        expect(result.isError).toBe(true);
        expect((result.content[0] as { text: string }).text).toContain(Object.keys(extra)[0]);
      }
      expect(runCommand).not.toHaveBeenCalled();
    });

    it.each(createMailTools().map((t) => [t.tool.name, t] as const))(
      '%s rejects a client argument without calling the native CLI',
      async (_name, t) => {
        const result = await t.handler({ ...validInput(t.tool.name), client: 'outlook' });

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('client');
        expect(text).toContain('nothing was sent');
        expect(runCommand).not.toHaveBeenCalled();
      }
    );

    it('detectMailClients declares the supported flag and the instructions of an unsupported client', () => {
      const tool = createMailTools().find((t) => t.tool.name === 'detectMailClients')!;
      const item = (tool.tool.outputSchema as any).properties.clients.items.properties;

      expect(Object.keys(item).sort()).toEqual(['instructions', 'name', 'supported']);
      expect(tool.tool.description).toContain('Outlook');
      expect(tool.tool.description).toContain('Apple Mail');
    });
  });

  describe('outputSchema matches what mail-cli emits', () => {
    const NATIVE_OUTPUT: Record<string, Record<string, unknown>> = {
      detectMailClients: {
        clients: [
          { name: 'Apple Mail', supported: true },
          { name: 'Microsoft Outlook', supported: false, instructions: 'Add the account…' },
        ],
      },
      listMailboxes: { mailboxes: [{ account: 'iCloud', name: 'INBOX', message_count: 3 }] },
      listEmails: {
        emails: [{ id: '<a@x>', subject: 'Hi', sender: 'Anna', date: 'Monday', read: false }],
      },
      getEmail: {
        email: {
          id: '<a@x>',
          subject: 'Hi',
          sender: 'Anna',
          date: 'Monday',
          read: true,
          to: ['me@x'],
          body: 'Hello',
        },
      },
      searchEmails: { emails: [{ id: '<a@x>', subject: 'Hi', sender: 'Anna', date: 'Monday' }] },
      sendEmail: { status: 'sent' },
      replyToEmail: { status: 'sent' },
    };

    it('covers every mail tool', () => {
      expect(Object.keys(NATIVE_OUTPUT).sort()).toEqual(
        createMailTools()
          .map((t) => t.tool.name)
          .sort()
      );
    });

    it.each(createMailTools().map((t) => [t.tool.name, t] as const))(
      '%s declares exactly the keys it emits',
      async (name, t) => {
        vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: NATIVE_OUTPUT[name] });

        const result = await t.handler(validInput(name));

        const emitted = JSON.parse((result.content[0] as { text: string }).text);
        expect(declaredShape(t.tool.outputSchema)).toEqual(shapeOf(emitted));
      }
    );
  });

  describe('confirm_send priority', () => {
    it('handleSendEmail returns CONFIRMATION_REQUIRED before MISSING_FIELDS when confirm_send is false and fields are missing', async () => {
      const result = await handleSendEmail({
        to: '',
        subject: '',
        body: '',
        confirm_send: false,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
    });

    it('handleReplyToEmail returns CONFIRMATION_REQUIRED before MISSING_FIELDS when confirm_send is false and fields are missing', async () => {
      const result = await handleReplyToEmail({
        id: '',
        body: '',
        confirm_send: false,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
    });
  });

  describe('input validation (SEC-012)', () => {
    describe('handleGetEmail', () => {
      it('rejects id with control characters', async () => {
        const result = await handleGetEmail({ id: 'm\x01id' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });
    });

    describe('handleListEmails', () => {
      it('rejects mailbox exceeding max length', async () => {
        const result = await handleListEmails({ mailbox: 'a'.repeat(1001) });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('FIELD_TOO_LONG');
      });

      it('rejects limit as string', async () => {
        const result = await handleListEmails({ limit: '20' as any });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });
    });

    describe('handleSearchEmails', () => {
      it('rejects query with control characters', async () => {
        const result = await handleSearchEmails({ query: 'test\x00query' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });

      it('rejects limit = -1', async () => {
        const result = await handleSearchEmails({ query: 'test', limit: -1 });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('OUT_OF_RANGE');
      });
    });

    describe('handleSendEmail', () => {
      it('rejects confirm_send as string "true"', async () => {
        const result = await handleSendEmail({
          to: 'bob@example.com',
          subject: 'Test',
          body: 'Hello',
          confirm_send: 'true' as any,
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });

      it('rejects body exceeding max length', async () => {
        const result = await handleSendEmail({
          to: 'bob@example.com',
          subject: 'Test',
          body: 'a'.repeat(100_001),
          confirm_send: true,
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('FIELD_TOO_LONG');
      });

      it('rejects subject with null byte', async () => {
        const result = await handleSendEmail({
          to: 'bob@example.com',
          subject: 'Test\x00Subject',
          body: 'Hello',
          confirm_send: true,
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });

      it('rejects bcc with control characters', async () => {
        const result = await handleSendEmail({
          to: 'bob@example.com',
          subject: 'Test',
          body: 'Hello',
          bcc: 'carol\x00@example.com',
          confirm_send: true,
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });
    });

    describe('handleReplyToEmail', () => {
      it('rejects confirm_send as string', async () => {
        const result = await handleReplyToEmail({
          id: 'msg-1',
          body: 'Thanks!',
          confirm_send: 'true' as any,
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });

      it('rejects reply_all as number 1', async () => {
        const result = await handleReplyToEmail({
          id: 'msg-1',
          body: 'Thanks!',
          confirm_send: true,
          reply_all: 1 as any,
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });
    });
  });
});

/**
 * A call each mail tool accepts.
 * @param name - Tool name.
 */
function validInput(name: string): Record<string, unknown> {
  const inputs: Record<string, Record<string, unknown>> = {
    detectMailClients: {},
    listMailboxes: {},
    listEmails: {},
    getEmail: { id: '<a@x>' },
    searchEmails: { query: 'hi' },
    sendEmail: { to: 'a@x', subject: 's', body: 'b', confirm_send: true },
    replyToEmail: { id: '<a@x>', body: 'b', confirm_send: true },
  };
  return inputs[name];
}

/**
 * The key tree of a JSON value: objects map keys to subtrees, arrays to the merged tree of their items.
 * @param value - Parsed JSON.
 */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(shapeOf);
    if (items.length === 0) return [null];
    if (items.every((item) => item !== null && typeof item === 'object')) {
      return [shapeOf(Object.assign({}, ...items))];
    }
    return [items[0]];
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shapeOf(v)])
    );
  }
  return null;
}

/**
 * The key tree a JSON schema declares, in the form {@link shapeOf} returns.
 * @param schema - JSON schema.
 */
function declaredShape(schema: any): unknown {
  if (schema?.type === 'array') return [declaredShape(schema.items)];
  if (schema?.type === 'object' && schema.properties) {
    return Object.fromEntries(
      Object.entries(schema.properties as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, declaredShape(v)])
    );
  }
  return null;
}
