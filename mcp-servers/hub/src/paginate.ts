/**
 * Pagination Helpers for Sandbox
 * @module paginate
 *
 * Async generators for efficient iteration over large datasets.
 * Processes data page-by-page to minimize memory usage and token consumption.
 *
 * Usage in execute_code:
 * ```typescript
 * // Iterate page by page (most memory efficient)
 * for await (const page of paginate(
 *   (offset, limit) => redmine.listIssues({ offset, limit, status: "open" })
 * )) {
 *   console.log(`Page ${page.pageNumber}: ${page.items.length} items`);
 * }
 *
 * // Collect all items (use with caution)
 * const all = await collectPages(paginate(
 *   (o, l) => redmine.listIssues({ offset: o, limit: l }),
 *   { maxItems: 100 }
 * ));
 *
 * // Find first match (stops early)
 * const urgent = await findInPages(
 *   paginate((o, l) => redmine.listIssues({ offset: o, limit: l })),
 *   issue => issue.priority?.name === "Urgent"
 * );
 * ```
 */

//═══════════════════════════════════════════════════════════════════════════════
// Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Configuration options for pagination
 */
export interface PaginationConfig {
  /** Items per page (default: 25) */
  limit?: number;
  /** Starting offset (default: 0) */
  offset?: number;
  /** Maximum total items to fetch (default: unlimited) */
  maxItems?: number;
  /** Maximum pages to fetch (default: 100) */
  maxPages?: number;
  /** Stop fetching when this returns true */
  stopWhen?: (items: unknown[], pageNumber: number) => boolean;
}

/**
 * Result for a single page of data
 */
export interface PageResult<T> {
  /** Items in this page */
  items: T[];
  /** 1-indexed page number */
  pageNumber: number;
  /** Offset used for this page */
  offset: number;
  /** Total count if available from API */
  totalCount?: number;
  /** Whether more pages exist */
  hasMore: boolean;
}

/**
 * Common response shapes from MCP workers
 */
type PaginatedResponse<T> = {
  /** Redmine issues */
  issues?: T[];
  /** Redmine time entries */
  time_entries?: T[];
  /** Redmine/GitLab projects */
  projects?: T[];
  /** GitLab merge requests */
  merge_requests?: T[];
  /** GitLab pipelines */
  pipelines?: T[];
  /** Slack messages */
  messages?: T[];
  /** Slack channels */
  channels?: T[];
  /** SharePoint files */
  files?: T[];
  /** Generic results array */
  results?: T[];
  /** Generic items array */
  items?: T[];
  /** Total count of items */
  total_count?: number;
  /** Metadata about pagination */
  _meta?: { truncated?: boolean; originalCount?: number };
  /** Allow other properties */
  [key: string]: unknown;
};

//═══════════════════════════════════════════════════════════════════════════════
// Main Pagination Generator
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Create async generator for paginated API calls
 *
 * Automatically extracts items from common response shapes:
 * - Redmine: { issues: [], total_count: N }
 * - GitLab: { projects: [], merge_requests: [] }
 * - Slack: { messages: [], channels: [] }
 * - Generic: { items: [], results: [] }
 * @param fetcher - Function that fetches a page given offset and limit
 * @param config - Pagination configuration
 * @yields {PageResult<T>} PageResult for each page
 */
export async function* paginate<T>(
  fetcher: (offset: number, limit: number) => Promise<PaginatedResponse<T>>,
  config: PaginationConfig = {}
): AsyncGenerator<PageResult<T>> {
  const limit = config.limit ?? 25;
  const maxPages = config.maxPages ?? 100;
  const maxItems = config.maxItems ?? Infinity;

  let offset = config.offset ?? 0;
  let pageNumber = 0;
  let totalFetched = 0;

  while (pageNumber < maxPages && totalFetched < maxItems) {
    const currentLimit = Math.min(limit, maxItems - totalFetched);
    const result = await fetcher(offset, currentLimit);

    // Extract items from common response shapes
    const items = extractItems<T>(result);
    const totalCount = result.total_count as number | undefined;

    if (items.length === 0) {
      break;
    }

    totalFetched += items.length;
    pageNumber++;

    // Determine if more pages exist
    const hasMore =
      totalCount !== undefined ? offset + items.length < totalCount : items.length === currentLimit;

    yield {
      items,
      pageNumber,
      offset,
      totalCount,
      hasMore,
    };

    // Check stop condition
    if (config.stopWhen?.(items, pageNumber)) {
      break;
    }

    if (!hasMore) {
      break;
    }

    offset += items.length;
  }
}

/**
 * Extract items array from various response shapes
 * @param result - API response object
 * @returns Array of items extracted from response
 */
function extractItems<T>(result: PaginatedResponse<T>): T[] {
  // Try common keys in order of likelihood
  const keys = [
    'issues',
    'time_entries',
    'projects',
    'merge_requests',
    'pipelines',
    'messages',
    'channels',
    'files',
    'results',
    'items',
  ];

  for (const key of keys) {
    if (Array.isArray(result[key])) {
      return result[key] as T[];
    }
  }

  // If result itself is an array, return it
  if (Array.isArray(result)) {
    return result as T[];
  }

  return [];
}

//═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Collect all pages into a single array
 *
 * WARNING: Use maxItems config to prevent memory issues with large datasets
 * @param generator - Pagination generator
 * @returns All items from all pages
 */
export async function collectPages<T>(generator: AsyncGenerator<PageResult<T>>): Promise<T[]> {
  const all: T[] = [];
  for await (const page of generator) {
    all.push(...page.items);
  }
  return all;
}

/**
 * Find first item matching predicate across all pages
 *
 * Stops fetching as soon as a match is found (efficient for large datasets)
 * @param generator - Pagination generator
 * @param predicate - Function to test each item
 * @returns First matching item or undefined
 */
export async function findInPages<T>(
  generator: AsyncGenerator<PageResult<T>>,
  predicate: (item: T) => boolean
): Promise<T | undefined> {
  for await (const page of generator) {
    const found = page.items.find(predicate);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Count items matching predicate across all pages
 * @param generator - Pagination generator
 * @param predicate - Optional filter (counts all if not provided)
 * @returns Total count of matching items
 */
export async function countInPages<T>(
  generator: AsyncGenerator<PageResult<T>>,
  predicate?: (item: T) => boolean
): Promise<number> {
  let count = 0;
  for await (const page of generator) {
    if (predicate) {
      count += page.items.filter(predicate).length;
    } else {
      count += page.items.length;
    }
  }
  return count;
}

/**
 * Filter items across all pages
 * @param generator - Pagination generator
 * @param predicate - Filter function
 * @returns All matching items
 */
export async function filterPages<T>(
  generator: AsyncGenerator<PageResult<T>>,
  predicate: (item: T) => boolean
): Promise<T[]> {
  const results: T[] = [];
  for await (const page of generator) {
    results.push(...page.items.filter(predicate));
  }
  return results;
}

/**
 * Map items across all pages
 * @param generator - Pagination generator
 * @param mapper - Transform function
 * @returns Transformed items from all pages
 */
export async function mapPages<T, U>(
  generator: AsyncGenerator<PageResult<T>>,
  mapper: (item: T) => U
): Promise<U[]> {
  const results: U[] = [];
  for await (const page of generator) {
    results.push(...page.items.map(mapper));
  }
  return results;
}

/**
 * Take first N items across pages
 *
 * Stops fetching once N items are collected
 * @param generator - Pagination generator
 * @param n - Number of items to take
 * @returns First N items
 */
export async function takeFromPages<T>(
  generator: AsyncGenerator<PageResult<T>>,
  n: number
): Promise<T[]> {
  const results: T[] = [];
  for await (const page of generator) {
    for (const item of page.items) {
      results.push(item);
      if (results.length >= n) {
        return results;
      }
    }
  }
  return results;
}
