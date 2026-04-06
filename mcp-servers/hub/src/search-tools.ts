/**
 * Progressive Discovery - search_tools implementation
 * @module search-tools
 *
 * Implements lazy loading of tool definitions:
 * - names_only: ~50 tokens (just tool paths)
 * - with_descriptions: ~200 tokens (paths + descriptions)
 * - full_schema: ~500 tokens (complete schema for specific tool)
 *
 * This reduces token usage from ~25K (all tools upfront) to ~50-500 per query
 *
 * Tool metadata is dynamically loaded from tools/{service}/index.ts files
 * to maintain a single source of truth and avoid duplication.
 */

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
 * Search tools by query string
 * Matches against tool names, descriptions, and keywords
 * Supports filtering by deferLoading status for progressive discovery
 * @param params - Search parameters including query, detailLevel, service filter, and includeDeferred flag
 */
export async function searchTools(params: SearchToolsParams): Promise<SearchToolsResult> {
  const { query, detailLevel, service, includeDeferred = true } = params;
  const queryLower = query.toLowerCase();
  const isWildcard = query === '*' || query === '';

  const results: ToolSearchResult[] = [];

  // Get services to search (use SERVICE_NAMES from tool-registry), filtered by enabled services
  const enabled = getEnabledServices();
  const disabledOs = getDisabledOsCategories();
  const servicesToSearch = (service ? [service] : [...SERVICE_NAMES]).filter((s) => enabled.has(s));

  for (const svc of servicesToSearch) {
    const tools = getToolsForService(svc);
    if (tools.length === 0) continue;

    for (const tool of tools) {
      // Skip deferred tools if includeDeferred is false
      if (!includeDeferred && tool.deferLoading !== false) {
        continue;
      }

      // Skip OS tools whose category is disabled
      if (svc === 'os' && tool.osCategory && disabledOs.has(tool.osCategory)) {
        continue;
      }

      // Check if query matches (wildcard matches everything)
      if (!isWildcard) {
        const nameMatch = tool.name.toLowerCase().includes(queryLower);
        const descMatch = tool.description.toLowerCase().includes(queryLower);
        const keywordMatch = tool.keywords.some((k) => k.toLowerCase().includes(queryLower));
        if (!nameMatch && !descMatch && !keywordMatch) {
          continue;
        }
      }

      // Tool matched - add to results
      {
        const result: ToolSearchResult = {
          tool: `${svc}/${tool.name}`,
          service: svc,
          deferLoading: tool.deferLoading ?? true,
        };

        // Add details based on detail level
        if (detailLevel === 'with_descriptions' || detailLevel === 'full_schema') {
          result.description = tool.description;
        }

        if (detailLevel === 'full_schema') {
          result.inputSchema = tool.inputSchema;
          result.outputSchema = tool.outputSchema;
          result.example = tool.example;
          result.inputExamples = tool.inputExamples;
        }

        results.push(result);
      }
    }
  }

  return {
    matches: results,
    total: results.length,
    query,
    detail_level: detailLevel,
  };
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
