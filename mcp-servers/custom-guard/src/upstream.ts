/**
 * Upstream connection of the guard: a fixed launcher endpoint (npm mode) or the Desktop relay endpoint re-read from its mount on every request (host mode).
 * @module custom-guard/upstream
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpClient, validateWorkerUrl, type McpClientOptions } from '@speedwave/mcp-shared';

/** Builds an MCP client for an endpoint (tests inject a custom one). */
export type ClientFactory = (options: McpClientOptions) => McpClient;

/** Outcome of resolving the upstream for one request. */
export type UpstreamResolution =
  { ok: true; client: McpClient } | { ok: false; reason: 'relay-unavailable' };

/** Resolves the upstream client for each request. */
export interface UpstreamSource {
  /** The client to use now, or why there is none. */
  resolve(): UpstreamResolution;
}

/** Relay endpoint file name inside the relay directory. */
export const ENDPOINT_FILE = 'endpoint.json';

/** Relay bearer file name inside the relay directory. */
export const TOKEN_FILE = 'token';

const MAX_RELAY_FILE_BYTES = 4096;
const RELAY_TOKEN_RE = /^[\x21-\x7e]{16,512}$/;
const CLIENT_INFO = { name: 'speedwave-custom-guard', version: '1.0.0' };

/**
 * The default client factory.
 * @param options - Client options.
 */
export function defaultClientFactory(options: McpClientOptions): McpClient {
  return new McpClient(options);
}

/**
 * A fixed upstream (npm mode): the launcher URL and bearer never change for the container's lifetime.
 * @param url - Launcher URL.
 * @param authToken - Launcher bearer.
 * @param factory - Client factory.
 */
export function createFixedUpstream(
  url: string,
  authToken: string,
  factory: ClientFactory = defaultClientFactory
): UpstreamSource {
  const client = factory({ url, authToken, clientInfo: CLIENT_INFO });
  return { resolve: () => ({ ok: true, client }) };
}

/**
 * Read a small relay file, or null when it is missing, oversized or unreadable.
 * @param path - File path.
 */
function readSmallFile(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8');
    return Buffer.byteLength(text, 'utf8') <= MAX_RELAY_FILE_BYTES ? text : null;
  } catch {
    return null;
  }
}

/**
 * Parse `endpoint.json`: the relay URL when it is valid and marked available, otherwise null.
 * @param text - File contents.
 */
export function parseRelayEndpoint(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { url, available } = parsed as Record<string, unknown>;
  if (available !== true || typeof url !== 'string' || !validateWorkerUrl(url)) return null;
  return url;
}

/**
 * The Desktop relay as upstream (host mode): `endpoint.json` and `token` are re-read on every request, and the client is rebuilt only when either changes.
 * @param relayDir - Mounted relay directory.
 * @param factory - Client factory.
 */
export function createRelayUpstream(
  relayDir: string,
  factory: ClientFactory = defaultClientFactory
): UpstreamSource {
  let cached: { key: string; client: McpClient } | null = null;
  return {
    resolve() {
      const endpoint = readSmallFile(join(relayDir, ENDPOINT_FILE));
      const url = endpoint === null ? null : parseRelayEndpoint(endpoint);
      const token = readSmallFile(join(relayDir, TOKEN_FILE))?.trim() ?? '';
      if (url === null || !RELAY_TOKEN_RE.test(token)) {
        return { ok: false, reason: 'relay-unavailable' };
      }
      const key = `${url}\n${token}`;
      if (cached?.key !== key) {
        cached = { key, client: factory({ url, authToken: token, clientInfo: CLIENT_INFO }) };
      }
      return { ok: true, client: cached.client };
    },
  };
}
