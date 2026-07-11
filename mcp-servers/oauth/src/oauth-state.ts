/**
 * Read/write per-service OAuth state (`oauth.json`, ADR-060 schema) at `<state_dir>/<service>.json`
 * (mode 0o600, parent 0o700, Rust supervisor); `.bearer-map.json` is read here too.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeRestrictedSecret } from '@speedwave/mcp-shared';
import type { GrantType, ProviderId } from './providers/types.js';

/** Per-service OAuth state on disk. See ADR-060 for field semantics. */
export interface OAuthState {
  provider: ProviderId;
  /** Grant the state uses. Absent (legacy SharePoint) → `refresh_token`. */
  grantType: GrantType;
  providerData: Record<string, string>;
  scopes: string[];
  grantedScopes: string[];
  /** Empty allowed only for `client_credentials` (re-mint, no refresh token). */
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
 * Load OAuth state for a service; validates only the structural shape (provider non-empty,
 * providerData a plain string map). Returns null if no file exists.
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
  // Absent grantType = legacy SharePoint state → refresh_token (back-compat migration).
  const grantType: GrantType =
    obj.grantType === undefined ? 'refresh_token' : (obj.grantType as GrantType);
  if (grantType !== 'refresh_token' && grantType !== 'client_credentials') {
    throw new Error('oauth state: `grantType` must be refresh_token or client_credentials');
  }
  // refresh_token grant needs a token; client_credentials re-mints, so empty is OK.
  if (typeof obj.refreshToken !== 'string') {
    throw new Error('oauth state: `refreshToken` must be a string');
  }
  if (grantType === 'refresh_token' && !obj.refreshToken) {
    throw new Error('oauth state: `refreshToken` must be non-empty for refresh_token grant');
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
    grantType,
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
 * Load the bearer-map (one bearer per consumer service id); empty map if absent. Each `service`
 * value must match SERVICE_SLUG_RE — caller uses the result as part of a filesystem path.
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
