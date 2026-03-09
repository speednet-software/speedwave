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

// Mock the platform runner
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
      const mockData = { clients: ['Apple Mail', 'Outlook'] };
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
        mailboxes: [{ name: 'INBOX', account: 'john@example.com', unread_count: 5 }],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListMailboxes({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });
  });

  describe('handleListEmails', () => {
    it('returns emails with pagination', async () => {
      const mockData = {
        emails: [{ id: 'msg-1', subject: 'Hello', from: 'alice@example.com' }],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListEmails({ limit: 10, offset: 0 });

      expect(result.success).toBe(true);
      expect(runCommand).toHaveBeenCalledWith('mail', 'list_emails', { limit: 10, offset: 0 });
    });
  });

  describe('handleGetEmail', () => {
    it('returns email by ID', async () => {
      const mockData = {
        id: 'msg-1',
        subject: 'Hello',
        from: 'alice@example.com',
        body: 'Hello world',
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
        results: [{ id: 'msg-2', subject: 'Invoice', from: 'billing@example.com' }],
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
      const mockData = { status: 'sent', message_id: 'msg-new' };
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

    describe('handleListMailboxes', () => {
      it('rejects client with control characters', async () => {
        const result = await handleListMailboxes({ client: 'mail\x07app' });
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

      it('rejects negative offset', async () => {
        const result = await handleListEmails({ offset: -1 });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('OUT_OF_RANGE');
      });

      it('rejects unread_only as string', async () => {
        const result = await handleListEmails({ unread_only: 'true' as any });
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
