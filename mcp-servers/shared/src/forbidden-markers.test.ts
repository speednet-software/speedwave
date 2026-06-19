/**
 * Static guardrail — fails CI if a comment-style TODO/FIXME/HACK/XXX marker
 * reappears anywhere in mcp-servers source.
 *
 * The desktop guard (`forbidden-patterns.spec.ts`) only covers `desktop/src`;
 * a real TODO once slipped into `mcp-servers/hub/pii-tokenizer.ts` through that
 * gap. This scans every worker's `src/` tree. It matches ONLY markers inside a
 * line- or block-comment — string literals such as the `query: 'TODO'` tool-arg
 * examples in the github/gitlab tool files are data, not markers, and must not
 * trip it. Test files (`*.test.ts`) are excluded: they legitimately carry the
 * words as fixtures (and this very file embeds them in its exemptions).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

/** Markers that must never appear in a code comment. */
const MARKER = /\b(TODO|FIXME|HACK|XXX)\b/;

/** Directories never scanned (vendored / generated / out-of-tree). */
const EXCLUDED_DIRS: readonly string[] = ['node_modules', 'dist', 'coverage', 'out-tsc'];

/**
 * Walk up from this file to the `mcp-servers/` root. This file lives at
 * `mcp-servers/shared/src/forbidden-markers.test.ts`, so the root is the first
 * ancestor directory named `mcp-servers`. Anchoring on `import.meta.url` keeps
 * the scan stable under coverage rewriting (cf. the desktop guard's troubles
 * with `__dirname`).
 */
function findMcpServersRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    if (dir.split(/[\\/]/).pop() === 'mcp-servers') return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `forbidden-markers: could not locate the mcp-servers root from ${fileURLToPath(import.meta.url)}`
  );
}

const MCP_ROOT = findMcpServersRoot();

/**
 * Collect every non-test `.ts` file under any `src/` directory of MCP_ROOT.
 * @param dir - Absolute directory to walk.
 * @param inSrc - Whether `dir` is already inside a `src/` subtree.
 */
function walkTsSources(dir: string, inSrc: boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsSources(full, inSrc || entry === 'src'));
    } else if (inSrc && entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract only the comment portions of a TypeScript source so the marker scan
 * never sees code or string-literal contents. Handles `//` line comments,
 * `/* *​/` block comments, and skips over single-, double-, and template-quoted
 * strings (where a `//` or `/*` would not start a comment).
 * @param source - The file contents to strip down to its comments.
 */
function extractComments(source: string): string[] {
  const comments: string[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    // String literals — consume verbatim (their contents are not comments).
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Line comment — capture to end of line.
    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < n && source[j] !== '\n') j++;
      comments.push(source.slice(i + 2, j));
      i = j;
      continue;
    }
    // Block comment — capture to the closing delimiter.
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
      comments.push(source.slice(i + 2, j));
      i = j + 2;
      continue;
    }
    i++;
  }
  return comments;
}

/** Scan every source file and return `path:comment` for each marker found. */
function gatherMarkerViolations(): string[] {
  const violations: string[] = [];
  for (const file of walkTsSources(MCP_ROOT, false)) {
    const source = readFileSync(file, 'utf-8');
    for (const comment of extractComments(source)) {
      if (MARKER.test(comment)) {
        violations.push(`${relative(MCP_ROOT, file)}: ${comment.trim()}`);
      }
    }
  }
  return violations;
}

describe('forbidden-markers — mcp-servers comment scan', () => {
  it('locates the mcp-servers root and finds source files to scan', () => {
    // Guards the anchor: a broken root-finder scans nothing and hides markers.
    expect(walkTsSources(MCP_ROOT, false).length).toBeGreaterThan(0);
  });

  it('extracts comments but not string-literal contents', () => {
    // A marker word inside a string literal is data, not a marker comment.
    expect(extractComments(`const x = { query: 'TODO' };`)).toEqual([]);
    expect(extractComments(`foo(); // real TODO marker`)).toEqual([' real TODO marker']);
    expect(extractComments(`/* block FIXME */`)).toEqual([' block FIXME ']);
    // Only the trailing comment is extracted, not the string-literal marker.
    expect(extractComments(`const s = 'TODO'; // and HACK here`)).toEqual([' and HACK here']);
  });

  it('no comment-style TODO/FIXME/HACK/XXX marker in any mcp-servers source', () => {
    const violations = gatherMarkerViolations();
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
