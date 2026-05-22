/**
 * Generic OAuth provider contract used by the host-side `oauth` worker.
 *
 * Each IdP (Microsoft, Atlassian, …) implements one `OAuthProvider`. The
 * worker reads `state.provider` from `oauth/<project>/<service>.json`, looks
 * the implementation up in the registry, and calls `refresh()` with the
 * stored `providerData` (IdP-specific fields like Microsoft `clientId` /
 * `tenantId`).
 */

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
  /** Stable id stored in `OAuthState.provider`. */
  readonly id: string;
  /** User-facing IdP name for audit log + error messages. */
  readonly displayName: string;
  /**
   * Keys of {@link RefreshRequest.providerData} the implementation requires.
   * The dispatcher validates presence + non-empty string PRIOR to calling
   * `refresh()` so a missing field surfaces as `missing_field` with an audit
   * entry rather than as an `URLSearchParams`-shaped HTTP error.
   */
  readonly requiredFields: readonly string[];
  refresh(req: RefreshRequest): Promise<RefreshResult>;
}
