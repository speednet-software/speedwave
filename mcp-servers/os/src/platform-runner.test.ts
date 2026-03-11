/**
 * Platform Runner Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

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

// Import after mocks are set up
import { resolvePaths, runCommand, buildChildEnv, SAFE_ENV_KEYS } from './platform-runner.js';
import { ALLOWED_COMMANDS } from './tools/index.js';

describe('platform-runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    delete process.env.SPEEDWAVE_PROD;
    delete process.env.SPEEDWAVE_RESOURCES_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MCP_OS_AUTH_TOKEN;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  describe('resolvePaths', () => {
    it('resolves darwin dev paths for Swift binaries', () => {
      const paths = resolvePaths();

      if (process.platform === 'darwin') {
        expect(paths.reminders).toContain(path.join('native', 'macos', 'reminders'));
        expect(paths.reminders).toContain('reminders-cli');
        expect(paths.calendar).toContain(path.join('native', 'macos', 'calendar'));
        expect(paths.calendar).toContain('calendar-cli');
        expect(paths.mail).toContain(path.join('native', 'macos', 'mail'));
        expect(paths.mail).toContain('mail-cli');
        expect(paths.notes).toContain(path.join('native', 'macos', 'notes'));
        expect(paths.notes).toContain('notes-cli');
      } else {
        expect(paths.reminders).toContain('native-os-cli');
        expect(paths.calendar).toBe(paths.reminders);
      }
    });

    it('resolves production paths when SPEEDWAVE_PROD is set', () => {
      process.env.SPEEDWAVE_PROD = '1';
      const paths = resolvePaths();

      if (process.platform === 'darwin') {
        expect(paths.reminders).toContain('Resources');
        expect(paths.reminders).toContain('reminders-cli');
      } else {
        expect(paths.reminders).toContain('Resources');
        expect(paths.reminders).toContain('native-os-cli');
      }
    });

    it('uses SPEEDWAVE_RESOURCES_DIR when set', () => {
      process.env.SPEEDWAVE_PROD = '1';
      process.env.SPEEDWAVE_RESOURCES_DIR = '/custom/resources';
      const paths = resolvePaths();

      expect(paths.reminders).toMatch(/^\/custom\/resources\//);
    });

    it('returns absolute paths', () => {
      const paths = resolvePaths();
      expect(path.isAbsolute(paths.reminders)).toBe(true);
      expect(path.isAbsolute(paths.calendar)).toBe(true);
      expect(path.isAbsolute(paths.mail)).toBe(true);
      expect(path.isAbsolute(paths.notes)).toBe(true);
    });
  });

  describe('ALLOWED_COMMANDS', () => {
    it('defines commands for all four domains', () => {
      expect(ALLOWED_COMMANDS.reminders).toBeDefined();
      expect(ALLOWED_COMMANDS.calendar).toBeDefined();
      expect(ALLOWED_COMMANDS.mail).toBeDefined();
      expect(ALLOWED_COMMANDS.notes).toBeDefined();
    });

    it('has expected command count per domain', () => {
      expect(ALLOWED_COMMANDS.reminders.size).toBe(5);
      expect(ALLOWED_COMMANDS.calendar.size).toBe(6);
      expect(ALLOWED_COMMANDS.mail.size).toBe(7);
      expect(ALLOWED_COMMANDS.notes.size).toBe(7);
    });
  });

  describe('runCommand', () => {
    it('calls execFile with correct args on macOS', async () => {
      if (process.platform !== 'darwin') return;

      execFileAsyncMock.mockResolvedValue({ stdout: '{"lists": []}', stderr: '' });

      const result = await runCommand('reminders', 'list_lists', {});

      expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
      const [binaryPath, args] = execFileAsyncMock.mock.calls[0];
      expect(binaryPath).toContain('reminders-cli');
      expect(args).toEqual(['list_lists', '{}']);
      expect(result.parsed).toEqual({ lists: [] });
    });

    it('calls execFile with domain.command format on Linux', async () => {
      if (process.platform !== 'linux') return;

      execFileAsyncMock.mockResolvedValue({ stdout: '{"reminders": []}', stderr: '' });

      const result = await runCommand('reminders', 'list_reminders', { limit: 20 });

      expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
      const [, args] = execFileAsyncMock.mock.calls[0];
      expect(args).toEqual(['reminders.list_reminders', '{"limit":20}']);
      expect(result.parsed).toEqual({ reminders: [] });
    });

    it('parses JSON stdout correctly', async () => {
      const jsonOutput = JSON.stringify({ id: 'abc-123', status: 'created' });
      execFileAsyncMock.mockResolvedValue({ stdout: jsonOutput, stderr: '' });

      const result = await runCommand('reminders', 'create_reminder', { name: 'Test' });

      expect(result.parsed).toEqual({ id: 'abc-123', status: 'created' });
      expect(result.stdout).toBe(jsonOutput);
    });

    it('throws on binary not found', async () => {
      existsSyncMock.mockReturnValue(false);

      await expect(runCommand('reminders', 'list_lists')).rejects.toThrow(
        'Native CLI binary not found'
      );
    });

    it('throws on timeout (killed process)', async () => {
      const error = new Error('timed out') as any;
      error.killed = true;
      execFileAsyncMock.mockRejectedValue(error);

      await expect(runCommand('reminders', 'list_lists', {}, 5000)).rejects.toThrow(
        'timed out after 5000ms'
      );
    });

    it('throws with stderr content on exit code 1', async () => {
      const error = new Error('exit code 1') as any;
      error.stderr = 'Permission denied: open System Settings > Privacy > Reminders';
      execFileAsyncMock.mockRejectedValue(error);

      await expect(runCommand('reminders', 'list_reminders')).rejects.toThrow('Permission denied');
    });

    it('throws on invalid JSON output', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: 'not valid json', stderr: '' });

      await expect(runCommand('reminders', 'list_lists')).rejects.toThrow();
    });

    it('logs stderr warnings without failing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      execFileAsyncMock.mockResolvedValue({ stdout: '{"ok": true}', stderr: 'some warning' });

      const result = await runCommand('reminders', 'list_lists');

      expect(result.parsed).toEqual({ ok: true });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('some warning'));
      warnSpy.mockRestore();
    });

    it('passes timeout option to execFile', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '{}', stderr: '' });

      await runCommand('reminders', 'list_lists', {}, 15_000);

      const opts = execFileAsyncMock.mock.calls[0][2] as { timeout: number };
      expect(opts.timeout).toBe(15_000);
    });

    it('uses default 30s timeout when not specified', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '{}', stderr: '' });

      await runCommand('reminders', 'list_lists');

      const opts = execFileAsyncMock.mock.calls[0][2] as { timeout: number };
      expect(opts.timeout).toBe(30_000);
    });

    it('throws generic error when no stderr', async () => {
      const error = new Error('Something unexpected');
      execFileAsyncMock.mockRejectedValue(error);

      await expect(runCommand('reminders', 'list_lists')).rejects.toThrow('Something unexpected');
    });

    it('rejects unknown command with allowlist error', async () => {
      await expect(runCommand('reminders', 'evil_command')).rejects.toThrow('Unknown command');
    });

    it('rejects path traversal in command name', async () => {
      await expect(runCommand('reminders', '../../../etc/passwd')).rejects.toThrow(
        'Unknown command'
      );
    });

    it('rejects shell metacharacters in command name', async () => {
      await expect(runCommand('reminders', 'list_lists; rm -rf /')).rejects.toThrow(
        'Unknown command'
      );
    });

    it('rejects empty command string', async () => {
      await expect(runCommand('reminders', '')).rejects.toThrow('Unknown command');
    });

    it('passes filtered env to child process (no secret leakage)', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '{}', stderr: '' });

      // Set a secret that must NOT leak
      process.env.MCP_OS_AUTH_TOKEN = 'secret-token-value';
      process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';

      await runCommand('reminders', 'list_lists');

      const opts = execFileAsyncMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.MCP_OS_AUTH_TOKEN).toBeUndefined();
      expect(opts.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(opts.env.PATH).toBeDefined();
      expect(opts.env.HOME).toBeDefined();
    });

    it('accepts all allowlisted commands (does not throw allowlist error)', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '{}', stderr: '' });

      for (const [domain, commands] of Object.entries(ALLOWED_COMMANDS)) {
        for (const cmd of commands) {
          // Should not throw allowlist error — may throw binary-not-found, but that's OK
          await expect(
            runCommand(domain as any, cmd).catch((e: Error) => {
              if (e.message.includes('Unknown command')) throw e;
              // Ignore non-allowlist errors (binary not found, etc.)
            })
          ).resolves.not.toThrow();
        }
      }
    });
  });

  describe('buildChildEnv', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore original env
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, originalEnv);
    });

    it('includes safe OS variables', () => {
      process.env.PATH = '/usr/bin:/bin';
      process.env.HOME = '/home/user';
      process.env.LANG = 'en_US.UTF-8';

      const env = buildChildEnv();

      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(env.HOME).toBe('/home/user');
      expect(env.LANG).toBe('en_US.UTF-8');
    });

    it('excludes MCP_OS_AUTH_TOKEN', () => {
      process.env.MCP_OS_AUTH_TOKEN = 'secret-token';

      const env = buildChildEnv();

      expect(env.MCP_OS_AUTH_TOKEN).toBeUndefined();
    });

    it('excludes arbitrary secrets and API keys', () => {
      process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
      process.env.GITHUB_TOKEN = 'ghp_xxxx';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-xxxx';
      process.env.DATABASE_URL = 'postgres://user:pass@host/db';

      const env = buildChildEnv();

      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
    });

    it('omits keys not present in process.env', () => {
      delete process.env.SDKROOT;
      delete process.env.DBUS_SESSION_BUS_ADDRESS;

      const env = buildChildEnv();

      expect('SDKROOT' in env).toBe(false);
      expect('DBUS_SESSION_BUS_ADDRESS' in env).toBe(false);
    });

    it('only contains allowlisted keys', () => {
      // Populate many env vars
      process.env.PATH = '/usr/bin';
      process.env.HOME = '/home/user';
      process.env.SECRET_KEY = 'leaked';
      process.env.NODE_ENV = 'production';
      process.env.npm_config_registry = 'https://registry.npmjs.org';

      const env = buildChildEnv();
      const keys = Object.keys(env);

      // Every key in the output must be from the implementation's allowlist
      const safeKeys = new Set(SAFE_ENV_KEYS);
      for (const key of keys) {
        expect(safeKeys.has(key), `Unexpected key in child env: ${key}`).toBe(true);
      }
    });
  });
});
