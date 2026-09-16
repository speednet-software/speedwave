import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('./service-list.js', () => ({
  getAllServiceNames: () => ['slack', 'gitlab'],
}));

let secretsDir: string;

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('fs');
  return {
    ...actual,
    existsSync: (path: string) => {
      if (typeof path === 'string' && path.startsWith('/secrets/')) {
        const filename = path.replace('/secrets/', '');
        return actual.existsSync(join(secretsDir, filename));
      }
      return actual.existsSync(path);
    },
    readFileSync: (path: string, encoding: string) => {
      if (typeof path === 'string' && path.startsWith('/secrets/')) {
        const filename = path.replace('/secrets/', '');
        return actual.readFileSync(join(secretsDir, filename), encoding);
      }
      return actual.readFileSync(path, encoding);
    },
  };
});

import { loadAuthTokens, getAuthToken, hasAuthToken, clearAuthTokens } from './auth-tokens.js';

describe('auth-tokens', () => {
  beforeEach(() => {
    secretsDir = mkdtempSync(join(tmpdir(), 'auth-tokens-test-'));
    clearAuthTokens();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads token from file and trims whitespace', () => {
    writeFileSync(join(secretsDir, 'slack-auth-token'), '  my-secret-token  \n');

    loadAuthTokens();

    expect(getAuthToken('slack')).toBe('my-secret-token');
    expect(hasAuthToken('slack')).toBe(true);
  });

  it('skips empty token files', () => {
    writeFileSync(join(secretsDir, 'slack-auth-token'), '   \n');

    loadAuthTokens();

    expect(getAuthToken('slack')).toBeUndefined();
    expect(hasAuthToken('slack')).toBe(false);
  });

  it('returns undefined for service with no token file', () => {
    loadAuthTokens();

    expect(getAuthToken('slack')).toBeUndefined();
    expect(hasAuthToken('slack')).toBe(false);
  });

  it('loads tokens for multiple services', () => {
    writeFileSync(join(secretsDir, 'slack-auth-token'), 'slack-token');
    writeFileSync(join(secretsDir, 'gitlab-auth-token'), 'gitlab-token');

    loadAuthTokens();

    expect(getAuthToken('slack')).toBe('slack-token');
    expect(getAuthToken('gitlab')).toBe('gitlab-token');
  });

  it('handles readFileSync error gracefully without crashing', () => {
    mkdirSync(join(secretsDir, 'slack-auth-token'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    loadAuthTokens();

    expect(getAuthToken('slack')).toBeUndefined();
    const warnMessages = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(warnMessages.some((msg) => msg.includes('Could not read token for slack'))).toBe(true);

    warnSpy.mockRestore();
  });

  it('clearAuthTokens removes all loaded tokens', () => {
    writeFileSync(join(secretsDir, 'slack-auth-token'), 'token');

    loadAuthTokens();
    expect(hasAuthToken('slack')).toBe(true);

    clearAuthTokens();
    expect(hasAuthToken('slack')).toBe(false);
    expect(getAuthToken('slack')).toBeUndefined();
  });

  it('iterates only services from getAllServiceNames', () => {
    writeFileSync(join(secretsDir, 'redmine-auth-token'), 'redmine-token');

    loadAuthTokens();

    expect(getAuthToken('redmine')).toBeUndefined();
  });
});
