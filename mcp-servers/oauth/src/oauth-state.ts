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

/** Per-service OAuth state on disk. See ADR-060 for field semantics. */
export interface OAuthState {
  provider: string;
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
 * Structural validation for {@link OAuthState}. Throws on any deviation from
 * the documented shape. Extracted so corruption surfaces uniformly through
 * `loadOAuthState`.
 * @param value - parsed JSON to validate
 */
function assertOAuthState(value: unknown): OAuthState {
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
  return obj as unknown as OAuthState;
}

/**
 * Write OAuth state atomically with mode 0o600. Parent dir must be owner-only.
 * @param stateDir - the per-project state dir
 * @param service - service id
 * @param state - state to persist
 */
export async function saveOAuthState(
  stateDir: string,
  service: string,
  state: OAuthState
): Promise<void> {
  const path = join(stateDir, `${service}.json`);
  await writeRestrictedSecret(path, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Load the bearer-map (one bearer per consumer service id).
 * Returns an empty map if the file does not exist (no consumers configured yet).
 * @param stateDir - the per-project state dir
 */
/**
 * Defense-in-depth slug regex matching the Rust SSOT `plugin::validate_manifest`
 * (and `oauth_process::is_valid_service_slug`). A bearer-map entry whose
 * `service` value doesn't match would otherwise let `loadOAuthState` and
 * `accessTokenPathFor` escape the per-project tokens dir (ADR-060 §"Per-service
 * bearer", security audit P0-1).
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
