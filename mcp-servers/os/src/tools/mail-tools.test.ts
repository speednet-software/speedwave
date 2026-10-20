/**
 * Mail Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { META_KEYS } from '@speedwave/mcp-shared';
import {
  handleDetectMailClients,
  handleListMailboxes,
  handleListEmails,
  handleGetEmail,
  handleSearchEmails,
  handleSendEmail,
  handleReplyToEmail,
  handleListMailRules,
  handleCheckMail,
  handleDeleteEmails,
  createMailTools,
} from './mail-tools.js';

vi.mock('../platform-runner.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../platform-runner.js';

const PROCESS_TIMEOUT = expect.any(Number);

const MAIL_ID = 'mail1.WyJpQ2xvdWQiLCJJTkJPWCIsIjxhQHg-Il0';

/**
 * The arguments mail-cli receives for a call: the tool's arguments plus the script time budget.
 * @param args - Tool arguments.
 */
function budgeted(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args, script_timeout_ms: expect.any(Number) };
}

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
      expect(runCommand).toHaveBeenCalledWith(
        'mail',
        'detect_clients',
        budgeted({}),
        PROCESS_TIMEOUT
      );
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
    it('returns the emails of a mailbox', async () => {
      const mockData = {
        emails: [{ id: MAIL_ID, subject: 'Hello', sender: 'alice@example.com' }],
        total: 1,
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListEmails({ mailbox: 'INBOX', limit: 10 });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(runCommand).toHaveBeenCalledWith(
        'mail',
        'list_emails',
        budgeted({ mailbox: 'INBOX', limit: 10 }),
        PROCESS_TIMEOUT
      );
    });

    it('passes the page and the unread filter through to mail-cli', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { emails: [], total: 0 } });
      const tool = createMailTools().find((t) => t.tool.name === 'listEmails')!;
      const input = { mailbox: 'INBOX', account: 'iCloud', limit: 5, offset: 0, unread_only: true };

      const result = await tool.handler(input);

      expect(result.isError).toBeFalsy();
      expect(vi.mocked(runCommand).mock.calls[0][2]).toEqual(budgeted(input));
    });

    it('fails without a mailbox', async () => {
      const result = await handleListEmails({} as any);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_FIELDS');
      expect(result.error?.message).toContain('mailbox');
      expect(runCommand).not.toHaveBeenCalled();
    });

    it.each([
      [{ offset: -1 }, 'OUT_OF_RANGE'],
      [{ offset: '10' }, 'INVALID_TYPE'],
      [{ unread_only: 'true' }, 'INVALID_TYPE'],
    ])('rejects %o without calling mail-cli', async (extra, code) => {
      const result = await handleListEmails({ mailbox: 'INBOX', ...(extra as object) });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(code);
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  describe('handleGetEmail', () => {
    it('returns email by ID', async () => {
      const mockData = {
        email: { id: MAIL_ID, subject: 'Hello', sender: 'alice@example.com', body: 'Hello world' },
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleGetEmail({ id: MAIL_ID });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('fails when id is empty', async () => {
      const result = await handleGetEmail({ id: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
    });

    it('passes the headers and source requests to mail-cli', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { email: {} } });

      await handleGetEmail({ id: MAIL_ID, include_headers: true, include_source: false });

      expect(runCommand).toHaveBeenCalledWith(
        'mail',
        'get_email',
        budgeted({ id: MAIL_ID, include_headers: true, include_source: false }),
        PROCESS_TIMEOUT
      );
    });

    it('refuses a headers request that is not a boolean without calling mail-cli', async () => {
      const result = await handleGetEmail({ id: MAIL_ID, include_source: 'yes' as never });

      expect(result.success).toBe(false);
      expect(runCommand).not.toHaveBeenCalled();
    });

    it('declares the truncation flags of the headers and the source', () => {
      const tool = createMailTools().find((t) => t.tool.name === 'getEmail')!;
      const email = (tool.tool.outputSchema as any).properties.email.properties;
      const input = tool.tool.inputSchema.properties as Record<string, { type: string }>;

      expect(email.source_truncated.description).toContain('100000');
      expect(email.headers_truncated.type).toBe('boolean');
      expect(input.include_headers.type).toBe('boolean');
      expect(input.include_source.type).toBe('boolean');
    });
  });

  describe('handleSearchEmails', () => {
    it('searches emails by query', async () => {
      const mockData = {
        emails: [{ id: MAIL_ID, subject: 'Invoice', sender: 'billing@example.com' }],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleSearchEmails({ query: 'invoice', mailbox: 'INBOX' });

      expect(result.success).toBe(true);
      expect(runCommand).toHaveBeenCalledWith(
        'mail',
        'search_emails',
        budgeted({ query: 'invoice', mailbox: 'INBOX' }),
        PROCESS_TIMEOUT
      );
    });

    it('fails when query is empty', async () => {
      const result = await handleSearchEmails({ query: '', mailbox: 'INBOX' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
      expect(result.error?.message).toContain('query');
    });

    it('passes the filters, the page and a Unicode query with quotes through to mail-cli', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { emails: [], total: 0 } });
      const tool = createMailTools().find((t) => t.tool.name === 'searchEmails')!;
      const input = {
        query: 'Zażółć "東京" \\ 🚀',
        mailbox: 'INBOX',
        account: 'iCloud',
        sender: "o'brien@example.com",
        since: '2026-10-01',
        before: '2026-10-20T09:00:00+02:00',
        unread_only: true,
        offset: 10,
        limit: 5,
      };

      const result = await tool.handler(input);

      expect(result.isError).toBeFalsy();
      expect(vi.mocked(runCommand).mock.calls[0][2]).toEqual(budgeted(input));
    });

    it('returns no hits with a total of zero', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { emails: [], total: 0 } });

      const result = await handleSearchEmails({ query: 'nothing', mailbox: 'INBOX' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ emails: [], total: 0 });
    });

    it('gives a body search a longer time budget than a subject and sender search', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { emails: [], total: 0 } });

      await handleSearchEmails({ query: 'x', mailbox: 'INBOX' });
      await handleSearchEmails({ query: 'x', mailbox: 'INBOX', search_body: true });

      const [fast, slow] = vi.mocked(runCommand).mock.calls;
      const scriptMs = (call: typeof fast) =>
        (call[2] as Record<string, unknown>).script_timeout_ms as number;
      expect(scriptMs(slow)).toBeGreaterThan(scriptMs(fast));
      expect(slow[3]).toBeGreaterThan(fast[3]!);
      const tool = createMailTools().find((t) => t.tool.name === 'searchEmails')!;
      expect(tool.tool._meta?.[META_KEYS.TIMEOUT_MS]).toBeGreaterThan(slow[3]!);
      expect(tool.tool._meta?.[META_KEYS.TIMEOUT_CLASS]).toBe('long');
    });

    it('tells Claude that a body search is slow', () => {
      const tool = createMailTools().find((t) => t.tool.name === 'searchEmails')!;
      const schema = tool.tool.inputSchema as {
        properties: Record<string, { description: string }>;
      };

      expect(tool.tool.description).toMatch(/subject.*sender/i);
      expect(schema.properties.search_body.description).toMatch(/slow/i);
    });

    it.each([
      [{ search_body: 'yes' }, 'INVALID_TYPE'],
      [{ unread_only: 1 }, 'INVALID_TYPE'],
      [{ offset: -1 }, 'OUT_OF_RANGE'],
      [{ sender: 'a\x01b' }, 'INVALID_CHARACTERS'],
      [{ since: 12 }, 'INVALID_TYPE'],
    ])('rejects %o without calling mail-cli', async (extra, code) => {
      const result = await handleSearchEmails({
        query: 'x',
        mailbox: 'INBOX',
        ...(extra as object),
      } as any);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(code);
      expect(runCommand).not.toHaveBeenCalled();
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

      expect(runCommand).toHaveBeenCalledWith(
        'mail',
        'send_email',
        budgeted({
          to: 'bob@example.com',
          subject: 'Test',
          body: 'Hello Bob',
          bcc: 'carol@example.com',
          confirm_send: true,
        }),
        PROCESS_TIMEOUT
      );
    });
  });

  describe('handleReplyToEmail', () => {
    it('replies when confirm_send is true', async () => {
      const mockData = { status: 'sent' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleReplyToEmail({
        id: MAIL_ID,
        body: 'Thanks!',
        confirm_send: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('rejects when confirm_send is false', async () => {
      const result = await handleReplyToEmail({
        id: MAIL_ID,
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
    it('returns 10 tool definitions', () => {
      const tools = createMailTools();

      expect(tools).toHaveLength(10);
      expect(tools.map((t) => t.tool.name)).toEqual([
        'detectMailClients',
        'listMailboxes',
        'listEmails',
        'getEmail',
        'searchEmails',
        'sendEmail',
        'replyToEmail',
        'listMailRules',
        'checkMail',
        'deleteEmails',
      ]);
    });

    it('all tools have handlers', () => {
      const tools = createMailTools();
      for (const t of tools) {
        expect(t.handler).toBeTypeOf('function');
      }
    });
  });

  describe('mail rules', () => {
    it('listMailRules reads the rules through mail-cli', async () => {
      const rules = {
        rules: [{ name: 'A', enabled: true, match_all: true, conditions: [], actions: [] }],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: rules });

      const result = await handleListMailRules({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(rules);
      expect(runCommand).toHaveBeenCalledWith('mail', 'list_rules', budgeted({}), PROCESS_TIMEOUT);
    });

    it('listMailRules is read-only', () => {
      const tool = createMailTools().find((t) => t.tool.name === 'listMailRules')!;

      expect(tool.tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.tool.annotations?.destructiveHint).toBe(false);
    });

    it('no mail tool creates, changes or deletes a rule', () => {
      const ruleTools = createMailTools().filter((t) =>
        /rule/i.test(`${t.tool.name} ${t.tool.keywords?.join(' ')}`)
      );

      expect(ruleTools.map((t) => t.tool.name)).toEqual(['listMailRules']);
      expect(ruleTools.every((t) => t.tool.annotations?.readOnlyHint)).toBe(true);
    });

    it('listMailRules takes no arguments', async () => {
      const tool = createMailTools().find((t) => t.tool.name === 'listMailRules')!;

      const result = await tool.handler({ name: 'Forward all', enabled: false });

      expect(result.isError).toBe(true);
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  describe('check mail', () => {
    it('checks every account when no account is given', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { status: 'started' } });

      const result = await handleCheckMail({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ status: 'started' });
      expect(runCommand).toHaveBeenCalledWith('mail', 'check_mail', budgeted({}), PROCESS_TIMEOUT);
    });

    it('checks only the named account', async () => {
      vi.mocked(runCommand).mockResolvedValue({
        stdout: '',
        parsed: { status: 'started', account: 'Work' },
      });

      await handleCheckMail({ account: 'Work' });

      expect(runCommand).toHaveBeenCalledWith(
        'mail',
        'check_mail',
        budgeted({ account: 'Work' }),
        PROCESS_TIMEOUT
      );
    });

    it('rejects an account with control characters', async () => {
      const result = await handleCheckMail({ account: 'Wo\x01rk' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_CHARACTERS');
      expect(runCommand).not.toHaveBeenCalled();
    });

    it('is a non-destructive write', () => {
      const tool = createMailTools().find((t) => t.tool.name === 'checkMail')!;

      expect(tool.tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.tool.annotations?.destructiveHint).toBe(false);
    });

    it('an unknown account points at listMailboxes', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        new Error("mail.check_mail failed: MAIL_ACCOUNT_NOT_FOUND: Account 'Nope' not found.")
      );
      const tool = createMailTools().find((t) => t.tool.name === 'checkMail')!;

      const result = await tool.handler({ account: 'Nope' });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('MAIL_ACCOUNT_NOT_FOUND');
      expect(text).toContain('listMailboxes');
    });
  });

  describe('mailbox account', () => {
    it.each(['listEmails', 'searchEmails'])(
      '%s passes mailbox and account through to mail-cli',
      async (name) => {
        vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { emails: [] } });
        const tool = createMailTools().find((t) => t.tool.name === name)!;
        const input = { ...validInput(name), mailbox: 'Drafts', account: 'Google' };

        await tool.handler(input);

        expect(vi.mocked(runCommand).mock.calls[0][2]).toEqual(budgeted(input));
      }
    );

    it.each(['listEmails', 'searchEmails'])(
      '%s rejects an account with control characters',
      async (name) => {
        const tool = createMailTools().find((t) => t.tool.name === name)!;

        const result = await tool.handler({
          ...validInput(name),
          mailbox: 'Inbox',
          account: 'Ex\x01change',
        });

        expect(result.isError).toBe(true);
        expect((result.content[0] as { text: string }).text).toContain('INVALID_CHARACTERS');
        expect(runCommand).not.toHaveBeenCalled();
      }
    );
  });

  describe('mail client choice', () => {
    it('no mail tool offers a client parameter', () => {
      for (const t of createMailTools()) {
        expect(Object.keys(t.tool.inputSchema.properties), t.tool.name).not.toContain('client');
      }
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
        emails: [
          {
            id: MAIL_ID,
            subject: 'Hi',
            sender: 'Anna',
            date: '2026-10-20T09:15:00+02:00',
            read: false,
            mailbox: 'INBOX',
            account: 'iCloud',
          },
        ],
        total: 1,
      },
      getEmail: {
        email: {
          id: MAIL_ID,
          subject: 'Hi',
          sender: 'Anna',
          to: ['me@x'],
          cc: ['ewa@x'],
          date: '2026-10-20T09:15:00+02:00',
          read: true,
          body: 'Hello',
          mailbox: 'Archive',
          account: 'iCloud',
          attachments: [{ index: 1, name: 'a.pdf', size: 1024, mime_type: 'application/pdf' }],
          headers: 'Received: from mx',
          headers_truncated: false,
          source: 'Received: from mx',
          source_truncated: true,
        },
      },
      searchEmails: {
        emails: [
          {
            id: MAIL_ID,
            subject: 'Hi',
            sender: 'Anna',
            date: '2026-10-20T09:15:00+02:00',
            read: false,
            mailbox: 'INBOX',
            account: 'iCloud',
          },
        ],
        total: 1,
      },
      sendEmail: { status: 'sent' },
      replyToEmail: { status: 'sent' },
      listMailRules: {
        rules: [
          {
            name: 'Invoices',
            enabled: true,
            match_all: false,
            conditions: [
              { field: 'from header', qualifier: 'does contain value', expression: 'billing@x' },
              {
                field: 'header key',
                header: 'X-Mailer',
                qualifier: 'begins with value',
                expression: 'Acme',
              },
            ],
            actions: [
              { type: 'move', mailbox: 'Finance', account: 'Work' },
              { type: 'forward', address: 'a@x' },
              { type: 'reply', text: 'Away' },
            ],
          },
        ],
      },
      checkMail: { status: 'started', account: 'Work' },
      deleteEmails: gatedBatchOutputs(DELETE_PREVIEW, DELETE_REPORT),
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
        const result = await handleListEmails({ mailbox: 'INBOX', limit: '20' as any });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });
    });

    describe('handleSearchEmails', () => {
      it('rejects query with control characters', async () => {
        const result = await handleSearchEmails({ query: 'test\x00query', mailbox: 'INBOX' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });

      it('rejects limit = -1', async () => {
        const result = await handleSearchEmails({ query: 'test', mailbox: 'INBOX', limit: -1 });
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
          id: MAIL_ID,
          body: 'Thanks!',
          confirm_send: 'true' as any,
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });

      it('rejects reply_all as number 1', async () => {
        const result = await handleReplyToEmail({
          id: MAIL_ID,
          body: 'Thanks!',
          confirm_send: true,
          reply_all: 1 as any,
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });
    });
  });

  describe('time budget', () => {
    it.each(createMailTools().map((t) => [t.tool.name, t] as const))(
      '%s ends the script before mail-cli is killed, and mail-cli before the hub gives up',
      async (name, t) => {
        vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: {} });

        await t.handler(validInput(name));

        const [, , args, processTimeoutMs] = vi.mocked(runCommand).mock.calls[0];
        const scriptTimeoutMs = (args as Record<string, unknown>).script_timeout_ms as number;
        const toolTimeoutMs = t.tool._meta?.[META_KEYS.TIMEOUT_MS] as number;
        expect(scriptTimeoutMs).toBeGreaterThan(0);
        expect(processTimeoutMs).toBeGreaterThan(scriptTimeoutMs);
        expect(toolTimeoutMs).toBeGreaterThan(processTimeoutMs!);
      }
    );

    it('leaves Mail at least a few seconds of headroom before the process is killed', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { emails: [] } });

      await handleListEmails({ mailbox: 'INBOX' });

      const [, , args, processTimeoutMs] = vi.mocked(runCommand).mock.calls[0];
      const scriptTimeoutMs = (args as Record<string, unknown>).script_timeout_ms as number;
      expect(processTimeoutMs! - scriptTimeoutMs).toBeGreaterThanOrEqual(2_000);
    });
  });

  describe('deleteEmails', () => {
    const ids = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => `${MAIL_ID.slice(0, -2)}${i}`);

    it('passes the ids and the confirmation to mail-cli', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: DELETE_REPORT });

      const result = await handleDeleteEmails({ ids: [MAIL_ID], confirm_delete: true });

      expect(result.success).toBe(true);
      expect(runCommand).toHaveBeenCalledWith(
        'mail',
        'delete_emails',
        budgeted({ ids: [MAIL_ID], confirm_delete: true }),
        PROCESS_TIMEOUT
      );
    });

    it('without confirm_delete still asks mail-cli, which only previews', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: DELETE_PREVIEW });

      const result = await handleDeleteEmails({ ids: [MAIL_ID] });

      expect(result).toEqual({ success: true, data: DELETE_PREVIEW });
      expect(vi.mocked(runCommand).mock.calls[0][2]).toEqual(budgeted({ ids: [MAIL_ID] }));
    });

    it('accepts 25 mail ids', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: DELETE_PREVIEW });

      const result = await handleDeleteEmails({ ids: ids(25) });

      expect(result.success).toBe(true);
    });

    it('refuses 26 mail ids with the instruction to split them into confirmed batches', async () => {
      const result = await handleDeleteEmails({ ids: ids(26), confirm_delete: true });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MAIL_BATCH_TOO_LARGE');
      expect(result.error?.message).toContain('at most 25');
      expect(result.error?.message).toContain('confirm each batch');
      expect(runCommand).not.toHaveBeenCalled();
    });

    it.each([
      ['no ids', {}, 'MISSING_FIELDS'],
      ['an empty list', { ids: [] }, 'EMPTY_FIELDS'],
      ['ids as a string', { ids: MAIL_ID }, 'INVALID_TYPE'],
      ['a number among the ids', { ids: [MAIL_ID, 7] }, 'INVALID_TYPE'],
      ['an id with control characters', { ids: ['mail1.\x01'] }, 'INVALID_CHARACTERS'],
      ['an over-long id', { ids: ['m'.repeat(513)] }, 'FIELD_TOO_LONG'],
      ['confirm_delete as a string', { ids: [MAIL_ID], confirm_delete: 'true' }, 'INVALID_TYPE'],
    ])('refuses %s before calling mail-cli', async (_case, input, code) => {
      const result = await handleDeleteEmails(input as any);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(code);
      expect(runCommand).not.toHaveBeenCalled();
    });

    it('is destructive and declares the confirmation and the 25-id limit', () => {
      const tool = createMailTools().find((t) => t.tool.name === 'deleteEmails')!.tool;

      expect(tool.annotations?.destructiveHint).toBe(true);
      expect(tool.annotations?.readOnlyHint).toBe(false);
      const props = tool.inputSchema.properties as any;
      expect(props.ids).toMatchObject({ type: 'array', minItems: 1, maxItems: 25 });
      expect(props.confirm_delete.type).toBe('boolean');
      expect(tool.inputSchema.required).toEqual(['ids']);
      expect(tool.description).toContain('Trash');
      expect(tool.description).toContain('ask the user');
    });

    it('a batch mail-cli refuses as too large teaches the split', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        new Error(
          'mail.delete_emails failed: MAIL_BATCH_TOO_LARGE: 30 mail ids given, but one call takes at most 25.'
        )
      );

      const result = await handleDeleteEmails({ ids: [MAIL_ID] });

      expect(result.error?.code).toBe('MAIL_BATCH_TOO_LARGE');
      expect(result.error?.message).toContain('confirm each batch');
    });
  });

  describe('mail-cli failures reach Claude as teaching errors', () => {
    const cliFailure = (command: string, stderr: string): Error =>
      new Error(`mail.${command} failed: ${stderr}`);

    it('a timeout says how long Mail had and how to retry safely', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        cliFailure('list_emails', 'MAIL_TIMEOUT: Mail.app did not answer within 25 s.')
      );

      const result = await handleListEmails({ mailbox: 'Archive', limit: 500 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MAIL_TIMEOUT');
      expect(result.error?.message).toContain('Mail.app did not answer within 25 s.');
      expect(result.error?.message).toContain('smaller limit');
      expect(result.error?.message).toContain('Sent');
    });

    it('a denied Automation permission tells the user where to allow it', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        cliFailure(
          'list_mailboxes',
          'MAIL_AUTOMATION_DENIED: Speedwave is not allowed to control Mail.app (Not authorized to send Apple events to Mail. (-1743)).'
        )
      );

      const result = await handleListMailboxes({});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MAIL_AUTOMATION_DENIED');
      expect(result.error?.message).toContain('not allowed to control Mail.app');
      expect(result.error?.message).toContain('System Settings > Privacy & Security > Automation');
    });

    it('a missing mailbox names it and points at listMailboxes', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        cliFailure(
          'search_emails',
          "MAIL_MAILBOX_NOT_FOUND: Mailbox 'Archiv' not found in any account."
        )
      );

      const result = await handleSearchEmails({ query: 'x', mailbox: 'Archiv' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MAIL_MAILBOX_NOT_FOUND');
      expect(result.error?.message).toContain('Invalid mailbox (received: "Archiv")');
      expect(result.error?.message).toContain('Get a valid value from listMailboxes');
      expect(result.error?.message).toContain("Mailbox 'Archiv' not found in any account.");
    });

    it('a missing account names it and points at listMailboxes', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        cliFailure('list_emails', "MAIL_ACCOUNT_NOT_FOUND: Account 'Nope' not found.")
      );

      const result = await handleListEmails({ mailbox: 'Inbox', account: 'Nope' });

      expect(result.error?.code).toBe('MAIL_ACCOUNT_NOT_FOUND');
      expect(result.error?.message).toContain('Invalid account (received: "Nope")');
      expect(result.error?.message).toContain('listMailboxes');
    });

    it('a mailbox in several accounts asks for the account', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        cliFailure(
          'list_emails',
          "MAIL_MAILBOX_AMBIGUOUS: Mailbox 'Inbox' exists in several accounts: Exchange, Google."
        )
      );

      const result = await handleListEmails({ mailbox: 'Inbox' });

      expect(result.error?.code).toBe('MAIL_MAILBOX_AMBIGUOUS');
      expect(result.error?.message).toContain('Invalid account');
      expect(result.error?.message).toContain('Exchange, Google');
    });

    it('an id that is not a mail id points at the tools that return one', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        cliFailure(
          'get_email',
          "MAIL_INVALID_ID: '<a@x>' is not a mail id. Take the id from listEmails or searchEmails."
        )
      );

      const result = await handleGetEmail({ id: '<a@x>' });

      expect(result.error?.code).toBe('MAIL_INVALID_ID');
      expect(result.error?.message).toContain('Invalid id (received: "<a@x>")');
      expect(result.error?.message).toContain('listEmails');
      expect(result.error?.message).toContain('searchEmails');
    });

    it('a mailbox that changed during the read asks for one retry', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        cliFailure(
          'list_emails',
          "MAIL_MAILBOX_CHANGED: Mailbox 'INBOX' changed while it was being read."
        )
      );

      const result = await handleListEmails({ mailbox: 'INBOX' });

      expect(result.error?.code).toBe('MAIL_MAILBOX_CHANGED');
      expect(result.error?.message).toContain("Mailbox 'INBOX' changed while it was being read.");
      expect(result.error?.message).toContain('retry');
    });

    it('reaches Claude through the registered tool as an error result', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        cliFailure('list_emails', 'MAIL_TIMEOUT: Mail.app did not answer within 25 s.')
      );
      const tool = createMailTools().find((t) => t.tool.name === 'listEmails')!;

      const result = await tool.handler({ mailbox: 'INBOX', limit: 5 });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('MAIL_TIMEOUT');
      expect(text).toContain('Mail.app did not answer within 25 s.');
    });

    it('a mail no longer in its mailbox points at the tools that list the current ones', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        cliFailure(
          'get_email',
          "MAIL_NOT_FOUND: No email with this id in mailbox 'INBOX' of account 'iCloud'; it was moved or deleted."
        )
      );

      const result = await handleGetEmail({ id: MAIL_ID });

      expect(result.error?.code).toBe('MAIL_NOT_FOUND');
      expect(result.error?.message).toContain('Invalid id');
      expect(result.error?.message).toContain("mailbox 'INBOX' of account 'iCloud'");
      expect(result.error?.message).toContain('listEmails');
    });

    it('any other failure keeps its own message', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        cliFailure('get_email', 'AppleScript error: Mail got an error: Can’t get message 1.')
      );
      const tool = createMailTools().find((t) => t.tool.name === 'getEmail')!;

      const result = await tool.handler({ id: MAIL_ID });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('HANDLER_ERROR');
      expect(text).toContain('AppleScript error: Mail got an error: Can’t get message 1.');
    });
  });
});

const DELETE_PREVIEW = {
  status: 'confirmation_required',
  confirm_param: 'confirm_delete',
  instruction: 'Nothing was changed. Show this preview to the user and ask the user: …',
  emails: [
    {
      id: MAIL_ID,
      ok: true,
      subject: 'Hi',
      sender: 'Anna',
      date: '2026-10-20T09:15:00+02:00',
      mailbox: 'INBOX',
      account: 'iCloud',
    },
  ],
};

const DELETE_REPORT = {
  status: 'partial',
  emails: [
    { id: MAIL_ID, ok: true, subject: 'Hi', sender: 'Anna', mailbox: 'INBOX', account: 'iCloud' },
    {
      id: MAIL_ID,
      ok: false,
      mailbox: 'INBOX',
      account: 'iCloud',
      error: 'MAIL_NOT_FOUND: The email is no longer in mailbox …',
    },
  ],
  succeeded: 1,
  failed: 1,
};

/**
 * One sample carrying every key a gated batch tool emits, from its preview and from its per-mail report.
 * @param preview - The unconfirmed answer.
 * @param report - The confirmed answer.
 */
function gatedBatchOutputs(
  preview: { emails: object[] },
  report: { emails: object[] }
): Record<string, unknown> {
  return { ...preview, ...report, emails: [...preview.emails, ...report.emails] };
}

/**
 * A call each mail tool accepts.
 * @param name - Tool name.
 */
function validInput(name: string): Record<string, unknown> {
  const inputs: Record<string, Record<string, unknown>> = {
    detectMailClients: {},
    listMailboxes: {},
    listEmails: { mailbox: 'INBOX' },
    getEmail: { id: MAIL_ID },
    searchEmails: { query: 'hi', mailbox: 'INBOX' },
    sendEmail: { to: 'a@x', subject: 's', body: 'b', confirm_send: true },
    replyToEmail: { id: MAIL_ID, body: 'b', confirm_send: true },
    listMailRules: {},
    checkMail: {},
    deleteEmails: { ids: [MAIL_ID], confirm_delete: true },
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
