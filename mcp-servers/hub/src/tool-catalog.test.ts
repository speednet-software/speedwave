import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { META_KEYS, type Tool } from '@speedwave/mcp-shared';
import {
  buildToolCatalog,
  MAX_TOOL_CATALOG_BYTES,
  TOOL_CATALOG_SCHEMA,
  toolCatalogFileName,
  writeToolCatalog,
} from './tool-catalog.js';

let dir: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

const pending: Tool = {
  name: 'post_comment',
  description: 'Add a comment',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  annotations: { destructiveHint: false },
  outputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  _meta: {
    [META_KEYS.TOOL_STATE]: 'pending',
    [META_KEYS.UPSTREAM_NAME]: 'post.comment',
  },
};
const bare = {
  name: 'get_file',
  inputSchema: { type: 'object', properties: {} },
} as unknown as Tool;

function auditDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'hub-catalog-'));
  vi.stubEnv('AUDIT_DIR', dir);
  return dir;
}

describe('buildToolCatalog', () => {
  it('records each tool as the worker listed it, with gate state, upstream name and output schema', () => {
    const catalog = buildToolCatalog('custom-figma', [pending, bare]);
    expect(catalog.schema).toBe(TOOL_CATALOG_SCHEMA);
    expect(catalog.service).toBe('custom-figma');
    expect(typeof catalog.written_at).toBe('string');
    expect(catalog.tools).toEqual([
      {
        name: 'post_comment',
        upstream_name: 'post.comment',
        description: 'Add a comment',
        inputSchema: pending.inputSchema,
        annotations: { destructiveHint: false },
        outputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        state: 'pending',
      },
      {
        name: 'get_file',
        upstream_name: null,
        description: '',
        inputSchema: { type: 'object', properties: {} },
        annotations: null,
        outputSchema: null,
        state: null,
      },
    ]);
  });
});

describe('writeToolCatalog', () => {
  it('writes the catalog atomically, owner-only, without leftovers', () => {
    const root = auditDir();
    writeToolCatalog('custom-figma', [pending]);
    const file = join(root, toolCatalogFileName('custom-figma'));
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    expect(parsed.tools[0].state).toBe('pending');
    expect(readdirSync(root)).toEqual(['tool-catalog-custom-figma.json']);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('replaces a previous catalog', () => {
    const root = auditDir();
    writeToolCatalog('custom-figma', [pending]);
    writeToolCatalog('custom-figma', [bare]);
    const parsed = JSON.parse(readFileSync(join(root, 'tool-catalog-custom-figma.json'), 'utf-8'));
    expect(parsed.tools.map((t: { name: string }) => t.name)).toEqual(['get_file']);
  });

  it('is a no-op without AUDIT_DIR', () => {
    vi.stubEnv('AUDIT_DIR', undefined);
    expect(() => writeToolCatalog('custom-figma', [pending])).not.toThrow();
  });

  it('keeps the last catalog when discovery returned no tools', () => {
    const root = auditDir();
    writeToolCatalog('custom-figma', [pending]);
    writeToolCatalog('custom-figma', []);
    const parsed = JSON.parse(readFileSync(join(root, 'tool-catalog-custom-figma.json'), 'utf-8'));
    expect(parsed.tools).toHaveLength(1);
  });

  it('skips and warns when the catalog is above the size cap', () => {
    const root = auditDir();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const huge: Tool = { ...pending, description: 'x'.repeat(MAX_TOOL_CATALOG_BYTES) };
    writeToolCatalog('custom-figma', [huge]);
    expect(readdirSync(root)).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toContain('not written');
  });

  it('counts output schemas toward the size cap', () => {
    const root = auditDir();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const huge: Tool = {
      ...pending,
      outputSchema: { type: 'object', description: 'x'.repeat(MAX_TOOL_CATALOG_BYTES) },
    };
    writeToolCatalog('custom-figma', [huge]);
    expect(readdirSync(root)).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toContain('not written');
  });

  it.each(['../evil', 'Custom-X', 'custom/x', '', 'a'.repeat(65)])(
    'refuses the service id %j as a file name',
    (service) => {
      const root = auditDir();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeToolCatalog(service, [pending]);
      expect(readdirSync(root)).toEqual([]);
      expect(warn).toHaveBeenCalled();
    }
  );

  it('warns and cleans up instead of throwing when the directory is unusable', () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-catalog-'));
    dir = root;
    const notADir = join(root, 'file');
    writeFileSync(notADir, 'x');
    vi.stubEnv('AUDIT_DIR', notADir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => writeToolCatalog('custom-figma', [pending])).not.toThrow();
    expect(String(warn.mock.calls[0][0])).toContain('catalog not written');
    expect(readdirSync(root)).toEqual(['file']);
  });
});
