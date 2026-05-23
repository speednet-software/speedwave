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
    providerData: {
      clientId: '11111111-1111-1111-1111-111111111111',
      tenantId: 'common',
    },
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

    it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
      'rethrows non-ENOENT read errors (e.g. EACCES)',
      async () => {
        const path = join(dir, 'denied.json');
        await writeFile(path, JSON.stringify(sample), { mode: 0o600 });
        await chmod(path, 0o000);
        try {
          await expect(loadOAuthState(dir, 'denied')).rejects.toThrow();
        } finally {
          await chmod(path, 0o600);
        }
      }
    );

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

    it('throws when root is not an object', async () => {
      await writeFile(join(dir, 'arr.json'), JSON.stringify([sample]), { mode: 0o600 });
      await expect(loadOAuthState(dir, 'arr')).rejects.toThrow(/must be a JSON object/);
    });

    it('throws when root is null', async () => {
      await writeFile(join(dir, 'null.json'), 'null', { mode: 0o600 });
      await expect(loadOAuthState(dir, 'null')).rejects.toThrow(/must be a JSON object/);
    });

    it('throws when provider is missing', async () => {
      const { provider: _p, ...rest } = sample;
      await writeFile(join(dir, 'noprov.json'), JSON.stringify(rest), { mode: 0o600 });
      await expect(loadOAuthState(dir, 'noprov')).rejects.toThrow(
        /`provider` must be a non-empty string/
      );
    });

    it('throws when provider is empty', async () => {
      await writeFile(join(dir, 'empty.json'), JSON.stringify({ ...sample, provider: '' }), {
        mode: 0o600,
      });
      await expect(loadOAuthState(dir, 'empty')).rejects.toThrow(
        /`provider` must be a non-empty string/
      );
    });

    it('throws when provider is not a string', async () => {
      await writeFile(join(dir, 'notstr.json'), JSON.stringify({ ...sample, provider: 42 }), {
        mode: 0o600,
      });
      await expect(loadOAuthState(dir, 'notstr')).rejects.toThrow(
        /`provider` must be a non-empty string/
      );
    });

    it('throws when providerData is null', async () => {
      await writeFile(join(dir, 'pdnull.json'), JSON.stringify({ ...sample, providerData: null }), {
        mode: 0o600,
      });
      await expect(loadOAuthState(dir, 'pdnull')).rejects.toThrow(
        /`providerData` must be a plain object/
      );
    });

    it('throws when providerData is an array', async () => {
      await writeFile(join(dir, 'pdarr.json'), JSON.stringify({ ...sample, providerData: [] }), {
        mode: 0o600,
      });
      await expect(loadOAuthState(dir, 'pdarr')).rejects.toThrow(
        /`providerData` must be a plain object/
      );
    });

    it('throws when providerData is a scalar', async () => {
      await writeFile(join(dir, 'pdscal.json'), JSON.stringify({ ...sample, providerData: 'x' }), {
        mode: 0o600,
      });
      await expect(loadOAuthState(dir, 'pdscal')).rejects.toThrow(
        /`providerData` must be a plain object/
      );
    });

    it('throws when providerData values are non-string', async () => {
      await writeFile(
        join(dir, 'pdval.json'),
        JSON.stringify({ ...sample, providerData: { clientId: 42 } }),
        { mode: 0o600 }
      );
      await expect(loadOAuthState(dir, 'pdval')).rejects.toThrow(
        /providerData\['clientId'\] must be a string/
      );
    });

    it('accepts an empty providerData object (provider with zero requiredFields)', async () => {
      await writeFile(join(dir, 'pdempty.json'), JSON.stringify({ ...sample, providerData: {} }), {
        mode: 0o600,
      });
      const result = await loadOAuthState(dir, 'pdempty');
      expect(result?.providerData).toEqual({});
    });

    it('throws when providerData is entirely missing', async () => {
      const { providerData: _pd, ...rest } = sample;
      await writeFile(join(dir, 'nopd.json'), JSON.stringify(rest), { mode: 0o600 });
      await expect(loadOAuthState(dir, 'nopd')).rejects.toThrow(
        /`providerData` must be a plain object/
      );
    });

    it('accepts an unknown provider id at the structural layer', async () => {
      await writeFile(
        join(dir, 'unknownprov.json'),
        JSON.stringify({ ...sample, provider: 'totally-unknown' }),
        { mode: 0o600 }
      );
      const result = await loadOAuthState(dir, 'unknownprov');
      expect(result?.provider).toBe('totally-unknown');
    });

    it('throws when refreshToken is missing', async () => {
      const { refreshToken: _rt, ...rest } = sample;
      await writeFile(join(dir, 'nort.json'), JSON.stringify(rest), { mode: 0o600 });
      await expect(loadOAuthState(dir, 'nort')).rejects.toThrow(/`refreshToken`/);
    });

    it('throws when expiresAt is not a valid ISO-8601 string', async () => {
      await writeFile(
        join(dir, 'badexp.json'),
        JSON.stringify({ ...sample, expiresAt: 'not-a-date' }),
        { mode: 0o600 }
      );
      await expect(loadOAuthState(dir, 'badexp')).rejects.toThrow(/`expiresAt`/);
    });

    it('throws when lastRefreshAt is not a valid ISO-8601 string', async () => {
      await writeFile(
        join(dir, 'badlast.json'),
        JSON.stringify({ ...sample, lastRefreshAt: 'whenever' }),
        { mode: 0o600 }
      );
      await expect(loadOAuthState(dir, 'badlast')).rejects.toThrow(/`lastRefreshAt`/);
    });

    it('throws when scopes is not an array of strings', async () => {
      await writeFile(join(dir, 'badsc.json'), JSON.stringify({ ...sample, scopes: [42, 'x'] }), {
        mode: 0o600,
      });
      await expect(loadOAuthState(dir, 'badsc')).rejects.toThrow(/`scopes`/);
    });

    it('throws when grantedScopes is missing', async () => {
      const { grantedScopes: _g, ...rest } = sample;
      await writeFile(join(dir, 'nogs.json'), JSON.stringify(rest), { mode: 0o600 });
      await expect(loadOAuthState(dir, 'nogs')).rejects.toThrow(/`grantedScopes`/);
    });

    it('throws when grantedScopes is not an array', async () => {
      await writeFile(
        join(dir, 'gsstr.json'),
        JSON.stringify({ ...sample, grantedScopes: 'offline_access' }),
        { mode: 0o600 }
      );
      await expect(loadOAuthState(dir, 'gsstr')).rejects.toThrow(/`grantedScopes`/);
    });

    it('throws when grantedScopes contains a non-string', async () => {
      await writeFile(join(dir, 'gsint.json'), JSON.stringify({ ...sample, grantedScopes: [42] }), {
        mode: 0o600,
      });
      await expect(loadOAuthState(dir, 'gsint')).rejects.toThrow(/`grantedScopes`/);
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

    it('rejects a partially-formed state before writing to disk', async () => {
      const broken = { ...sample, refreshToken: '' };
      await expect(saveOAuthState(dir, 'sharepoint', broken)).rejects.toThrow(/`refreshToken`/);
      await expect(loadOAuthState(dir, 'sharepoint')).resolves.toBeNull();
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

    it('rejects empty bearer key', async () => {
      // An empty key in the JSON object would map ambiguously inside the auth
      // map; the loader must reject it. This covers oauth-state.ts:104.
      await writeFile(join(dir, '.bearer-map.json'), JSON.stringify({ '': 'sharepoint' }), {
        mode: 0o600,
      });
      await expect(loadBearerMap(dir)).rejects.toThrow(/empty bearer key/);
    });
  });
});
