/**
 * Microsoft Identity v2 token endpoint client.
 *
 * Performs `grant_type=refresh_token` POST against
 * `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` and parses
 * the public-client response. No `client_secret` — device-code flow per
 * ADR-060.
 */

import { TIMEOUTS } from '@speedwave/mcp-shared';
import { readJsonCapped } from './http-body.js';
import type { OAuthProvider, RefreshRequest, RefreshResult } from './types.js';

/** Inputs for the Microsoft v2 refresh-token POST. */
export interface MicrosoftTokenRequest {
  clientId: string;
  tenantId: string;
  scopes: string[];
  refreshToken: string;
}

/** Outputs of a successful Microsoft v2 refresh-token POST. */
export interface MicrosoftTokenResponse {
  accessToken: string;
  /** New refresh token, if Microsoft rotated it; otherwise the caller keeps the previous one. */
  refreshToken?: string;
  /** Seconds until access token expires. */
  expiresIn: number;
  /** Scopes the user actually granted (may be a subset of the request). */
  grantedScopes: string[];
}

/** Failure result from {@link refreshMicrosoftToken}. */
export interface MicrosoftTokenError {
  code: 'scope_mismatch' | 'invalid_grant' | 'network' | 'http' | 'malformed';
  message: string;
}

/**
 * Keeps the AADSTS trace code; drops free text (ADR-060 live-compromise).
 * @param raw - Microsoft `error_description` body
 */
export function redactErrorDescription(raw: string): string {
  if (!raw) return 'no description';
  const trace = raw.match(/AADSTS\d+/);
  return trace ? trace[0] : 'redacted';
}

/**
 * Refresh an access token. Returns `{ ok: true, value }` on success or
 * `{ ok: false, error }` for any failure (HTTP, parse, scope mismatch).
 * @param req - the refresh request
 */
export async function refreshMicrosoftToken(
  req: MicrosoftTokenRequest
): Promise<
  { ok: true; value: MicrosoftTokenResponse } | { ok: false; error: MicrosoftTokenError }
> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(req.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: req.clientId,
    refresh_token: req.refreshToken,
    scope: req.scopes.join(' '),
  });

  // Upper bound on the Microsoft token endpoint round-trip.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.TOKEN_REFRESH_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'network',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }

  // A 3xx is not a valid token response; refuse rather than follow it.
  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      error: { code: 'http', message: `unexpected redirect ${response.status}` },
    };
  }

  const parsedBody = await readJsonCapped(response);
  if (!parsedBody.ok) {
    return {
      ok: false,
      error: { code: 'malformed', message: `Microsoft response: ${parsedBody.message}` },
    };
  }
  const json = parsedBody.json;

  if (!response.ok) {
    const errCode = typeof json.error === 'string' ? json.error : 'http';
    const errDesc = typeof json.error_description === 'string' ? json.error_description : '';
    const code: MicrosoftTokenError['code'] =
      errCode === 'invalid_grant' && /scope|consent|permission/i.test(errDesc)
        ? 'scope_mismatch'
        : errCode === 'invalid_grant'
          ? 'invalid_grant'
          : 'http';
    return {
      ok: false,
      error: { code, message: `${errCode}: ${redactErrorDescription(errDesc)}` },
    };
  }

  const accessToken = json.access_token;
  const expiresIn = json.expires_in;
  const grantedScope = json.scope;
  if (typeof accessToken !== 'string' || !accessToken) {
    return {
      ok: false,
      error: { code: 'malformed', message: 'access_token missing in token response' },
    };
  }
  if (typeof expiresIn !== 'number' || expiresIn <= 0) {
    return {
      ok: false,
      error: { code: 'malformed', message: 'expires_in missing or invalid in token response' },
    };
  }

  const grantedScopes =
    typeof grantedScope === 'string' && grantedScope.trim() ? grantedScope.trim().split(/\s+/) : [];

  // `offline_access` is never echoed in the token response; treat as satisfied.
  // Keep in sync with integrations_cmd.rs::OFFLINE_ACCESS_SCOPE.
  const missing = req.scopes.filter((s) => {
    if (s.toLowerCase() === 'offline_access') return false;
    return !grantedScopes.some((g) => g.toLowerCase() === s.toLowerCase());
  });
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'scope_mismatch',
        message: `not granted: ${missing.join(', ')}`,
      },
    };
  }

  const newRefreshToken =
    typeof json.refresh_token === 'string' && json.refresh_token.trim()
      ? json.refresh_token
      : undefined;

  return {
    ok: true,
    value: {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn,
      grantedScopes,
    },
  };
}

/** Refresh-only adapter; initial device-code exchange runs on the Tauri host. */
export const microsoftProvider: OAuthProvider = {
  id: 'microsoft',
  requiredFields: ['clientId', 'tenantId'],
  refresh: (req: RefreshRequest): Promise<RefreshResult> =>
    refreshMicrosoftToken({
      clientId: req.providerData.clientId,
      tenantId: req.providerData.tenantId,
      scopes: req.scopes,
      refreshToken: req.refreshToken,
    }),
};
