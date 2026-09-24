/** Test-only helper: locates the `desktop/src/src` source root from a spec file. */
import { join, resolve } from 'node:path';
import { statSync } from 'node:fs';

/**
 * Walks up from `startDir` until it finds the source root, handling __dirname variance under coverage.
 * @param startDir - Directory to start the upward search from (defaults to this file's directory).
 * @returns Absolute path of `desktop/src/src`.
 * @throws When no ancestor within six levels carries the source-root markers.
 */
export function findSrcRoot(startDir: string = __dirname): string {
  const candidates: string[] = [];
  let dir = startDir;
  for (let depth = 0; depth < 6; depth++) {
    candidates.push(dir);
    candidates.push(join(dir, 'src')); // when startDir == desktop/src
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    try {
      const markerSpec = join(candidate, 'app', 'forbidden-patterns.spec.ts');
      const markerSvc = join(candidate, 'app', 'services');
      if (statSync(markerSpec).isFile() && statSync(markerSvc).isDirectory()) {
        return candidate;
      }
    } catch {
      // missing path — try the next candidate.
    }
  }
  throw new Error(`findSrcRoot: could not locate desktop/src/src starting from ${startDir}`);
}
