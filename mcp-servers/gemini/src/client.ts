/**
 * Gemini CLI Client
 *
 * Executes Gemini CLI commands for chat-based text analysis.
 *
 * Security:
 * - API key read from /tokens/api_key (RO mount)
 * - API key passed via GEMINI_API_KEY env var (not written to disk)
 * - Workspace mounted at /workspace (read-only)
 *
 * Architecture:
 * - Uses native child_process (no additional dependencies)
 * - Retry logic for rate limiting
 * - Supports both text and JSON output formats
 *
 * Error Handling Convention:
 * - Factory functions (initializeGeminiClient) return null on config failures (graceful degradation)
 * - Instance methods throw errors on API failures
 * @module client
 */

import { execFile, ExecFileOptions } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { ts } from '../../shared/dist/index.js';

const execFileAsync = promisify(execFile);

//═══════════════════════════════════════════════════════════════════════════════
// Constants
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Default Gemini model to use for API calls.
 * Can be overridden via GEMINI_MODEL environment variable.
 * @constant {string}
 * @default 'gemini-2.5-flash'
 */
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * Maximum number of retry attempts for rate-limited requests.
 * @constant {number}
 * @default 3
 */
const MAX_RETRIES = 3;

/**
 * Regular expression to extract retry delay from Gemini API error messages.
 * Matches patterns like "Please retry in 5.2s".
 * @constant {RegExp}
 */
const RETRY_REGEX = /Please retry in (\d+\.?\d*)s/i;

/**
 * Directory path where API tokens are stored (read-only mount).
 * @constant {string}
 * @default '/tokens'
 */
const TOKENS_DIR = process.env.TOKENS_DIR || '/tokens';

/**
 * Root directory of the workspace to analyze.
 * @constant {string}
 * @default '/workspace'
 */
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace';

/**
 * Directory where Gemini configuration (.env file) is stored.
 * @constant {string}
 * @default '/app/.gemini'
 */
const GEMINI_CONFIG_DIR = process.env.GEMINI_CONFIG_DIR || '/app/.gemini';

//═══════════════════════════════════════════════════════════════════════════════
// Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Configuration options for initializing the GeminiClient.
 * @interface GeminiConfig
 * @property {string} apiKey - Gemini API key for authentication
 * @property {string} [workspacePath] - Optional workspace directory path. Defaults to WORKSPACE_DIR constant
 */
export interface GeminiConfig {
  /**
   * Gemini API key for authentication.
   * @type {string}
   */
  apiKey: string;
  /**
   * Optional workspace directory path. Defaults to WORKSPACE_DIR constant.
   * @type {string}
   */
  workspacePath?: string;
}

/**
 * Parameters for chatting with Gemini AI.
 * Use for: asking questions, definitions, explanations, translations,
 * or analyzing text content when context is provided.
 * @interface ChatParams
 * @property {string} prompt - Question to ask or analysis prompt
 * @property {string} [context] - Optional text content to analyze (omit for simple questions)
 * @property {boolean} [useGrounding] - Force Google Search grounding for current/real-time information
 * @property {'text' | 'json' | 'markdown'} [outputFormat] - Output format for the results. Default: 'text'
 */
export interface ChatParams {
  /**
   * Question to ask or analysis prompt.
   * @type {string}
   * @example "What is przyczłap?"
   * @example "Analyze these requirements for consistency"
   */
  prompt: string;
  /**
   * Optional text content to analyze (omit for simple questions).
   * @type {string}
   */
  context?: string;
  /**
   * Force Google Search grounding for current/real-time information.
   * When true, Gemini will search the web for up-to-date results.
   * @type {boolean}
   * @default false
   */
  useGrounding?: boolean;
  /**
   * Output format for the results.
   * @type {'text' | 'json' | 'markdown'}
   * @default 'text'
   */
  outputFormat?: 'text' | 'json' | 'markdown';
}

/**
 * Token usage statistics from Gemini API response.
 * @interface GeminiModelStats
 * @private
 * @property {{prompt: number, candidates: number, total: number}} [tokens] - Token count breakdown for the API call
 */
interface GeminiModelStats {
  /**
   * Token count breakdown for the API call.
   * @type {{prompt: number, candidates: number, total: number}}
   */
  tokens?: { prompt: number; candidates: number; total: number };
}

/**
 * Response structure from Gemini CLI JSON output.
 * @interface GeminiCLIResponse
 * @private
 * @property {string} response - The actual response text from the Gemini model
 * @property {{models?: Record<string, GeminiModelStats>}} [stats] - Optional statistics about model usage and token consumption
 */
interface GeminiCLIResponse {
  /**
   * The actual response text from the Gemini model.
   * @type {string}
   */
  response: string;
  /**
   * Optional statistics about model usage and token consumption.
   * @type {{models?: Record<string, GeminiModelStats>}}
   */
  stats?: { models?: Record<string, GeminiModelStats> };
}

//═══════════════════════════════════════════════════════════════════════════════
// Client Class
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Client for interacting with Gemini AI through the Gemini CLI.
 * Provides chat capabilities for analyzing arbitrary text content.
 * @class GeminiClient
 * @property {string} apiKey - Gemini API key for authentication (private)
 * @property {string} workspacePath - Root directory of the workspace to analyze (private)
 * @property {boolean} isReady - Flag indicating if client has been successfully initialized (private)
 * @example
 * const client = new GeminiClient({ apiKey: 'your-api-key' });
 * await client.initialize();
 * const result = await client.chat({ prompt: 'Analyze this text', context: 'Some content...' });
 */
export class GeminiClient {
  private apiKey: string;
  private workspacePath: string;
  private isReady: boolean = false;

  /**
   * Creates a new GeminiClient instance.
   * @param {GeminiConfig} config - Configuration options including API key and workspace path
   */
  constructor(config: GeminiConfig) {
    this.apiKey = config.apiKey;
    this.workspacePath = config.workspacePath || WORKSPACE_DIR;
  }

  /**
   * Initialize client by setting up the API key in the .gemini directory.
   * Creates the necessary configuration files for Gemini CLI to function.
   *
   * Note: Works without Gemini CLI installed, but tools will return errors if CLI not available.
   * @async
   * @returns {Promise<boolean>} True if initialization succeeded, false otherwise
   * @throws {Error} If unable to create configuration directory or write API key file
   */
  async initialize(): Promise<boolean> {
    try {
      // Check if Gemini CLI is installed (optional - server starts anyway)
      try {
        await execFileAsync('which', ['gemini']);
        console.log(`${ts()} ✅ Gemini CLI found`);
      } catch (cliError) {
        // Log actual error for debugging while showing user-friendly message
        console.warn(
          `${ts()} ⚠️  Gemini CLI check failed - tools will use API directly.`,
          cliError instanceof Error ? `(${cliError.message})` : ''
        );
      }

      // API key is passed via GEMINI_API_KEY env var when executing CLI
      // No need to write .env file (cleaner, more secure)
      console.log(`${ts()} ✅ Gemini client initialized`);
      this.isReady = true;
      return true;
    } catch (error) {
      console.error(`${ts()} ❌ Failed to initialize Gemini client:`, error);
      return false;
    }
  }

  /**
   * Check if the client has been successfully initialized.
   * @returns {boolean} True if the client is ready to use, false otherwise
   */
  isInitialized(): boolean {
    return this.isReady;
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Error Handling
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Map known error patterns to user-friendly messages.
   * Centralizes error translation logic to avoid duplication.
   * @private
   * @param {string} msg - Raw error message to check
   * @returns {string | null} User-friendly message if pattern matches, null otherwise
   */
  private mapKnownError(msg: string): string | null {
    if (msg.includes('exhausted your daily quota') || msg.includes('quota')) {
      return 'Daily quota exceeded for this model. Try again tomorrow or use a different model.';
    }
    if (msg.includes('rate limit') || msg.includes('Rate limit')) {
      return 'Rate limit exceeded. Please try again later.';
    }
    if (msg.includes('API key') || msg.includes('401') || msg.includes('Unauthorized')) {
      return 'Authentication failed. Check your Gemini API key.';
    }
    return null;
  }

  /**
   * Extract meaningful error message from CLI error output.
   * Handles JSON error files and various error formats from Gemini CLI.
   * @private
   * @param {object} error - The error object from execFileAsync
   * @param {string | object} [error.message] - Error message (string or object with message/error property)
   * @param {string} [error.stderr] - Standard error output from CLI
   * @returns {string} Extracted error message
   */
  private extractErrorMessage(error: { message?: string | object; stderr?: string }): string {
    const stderr = error.stderr || '';
    const fullMessage = typeof error.message === 'string' ? error.message : '';
    const combined = `${stderr}\n${fullMessage}`.trim();

    // Check if output contains path to error JSON file
    const errorFileMatch = combined.match(/Full report available at: ([^\s]+\.json)/);
    if (errorFileMatch) {
      const errorFilePath = errorFileMatch[1];

      // Try to read the error file for detailed message
      try {
        const errorFileContent = fsSync.readFileSync(errorFilePath, 'utf8');
        const errorJson = JSON.parse(errorFileContent) as {
          error?: { message?: string; stack?: string };
        };

        if (errorJson.error?.message) {
          const msg = errorJson.error.message;
          const friendlyMsg = this.mapKnownError(msg);
          return friendlyMsg || msg;
        }
      } catch (fileReadError) {
        // Log the secondary failure for debugging - the file existed but we couldn't read/parse it
        console.warn(
          `${ts()} [GeminiClient] Failed to read error details from ${errorFilePath}:`,
          fileReadError instanceof Error ? fileReadError.message : String(fileReadError)
        );
      }
    }

    // Handle message that might be an object
    if (error.message) {
      if (typeof error.message === 'object') {
        const msgObj = error.message as { message?: string; error?: string };
        return msgObj.message || msgObj.error || JSON.stringify(error.message);
      }

      // Check for known error patterns in message
      const msg = error.message;
      const friendlyMsg = this.mapKnownError(msg);
      return friendlyMsg || msg;
    }

    return stderr || 'Unknown error';
  }

  /**
   * Format error messages consistently for user-friendly display.
   * Converts technical errors into actionable error messages.
   * @static
   * @param {unknown} error - The error object to format
   * @returns {string} A user-friendly error message with actionable guidance
   */
  static formatError(error: unknown): string {
    const e = error as { message?: string; stderr?: string; code?: string; path?: string };
    const message = e.message || '';

    if (message.includes('not initialized')) {
      return 'Gemini not configured. Run: speedwave setup gemini';
    }

    if (message.includes('rate limited') || message.includes('Rate limit')) {
      return 'Rate limit exceeded. Please try again later.';
    }

    if (
      message.includes('API key') ||
      message.includes('401') ||
      message.includes('Unauthorized')
    ) {
      return 'Authentication failed. Check your Gemini API key. Run: speedwave setup gemini';
    }

    if (message.includes('getaddrinfo') || message.includes('ECONNREFUSED')) {
      return 'Network error. Cannot connect to Gemini API.';
    }

    return message || 'Gemini API error';
  }

  /**
   * Execute Gemini CLI command with automatic retry logic for rate limiting.
   * Handles JSON parsing and token usage logging.
   * @private
   * @async
   * @param {string} prompt - The prompt to send to Gemini
   * @param {string} [stdin] - Optional stdin content to pass to the CLI
   * @param {string} [cwd] - Optional working directory for command execution
   * @returns {Promise<string>} The response text from Gemini
   * @throws {Error} If client is not initialized
   * @throws {Error} If Gemini CLI fails after all retries
   * @throws {Error} If rate limit is exceeded after MAX_RETRIES attempts
   */
  private async executeGemini(prompt: string, stdin?: string, cwd?: string): Promise<string> {
    if (!this.isReady) {
      throw new Error('Gemini client not initialized');
    }

    const args = ['-y', '-m', DEFAULT_MODEL, '-o', 'json', '-p', prompt];

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const options: ExecFileOptions & { input?: string } = {
          maxBuffer: 10 * 1024 * 1024, // 10MB
          encoding: 'utf8' as BufferEncoding,
          cwd: cwd || this.workspacePath,
          env: {
            ...process.env,
            GEMINI_CONFIG_DIR,
            GEMINI_API_KEY: this.apiKey,
          },
        };

        if (stdin) {
          options.input = stdin;
        }

        const { stdout, stderr } = (await execFileAsync('gemini', args, options)) as unknown as {
          stdout: string;
          stderr: string;
        };

        if (stderr && !stderr.includes('Loading')) {
          console.warn(`${ts()} ⚠️  Gemini CLI stderr:`, stderr);
        }

        // Parse JSON wrapper
        try {
          const result = JSON.parse(stdout) as GeminiCLIResponse;

          // Log token usage
          if (result.stats?.models) {
            const modelStats = Object.values(result.stats.models)[0] as
              | GeminiModelStats
              | undefined;
            if (modelStats?.tokens) {
              console.log(
                `${ts()} 📊 Token usage: ${modelStats.tokens.prompt} + ${modelStats.tokens.candidates} = ${modelStats.tokens.total}`
              );
            }
          }

          return result.response;
        } catch (parseError) {
          // Log parse failure - this may indicate a real problem
          console.error(
            `${ts()} [GeminiClient] JSON parse failed:`,
            parseError instanceof Error ? parseError.message : parseError,
            `stdout preview: ${stdout.substring(0, 200)}...`
          );

          // Only fallback to raw output if it doesn't look like an error response
          const lowerStdout = stdout.toLowerCase();
          if (
            lowerStdout.includes('error') ||
            lowerStdout.includes('exception') ||
            lowerStdout.includes('failed')
          ) {
            throw new Error(
              `Gemini returned invalid JSON with error indicators: ${stdout.substring(0, 300)}`
            );
          }

          // Graceful degradation for non-error text responses
          console.warn(
            `${ts()} [GeminiClient] Returning raw stdout as fallback - JSON parsing failed but output appears valid`
          );
          return stdout.trim();
        }
      } catch (error: unknown) {
        const e = error as { stderr?: string; message?: string | object };
        const stderr = e.stderr || '';
        const retryMatch = stderr.match(RETRY_REGEX);

        if (retryMatch && attempt < MAX_RETRIES) {
          const waitSeconds = parseFloat(retryMatch[1]);
          console.warn(
            `${ts()} ⏳ Rate limit hit. Waiting ${waitSeconds.toFixed(1)}s (attempt ${attempt}/${MAX_RETRIES})...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
          continue;
        }

        if (retryMatch && attempt === MAX_RETRIES) {
          throw new Error(`Gemini CLI failed after ${MAX_RETRIES} retries (rate limited)`);
        }

        // Extract meaningful error message from various error formats
        const errorMessage = this.extractErrorMessage(e);
        throw new Error(`Gemini CLI failed: ${errorMessage}`);
      }
    }

    throw new Error('Gemini CLI failed: max retries exceeded');
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Tool Implementations
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Chat with Gemini AI about arbitrary text content.
   * Ideal for analyzing requirements, documents, or any text that doesn't come from files.
   * @async
   * @param {ChatParams} params - Chat parameters including prompt, context, useGrounding, and output format
   * @returns {Promise<string>} The chat response from Gemini in the requested format
   * @throws {Error} If client is not initialized
   * @throws {Error} If Gemini CLI fails after retries
   */
  async chat(params: ChatParams): Promise<string> {
    const { prompt, context, useGrounding, outputFormat = 'text' } = params;

    // Build prompt - apply grounding prefix if requested
    let finalPrompt = prompt;

    if (useGrounding) {
      finalPrompt = `Use Google Search to find current, up-to-date information about the following query. Search the web and provide accurate results:\n\n${prompt}`;
    }

    if (context) {
      finalPrompt += `\n\n---\nContent to analyze:\n${context}`;
    }

    if (outputFormat === 'json') {
      finalPrompt += '\n\nProvide your response as valid JSON.';
    } else if (outputFormat === 'markdown') {
      finalPrompt += '\n\nProvide your response in Markdown format.';
    }

    return await this.executeGemini(finalPrompt);
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Factory Function
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize a Gemini client by reading the API key from the mounted token file.
 * This is the recommended way to create a GeminiClient instance in production.
 *
 * IMPORTANT: Returns null (not throws) when tokens are missing or invalid.
 * This enables "graceful degradation" - server starts even without config:
 * - User can run `speedwave up` without configuring all integrations
 * - Healthcheck reports `configured: false` for unconfigured services
 * - Tools return clear "not configured" error when called
 *
 * DO NOT change this to throw - it breaks container startup for unconfigured services.
 * @returns An initialized GeminiClient instance, or null if API key not found/invalid
 */
export async function initializeGeminiClient(): Promise<GeminiClient | null> {
  try {
    const apiKeyPath = path.join(TOKENS_DIR, 'api_key');

    // Read API key from mounted token file
    let apiKey: string;
    try {
      apiKey = (await fs.readFile(apiKeyPath, 'utf8')).trim();
    } catch (error: unknown) {
      const e = error as { code?: string; path?: string };
      if (e.code === 'ENOENT') {
        console.warn(
          `${ts()} Gemini token file not found: ${e.path}. Expected token file: /tokens/api_key`
        );
        // Graceful degradation: log warning, return null, let server start
        // DO NOT throw here - see JSDoc above for rationale
        return null;
      }
      console.warn(`${ts()} Failed to read Gemini token file: ${e.code || 'unknown error'}`);
      // Graceful degradation: log warning, return null, let server start
      // DO NOT throw here - see JSDoc above for rationale
      return null;
    }

    if (!apiKey) {
      console.warn(`${ts()} Gemini API key is empty. Run: speedwave setup gemini`);
      // Graceful degradation: log warning, return null, let server start
      // DO NOT throw here - see JSDoc above for rationale
      return null;
    }

    console.log(`${ts()} ✅ Loaded Gemini API key from ${apiKeyPath}`);

    const client = new GeminiClient({
      apiKey,
      workspacePath: WORKSPACE_DIR,
    });

    const initialized = await client.initialize();
    if (!initialized) {
      console.warn(
        `${ts()} Gemini client initialization failed. Check Gemini CLI installation and API key validity.`
      );
      // Graceful degradation: log warning, return null, let server start
      // DO NOT throw here - see JSDoc above for rationale
      return null;
    }

    return client;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${ts()} Unexpected error initializing Gemini client: ${message}`);
    // Graceful degradation: log warning, return null, let server start
    // DO NOT throw here - see JSDoc above for rationale
    return null;
  }
}
