import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, chmod, writeFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolHandlerContext, ToolsCallResult } from '@speedwave/mcp-shared';
import { buildTools, type ToolDeps } from './tools.js';
import type { OAuthState } from './oauth-state.js';
import type { OAuthProvider, RefreshRequest, RefreshResult } from './providers/types.js';

function getTextResult(r: ToolsCallResult): string {
  const block = r.content?.[0];
  return block && block.type === 'text' ? (block.text ?? '') : '';
}

describe('oauth tools', () => {
  let stateDir: string;
  let tokensBase: string;
  let auditLogPath: string;
  let deps: ToolDeps;
  let now: number;
  let refreshCalls: RefreshRequest[];
  let refreshResult: RefreshResult;

  const sharepointState: OAuthState = {
    provider: 'microsoft',
    grantType: 'refresh_token',
    providerData: {
      clientId: '11111111-1111-1111-1111-111111111111',
      tenantId: 'common',
    },
    scopes: ['https://graph.microsoft.com/Sites.Manage.All', 'offline_access'],
    grantedScopes: ['https://graph.microsoft.com/Sites.Manage.All', 'offline_access'],
    refreshToken: 'old-refresh',
    expiresAt: new Date(0).toISOString(),
    lastRefreshAt: new Date(0).toISOString(),
  };

  const microsoftSpy: OAuthProvider = {
    id: 'microsoft',
    requiredFields: ['clientId', 'tenantId'],
    refresh: async (req: RefreshRequest): Promise<RefreshResult> => {
      refreshCalls.push({ ...req, providerData: { ...req.providerData } });
      return refreshResult;
    },
  };

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'oauth-state-'));
    tokensBase = await mkdtemp(join(tmpdir(), 'oauth-tokens-'));
    if (process.platform !== 'win32') {
      await chmod(stateDir, 0o700);
    }
    auditLogPath = join(stateDir, 'audit.log');
    now = Date.parse('2026-05-15T12:00:00Z');
    refreshCalls = [];
    refreshResult = {
      ok: true,
      value: {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh',
        expiresIn: 3600,
        grantedScopes: ['https://graph.microsoft.com/Sites.Manage.All', 'offline_access'],
      },
    };
    // pre-create per-service tokens dir for SharePoint
    await mkdir(join(tokensBase, 'test-project', 'sharepoint'), {
      recursive: true,
      mode: 0o700,
    });

    deps = {
      stateDir,
      project: 'test-project',
      auditLogPath,
      accessTokenPathFor: (svc) => join(tokensBase, 'test-project', svc, 'access_token'),
      now: () => now,
      providers: { microsoft: microsoftSpy },
    };
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(tokensBase, { recursive: true, force: true });
  });

  async function seedState(
    state: OAuthState | Record<string, unknown>,
    service = 'sharepoint'
  ): Promise<void> {
    const path = join(stateDir, `${service}.json`);
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });
    await chmod(path, 0o600);
  }

  async function seedBearerMap(map: Record<string, string>): Promise<void> {
    const path = join(stateDir, '.bearer-map.json');
    await writeFile(path, JSON.stringify(map), { mode: 0o600 });
  }

  async function readAuditLog(): Promise<string> {
    try {
      return await readFile(auditLogPath, 'utf8');
    } catch {
      return '';
    }
  }

  const ctxFor = (caller: string): ToolHandlerContext => ({ caller });

  describe('metadata', () => {
    it('exposes refresh and forget tools without service param', () => {
      const tools = buildTools(deps);
      expect(tools.map((t) => t.tool.name)).toEqual(['refresh', 'forget']);
      for (const t of tools) {
        const schema = t.tool.inputSchema as { properties: Record<string, unknown> };
        expect(Object.keys(schema.properties)).toEqual([]);
      }
    });
  });

  describe('refresh', () => {
    it('rejects unauthenticated callers (empty caller)', async () => {
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;
      const result = await refresh.handler({}, ctxFor(''));
      expect(result.isError).toBe(true);
      expect(getTextResult(result)).toContain('unauthorized');
    });

    it('rejects when ctx is missing entirely', async () => {
      // `ctx?.caller` defaults to '' when ctx itself is undefined — covers
      // the `?? ''` branch in resolveCaller (tools.ts:79).
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;
      const result = await refresh.handler({}, undefined);
      expect(result.isError).toBe(true);
      expect(getTextResult(result)).toContain('unauthorized');
    });

    it('falls back to Date.now / static registry when overrides absent', async () => {
      // Covers `deps.now ?? Date.now` and the registry fallback when
      // `deps.providers` is omitted. We do NOT actually call Microsoft — fetch
      // is mocked, but the branch coverage we care about (real registry →
      // microsoftProvider → refreshMicrosoftToken → fetch) is exercised.
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState(sharepointState);
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('', { status: 500 }));
      try {
        const tools = buildTools({
          stateDir: deps.stateDir,
          project: deps.project,
          auditLogPath: deps.auditLogPath,
          accessTokenPathFor: deps.accessTokenPathFor,
          // `now` and `providers` deliberately omitted to exercise the fallback.
        });
        const refresh = tools.find((t) => t.tool.name === 'refresh')!;
        await refresh.handler({}, ctxFor('sharepoint'));
        expect(fetchSpy).toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('rejects callers not in bearer-map', async () => {
      await seedBearerMap({ 'bearer-x': 'unknown-service' });
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;
      const result = await refresh.handler({}, ctxFor('not-configured'));
      expect(result.isError).toBe(true);
      expect(getTextResult(result)).toContain('unauthorized');
    });

    it('returns no_state when caller has no oauth.json', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;
      const result = await refresh.handler({}, ctxFor('sharepoint'));
      expect(result.isError).toBe(true);
      expect(getTextResult(result)).toContain('no_state');
      expect(await readAuditLog()).toContain('outcome=error:no_state');
    });

    it('refreshes successfully and writes access token + audit log', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState(sharepointState);
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;

      const result = await refresh.handler({}, ctxFor('sharepoint'));

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(getTextResult(result)) as {
        expiresIn: number;
        grantedScopes: string[];
      };
      expect(payload.expiresIn).toBe(3600);
      expect(payload.grantedScopes).toContain('offline_access');

      // provider.refresh called with stored providerData + refreshToken
      expect(refreshCalls).toHaveLength(1);
      expect(refreshCalls[0]).toMatchObject({
        providerData: {
          clientId: sharepointState.providerData.clientId,
          tenantId: sharepointState.providerData.tenantId,
        },
        refreshToken: 'old-refresh',
      });

      // access token written
      const access = await readFile(
        join(tokensBase, 'test-project', 'sharepoint', 'access_token'),
        'utf8'
      );
      expect(access).toBe('new-access-token');

      // oauth.json updated with rotated refresh + new expires
      const newState = JSON.parse(
        await readFile(join(stateDir, 'sharepoint.json'), 'utf8')
      ) as OAuthState;
      expect(newState.refreshToken).toBe('new-refresh');
      expect(Date.parse(newState.expiresAt)).toBe(now + 3600 * 1000);
      expect(Date.parse(newState.lastRefreshAt)).toBe(now);

      // audit log appended
      expect(await readAuditLog()).toContain('action=refresh outcome=ok');
    });

    it('clamps an absurd expiresIn instead of throwing RangeError', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState(sharepointState);
      refreshResult = {
        ok: true,
        value: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresIn: 1e16, // would overflow Date without the clamp
          grantedScopes: sharepointState.scopes,
        },
      };
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;

      const result = await refresh.handler({}, ctxFor('sharepoint'));
      expect(result.isError).toBeFalsy();
      const newState = JSON.parse(
        await readFile(join(stateDir, 'sharepoint.json'), 'utf8')
      ) as OAuthState;
      // expiresAt is a valid, parseable, future ISO date (clamped, not NaN/throw).
      expect(Number.isNaN(Date.parse(newState.expiresAt))).toBe(false);
      expect(Date.parse(newState.expiresAt)).toBeGreaterThan(now);
    });

    it('keeps old refresh token when Microsoft does not rotate', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState(sharepointState);
      refreshResult = {
        ok: true,
        value: {
          accessToken: 'new-access',
          refreshToken: undefined,
          expiresIn: 3600,
          grantedScopes: sharepointState.scopes,
        },
      };
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;

      await refresh.handler({}, ctxFor('sharepoint'));
      const newState = JSON.parse(
        await readFile(join(stateDir, 'sharepoint.json'), 'utf8')
      ) as OAuthState;
      expect(newState.refreshToken).toBe('old-refresh');
    });

    it('rate-limit with valid token: success-noop, no IdP call, audited', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      // last refresh 10 minutes ago, access valid for 50 more minutes → rate-limit
      await seedState({
        ...sharepointState,
        expiresAt: new Date(now + 50 * 60 * 1000).toISOString(),
        lastRefreshAt: new Date(now - 10 * 60 * 1000).toISOString(),
      });
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;

      const result = await refresh.handler({}, ctxFor('sharepoint'));
      // Success-noop: a caller that lost the single-flight race re-reads the
      // fresh token and retries instead of failing for the whole window.
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(getTextResult(result)) as {
        expiresIn: number;
        grantedScopes: string[];
        rateLimited?: boolean;
      };
      expect(payload.rateLimited).toBe(true);
      expect(payload.expiresIn).toBe(50 * 60);
      expect(payload.grantedScopes).toEqual(sharepointState.grantedScopes);
      expect(refreshCalls).toHaveLength(0);
      expect(await readAuditLog()).toContain('outcome=error:rate_limited');
    });

    it('serializes concurrent refreshes per service (one IdP call)', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState(sharepointState); // expired → first caller refreshes
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;

      let resolveRefresh!: (r: RefreshResult) => void;
      const gate = new Promise<RefreshResult>((r) => {
        resolveRefresh = r;
      });
      deps.providers = {
        microsoft: {
          ...microsoftSpy,
          refresh: async (req) => {
            refreshCalls.push({ ...req, providerData: { ...req.providerData } });
            return gate;
          },
        },
      };

      const first = refresh.handler({}, ctxFor('sharepoint'));
      const second = refresh.handler({}, ctxFor('sharepoint'));
      // Let the first caller reach the provider before releasing it.
      await new Promise((r) => setTimeout(r, 10));
      expect(refreshCalls).toHaveLength(1);
      // Winner persists a fresh expiresAt/lastRefreshAt at `now`...
      now = Date.parse('2026-05-15T12:00:05Z');
      resolveRefresh({
        ok: true,
        value: {
          accessToken: 'race-token',
          refreshToken: 'race-refresh',
          expiresIn: 3600,
          grantedScopes: ['s'],
        },
      });
      const [r1, r2] = await Promise.all([first, second]);
      expect(r1.isError).toBeFalsy();
      // ...so the loser hits the rate-limit noop instead of a second IdP call.
      expect(r2.isError).toBeFalsy();
      expect(refreshCalls).toHaveLength(1);
      const loserPayload = JSON.parse(getTextResult(r2)) as { rateLimited?: boolean };
      expect(loserPayload.rateLimited).toBe(true);
    });

    it('allows refresh when access token expired even within rate-limit window', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState({
        ...sharepointState,
        expiresAt: new Date(now - 1000).toISOString(),
        lastRefreshAt: new Date(now - 60 * 1000).toISOString(),
      });
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;

      const result = await refresh.handler({}, ctxFor('sharepoint'));
      expect(result.isError).toBeFalsy();
      expect(refreshCalls).toHaveLength(1);
    });

    it('surfaces scope_mismatch from the provider', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState(sharepointState);
      refreshResult = {
        ok: false,
        error: { code: 'scope_mismatch', message: 'not granted: Sites.Manage.All' },
      };
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;
      const result = await refresh.handler({}, ctxFor('sharepoint'));
      expect(result.isError).toBe(true);
      expect(getTextResult(result)).toContain('scope_mismatch');
      expect(await readAuditLog()).toContain('outcome=error:scope_mismatch');
    });

    it('rejects unknown provider and audits unknown_provider', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState({ ...sharepointState, provider: 'nonexistent' });
      // Use the static registry (no override) so `getProvider('nonexistent')` returns undefined.
      const tools = buildTools({
        stateDir: deps.stateDir,
        project: deps.project,
        auditLogPath: deps.auditLogPath,
        accessTokenPathFor: deps.accessTokenPathFor,
        now: deps.now,
      });
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;
      const result = await refresh.handler({}, ctxFor('sharepoint'));
      expect(result.isError).toBe(true);
      expect(getTextResult(result)).toContain('unknown_provider');
      expect(getTextResult(result)).toContain('nonexistent');
      expect(await readAuditLog()).toContain('outcome=error:unknown_provider');
    });

    it('rejects missing required field and audits missing_field', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState({ ...sharepointState, providerData: { tenantId: 'common' } });
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;
      const result = await refresh.handler({}, ctxFor('sharepoint'));
      expect(result.isError).toBe(true);
      expect(getTextResult(result)).toContain('missing_field');
      expect(getTextResult(result)).toContain('clientId');
      expect(refreshCalls).toHaveLength(0);
      expect(await readAuditLog()).toContain('outcome=error:missing_field');
    });

    it('rejects empty required field as missing_field', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState({
        ...sharepointState,
        providerData: { clientId: '', tenantId: 'common' },
      });
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;
      const result = await refresh.handler({}, ctxFor('sharepoint'));
      expect(result.isError).toBe(true);
      expect(getTextResult(result)).toContain('missing_field');
      expect(refreshCalls).toHaveLength(0);
    });

    it('returns malformed_state on corrupted oauth.json and audits', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      // Write JSON that parses but fails OAuthState assertion (provider missing).
      await writeFile(join(stateDir, 'sharepoint.json'), JSON.stringify({ providerData: {} }), {
        mode: 0o600,
      });
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;
      const result = await refresh.handler({}, ctxFor('sharepoint'));
      expect(result.isError).toBe(true);
      expect(getTextResult(result)).toContain('malformed_state');
      expect(await readAuditLog()).toContain('outcome=error:malformed_state');
    });

    it('preserves providerData verbatim through a successful refresh', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState(sharepointState);
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;
      await refresh.handler({}, ctxFor('sharepoint'));
      const newState = JSON.parse(
        await readFile(join(stateDir, 'sharepoint.json'), 'utf8')
      ) as OAuthState;
      expect(newState.providerData).toEqual(sharepointState.providerData);
    });

    it('surfaces network errors and does not mutate state', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState(sharepointState);
      refreshResult = {
        ok: false,
        error: { code: 'network', message: 'fetch failed' },
      };
      const tools = buildTools(deps);
      const refresh = tools.find((t) => t.tool.name === 'refresh')!;
      const result = await refresh.handler({}, ctxFor('sharepoint'));
      expect(result.isError).toBe(true);
      expect(getTextResult(result)).toContain('network');
      // state untouched
      const newState = JSON.parse(
        await readFile(join(stateDir, 'sharepoint.json'), 'utf8')
      ) as OAuthState;
      expect(newState).toEqual(sharepointState);
    });
  });

  describe('forget', () => {
    it('deletes oauth.json and access_token; appends audit log', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      await seedState(sharepointState);
      await writeFile(
        join(tokensBase, 'test-project', 'sharepoint', 'access_token'),
        'some-access'
      );
      const tools = buildTools(deps);
      const forget = tools.find((t) => t.tool.name === 'forget')!;

      const result = await forget.handler({}, ctxFor('sharepoint'));
      expect(result.isError).toBeFalsy();

      await expect(stat(join(stateDir, 'sharepoint.json'))).rejects.toThrow();
      await expect(
        stat(join(tokensBase, 'test-project', 'sharepoint', 'access_token'))
      ).rejects.toThrow();
      expect(await readAuditLog()).toContain('action=forget outcome=ok');
    });

    it('rejects unauthorized callers and does not touch state', async () => {
      await seedState(sharepointState);
      const tools = buildTools(deps);
      const forget = tools.find((t) => t.tool.name === 'forget')!;
      const result = await forget.handler({}, ctxFor(''));
      expect(result.isError).toBe(true);
      const stillThere = await readFile(join(stateDir, 'sharepoint.json'), 'utf8');
      expect(JSON.parse(stillThere)).toEqual(sharepointState);
    });

    it('is idempotent on already-forgotten service', async () => {
      await seedBearerMap({ 'bearer-sp': 'sharepoint' });
      const tools = buildTools(deps);
      const forget = tools.find((t) => t.tool.name === 'forget')!;
      const result1 = await forget.handler({}, ctxFor('sharepoint'));
      const result2 = await forget.handler({}, ctxFor('sharepoint'));
      expect(result1.isError).toBeFalsy();
      expect(result2.isError).toBeFalsy();
    });

    it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
      'returns unlink_failed when unlink errors with non-ENOENT',
      async () => {
        await seedBearerMap({ 'bearer-sp': 'sharepoint' });
        await seedState(sharepointState);
        const stateFile = join(stateDir, 'sharepoint.json');
        // Read-only parent dir → unlink fails with EACCES (non-ENOENT).
        // Keep the audit log outside the locked dir so the error path can
        // still record the outcome.
        const isolatedAudit = join(tokensBase, 'audit.log');
        await chmod(stateDir, 0o500);
        try {
          const tools = buildTools({ ...deps, auditLogPath: isolatedAudit });
          const forget = tools.find((t) => t.tool.name === 'forget')!;
          const result = await forget.handler({}, ctxFor('sharepoint'));
          expect(result.isError).toBe(true);
          expect(getTextResult(result)).toContain('unlink_failed');
          const audit = await readFile(isolatedAudit, 'utf8');
          expect(audit).toContain('action=forget outcome=error:unlink_failed');
        } finally {
          await chmod(stateDir, 0o700);
          await unlink(stateFile).catch(() => {});
        }
      }
    );
  });
});
