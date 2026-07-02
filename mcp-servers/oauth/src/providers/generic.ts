/**
 * Data-driven OAuth2 provider for plugins; re-validates token_url and grant on every refresh (ADR-069).
 */

import { TIMEOUTS, ts } from '@speedwave/mcp-shared';
import { readJsonCapped } from './http-body.js';
import type {
  GrantType,
  OAuthProvider,
  RefreshError,
  RefreshRequest,
  RefreshResult,
} from './types.js';

/** providerData keys the generic provider reads. */
interface GenericProviderData {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  authStyle?: 'basic' | 'body';
  grantType?: GrantType;
}

/**
 * Narrows untyped `providerData` to the generic shape; rejects unknown authStyle/grantType.
 * @param raw - the stored providerData map
 */
function parseGenericProviderData(
  raw: Record<string, string>
): { ok: true; data: GenericProviderData } | { ok: false; message: string } {
  const { tokenUrl = '', clientId = '', clientSecret, authStyle, grantType } = raw;
  if (authStyle !== undefined && authStyle !== 'basic' && authStyle !== 'body') {
    return { ok: false, message: "providerData.authStyle must be 'basic' or 'body'" };
  }
  if (
    grantType !== undefined &&
    grantType !== 'refresh_token' &&
    grantType !== 'client_credentials'
  ) {
    return { ok: false, message: 'providerData.grantType is not a known grant' };
  }
  return { ok: true, data: { tokenUrl, clientId, clientSecret, authStyle, grantType } };
}

/** RFC 6749 §5.2 token-error codes — the only `error` values surfaced verbatim. */
const RFC6749_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
]);

/**
 * Returns the `error` code only if it is a known RFC 6749 §5.2 value, else 'redacted'.
 * @param errorCode - the IdP `error` field (or empty)
 */
export function redactGenericError(errorCode: string): string {
  if (RFC6749_ERROR_CODES.has(errorCode)) return errorCode;
  console.error(
    `${ts()} oauth generic: non-RFC6749 token error redacted (first 64 chars): ${JSON.stringify(errorCode.slice(0, 64))}`
  );
  return 'redacted';
}

/**
 * Re-validates the token URL (https, no private host) on every call.
 * @param raw - the candidate token URL
 */
function validateTokenUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // Strip brackets URL keeps on IPv6 literals.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  // Block private/loopback/link-local/CGNAT literals.
  if (
    /^127\./.test(host) ||
    /^0\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    host === '::1' ||
    host.startsWith('::ffff:') || // any IPv4-mapped IPv6 — no legit IdP uses one
    /^f[cd][0-9a-f]{2}:/.test(host) || // IPv6 ULA fc00::/7 (RFC 4193)
    /^fe[89ab][0-9a-f]:/.test(host) // IPv6 link-local fe80::/10 (RFC 4291)
  ) {
    return null;
  }
  return url;
}

/**
 * Refresh/re-mint an access token against a data-driven token endpoint.
 * @param req - the refresh request (providerData carries the endpoint + client)
 */
export async function refreshGenericToken(req: RefreshRequest): Promise<RefreshResult> {
  const parsed = parseGenericProviderData(req.providerData);
  if (!parsed.ok) {
    return { ok: false, error: { code: 'malformed', message: parsed.message } };
  }
  const data = parsed.data;
  const grantType: GrantType = req.grantType ?? data.grantType ?? 'refresh_token';
  const authStyle = data.authStyle ?? 'basic';

  const url = validateTokenUrl(data.tokenUrl);
  if (!url) {
    return {
      ok: false,
      error: { code: 'malformed', message: 'token_url is invalid or not https' },
    };
  }

  const params = new URLSearchParams();
  if (grantType === 'refresh_token') {
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', req.refreshToken);
  } else {
    params.set('grant_type', 'client_credentials');
  }
  if (req.scopes.length > 0) {
    params.set('scope', req.scopes.join(' '));
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (authStyle === 'basic') {
    const basic = Buffer.from(`${data.clientId}:${data.clientSecret ?? ''}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  } else {
    params.set('client_id', data.clientId);
    if (data.clientSecret) params.set('client_secret', data.clientSecret);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.TOKEN_REFRESH_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: params,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    return {
      ok: false,
      error: { code: 'network', message: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    clearTimeout(timeoutId);
  }

  // A 3xx is not a valid token response.
  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      error: { code: 'http', message: `unexpected redirect ${response.status}` },
    };
  }

  const body = await readJsonCapped(response);
  if (!body.ok) {
    return { ok: false, error: { code: 'malformed', message: body.message } };
  }
  const json = body.json;

  if (!response.ok) {
    const errCode = typeof json.error === 'string' ? json.error : 'http';
    const code = errCode === 'invalid_grant' ? 'invalid_grant' : 'http';
    return { ok: false, error: { code, message: redactGenericError(errCode) } };
  }

  const accessToken = json.access_token;
  const expiresIn = json.expires_in;
  if (typeof accessToken !== 'string' || !accessToken) {
    return { ok: false, error: { code: 'malformed', message: 'access_token missing' } };
  }
  if (typeof expiresIn !== 'number' || expiresIn <= 0) {
    return { ok: false, error: { code: 'malformed', message: 'expires_in missing or invalid' } };
  }

  const grantedRaw = json.scope;
  const grantedScopes =
    typeof grantedRaw === 'string' && grantedRaw.trim()
      ? grantedRaw.trim().split(/\s+/)
      : req.scopes;
  const newRefreshToken =
    typeof json.refresh_token === 'string' && json.refresh_token.trim()
      ? json.refresh_token
      : undefined;

  return {
    ok: true,
    value: { accessToken, refreshToken: newRefreshToken, expiresIn, grantedScopes },
  };
}

/** Data-driven plugin OAuth provider. */
export const genericProvider: OAuthProvider = {
  id: 'generic',
  requiredFields: ['tokenUrl', 'clientId'],
  validateRequest(req: RefreshRequest): RefreshError | null {
    const parsed = parseGenericProviderData(req.providerData);
    if (!parsed.ok) return { code: 'malformed', message: parsed.message };
    const data = parsed.data;
    const grantType: GrantType = req.grantType ?? data.grantType ?? 'refresh_token';
    if (!data.tokenUrl)
      return { code: 'missing_field', message: 'providerData.tokenUrl is required' };
    if (!data.clientId)
      return { code: 'missing_field', message: 'providerData.clientId is required' };
    if (grantType === 'refresh_token' && !req.refreshToken) {
      return { code: 'missing_field', message: 'refreshToken is required for refresh_token grant' };
    }
    if (grantType === 'client_credentials' && !data.clientSecret) {
      return {
        code: 'missing_field',
        message: 'providerData.clientSecret is required for client_credentials grant',
      };
    }
    return null;
  },
  refresh: (req: RefreshRequest): Promise<RefreshResult> => refreshGenericToken(req),
};
