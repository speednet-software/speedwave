/**
 * Site-scoped Graph client.
 *
 * Encapsulates the **site policy by omission** invariant (ADR-060): the worker
 * stores its `siteId` once at construction and every Graph URL is derived from
 * it. Page / list tools must never accept a `site_id` parameter from the model,
 * so URL builders for those domains live in their respective `graph/<area>-client.ts`
 * modules and consult `getSiteId()` here — never a caller-supplied value.
 *
 * `siteId` and `accessToken` are loaded from the worker's `/tokens` mount; the
 * application credentials (`client_id`, `tenant_id`, `refresh_token`) live in
 * `~/.speedwave/oauth/<project>/sharepoint.json` and are NOT visible here.
 *
 * This module is intentionally tiny — it owns nothing but the site id and a
 * generic `graphRequest` helper. Domain-specific URL building lives in the
 * `pages-client`, `lists-client`, and `columns-client` siblings.
 */

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

/**
 * Inversion-of-control surface that the domain Graph clients (pages, lists,
 * columns) call back into. The concrete implementation is `SharePointClient`,
 * which handles 401-refresh + retry and bearer injection. Splitting it out as
 * an interface lets domain clients be unit-tested without spinning up the full
 * file-ops facade.
 */
export interface GraphRequester {
  /** Returns the configured site id. Never accepts a caller-supplied value. */
  getSiteId(): string;
  /**
   * Performs a Graph request. The path form (`/sites/{site-id}/...`) gets the
   * site id substituted and is prefixed with the v1.0 base URL; absolute URLs
   * are passed through. Inherits the OAuth refresh / retry behaviour of the
   * concrete implementation.
   */
  graphRequest<T = unknown>(
    method: string,
    urlOrPath: string,
    body?: unknown
  ): Promise<T | undefined>;
}

/** Shared base URL helper — domain clients build their own paths off this. */
export function graphV1BaseUrl(): string {
  return GRAPH_BASE_URL;
}
