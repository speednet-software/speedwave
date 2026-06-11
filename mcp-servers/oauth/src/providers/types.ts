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
export type ProviderId = 'microsoft' | 'generic' | 'slack';

/** OAuth grant the stored state was minted with; drives generic refresh. */
export type GrantType = 'refresh_token' | 'client_credentials';

/** Inputs for an OAuth refresh round-trip. */
export interface RefreshRequest {
  /** Grant the state uses. Defaults to `refresh_token` for legacy state. */
  grantType?: GrantType;
  /** Long-lived refresh token. Empty for `client_credentials` (re-mint). */
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
  /**
   * Required keys of `providerData`; dispatcher validates pre-call. Used
   * when the provider does not supply its own {@link validateRequest}.
   */
  readonly requiredFields: readonly string[];
  /**
   * Per-request validation when requirements depend on grant/auth style
   * (generic provider). Returns an error to reject, or `null` to proceed.
   * When absent, the dispatcher falls back to {@link requiredFields}.
   */
  validateRequest?(req: RefreshRequest): RefreshError | null;
  refresh(req: RefreshRequest): Promise<RefreshResult>;
}
