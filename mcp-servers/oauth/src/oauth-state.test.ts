import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, chmod, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOAuthState, saveOAuthState, loadBearerMap, type OAuthState } from './oauth-state.js';

describe('oauth-state', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oauth-state-test-'));
    if (process.platform !== 'win32') {
      await chmod(dir, 0o700);
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sample: OAuthState = {
    provider: 'microsoft',
    clientId: '11111111-1111-1111-1111-111111111111',
    tenantId: 'common',
    scopes: ['https://graph.microsoft.com/Sites.Manage.All'],
    grantedScopes: ['https://graph.microsoft.com/Sites.Manage.All'],
    refreshToken: 'r',
    expiresAt: '2026-05-15T00:00:00.000Z',
    lastRefreshAt: '2026-05-15T00:00:00.000Z',
  };

  describe('loadOAuthState', () => {
    it('returns null when file does not exist', async () => {
      const result = await loadOAuthState(dir, 'sharepoint');
      expect(result).toBeNull();
    });

    it('returns parsed state when file exists', async () => {
      await writeFile(join(dir, 'sharepoint.json'), JSON.stringify(sample), {
        mode: 0o600,
      });
      const result = await loadOAuthState(dir, 'sharepoint');
      expect(result).toEqual(sample);
    });

    it('throws on malformed JSON', async () => {
      await writeFile(join(dir, 'broken.json'), 'not-json', { mode: 0o600 });
      await expect(loadOAuthState(dir, 'broken')).rejects.toThrow();
    });
  });

  describe('saveOAuthState', () => {
    it.runIf(process.platform !== 'win32')(
      'writes file with mode 0o600 in an owner-only dir',
      async () => {
        await saveOAuthState(dir, 'sharepoint', sample);
        const content = await readFile(join(dir, 'sharepoint.json'), 'utf8');
        const parsed = JSON.parse(content) as OAuthState;
        expect(parsed).toEqual(sample);
      }
    );

    it('roundtrips through loadOAuthState', async () => {
      await saveOAuthState(dir, 'sharepoint', sample);
      const result = await loadOAuthState(dir, 'sharepoint');
      expect(result).toEqual(sample);
    });
  });

  describe('loadBearerMap', () => {
    it('returns empty map when file is absent', async () => {
      const result = await loadBearerMap(dir);
      expect(result).toEqual({});
    });

    it('returns parsed map when present', async () => {
      await writeFile(
        join(dir, '.bearer-map.json'),
        JSON.stringify({ 'bearer-sp': 'sharepoint', 'bearer-x': 'other' }),
        { mode: 0o600 }
      );
      const result = await loadBearerMap(dir);
      expect(result).toEqual({ 'bearer-sp': 'sharepoint', 'bearer-x': 'other' });
    });

    it('rejects non-object JSON', async () => {
      await writeFile(join(dir, '.bearer-map.json'), JSON.stringify(['nope']), {
        mode: 0o600,
      });
      await expect(loadBearerMap(dir)).rejects.toThrow();
    });

    it('rejects entries with non-string service id', async () => {
      await writeFile(join(dir, '.bearer-map.json'), JSON.stringify({ 'bearer-sp': 42 }), {
        mode: 0o600,
      });
      await expect(loadBearerMap(dir)).rejects.toThrow();
    });

    it('rejects entries with empty service id', async () => {
      await writeFile(join(dir, '.bearer-map.json'), JSON.stringify({ 'bearer-sp': '' }), {
        mode: 0o600,
      });
      await expect(loadBearerMap(dir)).rejects.toThrow();
    });

    it('rejects service id with path traversal (defense in depth)', async () => {
      await writeFile(
        join(dir, '.bearer-map.json'),
        JSON.stringify({ 'bearer-x': '../../etc/passwd' }),
        { mode: 0o600 }
      );
      await expect(loadBearerMap(dir)).rejects.toThrow(/does not match/);
    });

    it('rejects service id with slash (path injection)', async () => {
      await writeFile(join(dir, '.bearer-map.json'), JSON.stringify({ 'bearer-x': 'a/b' }), {
        mode: 0o600,
      });
      await expect(loadBearerMap(dir)).rejects.toThrow(/does not match/);
    });

    it('rejects service id with uppercase (slug regex)', async () => {
      await writeFile(join(dir, '.bearer-map.json'), JSON.stringify({ 'bearer-x': 'SharePoint' }), {
        mode: 0o600,
      });
      await expect(loadBearerMap(dir)).rejects.toThrow(/does not match/);
    });

    it('rejects null', async () => {
      await writeFile(join(dir, '.bearer-map.json'), 'null', { mode: 0o600 });
      await expect(loadBearerMap(dir)).rejects.toThrow();
    });
  });
});
