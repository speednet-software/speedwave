/**
 * Gemini: Chat / Ask Questions / Analyze Text
 * Chat with Gemini AI to answer questions or analyze text content.
 * Use for: general knowledge questions, definitions, explanations, translations,
 * text analysis, requirements review, document summarization.
 * Set useGrounding=true to force Google Search for current/real-time information.
 * @param {string} prompt - Question to ask or analysis prompt
 * @param {string} [context] - Optional text content to analyze (if analyzing documents)
 * @param {boolean} [useGrounding=false] - Force Google Search for current information
 * @param {string} [outputFormat="text"] - Output format: text, json, markdown
 * @returns {object} Response from Gemini
 * @example
 * // Ask a question
 * const answer = await gemini.chat({ prompt: "What is przyczłap?" });
 * @example
 * // Search with Google grounding for current info
 * const result = await gemini.chat({ prompt: "Who is Tomasz Reda?", useGrounding: true });
 * @example
 * // Analyze requirements from Redmine
 * const analysis = await gemini.chat({
 *   prompt: "Find gaps and inconsistencies",
 *   context: issues.map(i => `## ${i.subject}\n${i.description}`).join('\n\n'),
 *   outputFormat: "markdown"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { ts } from '../../../../shared/dist/index.js';

export const metadata: ToolMetadata = {
  name: 'chat',
  service: 'gemini',
  category: 'read',
  deferLoading: false,
  timeoutClass: 'long',
  description:
    'Ask Gemini AI questions or analyze text. Use for: definitions, explanations, translations, general knowledge, text analysis, requirements review. Set useGrounding=true to force Google Search for current/real-time information.',
  keywords: [
    'gemini',
    'chat',
    'ask',
    'question',
    'search',
    'google',
    'grounding',
    'web',
    'define',
    'explain',
    'translate',
    'analyze',
    'text',
    'requirements',
    'review',
    'document',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Question to ask or analysis prompt' },
      context: {
        type: 'string',
        description: 'Optional text content to analyze (omit for simple questions)',
      },
      useGrounding: {
        type: 'boolean',
        description:
          'Force Google Search grounding for current/real-time information (default: false)',
      },
      outputFormat: {
        type: 'string',
        enum: ['text', 'json', 'markdown'],
        description: 'Output format',
      },
    },
    required: ['prompt'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean', description: 'Whether the analysis completed successfully' },
      analysis: { type: 'string', description: 'Analysis result from Gemini' },
      error: { type: 'string', description: 'Error message if analysis failed' },
    },
    required: ['success'],
  },
  example: `// Ask a simple question
const answer = await gemini.chat({ prompt: "Co to jest przyczłap?" });

// Search with Google grounding for current info
const result = await gemini.chat({ prompt: "Who is Tomasz Reda?", useGrounding: true });

// Analyze text with context
const analysis = await gemini.chat({
  prompt: "Find gaps and inconsistencies",
  context: issues.map(i => \`## \${i.subject}\\n\${i.description}\`).join('\\n\\n')
})`,
  inputExamples: [
    {
      description: 'Simple question (no context needed)',
      input: { prompt: 'What is przyczłap?' },
    },
    {
      description: 'Web search with Google grounding',
      input: { prompt: 'Who is Tomasz Reda?', useGrounding: true },
    },
    {
      description: 'Definition/explanation',
      input: { prompt: 'Explain dependency injection in Angular' },
    },
    {
      description: 'Text analysis with context',
      input: {
        prompt: 'Find gaps and inconsistencies in these requirements',
        context: '## REQ-001: User Login\n...\n## REQ-002: Password Reset\n...',
        outputFormat: 'markdown',
      },
    },
  ],
};

/**
 * Result of an analyze operation
 */
interface AnalyzeResult {
  /** Analysis output from Gemini */
  analysis: string;
  /** Output format used */
  format: string;
}

/**
 * Execute gemini_chat tool
 * @param params - Analysis parameters
 * @param params.prompt - Analysis prompt describing what to analyze
 * @param params.context - Text content to analyze
 * @param params.useGrounding - Force Google Search grounding for current info
 * @param params.outputFormat - Output format: text, json, or markdown (default: "text")
 * @param context - Execution context with gemini service
 * @param context.gemini - Gemini service bridge instance
 * @param context.gemini.chat - Function to analyze text content
 * @returns Analysis result or error
 */
export async function execute(
  params: { prompt: string; context?: string; useGrounding?: boolean; outputFormat?: string },
  context: { gemini: { chat: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; result?: AnalyzeResult; error?: string }> {
  const { prompt } = params;

  if (!prompt) {
    return {
      success: false,
      error: 'Missing required field: prompt',
    };
  }

  // context is now optional - for simple questions, only prompt is needed

  try {
    const result = await context.gemini.chat(params);

    return {
      success: true,
      result: result as AnalyzeResult,
    };
  } catch (error) {
    // Format error message for various error types
    let errorMessage: string;
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    } else if (error && typeof error === 'object') {
      errorMessage = JSON.stringify(error);
    } else {
      errorMessage = `Unexpected error type: ${typeof error}`;
    }

    // Log error for debugging (with truncated context to avoid log bloat)
    console.error(`${ts()} [gemini_chat] Tool execution failed:`, {
      prompt: params.prompt?.substring(0, 100),
      contextLength: params.context?.length,
      error: errorMessage,
    });

    return {
      success: false,
      error: errorMessage,
    };
  }
}
