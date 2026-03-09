/**
 * Chat Tools
 *
 * Tools for chatting with Gemini AI.
 */

import { Tool, ToolDefinition, ts } from '../../../shared/dist/index.js';
import { GeminiClient, ChatParams } from '../client.js';
import { withValidation, ToolResult } from './validation.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tool Definitions
//═══════════════════════════════════════════════════════════════════════════════

const chatTool: Tool = {
  name: 'chat',
  description:
    'Ask Gemini AI questions or analyze text. Use for: definitions, explanations, translations, general knowledge, text analysis, requirements review. Set useGrounding=true to force Google Search for current/real-time information.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Question to ask or analysis prompt (e.g., "What is przyczłap?", "Find inconsistencies")',
      },
      context: {
        type: 'string',
        description: 'Optional: text content to analyze (omit for simple questions)',
      },
      useGrounding: {
        type: 'boolean',
        description:
          'Force Google Search grounding for current/real-time information (default: false)',
      },
      outputFormat: {
        type: 'string',
        enum: ['text', 'json', 'markdown'],
        description: "Output format (default: 'text')",
      },
    },
    required: ['prompt'],
  },
};

//═══════════════════════════════════════════════════════════════════════════════
// Tool Handlers
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle chat request to Gemini
 * @param client - Gemini client instance
 * @param params - Tool parameters
 */
export async function handleChat(
  client: GeminiClient | null,
  params: ChatParams
): Promise<ToolResult> {
  if (!client) {
    return {
      success: false,
      error: {
        code: 'NOT_CONFIGURED',
        message: 'Gemini not configured. Run: speedwave setup gemini',
      },
    };
  }

  if (!params.prompt || typeof params.prompt !== 'string') {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'prompt is required and must be a string' },
    };
  }

  try {
    const result = await client.chat(params);
    return { success: true, data: result };
  } catch (error: unknown) {
    console.error(`${ts()} chat error:`, error);
    return {
      success: false,
      error: { code: 'GEMINI_ERROR', message: GeminiClient.formatError(error) },
    };
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Tool Exports
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Create chat tool definitions
 * @param client - Gemini client instance
 */
export function createChatTools(client: GeminiClient | null): ToolDefinition[] {
  return [
    {
      tool: chatTool,
      handler: withValidation<ChatParams>(async (params) => handleChat(client, params)),
    },
  ];
}
