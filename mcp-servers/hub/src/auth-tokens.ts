/**
 * Reads per-service tokens from /secrets/<service>-auth-token (bind-mounted by compose.rs).
 * Used by http-bridge.ts for Authorization headers on workers requiring auth (e.g. mcp-os).
 */

import { readFileSync, existsSync } from 'fs';
import { getAllServiceNames } from './service-list.js';
import { ts } from '@speedwave/mcp-shared';

const AUTH_TOKENS: Map<string, string> = new Map();

/** Load auth tokens from /secrets/<service>-auth-token files. Called once at server startup. */
export function loadAuthTokens(): void {
  for (const service of getAllServiceNames()) {
    const path = `/secrets/${service}-auth-token`;
    if (existsSync(path)) {
      try {
        const token = readFileSync(path, 'utf8').trim();
        if (token) {
          AUTH_TOKENS.set(service, token);
          console.log(`${ts()} [auth-tokens] Loaded auth token for ${service}`);
        }
      } catch (err) {
        console.warn(`${ts()} [auth-tokens] Could not read token for ${service}: ${err}`);
      }
    }
  }

  const count = AUTH_TOKENS.size;
  if (count > 0) {
    console.log(`${ts()} [auth-tokens] ${count} service auth token(s) loaded`);
  }
}

/**
 * Get auth token for a service; returns undefined if none is configured.
 * @param service - Service name.
 */
export function getAuthToken(service: string): string | undefined {
  return AUTH_TOKENS.get(service);
}

/**
 * True if a service has an auth token configured.
 * @param service - Service name.
 */
export function hasAuthToken(service: string): boolean {
  return AUTH_TOKENS.has(service);
}

/** Clear all loaded auth tokens (for testing only). */
export function clearAuthTokens(): void {
  AUTH_TOKENS.clear();
}
