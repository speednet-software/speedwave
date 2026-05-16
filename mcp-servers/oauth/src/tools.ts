/**
 * MCP tools for the oauth worker — `refresh` and `forget`.
 *
 * Neither tool accepts a `service` parameter. The caller's service id is
 * derived from the incoming bearer token via the bearer-map maintained by the
 * Rust supervisor (ADR-060 decision 3b). This eliminates the
 * "compromised-caller forges service" failure mode.
 */
import { join } from 'node:path';
import { unlink, readFile } from 'node:fs/promises';
import type { ToolDefinition, ToolHandlerContext, ToolsCallResult } from '@speedwave/mcp-shared';
import { writeRestrictedSecret, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { loadOAuthState, saveOAuthState, loadBearerMap, type OAuthState } from './oauth-state.js';
import { refreshMicrosoftToken } from './providers/microsoft.js';
import { appendAuditEvent } from './audit-log.js';

/** Default rate-limit between refreshes when access token is still valid. */
const DEFAULT_RATE_LIMIT_SECONDS = 1800;

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
  /** Override for tests; defaults to `refreshMicrosoftToken`. */
  doRefresh?: typeof refreshMicrosoftToken;
  /** Override the rate-limit constant (seconds). */
  rateLimitSeconds?: number;
}

/**
 * Build the tool list for `createMCPServer`.
 * @param deps - injected paths and overrides
 */
export function buildTools(deps: ToolDeps): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'refresh',
        description:
          'Refresh the access token for the caller service. Caller identity is derived from the bearer token; no parameter is taken from the call site.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: (_params: Record<string, unknown>, ctx?: ToolHandlerContext) =>
        handleRefresh(deps, ctx),
    },
    {
      tool: {
        name: 'forget',
        description:
          'Delete local OAuth state for the caller service. Does NOT revoke at Microsoft — complete revocation requires user action at account.microsoft.com or admin action in Azure AD.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: (_params: Record<string, unknown>, ctx?: ToolHandlerContext) =>
        handleForget(deps, ctx),
    },
  ];
}

/**
 * Resolve `service` from `ctx.caller` and the on-disk bearer map.
 * Empty caller (`''`) means the request was authenticated with the supervisor's
 * primary token; this worker has no tool the supervisor itself should call,
 * so we treat it as unauthorized.
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
  ctx: ToolHandlerContext | undefined
): Promise<ToolsCallResult> {
  const now = deps.now ?? Date.now;
  const doRefresh = deps.doRefresh ?? refreshMicrosoftToken;
  const rateLimitMs = (deps.rateLimitSeconds ?? DEFAULT_RATE_LIMIT_SECONDS) * 1000;
  const ts = new Date().toISOString();

  const callerResult = await resolveCaller(deps, ctx);
  if (!callerResult.ok) return callerResult.result;
  const service = callerResult.service;

  const state = await loadOAuthState(deps.stateDir, service);
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

  // Rate limit: if access token is still valid AND last refresh was within the
  // window, refuse. (Slows refresh-in-a-loop after RCE; cannot stop it — ADR-060.)
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
    return errorResult(
      `rate_limited: last refresh was ${Math.round((now() - lastRefreshMs) / 1000)}s ago; access token still valid`
    );
  }

  const result = await doRefresh({
    clientId: state.clientId,
    tenantId: state.tenantId,
    scopes: state.scopes,
    refreshToken: state.refreshToken,
  });

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
  const newState: OAuthState = {
    ...state,
    refreshToken: result.value.refreshToken ?? state.refreshToken,
    grantedScopes: result.value.grantedScopes,
    expiresAt: new Date(nowMs + result.value.expiresIn * 1000).toISOString(),
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
  ctx: ToolHandlerContext | undefined
): Promise<ToolsCallResult> {
  const ts = new Date().toISOString();
  const callerResult = await resolveCaller(deps, ctx);
  if (!callerResult.ok) return callerResult.result;
  const service = callerResult.service;

  const statePath = join(deps.stateDir, `${service}.json`);
  const accessTokenPath = deps.accessTokenPathFor(service);

  await unlink(statePath).catch(() => {});
  await unlink(accessTokenPath).catch(() => {});

  await appendAuditEvent(deps.auditLogPath, {
    ts,
    project: deps.project,
    service,
    action: 'forget',
    outcome: 'ok',
  });
  return jsonResult({ forgotten: service });
}

// Used only in tests to keep `readFile` import warning-free if a future test
// stub injects a different filesystem layer.
export { readFile as _readFileForTest };
