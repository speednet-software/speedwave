/**
 * Data-driven OAuth2 provider for plugins (ADR-060 extension).
 *
 * `token_url`, client id/secret, grant type, and auth style all come from the
 * stored state (host-validated at manifest install + start_plugin_oauth), so
 * this provider re-validates the URL and hardens the HTTP call on every refresh.
 */

import { TIMEOUTS } from '@speedwave/mcp-shared';
import type {
  GrantType,
  OAuthProvider,
  RefreshError,
  RefreshRequest,
  RefreshResult,
} from './types.js';

/** Max token-response body we read before treating it as malformed. */
const MAX_BODY_BYTES = 256 * 1024;

/** providerData keys the generic provider reads. */
interface GenericProviderData {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  authStyle?: 'basic' | 'body';
  grantType?: GrantType;
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
 * Keeps the `error` code only if it is a known RFC 6749 §5.2 value; a
 * data-driven IdP could otherwise stuff secrets into a free-form `error`.
 * @param errorCode - the IdP `error` field (or empty)
 */
export function redactGenericError(errorCode: string): string {
  return RFC6749_ERROR_CODES.has(errorCode) ? errorCode : 'redacted';
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
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  // Block obvious private/loopback literals; the host-side Rust validator is
  // authoritative at install — this is defense-in-depth against a tampered file.
  if (
    /^127\./.test(host) ||
    host === '0.0.0.0' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === '::1' ||
    host === '[::1]'
  ) {
    return null;
  }
  return url;
}

/**
 * Reads at most `MAX_BODY_BYTES` of the response, then parses JSON.
 * @param response - the token endpoint response
 */
async function readJsonCapped(
  response: Response
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; message: string }> {
  const ctype = response.headers.get('content-type') ?? '';
  if (!/json/i.test(ctype)) {
    return { ok: false, message: `unexpected content-type '${ctype}'` };
  }
  const buf = await response.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    return { ok: false, message: `response exceeds ${MAX_BODY_BYTES} bytes` };
  }
  try {
    const text = Buffer.from(buf).toString('utf8');
    return { ok: true, json: JSON.parse(text) as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Refresh/re-mint an access token against a data-driven token endpoint.
 * @param req - the refresh request (providerData carries the endpoint + client)
 */
export async function refreshGenericToken(req: RefreshRequest): Promise<RefreshResult> {
  const data = req.providerData as unknown as GenericProviderData;
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

  // A 3xx (redirect: 'manual' yields an opaqueredirect/non-ok) is not a valid
  // token response — refuse rather than follow an attacker-influenced Location.
  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      error: { code: 'http', message: `unexpected redirect ${response.status}` },
    };
  }

  const parsed = await readJsonCapped(response);
  if (!parsed.ok) {
    return { ok: false, error: { code: 'malformed', message: parsed.message } };
  }
  const json = parsed.json;

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
    const data = req.providerData as unknown as GenericProviderData;
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
