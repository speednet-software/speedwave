/**
 * Slack rotating-token provider (ADR-071); diverges from RFC 6749 (HTTP 200 `{ok:false, error}`
 * errors, tokens nest under `authed_user`). PKCE public client — refresh sends `client_id` only.
 */

import { TIMEOUTS, ts } from '@speedwave/mcp-shared';
import { readJsonCapped } from './http-body.js';
import type { OAuthProvider, RefreshError, RefreshRequest, RefreshResult } from './types.js';

/** Fixed endpoint — never read from providerData (zero SSRF surface). */
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';

/** Slack `ok:false` codes that mean the grant is dead → user must re-login. */
const REAUTH_ERROR_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'token_revoked',
  'invalid_auth',
]);

/** Slack error codes are machine slugs; anything else is redacted. */
const SLACK_ERROR_SLUG = /^[a-z0-9_]{1,64}$/;

/**
 * Pass a Slack error code through only if it looks like a Slack slug; free-form values are
 * redacted (stderr keeps a capped breadcrumb).
 * @param errorCode - the `error` field from a Slack `ok:false` envelope
 */
export function redactSlackError(errorCode: string): string {
  if (SLACK_ERROR_SLUG.test(errorCode)) return errorCode;
  console.error(
    `${ts()} oauth slack: non-slug token error redacted (first 64 chars): ${JSON.stringify(errorCode.slice(0, 64))}`
  );
  return 'redacted';
}

/** Token fields extracted from either Slack response shape. */
interface SlackTokenFields {
  accessToken: string;
  refreshToken?: string;
  expiresIn: unknown;
  scope?: string;
}

/**
 * Accepts both Slack shapes: flat (refresh responses) and nested under `authed_user`
 * (exchange-style). A flat token with `token_type` not `'user'` is a bot token — never persist.
 * @param json - parsed `ok:true` response body
 */
function extractUserToken(
  json: Record<string, unknown>
): { ok: true; fields: SlackTokenFields } | { ok: false; error: RefreshError } {
  const nested = json.authed_user;
  if (nested && typeof nested === 'object') {
    const user = nested as Record<string, unknown>;
    if (typeof user.token_type === 'string' && user.token_type !== 'user') {
      return {
        ok: false,
        error: { code: 'malformed', message: 'authed_user.token_type is not user' },
      };
    }
    if (typeof user.access_token === 'string' && user.access_token) {
      return {
        ok: true,
        fields: {
          accessToken: user.access_token,
          refreshToken: typeof user.refresh_token === 'string' ? user.refresh_token : undefined,
          expiresIn: user.expires_in,
          scope: typeof user.scope === 'string' ? user.scope : undefined,
        },
      };
    }
  }
  if (typeof json.access_token === 'string' && json.access_token) {
    if (json.token_type !== 'user') {
      return {
        ok: false,
        error: { code: 'malformed', message: 'top-level token_type is not user (bot token?)' },
      };
    }
    return {
      ok: true,
      fields: {
        accessToken: json.access_token,
        refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
        expiresIn: json.expires_in,
        scope: typeof json.scope === 'string' ? json.scope : undefined,
      },
    };
  }
  return { ok: false, error: { code: 'malformed', message: 'access_token missing' } };
}

/**
 * Slack scope strings are comma-separated (with whitespace fallback).
 * @param raw - the `scope` field, if any
 * @param fallback - requested scopes used when the response omits `scope`
 */
function parseScopes(raw: string | undefined, fallback: string[]): string[] {
  if (!raw || !raw.trim()) return fallback;
  return raw
    .split(raw.includes(',') ? ',' : /\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Refresh a rotating Slack user token via `oauth.v2.access` (providerData: `clientId` only).
 * @param req - refresh request (providerData carries `clientId` only)
 */
export async function refreshSlackToken(req: RefreshRequest): Promise<RefreshResult> {
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', req.refreshToken);
  params.set('client_id', req.providerData.clientId);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.TOKEN_REFRESH_MS);
  let response: Response;
  try {
    response = await fetch(SLACK_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
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

  // Slack signals failure via `ok:false` on HTTP 200; check it before (and in
  // addition to) the HTTP status so both conventions are covered.
  if (json.ok !== true) {
    const errCode = typeof json.error === 'string' ? json.error : `http_${response.status}`;
    const code = REAUTH_ERROR_CODES.has(errCode) ? 'invalid_grant' : 'http';
    return { ok: false, error: { code, message: redactSlackError(errCode) } };
  }

  const extracted = extractUserToken(json);
  if (!extracted.ok) {
    return { ok: false, error: extracted.error };
  }
  const fields = extracted.fields;

  // A missing/invalid expires_in means token rotation is off — broken state
  // for this integration (Speedwave's Slack app always enables rotation).
  if (typeof fields.expiresIn !== 'number' || fields.expiresIn <= 0) {
    return {
      ok: false,
      error: { code: 'malformed', message: 'expires_in missing — token rotation disabled?' },
    };
  }

  return {
    ok: true,
    value: {
      accessToken: fields.accessToken,
      refreshToken: fields.refreshToken,
      expiresIn: fields.expiresIn,
      grantedScopes: parseScopes(fields.scope, req.scopes),
    },
  };
}

/** Slack user-token provider (rotating refresh, PKCE public client). */
export const slackProvider: OAuthProvider = {
  id: 'slack',
  requiredFields: ['clientId'],
  validateRequest(req: RefreshRequest): RefreshError | null {
    if (req.grantType !== undefined && req.grantType !== 'refresh_token') {
      return { code: 'malformed', message: 'slack supports only the refresh_token grant' };
    }
    if (!req.providerData.clientId) {
      return { code: 'missing_field', message: "providerData['clientId'] is required" };
    }
    if (!req.refreshToken) {
      return { code: 'missing_field', message: 'refreshToken is required for refresh_token grant' };
    }
    return null;
  },
  refresh: (req: RefreshRequest): Promise<RefreshResult> => refreshSlackToken(req),
};
