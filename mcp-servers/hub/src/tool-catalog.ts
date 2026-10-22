/**
 * Raw tool catalog of a custom MCP server, written to `$AUDIT_DIR/tool-catalog-<service>.json` for Desktop to review
 * (untrusted text there; Desktop recomputes definition hashes itself).
 * @module tool-catalog
 */

import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { META_KEYS, ts, type Tool } from '@speedwave/mcp-shared';

/** Catalog schema version. */
export const TOOL_CATALOG_SCHEMA = 1;

/** Upper bound on one catalog file, in bytes; a larger catalog is skipped. */
export const MAX_TOOL_CATALOG_BYTES = 1024 * 1024;

const SERVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Catalog file name for a service.
 * @param service - Hub service id.
 */
export function toolCatalogFileName(service: string): string {
  return `tool-catalog-${service}.json`;
}

/**
 * A `_meta` string value, or null.
 * @param tool - Worker tool.
 * @param key - Prefixed `_meta` key.
 */
function metaString(tool: Tool, key: string): string | null {
  const value = tool._meta?.[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Build the catalog document for a raw worker `tools/list`.
 * @param service - Hub service id.
 * @param tools - Tools exactly as the worker listed them.
 */
export function buildToolCatalog(service: string, tools: readonly Tool[]): Record<string, unknown> {
  return {
    schema: TOOL_CATALOG_SCHEMA,
    service,
    written_at: new Date().toISOString(),
    tools: tools.map((tool) => ({
      name: tool.name,
      upstream_name: metaString(tool, META_KEYS.UPSTREAM_NAME),
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? null,
      annotations: tool.annotations ?? null,
      outputSchema: tool.outputSchema ?? null,
      state: metaString(tool, META_KEYS.TOOL_STATE),
    })),
  };
}

/**
 * Write a service's raw catalog atomically (tmp + fsync + rename, 0o600); no-op without `AUDIT_DIR` or tools, skipped above {@link MAX_TOOL_CATALOG_BYTES}. Never throws.
 * @param service - Hub service id.
 * @param tools - Tools exactly as the worker listed them.
 */
export function writeToolCatalog(service: string, tools: readonly Tool[]): void {
  const auditDir = process.env.AUDIT_DIR;
  if (!auditDir || tools.length === 0) return;
  if (!SERVICE_ID_RE.test(service)) {
    console.warn(`${ts()} [tool-catalog] refusing a catalog for an invalid service id`);
    return;
  }
  const body = JSON.stringify(buildToolCatalog(service, tools));
  const size = Buffer.byteLength(body, 'utf8');
  if (size > MAX_TOOL_CATALOG_BYTES) {
    console.warn(
      `${ts()} [tool-catalog] ${service}: catalog is ${size} bytes, above ${MAX_TOOL_CATALOG_BYTES}; not written`
    );
    return;
  }
  const target = join(auditDir, toolCatalogFileName(service));
  const tmp = join(
    auditDir,
    `.${toolCatalogFileName(service)}.tmp.${randomBytes(6).toString('hex')}`
  );
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    console.warn(
      `${ts()} [tool-catalog] ${service}: catalog not written: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
