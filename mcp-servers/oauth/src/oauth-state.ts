/**
 * Read / write per-service OAuth state files.
 *
 * `oauth.json` schema (ADR-060, post-OAuthProvider refactor):
 *   { provider, providerData, scopes, grantedScopes, refreshToken,
 *     expiresAt, lastRefreshAt }
 *
 * `provider` identifies the IdP implementation in `providers/registry.ts`;
 * `providerData` holds IdP-specific fields (Microsoft: clientId, tenantId).
 *
 * Files live at `<state_dir>/<service>.json`, mode 0o600. The Rust supervisor
 * creates `<state_dir>` with mode 0o700 so `writeRestrictedSecret` accepts
 * the parent (POSIX). The bearer-map file `.bearer-map.json` is read here too.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeRestrictedSecret } from '@speedwave/mcp-shared';
import type { ProviderId } from './providers/types.js';

/** Per-service OAuth state on disk. See ADR-060 for field semantics. */
export interface OAuthState {
  provider: ProviderId;
  providerData: Record<string, string>;
  scopes: string[];
  grantedScopes: string[];
  refreshToken: string;
  expiresAt: string;
  lastRefreshAt: string;
}

/**
 * Map of consumer bearer token → service id. The Rust supervisor writes this
 * file; the worker reads it once at startup and on every consumer change.
 */
export type BearerMap = Record<string, string>;

/**
 * Load OAuth state for one service from disk. Validates the structural shape
 * (`provider` non-empty string, `providerData` plain object of strings) so a
 * malformed file fails fast with a descriptive error instead of crashing the
 * dispatcher mid-refresh. Field-value semantics (e.g. Microsoft tenantId
 * format) are the provider's responsibility — see `OAuthProvider.requiredFields`.
 * @param stateDir - the per-project state dir
 * @param service - service id (e.g. 'sharepoint')
 * @returns parsed OAuthState, or null if no file exists
 */
export async function loadOAuthState(
  stateDir: string,
  service: string
): Promise<OAuthState | null> {
  const path = join(stateDir, `${service}.json`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  return assertOAuthState(parsed);
}

/**
 * Structural-only validation; provider id semantics are the dispatcher's job.
 * @param value - parsed JSON to validate
 */
export function assertOAuthState(value: unknown): OAuthState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('oauth state must be a JSON object');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.provider !== 'string' || !obj.provider) {
    throw new Error('oauth state: `provider` must be a non-empty string');
  }
  if (
    obj.providerData === null ||
    typeof obj.providerData !== 'object' ||
    Array.isArray(obj.providerData)
  ) {
    throw new Error('oauth state: `providerData` must be a plain object');
  }
  for (const [k, v] of Object.entries(obj.providerData as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new Error(`oauth state: providerData['${k}'] must be a string`);
    }
  }
  if (typeof obj.refreshToken !== 'string' || !obj.refreshToken) {
    throw new Error('oauth state: `refreshToken` must be a non-empty string');
  }
  if (typeof obj.expiresAt !== 'string' || Number.isNaN(Date.parse(obj.expiresAt))) {
    throw new Error('oauth state: `expiresAt` must be an ISO-8601 string');
  }
  if (typeof obj.lastRefreshAt !== 'string' || Number.isNaN(Date.parse(obj.lastRefreshAt))) {
    throw new Error('oauth state: `lastRefreshAt` must be an ISO-8601 string');
  }
  if (!Array.isArray(obj.scopes) || !obj.scopes.every((s) => typeof s === 'string')) {
    throw new Error('oauth state: `scopes` must be an array of strings');
  }
  if (!Array.isArray(obj.grantedScopes) || !obj.grantedScopes.every((s) => typeof s === 'string')) {
    throw new Error('oauth state: `grantedScopes` must be an array of strings');
  }
  return {
    provider: obj.provider as ProviderId,
    providerData: obj.providerData as Record<string, string>,
    scopes: obj.scopes as string[],
    grantedScopes: obj.grantedScopes as string[],
    refreshToken: obj.refreshToken,
    expiresAt: obj.expiresAt,
    lastRefreshAt: obj.lastRefreshAt,
  };
}

/**
 * Atomic 0o600 write; validates the shape first.
 * @param stateDir - per-project state dir
 * @param service - service id
 * @param state - state to persist
 */
export async function saveOAuthState(
  stateDir: string,
  service: string,
  state: OAuthState
): Promise<void> {
  const validated = assertOAuthState(state);
  const path = join(stateDir, `${service}.json`);
  await writeRestrictedSecret(path, JSON.stringify(validated, null, 2) + '\n');
}

/**
 * Slug regex mirroring `plugin::validate_manifest` — defense in depth against
 * a bearer-map entry escaping the per-project tokens dir.
 */
const SERVICE_SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Load the bearer-map (one bearer per consumer service id).
 * Returns an empty map if the file does not exist (no consumers configured yet).
 * Each `service` value must match SERVICE_SLUG_RE — caller is expected to use
 * the result as part of a filesystem path.
 * @param stateDir - the per-project oauth state dir
 */
export async function loadBearerMap(stateDir: string): Promise<BearerMap> {
  const path = join(stateDir, '.bearer-map.json');
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('.bearer-map.json must be a JSON object {bearer: service}');
    }
    const result: BearerMap = {};
    for (const [bearer, service] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof service !== 'string' || !service) {
        throw new Error(`.bearer-map.json: service for one bearer is not a non-empty string`);
      }
      if (!bearer) {
        throw new Error('.bearer-map.json: empty bearer key');
      }
      if (!SERVICE_SLUG_RE.test(service)) {
        throw new Error(
          `.bearer-map.json: service '${service}' does not match ${SERVICE_SLUG_RE.source}`
        );
      }
      result[bearer] = service;
    }
    return result;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}
