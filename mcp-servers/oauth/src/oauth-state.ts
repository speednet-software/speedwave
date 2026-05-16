/**
 * Read / write per-service OAuth state files.
 *
 * `oauth.json` schema (ADR-060):
 *   { provider, clientId, tenantId, scopes, grantedScopes, refreshToken,
 *     expiresAt, lastRefreshAt }
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
  provider: 'microsoft';
  clientId: string;
  tenantId: string;
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
 * Load OAuth state for one service from disk.
 * @param stateDir - the per-project state dir
 * @param service - service id (e.g. 'sharepoint')
 * @returns parsed OAuthState, or null if no file exists
 */
export async function loadOAuthState(
  stateDir: string,
  service: string
): Promise<OAuthState | null> {
  const path = join(stateDir, `${service}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as OAuthState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
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
