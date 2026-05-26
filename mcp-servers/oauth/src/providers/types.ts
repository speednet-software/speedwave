/**
 * Generic OAuth provider contract used by the host-side `oauth` worker.
 *
 * Each IdP (Microsoft, Atlassian, …) implements one `OAuthProvider`. The
 * worker reads `state.provider` from `oauth/<project>/<service>.json`, looks
 * the implementation up in the registry, and calls `refresh()` with the
 * stored `providerData` (IdP-specific fields like Microsoft `clientId` /
 * `tenantId`).
 */

/** SSOT — widen this union when adding an IdP. */
export type ProviderId = 'microsoft';

/** Inputs for an OAuth refresh round-trip. */
export interface RefreshRequest {
  /** Long-lived refresh token issued by the IdP. */
  refreshToken: string;
  /** Scopes requested at refresh time (caller-supplied, IdP-validated). */
  scopes: string[];
  /** IdP-specific fields (e.g. `clientId`, `tenantId` for Microsoft). */
  providerData: Record<string, string>;
}

/** Output of a successful refresh. */
export interface RefreshResponse {
  accessToken: string;
  /** New refresh token, if the IdP rotated it; otherwise the caller keeps the previous one. */
  refreshToken?: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Scopes the user actually granted (may be a subset of `request.scopes`). */
  grantedScopes: string[];
}

/** Failure result from {@link OAuthProvider.refresh}. */
export interface RefreshError {
  code: 'scope_mismatch' | 'invalid_grant' | 'network' | 'http' | 'malformed' | 'missing_field';
  message: string;
}

/** Discriminated union returned by every provider. */
export type RefreshResult =
  | { ok: true; value: RefreshResponse }
  | { ok: false; error: RefreshError };

/** One IdP implementation registered in the provider registry. */
export interface OAuthProvider {
  readonly id: ProviderId;
  /** Required keys of `providerData`; dispatcher validates pre-call. */
  readonly requiredFields: readonly string[];
  refresh(req: RefreshRequest): Promise<RefreshResult>;
}
