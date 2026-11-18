/**
 * OAuth token helpers for workers: refresh failure messages from the host's `refresh_status` file, and JWT expiry checks.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Discriminant for {@link OAuthRefreshError}. */
export type OAuthRefreshCode = 'reconnect_required' | 'network_error' | 'not_refreshed';

/** Typed error thrown when granted scopes are a strict subset of requested (re-consent trigger). */
export class OAuthScopeMismatchError extends Error {
  /**
   * Construct a scope-mismatch error.
   * @param message - human-readable scope mismatch detail
   */
  constructor(message: string) {
    super(message);
    this.name = 'OAuthScopeMismatchError';
  }
}

/** Error for an access token the host did not refresh in time; the message tells the user what to do. */
export class OAuthRefreshError extends Error {
  readonly code: OAuthRefreshCode;
  /**
   * Construct a refresh error.
   * @param code - machine-readable code (drives caller branching)
   * @param message - human-readable error message
   */
  constructor(code: OAuthRefreshCode, message: string) {
    super(message);
    this.name = 'OAuthRefreshError';
    this.code = code;
  }
}

/** Refresh when the JWT `exp` claim is within this many seconds of now. */
export const PROACTIVE_REFRESH_SECONDS = 120;

/**
 * Read the `exp` claim (UNIX seconds) from a JWT; `null` for malformed/non-JWT tokens.
 * @param token - the JWT to parse
 */
export function readJwtExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * True when the token's `exp` is within `seconds` of now; `false` for unparseable tokens.
 * @param token - the JWT access token to check
 * @param seconds - the expiry window in seconds
 * @param nowMs - injectable clock for tests
 */
export function accessTokenExpiresWithin(
  token: string,
  seconds: number,
  nowMs: number = Date.now()
): boolean {
  const exp = readJwtExp(token);
  if (exp === null) return false;
  return exp * 1000 - nowMs < seconds * 1000;
}

const REFRESH_STATUS_FILE = 'refresh_status';

const SERVICE_DISPLAY_NAMES: ReadonlyMap<string, string> = new Map([
  ['slack', 'Slack'],
  ['sharepoint', 'SharePoint'],
]);

type RefreshStatus = { state: 'reconnect_required' | 'network_error'; at: string };

/**
 * Build the error for a token the host did not refresh, worded by `<tokensDir>/refresh_status`.
 * @param service - service id (display name falls back to the id)
 * @param tokensDir - the `/tokens` directory
 */
export async function refreshFailure(
  service: string,
  tokensDir: string
): Promise<OAuthRefreshError> {
  const name = SERVICE_DISPLAY_NAMES.get(service) ?? service;
  const status = await readRefreshStatus(join(tokensDir, REFRESH_STATUS_FILE));
  if (status?.state === 'reconnect_required') {
    return new OAuthRefreshError(
      'reconnect_required',
      `${name} sign-in expired. Reconnect ${name} in Speedwave Desktop: Settings, Integrations, ${name}.`
    );
  }
  if (status?.state === 'network_error') {
    return new OAuthRefreshError(
      'network_error',
      `${name} token expired and Speedwave could not refresh it yet (network error at ${status.at}). It retries every 10 seconds.`
    );
  }
  return new OAuthRefreshError(
    'not_refreshed',
    `${name} token expired and has not been refreshed yet. Speedwave refreshes it while a session of this project runs.`
  );
}

/**
 * Read the host's refresh status file; `null` when absent, unreadable or not a known status.
 * @param path - path of the status file
 */
async function readRefreshStatus(path: string): Promise<RefreshStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      state?: unknown;
      at?: unknown;
    };
    if (typeof parsed.at !== 'string') return null;
    if (parsed.state === 'reconnect_required' || parsed.state === 'network_error') {
      return { state: parsed.state, at: parsed.at };
    }
    return null;
  } catch {
    return null;
  }
}
