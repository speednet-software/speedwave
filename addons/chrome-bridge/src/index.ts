import { readFileSync } from 'node:fs';
import { BridgeClient } from './bridge.js';
import { createMCPServer, ts } from './server/index.js';
import { createToolDefinitions } from './tools.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const AUTH_TOKEN = process.env.MCP_CHROME_AUTH_TOKEN;
const SERVER_NAME = 'mcp-chrome';
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

async function main(): Promise<void> {
  const bridge = new BridgeClient(process.env.CHROME_BRIDGE_URL, process.env.CHROME_BRIDGE_TOKEN);
  const tools = createToolDefinitions(bridge);
  console.log(
    `${ts()} Starting ${SERVER_NAME} v${SERVER_VERSION}, ${tools.length} tools, bridge ${process.env.CHROME_BRIDGE_URL ? 'configured' : 'not configured'}`
  );
  const server = createMCPServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    port: PORT,
    host: HOST,
    tools,
    ...(AUTH_TOKEN ? { auth: { token: AUTH_TOKEN, publicPaths: ['/health'] } } : {}),
  });
  await server.start();
}

main().catch((error: unknown) => {
  console.error(`${ts()} Fatal error during boot:`, error);
  process.exit(1);
});
