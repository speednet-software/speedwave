/**
 * Security Tests
 *
 * Covers:
 * - Command allowlist enforcement
 * - ISO8601 strict validation
 * - Input sanitization via withValidation
 * - Tool ↔ allowlist parity
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted ensures these are created before vi.mock factories execute
const { execFileAsyncMock, existsSyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  existsSyncMock: vi.fn(() => true),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: existsSyncMock,
  },
}));

vi.mock('node:util', async () => {
  const actual = await vi.importActual('node:util');
  return {
    ...actual,
    promisify: vi.fn(() => execFileAsyncMock),
  };
});

import { runCommand, buildChildEnv, type OsDomain } from './platform-runner.js';
import { ALLOWED_COMMANDS } from './tools/index.js';
import { isValidISO8601, withValidation } from './tools/validation.js';
import type { ToolResult } from './tools/validation.js';
import { createToolDefinitions } from './tools/index.js';

describe('Security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    delete process.env.SPEEDWAVE_PROD;
    delete process.env.SPEEDWAVE_RESOURCES_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Command Allowlist
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Command Allowlist', () => {
    it('rejects unknown command names', async () => {
      await expect(runCommand('reminders', 'evil_command')).rejects.toThrow('Unknown command');
      await expect(runCommand('calendar', 'drop_tables')).rejects.toThrow('Unknown command');
      await expect(runCommand('mail', 'exec')).rejects.toThrow('Unknown command');
      await expect(runCommand('notes', 'shell')).rejects.toThrow('Unknown command');
    });

    it('rejects path traversal attempts', async () => {
      await expect(runCommand('reminders', '../../../etc/passwd')).rejects.toThrow(
        'Unknown command'
      );
      await expect(runCommand('notes', '../../secrets')).rejects.toThrow('Unknown command');
    });

    it('rejects shell metacharacters in command name', async () => {
      await expect(runCommand('reminders', 'list_lists; rm -rf /')).rejects.toThrow(
        'Unknown command'
      );
      await expect(runCommand('mail', 'send_email | cat /etc/passwd')).rejects.toThrow(
        'Unknown command'
      );
      await expect(runCommand('calendar', 'list_events && whoami')).rejects.toThrow(
        'Unknown command'
      );
    });

    it('rejects empty string as command', async () => {
      await expect(runCommand('reminders', '')).rejects.toThrow('Unknown command');
    });

    it('has expected command count per domain', () => {
      expect(ALLOWED_COMMANDS.reminders.size).toBe(5);
      expect(ALLOWED_COMMANDS.calendar.size).toBe(6);
      expect(ALLOWED_COMMANDS.mail.size).toBe(7);
      expect(ALLOWED_COMMANDS.notes.size).toBe(7);
    });

    it('accepts all allowlisted reminders commands', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '{}', stderr: '' });
      for (const cmd of ALLOWED_COMMANDS.reminders) {
        await expect(runCommand('reminders', cmd)).resolves.toBeDefined();
      }
    });

    it('accepts all allowlisted calendar commands', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '{}', stderr: '' });
      for (const cmd of ALLOWED_COMMANDS.calendar) {
        await expect(runCommand('calendar', cmd)).resolves.toBeDefined();
      }
    });

    it('accepts all allowlisted mail commands', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '{}', stderr: '' });
      for (const cmd of ALLOWED_COMMANDS.mail) {
        await expect(runCommand('mail', cmd)).resolves.toBeDefined();
      }
    });

    it('accepts all allowlisted notes commands', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '{}', stderr: '' });
      for (const cmd of ALLOWED_COMMANDS.notes) {
        await expect(runCommand('notes', cmd)).resolves.toBeDefined();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool ↔ Allowlist parity
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Tool ↔ Allowlist parity', () => {
    it('every registered tool handler invokes runCommand with an allowlisted command', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '{}', stderr: '' });

      const tools = createToolDefinitions();
      const calledCommands: Array<{ domain: string; command: string }> = [];

      // Spy on the real runCommand to capture actual calls
      const runCommandSpy = vi.spyOn(await import('./platform-runner.js'), 'runCommand');
      runCommandSpy.mockImplementation(async (domain, command) => {
        calledCommands.push({ domain, command });
        return { stdout: '{}', parsed: {} };
      });

      for (const { tool, handler } of tools) {
        const required = tool.inputSchema.required ?? [];
        const params: Record<string, unknown> = {};
        for (const field of required) {
          // Use correct types so handlers don't short-circuit on validation
          const prop = tool.inputSchema.properties?.[field] as
            | { type?: string; description?: string }
            | undefined;
          const isDateField =
            prop?.description?.toLowerCase().includes('iso8601') ||
            field === 'start' ||
            field === 'end';
          if (prop?.type === 'boolean') {
            params[field] = true;
          } else if (isDateField) {
            params[field] = '2026-02-20T10:00:00Z';
          } else {
            params[field] = 'test-value';
          }
        }
        await handler(params);
      }

      // Verify runCommand was called for EVERY tool
      expect(calledCommands.length).toBe(tools.length);

      // Verify every called command is in the allowlist
      for (const { domain, command } of calledCommands) {
        const allowed = ALLOWED_COMMANDS[domain as OsDomain];
        expect(allowed, `No allowlist for domain '${domain}'`).toBeDefined();
        expect(allowed.has(command), `Command '${domain}.${command}' not in allowlist`).toBe(true);
      }

      runCommandSpy.mockRestore();
    });

    it('allowlist count matches registered tool count', () => {
      const tools = createToolDefinitions();
      const allowlistTotal =
        ALLOWED_COMMANDS.reminders.size +
        ALLOWED_COMMANDS.calendar.size +
        ALLOWED_COMMANDS.mail.size +
        ALLOWED_COMMANDS.notes.size;

      expect(tools.length).toBe(allowlistTotal);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ISO8601 Strictness
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ISO8601 Strictness', () => {
    it('rejects human-readable date formats', () => {
      expect(isValidISO8601('Feb 20, 2026')).toBe(false);
      expect(isValidISO8601('20 Feb 2026')).toBe(false);
      expect(isValidISO8601('February 20, 2026')).toBe(false);
    });

    it('rejects slash-delimited dates', () => {
      expect(isValidISO8601('2026/02/20')).toBe(false);
      expect(isValidISO8601('02/20/2026')).toBe(false);
    });

    it('rejects unix timestamps as strings', () => {
      expect(isValidISO8601('1708387200000')).toBe(false);
      expect(isValidISO8601('1708387200')).toBe(false);
    });

    it('rejects dates with trailing content', () => {
      expect(isValidISO8601('2026-02-20T10:00:00Z; DROP TABLE users')).toBe(false);
      expect(isValidISO8601('2026-02-20 extra content')).toBe(false);
      expect(isValidISO8601('2026-02-20T10:00:00ZZZZ')).toBe(false);
    });

    it('accepts valid ISO8601 date-only format', () => {
      expect(isValidISO8601('2026-02-20')).toBe(true);
    });

    it('accepts valid ISO8601 with UTC timezone', () => {
      expect(isValidISO8601('2026-02-20T10:00:00Z')).toBe(true);
    });

    it('accepts valid ISO8601 with offset timezone', () => {
      expect(isValidISO8601('2026-02-20T10:00:00+01:00')).toBe(true);
      expect(isValidISO8601('2026-02-20T10:00:00-05:00')).toBe(true);
    });

    it('accepts valid ISO8601 with milliseconds', () => {
      expect(isValidISO8601('2026-02-20T10:00:00.000Z')).toBe(true);
      expect(isValidISO8601('2026-02-20T10:00:00.123456Z')).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Environment Isolation (SEC-025)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Environment Isolation', () => {
    const envKeysToClean = [
      'MCP_OS_AUTH_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'ANTHROPIC_API_KEY',
      'DATABASE_URL',
      'SLACK_BOT_TOKEN',
      'npm_config_registry',
      'NODE_OPTIONS',
      'LD_PRELOAD',
    ];

    afterEach(() => {
      for (const key of envKeysToClean) {
        delete process.env[key];
      }
    });

    it('buildChildEnv excludes MCP_OS_AUTH_TOKEN', () => {
      process.env.MCP_OS_AUTH_TOKEN = 'secret-token-value';
      const env = buildChildEnv();
      expect(env.MCP_OS_AUTH_TOKEN).toBeUndefined();
    });

    it('buildChildEnv excludes common secret env vars', () => {
      const secrets = [
        'AWS_SECRET_ACCESS_KEY',
        'GITHUB_TOKEN',
        'ANTHROPIC_API_KEY',
        'DATABASE_URL',
        'SLACK_BOT_TOKEN',
        'npm_config_registry',
        'NODE_OPTIONS',
        'LD_PRELOAD',
      ];
      for (const key of secrets) {
        process.env[key] = 'should-not-leak';
      }

      const env = buildChildEnv();

      for (const key of secrets) {
        expect(env[key as keyof NodeJS.ProcessEnv], `${key} should not leak`).toBeUndefined();
      }
    });

    it('runCommand does not pass secrets to child process', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '{}', stderr: '' });
      process.env.MCP_OS_AUTH_TOKEN = 'secret';

      await runCommand('reminders', 'list_lists');

      const opts = execFileAsyncMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.MCP_OS_AUTH_TOKEN).toBeUndefined();
      expect(opts.env.PATH).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Input Sanitization (withValidation)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Input Sanitization', () => {
    it('rejects null params via withValidation', async () => {
      const handler = async (): Promise<ToolResult> => ({ success: true, data: {} });
      const wrapped = withValidation(handler);

      const result = await wrapped(null as any);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('INVALID_INPUT');
    });

    it('rejects array params via withValidation', async () => {
      const handler = async (): Promise<ToolResult> => ({ success: true, data: {} });
      const wrapped = withValidation(handler);

      const result = await wrapped([] as any);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('INVALID_INPUT');
    });

    it('rejects undefined params via withValidation', async () => {
      const handler = async (): Promise<ToolResult> => ({ success: true, data: {} });
      const wrapped = withValidation(handler);

      const result = await wrapped(undefined as any);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('INVALID_INPUT');
    });

    it('accepts valid object params via withValidation', async () => {
      const handler = async (params: { name: string }): Promise<ToolResult> => ({
        success: true,
        data: { name: params.name },
      });
      const wrapped = withValidation(handler);

      const result = await wrapped({ name: 'test' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('test');
    });

    it('catches thrown errors in handler and returns HANDLER_ERROR', async () => {
      const handler = async (): Promise<ToolResult> => {
        throw new Error('Simulated failure');
      };
      const wrapped = withValidation(handler);

      const result = await wrapped({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('HANDLER_ERROR');
      expect(result.content[0].text).toContain('Simulated failure');
    });
  });
});
