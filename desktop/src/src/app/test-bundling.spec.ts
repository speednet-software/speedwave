import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// esbuild takes the module format of an export-less file (every spec) from the nearest package.json;
// `"type": "commonjs"` wraps the spec in a closure, so Vitest finds its `vi.mock` calls nested.

/**
 * Reads the nearest package.json at or above `dir`, the manifest esbuild consults for module type.
 * @param dir - Directory the lookup starts from.
 */
function nearestPackageManifest(dir: string): { name?: string; type?: string } {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, 'package.json');
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf-8'));
    }
    if (dirname(current) === current) {
      throw new Error(`test-bundling: no package.json at or above ${dir}`);
    }
  }
}

describe('unit-test bundling', () => {
  const manifest = nearestPackageManifest(__dirname);

  it('resolves the desktop UI package manifest', () => {
    expect(manifest.name).toBe('speedwave-desktop-ui');
  });

  it('keeps spec files ES modules by not declaring the package CommonJS', () => {
    expect(manifest.type).not.toBe('commonjs');
  });
});
