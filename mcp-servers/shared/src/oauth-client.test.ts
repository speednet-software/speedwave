import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OAuthRefreshError,
  OAuthScopeMismatchError,
  readJwtExp,
  accessTokenExpiresWithin,
  refreshFailure,
} from './oauth-client.js';

describe('refreshFailure', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oauth-client-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeStatus(content: string): Promise<void> {
    await writeFile(join(dir, 'refresh_status'), content);
  }

  it('asks to reconnect when the status is reconnect_required', async () => {
    await writeStatus('{"state":"reconnect_required","at":"2026-11-18T10:00:00Z"}');
    const err = await refreshFailure('slack', dir);
    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect(err.code).toBe('reconnect_required');
    expect(err.message).toBe(
      'Slack sign-in expired. Reconnect Slack in Speedwave Desktop: Settings, Integrations, Slack.'
    );
  });

  it('reports the network error time when the status is network_error', async () => {
    await writeStatus('{"state":"network_error","at":"2026-11-18T10:00:00Z"}');
    const err = await refreshFailure('slack', dir);
    expect(err.code).toBe('network_error');
    expect(err.message).toBe(
      'Slack token expired and Speedwave could not refresh it yet (network error at 2026-11-18T10:00:00Z). It retries every 10 seconds.'
    );
  });

  it('says the token has not been refreshed yet when there is no status file', async () => {
    const err = await refreshFailure('slack', dir);
    expect(err.code).toBe('not_refreshed');
    expect(err.message).toBe(
      'Slack token expired and has not been refreshed yet. Speedwave refreshes it while a session of this project runs.'
    );
  });

  it.each([
    ['not JSON', 'not json'],
    ['JSON null', 'null'],
    ['an unknown state', '{"state":"ok","at":"2026-11-18T10:00:00Z"}'],
    ['a status without a time', '{"state":"network_error"}'],
  ])('treats a status file with %s as absent', async (_label, content) => {
    await writeStatus(content);
    const err = await refreshFailure('slack', dir);
    expect(err.code).toBe('not_refreshed');
  });

  it('names SharePoint by its display name', async () => {
    await writeStatus('{"state":"reconnect_required","at":"2026-11-18T10:00:00Z"}');
    const err = await refreshFailure('sharepoint', dir);
    expect(err.message).toBe(
      'SharePoint sign-in expired. Reconnect SharePoint in Speedwave Desktop: Settings, Integrations, SharePoint.'
    );
  });

  it('uses the service id for a service without a display name', async () => {
    const err = await refreshFailure('glpi', dir);
    expect(err.message).toBe(
      'glpi token expired and has not been refreshed yet. Speedwave refreshes it while a session of this project runs.'
    );
  });
});

describe('OAuthScopeMismatchError', () => {
  it('is an Error named OAuthScopeMismatchError carrying its message', () => {
    const err = new OAuthScopeMismatchError('Sites.Manage.All not granted');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OAuthScopeMismatchError');
    expect(err.message).toBe('Sites.Manage.All not granted');
  });
});

describe('readJwtExp', () => {
  function jwt(payload: Record<string, unknown>): string {
    const b64url = (s: string) =>
      Buffer.from(s, 'utf8')
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(payload))}.sig`;
  }

  it('returns the exp claim as a number', () => {
    expect(readJwtExp(jwt({ exp: 1779000000 }))).toBe(1779000000);
  });

  it('returns null for non-JWT plain strings', () => {
    expect(readJwtExp('test-access-token')).toBeNull();
  });

  it('returns null when the JWT has no exp claim', () => {
    expect(readJwtExp(jwt({ sub: 'user' }))).toBeNull();
  });

  it('returns null when the JWT exp is not a number', () => {
    expect(readJwtExp(jwt({ exp: 'soon' }))).toBeNull();
  });

  it('returns null when the payload is not valid base64', () => {
    expect(readJwtExp('header.@@@.sig')).toBeNull();
  });

  it('returns null when payload is valid base64 but not JSON', () => {
    expect(readJwtExp('header.dmFsaWQ.sig')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(readJwtExp('')).toBeNull();
  });
});

describe('accessTokenExpiresWithin', () => {
  function jwt(exp: number): string {
    const b64url = (s: string) =>
      Buffer.from(s, 'utf8')
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify({ exp }))}.sig`;
  }

  const NOW_MS = 1_779_000_000_000;
  const NOW_S = NOW_MS / 1000;

  it('true when token expires inside the window', () => {
    expect(accessTokenExpiresWithin(jwt(NOW_S + 30), 120, NOW_MS)).toBe(true);
  });

  it('true when token is already expired', () => {
    expect(accessTokenExpiresWithin(jwt(NOW_S - 60), 120, NOW_MS)).toBe(true);
  });

  it('false when token expires beyond the window', () => {
    expect(accessTokenExpiresWithin(jwt(NOW_S + 600), 120, NOW_MS)).toBe(false);
  });

  it('false exactly at the window boundary (strict <)', () => {
    expect(accessTokenExpiresWithin(jwt(NOW_S + 120), 120, NOW_MS)).toBe(false);
  });

  it('seconds=0 true for already-expired token', () => {
    expect(accessTokenExpiresWithin(jwt(NOW_S - 1), 0, NOW_MS)).toBe(true);
  });

  it('seconds=0 false for future token', () => {
    expect(accessTokenExpiresWithin(jwt(NOW_S + 1), 0, NOW_MS)).toBe(false);
  });

  it('false for unparseable tokens (legacy/test strings)', () => {
    expect(accessTokenExpiresWithin('test-access-token', 120, NOW_MS)).toBe(false);
  });
});
