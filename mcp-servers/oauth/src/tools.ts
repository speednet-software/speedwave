/**
 * MCP tools for the oauth worker — `refresh` and `forget`.
 * Service id is derived from the bearer token, not a parameter (ADR-060).
 */
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { ToolDefinition, ToolHandlerContext, ToolsCallResult } from '@speedwave/mcp-shared';
import { writeRestrictedSecret, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { loadOAuthState, saveOAuthState, loadBearerMap, type OAuthState } from './oauth-state.js';
import { getProvider, knownProviderIds } from './providers/registry.js';
import type { OAuthProvider, RefreshError } from './providers/types.js';
import { appendAuditEvent } from './audit-log.js';

/** Default rate-limit between refreshes when access token is still valid. */
const DEFAULT_RATE_LIMIT_SECONDS = 1800;

/** Upper bound on a token lifetime (10y) — mirrors the Rust oauth_persist clamp. */
const MAX_EXPIRES_IN_SECONDS = 10 * 365 * 24 * 60 * 60;

/**
 * Fallback validation for providers without `validateRequest` (e.g. Microsoft).
 * @param requiredFields - keys that must be present and non-empty
 * @param providerData - the stored IdP fields to check
 */
function missingStaticField(
  requiredFields: readonly string[],
  providerData: Record<string, string>
): RefreshError | null {
  for (const field of requiredFields) {
    const value = providerData[field];
    if (typeof value !== 'string' || !value) {
      return { code: 'missing_field', message: `providerData['${field}'] is required` };
    }
  }
  return null;
}

/** Injected paths and overrides for {@link buildTools}. */
export interface ToolDeps {
  /** Per-project state dir (`~/.speedwave/oauth/<project>/`). */
  stateDir: string;
  /** Project id, embedded in audit log entries. */
  project: string;
  /** Path to the audit log (append-only, mode 0o600). */
  auditLogPath: string;
  /** Path to the access-token file the caller's worker mount maps to. */
  accessTokenPathFor: (service: string) => string;
  /** Override for tests; defaults to `Date.now()`. */
  now?: () => number;
  /** Override registry for tests; defaults to the static `providers/registry.ts`. */
  providers?: Record<string, OAuthProvider>;
  /** Override the rate-limit constant (seconds). */
  rateLimitSeconds?: number;
}

/** Serializes `fn` per service key; concurrent callers queue FIFO. */
type ServiceMutex = <T>(service: string, fn: () => Promise<T>) => Promise<T>;

/** Per-service promise-chain mutex (rotating refresh tokens are single-use). */
function createServiceMutex(): ServiceMutex {
  const tails = new Map<string, Promise<void>>();
  return async <T>(service: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(service) ?? Promise.resolve();
    let settle!: () => void;
    const tail = new Promise<void>((resolve) => {
      settle = resolve;
    });
    tails.set(service, tail);
    await prev;
    try {
      return await fn();
    } finally {
      settle();
      if (tails.get(service) === tail) tails.delete(service);
    }
  };
}

/**
 * Build the tool list for `createMCPServer`.
 * @param deps - injected paths and overrides
 */
export function buildTools(deps: ToolDeps): ToolDefinition[] {
  const withServiceLock = createServiceMutex();
  return [
    {
      tool: {
        name: 'refresh',
        description:
          'Refresh the access token for the caller service. Caller identity is derived from the bearer token; no parameter is taken from the call site.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: (_params: Record<string, unknown>, ctx?: ToolHandlerContext) =>
        handleRefresh(deps, withServiceLock, ctx),
    },
    {
      tool: {
        name: 'forget',
        description:
          'Delete local OAuth state for the caller service. Does NOT revoke at the identity provider — complete revocation requires user action at the IdP.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: (_params: Record<string, unknown>, ctx?: ToolHandlerContext) =>
        handleForget(deps, withServiceLock, ctx),
    },
  ];
}

/**
 * Resolve `service` from `ctx.caller` and the on-disk bearer map.
 * @param deps - dependencies (used for stateDir)
 * @param ctx - per-call context with caller id
 */
async function resolveCaller(
  deps: ToolDeps,
  ctx: ToolHandlerContext | undefined
): Promise<{ ok: true; service: string } | { ok: false; result: ToolsCallResult }> {
  const caller = ctx?.caller ?? '';
  if (!caller) {
    return {
      ok: false,
      result: errorResult('unauthorized: caller is not a configured consumer'),
    };
  }
  // Bearer-map already validated by middleware; re-load here only to verify
  // the caller still exists (consumer could have been forget()'d concurrently).
  const map = await loadBearerMap(deps.stateDir);
  if (!Object.values(map).includes(caller)) {
    return {
      ok: false,
      result: errorResult(`unauthorized: caller '${caller}' is not configured`),
    };
  }
  return { ok: true, service: caller };
}

async function handleRefresh(
  deps: ToolDeps,
  withServiceLock: ServiceMutex,
  ctx: ToolHandlerContext | undefined
): Promise<ToolsCallResult> {
  const callerResult = await resolveCaller(deps, ctx);
  if (!callerResult.ok) return callerResult.result;
  const service = callerResult.service;
  return withServiceLock(service, () => refreshLocked(deps, service));
}

async function refreshLocked(deps: ToolDeps, service: string): Promise<ToolsCallResult> {
  const now = deps.now ?? Date.now;
  const rateLimitMs = (deps.rateLimitSeconds ?? DEFAULT_RATE_LIMIT_SECONDS) * 1000;
  // Deliberate UTC (bare Z): JSON audit-record field, not a human log prefix.
  const ts = new Date().toISOString();

  let state: OAuthState | null;
  try {
    state = await loadOAuthState(deps.stateDir, service);
  } catch (err) {
    await appendAuditEvent(deps.auditLogPath, {
      ts,
      project: deps.project,
      service,
      action: 'refresh',
      outcome: { error: 'malformed_state' },
    });
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`malformed_state: ${msg}`);
  }
  if (!state) {
    await appendAuditEvent(deps.auditLogPath, {
      ts,
      project: deps.project,
      service,
      action: 'refresh',
      outcome: { error: 'no_state' },
    });
    return errorResult(`no_state: no oauth state on disk for service '${service}'`);
  }

  const provider = deps.providers?.[state.provider] ?? getProvider(state.provider);
  if (!provider) {
    await appendAuditEvent(deps.auditLogPath, {
      ts,
      project: deps.project,
      service,
      action: 'refresh',
      outcome: { error: 'unknown_provider' },
    });
    return errorResult(
      `unknown_provider: '${state.provider}' is not registered (known: ${knownProviderIds().join(', ')})`
    );
  }

  const refreshReq = {
    grantType: state.grantType,
    providerData: state.providerData,
    scopes: state.scopes,
    refreshToken: state.refreshToken,
  };
  // Provider validation if present, else the static requiredFields check.
  const validationError = provider.validateRequest
    ? provider.validateRequest(refreshReq)
    : missingStaticField(provider.requiredFields, state.providerData);
  if (validationError) {
    await appendAuditEvent(deps.auditLogPath, {
      ts,
      project: deps.project,
      service,
      action: 'refresh',
      outcome: { error: 'missing_field' },
    });
    return errorResult(`${validationError.code}: ${validationError.message}`);
  }

  // Rate limit: skip IdP call if token still valid and refresh is recent.
  const expiresAtMs = Date.parse(state.expiresAt);
  const lastRefreshMs = Date.parse(state.lastRefreshAt);
  const skewMs = 60_000;
  if (
    Number.isFinite(expiresAtMs) &&
    now() < expiresAtMs - skewMs &&
    Number.isFinite(lastRefreshMs) &&
    now() - lastRefreshMs < rateLimitMs
  ) {
    await appendAuditEvent(deps.auditLogPath, {
      ts,
      project: deps.project,
      service,
      action: 'refresh',
      outcome: { error: 'rate_limited' },
    });
    return jsonResult({
      expiresIn: Math.floor((expiresAtMs - now()) / 1000),
      grantedScopes: state.grantedScopes,
      rateLimited: true,
    });
  }

  const result = await provider.refresh(refreshReq);

  if (!result.ok) {
    await appendAuditEvent(deps.auditLogPath, {
      ts,
      project: deps.project,
      service,
      action: 'refresh',
      outcome: { error: result.error.code },
    });
    return errorResult(`${result.error.code}: ${result.error.message}`);
  }

  const nowMs = now();
  // Clamp the IdP-supplied lifetime so `new Date(...)` stays in range.
  const expiresInMs = Math.min(result.value.expiresIn, MAX_EXPIRES_IN_SECONDS) * 1000;
  const newState: OAuthState = {
    ...state,
    refreshToken: result.value.refreshToken ?? state.refreshToken,
    grantedScopes: result.value.grantedScopes,
    expiresAt: new Date(nowMs + expiresInMs).toISOString(),
    lastRefreshAt: new Date(nowMs).toISOString(),
  };
  await saveOAuthState(deps.stateDir, service, newState);
  await writeRestrictedSecret(deps.accessTokenPathFor(service), result.value.accessToken);

  await appendAuditEvent(deps.auditLogPath, {
    ts,
    project: deps.project,
    service,
    action: 'refresh',
    outcome: 'ok',
  });
  return jsonResult({
    expiresIn: result.value.expiresIn,
    grantedScopes: result.value.grantedScopes,
  });
}

async function handleForget(
  deps: ToolDeps,
  withServiceLock: ServiceMutex,
  ctx: ToolHandlerContext | undefined
): Promise<ToolsCallResult> {
  const callerResult = await resolveCaller(deps, ctx);
  if (!callerResult.ok) return callerResult.result;
  const service = callerResult.service;
  return withServiceLock(service, () => forgetLocked(deps, service));
}

async function forgetLocked(deps: ToolDeps, service: string): Promise<ToolsCallResult> {
  // Deliberate UTC (bare Z): JSON audit-record field, not a human log prefix.
  const ts = new Date().toISOString();

  const statePath = join(deps.stateDir, `${service}.json`);
  const accessTokenPath = deps.accessTokenPathFor(service);

  const stateErr = await safeUnlink(statePath);
  const tokenErr = await safeUnlink(accessTokenPath);

  if (stateErr || tokenErr) {
    const detail = [stateErr, tokenErr].filter((s): s is string => Boolean(s)).join('; ');
    await appendAuditEvent(deps.auditLogPath, {
      ts,
      project: deps.project,
      service,
      action: 'forget',
      outcome: { error: 'unlink_failed' },
    });
    return errorResult(`unlink_failed: ${detail}`);
  }

  await appendAuditEvent(deps.auditLogPath, {
    ts,
    project: deps.project,
    service,
    action: 'forget',
    outcome: 'ok',
  });
  return jsonResult({ forgotten: service });
}

/**
 * ENOENT → null (idempotent); other errors are surfaced.
 * @param path - file to remove
 */
async function safeUnlink(path: string): Promise<string | null> {
  try {
    await unlink(path);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    const msg = err instanceof Error ? err.message : String(err);
    return `${path}: ${msg}`;
  }
}
