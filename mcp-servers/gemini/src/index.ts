/**
 * MCP Gemini Worker
 *
 * AI-powered chat using Gemini API.
 * Architecture: Domain-tools pattern with separation of concerns.
 * @module mcp-gemini
 */

import { createMCPServer, ts } from '../../shared/dist/index.js';
import { initializeGeminiClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

//═══════════════════════════════════════════════════════════════════════════════
// Configuration
//═══════════════════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || '3005', 10);
const SERVER_NAME = 'mcp-gemini';
const SERVER_VERSION = '1.0.0';

//═══════════════════════════════════════════════════════════════════════════════
// Main Server
//═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`${ts()} 🚀 Starting ${SERVER_NAME}...`);

  // Initialize Gemini client (may be null if not configured)
  const geminiClient = await initializeGeminiClient();

  if (!geminiClient) {
    console.warn(`${ts()} ⚠️  Gemini not configured (no API key)`);
    console.warn(`${ts()}    Run: speedwave setup gemini`);
    console.warn(`${ts()}    Server will start but tools will return errors until configured.`);
  } else {
    console.log(`${ts()} ✅ Gemini client initialized`);
  }

  // Create MCP server with tool definitions from domain-tools
  const server = createMCPServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    port: PORT,
    host: '0.0.0.0', // inside container — must be reachable from Docker network
    tools: createToolDefinitions(geminiClient),
    healthCheck: async () => {
      if (!geminiClient?.isInitialized()) {
        throw new Error('Gemini client not initialized');
      }
    },
  });

  await server.start();
  console.log(`${ts()} ✅ ${SERVER_NAME} started on port ${PORT}`);
}

// Start server
main().catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
