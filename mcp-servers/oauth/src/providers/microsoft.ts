/**
 * Microsoft Identity v2 token endpoint client.
 *
 * Performs `grant_type=refresh_token` POST against
 * `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` and parses
 * the public-client response. No `client_secret` — device-code flow per
 * ADR-060.
 */

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

  // 30s upper bound on the Microsoft token endpoint round-trip. A hang
  // here would block every SharePoint tool call (refresh fires on 401),
  // so we abort rather than wait indefinitely. The connection-pool kept-
  // alive default is much shorter; this is purely a stall guard.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
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

  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'malformed',
        message: `Microsoft response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (!response.ok) {
    const errCode = typeof json.error === 'string' ? json.error : 'http';
    const errDesc = typeof json.error_description === 'string' ? json.error_description : '';
    // Scope-related failures bubble up as scope_mismatch so the caller can
    // surface a re-consent flow without parsing free-text error_description.
    const code: MicrosoftTokenError['code'] =
      errCode === 'invalid_grant' && /scope|consent|permission/i.test(errDesc)
        ? 'scope_mismatch'
        : errCode === 'invalid_grant'
          ? 'invalid_grant'
          : 'http';
    return {
      ok: false,
      error: { code, message: `${errCode}: ${errDesc || 'no description'}` },
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

  // Scope mismatch (granted ⊊ requested) — Microsoft returns 200 in this case.
  const missing = req.scopes.filter(
    (s) => !grantedScopes.some((g) => g.toLowerCase() === s.toLowerCase())
  );
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
