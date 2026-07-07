/**
 * Progressive discovery — lazy tool definitions (names_only/with_descriptions/full_schema).
 * Tool metadata from tool-registry.ts (SSOT).
 * @module search-tools
 */

import { ts } from '@speedwave/mcp-shared';
import { ToolSearchResult, ToolMetadata } from './hub-types.js';
import {
  getToolMetadata as getToolMetadataFromRegistry,
  TOOL_REGISTRY,
  SERVICE_NAMES,
  getEnabledServices,
  getDisabledOsCategories,
} from './tool-registry.js';

/**
 * Parameters for searching available tools
 */
export interface SearchToolsParams {
  /** Search query to match against tool names, descriptions, and keywords */
  query: string;
  /** Level of detail to return: names_only, with_descriptions, or full_schema */
  detailLevel: 'names_only' | 'with_descriptions' | 'full_schema';
  /** Optional service name to filter results (slack, sharepoint, redmine, gitlab) */
  service?: string;
  /** Include deferred tools in results (default: true). Set false to get only core tools. */
  includeDeferred?: boolean;
}

/**
 * Result of a tool search operation
 */
export interface SearchToolsResult {
  /** Array of matching tools */
  matches: ToolSearchResult[];
  /** Total number of matches found */
  total: number;
  /** The original search query */
  query: string;
  /** The detail level that was used */
  detail_level: string;
  /** Present only on zero matches: explains why and suggests a next step. */
  hint?: string;
}

/** Tokens that signal the caller means "the authenticated user" (English + Polish). */
const SELF_REFERENCE_TOKENS: ReadonlySet<string> = new Set([
  'my',
  'mine',
  'me',
  'moje',
  'moich',
  'moj',
  'mój',
  'mnie',
]);

/** Ranking tiers, lower sorts first. */
const MatchTier = Object.freeze({
  ExactName: 0,
  NamePrefix: 1,
  Keyword: 2,
  Description: 3,
} as const);
type MatchTier = (typeof MatchTier)[keyof typeof MatchTier];

/** Per-tool computed match info used for ranking before result shaping. */
interface ScoredTool {
  service: string;
  tool: ToolMetadata;
  tier: MatchTier;
  selfBoost: boolean;
}

/**
 * Get tools for a service as an array of ToolMetadata.
 * Uses TOOL_REGISTRY from tool-registry.ts as Single Source of Truth.
 * @param service - Service name to get tools for (e.g., 'slack', 'redmine')
 * @returns Array of tool metadata, or empty array if service not found
 */
function getToolsForService(service: string): ToolMetadata[] {
  const tools = TOOL_REGISTRY[service];
  return tools ? Object.values(tools) : [];
}

/**
 * Lowercase and split a query into whitespace-separated tokens, dropping empties.
 * @param query - Raw search query.
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Minimum matching-token count for a query of this length; 4+ tokens tolerate one miss.
 * @param tokenCount - Number of tokens in the query.
 */
function requiredMatchCount(tokenCount: number): number {
  return tokenCount >= 4 ? tokenCount - 1 : tokenCount;
}

/**
 * Determine the best match tier for a tool against a single token, or undefined if
 * the token does not appear in name, keywords, or description.
 * @param tool - Tool metadata to test.
 * @param token - Lowercased query token.
 */
function tokenMatchTier(tool: ToolMetadata, token: string): MatchTier | undefined {
  const nameLower = tool.name.toLowerCase();
  if (nameLower === token) return MatchTier.ExactName;
  if (nameLower.startsWith(token)) return MatchTier.NamePrefix;
  if (tool.keywords.some((k) => k.toLowerCase().includes(token))) return MatchTier.Keyword;
  if (tool.description.toLowerCase().includes(token)) return MatchTier.Description;
  return undefined;
}

/**
 * Score a tool against tokenized query, ignoring self-reference tokens (they drive
 * only the boost signal). Returns undefined below the required-match-count threshold.
 * @param tool - Tool metadata to test.
 * @param tokens - Lowercased query tokens (including any self-reference tokens).
 */
function scoreTool(tool: ToolMetadata, tokens: string[]): MatchTier | undefined {
  const contentTokens = tokens.filter((t) => !SELF_REFERENCE_TOKENS.has(t));
  if (contentTokens.length === 0) return MatchTier.Description;

  let matchedCount = 0;
  let bestTier: MatchTier | undefined;

  for (const token of contentTokens) {
    const tier = tokenMatchTier(tool, token);
    if (tier !== undefined) {
      matchedCount++;
      if (bestTier === undefined || tier < bestTier) bestTier = tier;
    }
  }

  if (matchedCount < requiredMatchCount(contentTokens.length)) return undefined;
  return bestTier;
}

/**
 * Search tools via tokenized, ranked matching (name/keyword/description); ranks
 * exact-name first, then prefix, keyword, description; self-reference queries boost userScoped tools.
 * @param params - Search parameters including query, detailLevel, service filter, and includeDeferred flag
 */
export async function searchTools(params: SearchToolsParams): Promise<SearchToolsResult> {
  const { query, detailLevel, service, includeDeferred = true } = params;
  const isWildcard = query === '*' || query === '';
  const tokens = tokenize(query);
  const wantsSelfBoost = tokens.some((t) => SELF_REFERENCE_TOKENS.has(t));

  const enabled = getEnabledServices();
  const disabledOs = getDisabledOsCategories();
  const servicesToSearch = (service ? [service] : [...SERVICE_NAMES]).filter((s) => enabled.has(s));

  const serviceFilterInvalid = Boolean(service) && !SERVICE_NAMES.includes(service as string);

  const scored: ScoredTool[] = [];

  for (const svc of servicesToSearch) {
    const tools = getToolsForService(svc);
    if (tools.length === 0) continue;

    for (const tool of tools) {
      if (!includeDeferred && tool.deferLoading !== false) continue;
      if (tool.osCategory && disabledOs.has(tool.osCategory)) continue;

      if (isWildcard) {
        scored.push({ service: svc, tool, tier: MatchTier.Description, selfBoost: false });
        continue;
      }

      const tier = scoreTool(tool, tokens);
      if (tier === undefined) continue;
      scored.push({ service: svc, tool, tier, selfBoost: wantsSelfBoost && !!tool.userScoped });
    }
  }

  scored.sort((a, b) => {
    if (a.selfBoost !== b.selfBoost) return a.selfBoost ? -1 : 1;
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.tool.name.localeCompare(b.tool.name);
  });

  const results: ToolSearchResult[] = scored.map(({ service: svc, tool }) =>
    buildSearchResult(svc, tool, detailLevel)
  );

  const result: SearchToolsResult = {
    matches: results,
    total: results.length,
    query,
    detail_level: detailLevel,
  };

  if (results.length === 0) {
    result.hint = buildZeroMatchHint(service, serviceFilterInvalid, enabled);
  }

  return result;
}

/**
 * Build a single {@link ToolSearchResult} entry, including detail-level-gated fields
 * and the rendered identity sentence for userScoped tools.
 * @param service - Service name the tool belongs to.
 * @param tool - Tool metadata.
 * @param detailLevel - Requested detail level.
 */
function buildSearchResult(
  service: string,
  tool: ToolMetadata,
  detailLevel: SearchToolsParams['detailLevel']
): ToolSearchResult {
  const result: ToolSearchResult = {
    tool: `${service}/${tool.name}`,
    service,
    deferLoading: tool.deferLoading ?? true,
  };

  if (detailLevel === 'with_descriptions' || detailLevel === 'full_schema') {
    result.description = renderDescriptionWithIdentity(tool);
  }

  if (detailLevel === 'full_schema') {
    result.inputSchema = tool.inputSchema;
    result.outputSchema = tool.outputSchema;
    result.example = tool.example;
    result.inputExamples = tool.inputExamples;
  }

  return result;
}

/**
 * Render a tool's served description, appending ONE canonical identity sentence when
 * userScoped. Never mutates the stored metadata — renders fresh on every call.
 * @param tool - Tool metadata (stored, read-only).
 */
export function renderDescriptionWithIdentity(tool: ToolMetadata): string {
  if (!tool.userScoped) return tool.description;

  const parts = ['Results depend on the authenticated user.'];
  if (tool.currentUserTool) {
    parts.push(`Use ${tool.currentUserTool} to resolve the current user.`);
  }
  if (tool.selfParam) {
    parts.push(`Pass "${tool.selfParam}" to reference yourself.`);
  }
  if (!tool.currentUserTool && !tool.selfParam) {
    console.warn(
      `${ts()} [search-tools] userScoped tool "${tool.name}" declares neither currentUserTool nor selfParam; serving a degraded identity sentence`
    );
  }

  return `${tool.description} ${parts.join(' ')}`;
}

/**
 * Build the `hint` field for a zero-match search: names the invalid service filter
 * (with valid services listed) or suggests broadening the query.
 * @param service - The requested service filter, if any.
 * @param serviceFilterInvalid - Whether `service` was provided but unrecognized.
 * @param enabled - Set of currently enabled service names.
 */
function buildZeroMatchHint(
  service: string | undefined,
  serviceFilterInvalid: boolean,
  enabled: Set<string>
): string {
  if (serviceFilterInvalid) {
    const known = [...SERVICE_NAMES].filter((s) => enabled.has(s)).sort();
    return `Unknown service "${service}". Known services: ${known.join(', ') || '(none enabled)'}.`;
  }
  if (service) {
    return `No tools in service "${service}" matched this query. Retry with a single keyword, or query:"*" with detail_level:"names_only" to list all tools in this service.`;
  }
  return 'No tools matched this query. Retry with a single keyword instead of a full sentence, or use query:"*" with detail_level:"names_only" to list all available tools.';
}

/**
 * Get all tools for a service (used by executor)
 * @param service - Service name to get tools for
 * @returns Array of tool metadata for the service, or empty array if service not found
 */
export function getServiceTools(service: string): ToolMetadata[] {
  return getToolsForService(service);
}

/**
 * Get specific tool metadata
 * Re-exported from tool-registry.ts for backward compatibility.
 * @param service - Service name containing the tool
 * @param toolName - Name of the tool to retrieve
 * @returns Tool metadata if found, undefined otherwise
 */
export const getToolMetadata: (service: string, toolName: string) => ToolMetadata | undefined =
  getToolMetadataFromRegistry;
