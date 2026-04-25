/**
 * Code Executor Handlers
 * Implementation of 2 meta-tools for Filesystem as API pattern
 * @module handlers
 */

import { ToolHandler, ToolsCallResult } from '@speedwave/mcp-shared';
import { searchTools, SearchToolsParams } from './search-tools.js';
import { executeCode, ExecuteCodeParams } from './executor.js';
import { getExecutionTimeout } from './tool-registry.js';

/**
 * Configuration for handler creation
 */
interface HandlerConfig {
  /** Default timeout for code execution in milliseconds */
  timeoutMs: number;
}

/**
 * Convert data to JSON text for MCP response
 * Handles undefined/null: JSON.stringify(undefined) returns undefined, not a string!
 * @param data - Data to convert to JSON string
 * @returns JSON string representation
 */
const toJsonText = (data: unknown): string =>
  typeof data === 'string' ? data : JSON.stringify(data ?? null);

type McpContentType = 'text' | 'image' | 'audio' | 'resource' | 'resource_link';

interface McpContentItem {
  type: McpContentType;
  text?: string;
  data?: string;
  mimeType?: string;
}

const MCP_CONTENT_TYPES: Set<McpContentType> = new Set([
  'text',
  'image',
  'audio',
  'resource',
  'resource_link',
]);

function isMcpContentArray(data: unknown): data is McpContentItem[] {
  if (!Array.isArray(data) || data.length === 0) return false;
  return data.every((item) => {
    if (typeof item !== 'object' || item === null || !('type' in item)) return false;
    const typed = item as McpContentItem;
    if (!MCP_CONTENT_TYPES.has(typed.type)) return false;
    if (typed.type === 'text') return typeof typed.text === 'string';
    if (typed.type === 'image' || typed.type === 'audio') {
      return typeof typed.data === 'string' && typeof typed.mimeType === 'string';
    }
    return true;
  });
}

/**
 * Validate and normalize timeout parameter
 * @param paramValue - The timeout_ms value from request params
 * @param configDefault - Default timeout from config
 * @param maxTimeout - Maximum allowed timeout (varies by operation type)
 * @returns Validated timeout value in milliseconds
 * @throws {Error} Error if timeout is invalid (negative, zero, or non-numeric)
 */
function validateTimeout(paramValue: unknown, configDefault: number, maxTimeout: number): number {
  // Not provided → use config default (capped at max)
  if (paramValue === undefined || paramValue === null) {
    return Math.min(configDefault, maxTimeout);
  }

  const timeout = Number(paramValue);

  // Validate it's a finite positive number
  if (!Number.isFinite(timeout)) {
    throw new Error(`timeout_ms must be a valid number (got: ${paramValue})`);
  }

  if (timeout <= 0) {
    throw new Error(`timeout_ms must be positive (got: ${timeout})`);
  }

  // Cap at maximum and floor to integer
  return Math.min(Math.floor(timeout), maxTimeout);
}

/**
 * Factory function to create code executor handlers
 * Uses dependency injection pattern for testability
 * @param config - Handler configuration including default timeout
 * @returns Object containing handler functions for all three meta-tools
 */
export function createCodeExecutorHandlers(config: HandlerConfig) {
  /**
   * search_tools - Progressive discovery handler
   * Searches available tools by keyword with configurable detail levels
   * @param params - Search parameters
   * @returns MCP tool call result
   */
  const handleSearchTools: ToolHandler = async (
    params: Record<string, unknown>
  ): Promise<ToolsCallResult> => {
    try {
      if (typeof params.query !== 'string') {
        return {
          content: [{ type: 'text', text: 'Error: query parameter must be a string' }],
          isError: true,
        };
      }

      const searchParams: SearchToolsParams = {
        query: params.query,
        detailLevel:
          params.detail_level === 'names_only' ||
          params.detail_level === 'with_descriptions' ||
          params.detail_level === 'full_schema'
            ? params.detail_level
            : 'names_only',
        service: typeof params.service === 'string' ? params.service : undefined,
        includeDeferred:
          typeof params.include_deferred === 'boolean' ? params.include_deferred : undefined,
      };

      const results = await searchTools(searchParams);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: `Error searching tools: ${message}`,
          },
        ],
        isError: true,
      };
    }
  };

  /**
   * execute_code - JavaScript execution in sandbox
   * Executes user code with access to tool imports
   * @param params - Code execution parameters
   * @returns MCP tool call result
   */
  const handleExecuteCode: ToolHandler = async (
    params: Record<string, unknown>
  ): Promise<ToolsCallResult> => {
    try {
      if (typeof params.code !== 'string') {
        return {
          content: [{ type: 'text', text: 'Error: code parameter must be a string' }],
          isError: true,
        };
      }

      const code = params.code;

      // Get timeout configuration based on tools used in code (SSOT from tool-registry)
      const { timeoutMs: defaultTimeout, maxTimeoutMs } = getExecutionTimeout(
        code,
        config.timeoutMs
      );

      // Validate and apply user-provided timeout (if any)
      const timeoutMs = validateTimeout(params.timeout_ms, defaultTimeout, maxTimeoutMs);

      const executeParams: ExecuteCodeParams = {
        code,
        timeoutMs,
      };

      const result = await executeCode(executeParams);

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Execution error: ${result.error?.message || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      if (isMcpContentArray(result.data)) {
        return { content: result.data };
      }
      return {
        content: [{ type: 'text', text: toJsonText(result.data) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Execution failed: ${message}` }],
        isError: true,
      };
    }
  };

  return {
    handleSearchTools,
    handleExecuteCode,
  };
}
