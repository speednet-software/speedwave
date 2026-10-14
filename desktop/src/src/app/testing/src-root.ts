import { join, resolve } from 'node:path';
import { statSync } from 'node:fs';

/**
 * Walks up from this file's own directory until it finds the source root, handling
 * __dirname variance under coverage.
 * @returns Absolute path of `desktop/src/src`.
 * @throws When no ancestor within six levels carries the source-root markers.
 */
export function findSrcRoot(): string {
  const candidates: string[] = [];
  let dir = __dirname;
  for (let depth = 0; depth < 6; depth++) {
    candidates.push(dir);
    candidates.push(join(dir, 'src'));
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
    } catch {}
  }
  throw new Error(`findSrcRoot: could not locate desktop/src/src starting from ${__dirname}`);
}
