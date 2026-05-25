/**
 * Context7 worker constants — base URL, user agent, output caps.
 * @module mcp-context7/consts
 */

/** Base URL for Context7 REST API v2. */
export const BASE_URL = 'https://context7.com/api/v2';

/** Worker version used in `User-Agent`. */
export const SERVER_VERSION = '0.1.0';

/** Default cap for `queryDocs` response, in tokens (~20 KB text). */
export const DEFAULT_OUTPUT_TOKENS = 5000;

/** Lower bound for `queryDocs` `tokens` parameter (Context7 minimum). */
export const MIN_OUTPUT_TOKENS = 500;

/** Upper bound for `queryDocs` `tokens` parameter — caps context-window usage. */
export const MAX_OUTPUT_TOKENS = 15000;

/** Top-N libraries returned by `resolveLibraryId` (Context7 returns up to 20). */
export const MAX_SEARCH_RESULTS = 10;

/** Per-request timeout (ms) for Context7 HTTP calls. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Maximum response body size (bytes) — defence-in-depth against a runaway upstream. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
