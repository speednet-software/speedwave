/**
 * Type definitions for the Context7 REST API responses (`/api/v2/libs/search`, `/api/v2/context`).
 * @module mcp-context7/types
 */

/** One library entry returned by `/api/v2/libs/search`. */
export interface Context7Library {
  /** Library ID, e.g. `/facebook/react` or `/websites/react_dev`. */
  id: string;
  /** Display title. */
  title: string;
  /** Short summary. */
  description: string;
  /** Git branch indexed (null/empty for non-Git sources). */
  branch?: string;
  /** ISO 8601 timestamp of the last index refresh. */
  lastUpdateDate?: string;
  /** Lifecycle state, e.g. `"finalized"`. */
  state?: string;
  /** Total tokens across all snippets in the index. */
  totalTokens?: number;
  /** Total snippet count in the index. */
  totalSnippets?: number;
  /** GitHub star count (`-1` for non-GitHub sources). */
  stars?: number;
  /** Trust score (0–10). */
  trustScore?: number;
  /** Benchmark score (0–100). */
  benchmarkScore?: number;
  /** Available pinned versions (empty when none). */
  versions?: string[];
}

/** Response shape for `/api/v2/libs/search`. */
export interface SearchResponse {
  /** Ranked library matches. */
  results: Context7Library[];
  /** Whether a server-side filter narrowed the results. */
  searchFilterApplied?: boolean;
}

/** Tier reported by Context7 in the `context7-quota-tier` response header. */
export type QuotaTier = 'anonymous' | 'free' | 'pro' | 'enterprise' | 'unknown';

/** Wrapped result of one Context7 call, exposing the tier to callers. */
export interface Context7CallResult<T> {
  /** Parsed body. */
  data: T;
  /** Quota tier reported by the server (defaults to `"unknown"` when missing). */
  tier: QuotaTier;
}
