/** Code Executor Handlers: implementation of the 2 meta-tools for the Filesystem-as-API pattern. */

import { ToolHandler, ToolsCallResult, teachingErrorResult } from '@speedwave/mcp-shared';
import { searchTools, SearchToolsParams, DETAIL_LEVELS, DetailLevel } from './search-tools.js';
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
 * Convert data to JSON text for an MCP response. Coerces undefined/null → null.
 * @param data - Data to convert to JSON string.
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
 * Validate and normalize the timeout_ms param, capped at maxTimeout.
 * Throws if negative, zero, or non-numeric.
 * @param paramValue - The timeout_ms value from request params.
 * @param configDefault - Default timeout from config.
 * @param maxTimeout - Maximum allowed timeout (varies by operation type).
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
 * Factory to create code executor handlers.
 * @param config - Handler configuration including default timeout.
 */
export function createCodeExecutorHandlers(config: HandlerConfig) {
  /**
   * search_tools — searches available tools by keyword with detail levels.
   * @param params - Search parameters.
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

      const rawDetail = params.detail_level;
      if (rawDetail !== undefined && !DETAIL_LEVELS.includes(rawDetail as DetailLevel)) {
        return teachingErrorResult({
          paramName: 'detail_level',
          received: rawDetail,
          nextStep: `Use one of: ${DETAIL_LEVELS.join(', ')}. Omit it to default to names_only.`,
        });
      }
      const searchParams: SearchToolsParams = {
        query: params.query,
        detailLevel: rawDetail === undefined ? 'names_only' : (rawDetail as DetailLevel),
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
   * execute_code — executes user JavaScript in a sandbox with tool imports.
   * @param params - Code execution parameters.
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
