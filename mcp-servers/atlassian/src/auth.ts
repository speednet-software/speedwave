/**
 * Atlassian worker credential loading from the read-only `/tokens` mount.
 *
 * Credential layout (one file per field, perms `0o600`, mounted `:ro`):
 * - `/tokens/site_url`               — required, e.g. `https://acme.atlassian.net`
 * - `/tokens/email`                  — required (Basic-auth username)
 * - `/tokens/api_token`              — required (Basic-auth password) — never logged
 * - `/tokens/jira_project_keys`      — optional allowlist, comma-separated; empty/missing = unrestricted
 * - `/tokens/confluence_space_keys`  — optional allowlist, comma-separated; empty/missing = unrestricted
 * @module mcp-atlassian/auth
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ts, withSetupGuidance } from '@speedwave/mcp-shared';
import type { AtlassianConfig } from './types.js';

/** Directory the orchestrator mounts service credentials into (read-only). */
const TOKENS_DIR = process.env.TOKENS_DIR || '/tokens';

/** Required credential file names. */
const REQUIRED_FILES = ['site_url', 'email', 'api_token'] as const;

/**
 * Read and trim a required credential file. Returns `null` (with a guidance log)
 * if the file is missing or empty — the worker then starts in "not configured"
 * mode rather than crashing.
 * @param name - File name under {@link TOKENS_DIR}.
 * @returns Trimmed contents, or `null` if missing/empty.
 */
async function readRequired(name: string): Promise<string | null> {
  try {
    const value = (await fs.readFile(path.join(TOKENS_DIR, name), 'utf-8')).trim();
    if (!value) {
      console.warn(`${ts()} ${withSetupGuidance(`Atlassian credential '${name}' is empty.`)}`);
      return null;
    }
    return value;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      console.warn(
        `${ts()} ${withSetupGuidance(`Atlassian credential '${name}' is not configured.`)}`
      );
    } else {
      console.warn(`${ts()} Failed to read Atlassian credential '${name}': ${error}`);
    }
    return null;
  }
}

/**
 * Read an optional allowlist file (comma- or whitespace-separated). Missing file
 * or empty contents yield an empty list (= unrestricted).
 * @param name - File name under {@link TOKENS_DIR}.
 * @returns Deduplicated, trimmed, upper-cased keys (Atlassian keys are upper-case).
 */
async function readAllowlist(name: string): Promise<string[]> {
  try {
    const raw = (await fs.readFile(path.join(TOKENS_DIR, name), 'utf-8')).trim();
    if (!raw) return [];
    const keys = raw
      .split(/[\s,]+/)
      .map((k) => k.trim().toUpperCase())
      .filter((k) => k.length > 0);
    return [...new Set(keys)];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn(`${ts()} Failed to read Atlassian allowlist '${name}': ${error}`);
    }
    return [];
  }
}

/**
 * Validate and normalise the site URL: must be `https://`, host must end in
 * `.atlassian.net` (Atlassian Cloud only — Server/Data Center is not supported),
 * no path/query/fragment. Returns the normalised `https://host` form, or `null`
 * if invalid.
 * @param raw - Raw `site_url` credential value.
 * @returns Normalised origin, or `null` if invalid.
 */
export function normalizeSiteUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.atlassian.net')) return null;
  // Reject embedded credentials / non-default ports / paths to avoid surprises.
  // (The WHATWG URL parser always sets `pathname` to at least `/` for https:.)
  if (url.username || url.password || (url.port && url.port !== '443')) return null;
  if (url.pathname !== '/') return null;
  return `https://${host}`;
}

/**
 * Load the full Atlassian worker configuration from `/tokens`.
 * @returns Resolved config, or `null` if any required credential is missing/invalid.
 */
export async function readCredentials(): Promise<AtlassianConfig | null> {
  const [siteUrlRaw, email, apiToken] = await Promise.all(REQUIRED_FILES.map(readRequired));
  if (!siteUrlRaw || !email || !apiToken) return null;

  const siteUrl = normalizeSiteUrl(siteUrlRaw);
  if (!siteUrl) {
    console.warn(
      `${ts()} ${withSetupGuidance(
        `Atlassian 'site_url' must be an https://*.atlassian.net URL (got: ${siteUrlRaw}).`
      )}`
    );
    return null;
  }

  const [jiraProjectKeys, confluenceSpaceKeys] = await Promise.all([
    readAllowlist('jira_project_keys'),
    readAllowlist('confluence_space_keys'),
  ]);

  return { siteUrl, email, apiToken, jiraProjectKeys, confluenceSpaceKeys };
}
