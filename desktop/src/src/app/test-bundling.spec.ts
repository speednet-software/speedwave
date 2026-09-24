import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Parses the package.json at `path`.
 * @param path - Manifest file to read.
 */
function readManifest(path: string): { name?: string; type?: string } {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('unit-test bundling', () => {
  it('declares the desktop UI package as ES modules', ({ task }) => {
    const manifestPath = join(dirname(task.file.filepath), '..', '..', 'package.json');
    const manifest = readManifest(manifestPath);
    expect(manifest.name, `expected the desktop UI manifest at ${manifestPath}`).toBe(
      'speedwave-desktop-ui'
    );
    expect(manifest.type, `${manifestPath} needs "type": "module" so specs bundle as ESM`).toBe(
      'module'
    );
  });

  it('has no package.json under src that overrides the module type', ({ task }) => {
    const srcRoot = join(dirname(task.file.filepath), '..');
    const overriding = readdirSync(srcRoot, { recursive: true, encoding: 'utf-8' })
      .filter((entry) => basename(entry) === 'package.json')
      .filter((entry) => readManifest(join(srcRoot, entry)).type !== 'module');
    expect(overriding, `set "type": "module" in or remove: ${overriding.join(', ')}`).toEqual([]);
  });
});
