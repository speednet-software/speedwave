/**
 * Progressive discovery — lazy tool definitions (names_only/with_descriptions/full_schema).
 * Tool metadata SSOT is tool-registry.ts.
 */

import { ToolSearchResult, ToolMetadata } from './hub-types.js';
import {
  getToolMetadata as getToolMetadataFromRegistry,
  TOOL_REGISTRY,
  SERVICE_NAMES,
  getEnabledServices,
  getDisabledOsCategories,
} from './tool-registry.js';

/** Valid detail levels for search_tools, ascending verbosity (SSOT for schema and validation). */
export const DETAIL_LEVELS = ['names_only', 'with_descriptions', 'full_schema'] as const;

/** One of the {@link DETAIL_LEVELS} values. */
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/**
 * Parameters for searching available tools
 */
export interface SearchToolsParams {
  /** Search query to match against tool names, descriptions, and keywords */
  query: string;
  /** Level of detail to return: names_only, with_descriptions, or full_schema */
  detailLevel: DetailLevel;
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
  NameSubstring: 2,
  Keyword: 3,
  Description: 4,
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
 * Get tools for a service as ToolMetadata[], using TOOL_REGISTRY as SSOT; empty if missing.
 * @param service - Service name to get tools for (e.g., 'slack', 'redmine')
 */
function getToolsForService(service: string): ToolMetadata[] {
  const tools = TOOL_REGISTRY[service];
  return tools ? Object.values(tools) : [];
}

/**
 * Lowercase and split a query into whitespace-separated tokens, dropping empties.
 * @param query - Raw search query
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
 * @param tokenCount - Number of tokens in the query
 */
function requiredMatchCount(tokenCount: number): number {
  return tokenCount >= 4 ? tokenCount - 1 : tokenCount;
}

/** Lowercased copies of a tool's searchable fields, computed once per tool per scoring pass. */
interface LowercasedToolFields {
  nameLower: string;
  descriptionLower: string;
  keywordsLower: string[];
}

/**
 * Lowercase the searchable name/description/keywords of a tool.
 * @param tool - Tool metadata to derive lowercased fields from
 */
function lowercaseFields(tool: ToolMetadata): LowercasedToolFields {
  return {
    nameLower: tool.name.toLowerCase(),
    descriptionLower: tool.description.toLowerCase(),
    keywordsLower: tool.keywords.map((k) => k.toLowerCase()),
  };
}

/**
 * Best match tier for a token, or undefined if absent from name/keyword/description.
 * @param fields - Lowercased searchable fields of the tool
 * @param token - Lowercased query token
 */
function tokenMatchTier(fields: LowercasedToolFields, token: string): MatchTier | undefined {
  const { nameLower, descriptionLower, keywordsLower } = fields;
  if (nameLower === token) return MatchTier.ExactName;
  if (nameLower.startsWith(token)) return MatchTier.NamePrefix;
  if (nameLower.includes(token)) return MatchTier.NameSubstring;
  if (keywordsLower.some((k) => k.includes(token))) return MatchTier.Keyword;
  if (descriptionLower.includes(token)) return MatchTier.Description;
  return undefined;
}

/**
 * Score a tool against a query's content tokens (self-reference tokens already filtered out).
 * Returns undefined below the required-match-count threshold.
 * @param tool - Tool metadata to test
 * @param contentTokens - Lowercased query tokens with self-reference tokens removed
 */
function scoreTool(tool: ToolMetadata, contentTokens: string[]): MatchTier | undefined {
  if (contentTokens.length === 0) {
    // Intended: a pure self-reference query ("me") lists userScoped tools across enabled services.
    return tool.userScoped ? MatchTier.Description : undefined;
  }

  const fields = lowercaseFields(tool);
  let matchedCount = 0;
  let bestTier: MatchTier | undefined;

  for (const token of contentTokens) {
    const tier = tokenMatchTier(fields, token);
    if (tier !== undefined) {
      matchedCount++;
      if (bestTier === undefined || tier < bestTier) bestTier = tier;
    }
  }

  if (matchedCount < requiredMatchCount(contentTokens.length)) return undefined;
  return bestTier;
}

/**
 * Search tools via tokenized, ranked matching: exact-name, name-prefix, substring, keyword,
 * description (in that order); self-reference queries boost userScoped tools.
 * @param params - Search parameters including query, detailLevel, service filter, and includeDeferred flag
 */
export async function searchTools(params: SearchToolsParams): Promise<SearchToolsResult> {
  const { query, detailLevel, service, includeDeferred = true } = params;
  const isWildcard = query === '*' || query === '';
  const tokens = tokenize(query);
  const wantsSelfBoost = tokens.some((t) => SELF_REFERENCE_TOKENS.has(t));
  const contentTokens = tokens.filter((t) => !SELF_REFERENCE_TOKENS.has(t));

  const enabled = getEnabledServices();
  const disabledOs = getDisabledOsCategories();
  const servicesToSearch = (service ? [service] : [...SERVICE_NAMES]).filter((s) => enabled.has(s));

  const serviceFilterInvalid = Boolean(service) && !SERVICE_NAMES.includes(service as string);
  const serviceDisabled =
    Boolean(service) && !serviceFilterInvalid && !enabled.has(service as string);

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

      const tier = scoreTool(tool, contentTokens);
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
    result.hint = buildZeroMatchHint(service, serviceFilterInvalid, serviceDisabled, enabled);
  }

  return result;
}

/**
 * Build a single {@link ToolSearchResult} entry: detail-level-gated fields plus the
 * rendered identity sentence for userScoped tools.
 * @param service - Service name the tool belongs to
 * @param tool - Tool metadata
 * @param detailLevel - Requested detail level
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
 * Render a tool's served description, appending ONE canonical identity sentence when userScoped.
 * Never mutates the stored metadata — renders fresh on every call.
 * @param tool - Tool metadata (stored, read-only)
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
    parts.push(
      'No self-reference helper is configured for this tool; identify the target account explicitly.'
    );
  }

  return `${tool.description} ${parts.join(' ')}`;
}

/**
 * Build the `hint` field for a zero-match search: names the invalid or disabled service
 * filter (with valid services listed) or suggests broadening the query.
 * @param service - The requested service filter, if any
 * @param serviceFilterInvalid - Whether `service` was provided but unrecognized
 * @param serviceDisabled - Whether `service` is known but not enabled for this project
 * @param enabled - Set of currently enabled service names
 */
function buildZeroMatchHint(
  service: string | undefined,
  serviceFilterInvalid: boolean,
  serviceDisabled: boolean,
  enabled: Set<string>
): string {
  if (serviceFilterInvalid) {
    const known = [...SERVICE_NAMES].filter((s) => enabled.has(s)).sort();
    return `Unknown service "${service}". Known services: ${known.join(', ') || '(none enabled)'}.`;
  }
  if (serviceDisabled) {
    const known = [...SERVICE_NAMES].filter((s) => enabled.has(s)).sort();
    return `Service "${service}" is not enabled for this project. Enabled services: ${known.join(', ') || '(none)'}. Enable it in Speedwave settings or search without the service filter.`;
  }
  if (service) {
    return `No tools in service "${service}" matched this query. Retry with a single keyword, or query:"*" with detail_level:"names_only" to list all tools in this service.`;
  }
  return 'No tools matched this query. Retry with a single keyword instead of a full sentence, or use query:"*" with detail_level:"names_only" to list all available tools.';
}

/**
 * Get all tools for a service (used by executor); empty array if service not found.
 * @param service - Service name to get tools for
 */
export function getServiceTools(service: string): ToolMetadata[] {
  return getToolsForService(service);
}

/** Get specific tool metadata; re-exported from tool-registry.ts for backward compatibility. */
export const getToolMetadata: (service: string, toolName: string) => ToolMetadata | undefined =
  getToolMetadataFromRegistry;
