/**
 * Site-scoped Graph client: immutable `siteId`, site-derived URL building (ADR-060).
 */

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

/**
 * IOC surface for domain Graph clients. Concrete: `SharePointClient` (401-refresh + bearer).
 */
export interface GraphRequester {
  /** Returns the configured site id. Never accepts a caller-supplied value. */
  getSiteId(): string;
  /**
   * Graph request: path (`/sites/{site-id}/...`) or absolute URL; handles OAuth refresh + retry.
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
