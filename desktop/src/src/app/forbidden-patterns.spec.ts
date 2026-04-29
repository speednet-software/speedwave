/**
 * Static guardrail — fails CI if any forbidden pattern reappears in src/.
 *
 * The patterns below represent legacy Angular or TypeScript idioms that
 * the project has phased out. Keeping this spec prevents regressions.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

interface ForbiddenPattern {
  readonly label: string;
  readonly regex: RegExp;
  readonly extensions: readonly string[];
  readonly ignoreFiles?: readonly string[];
  /** Lines matching any of these substrings are exempt (e.g. test fixtures). */
  readonly lineExemptions?: readonly string[];
}

/**
 * Locate the `desktop/src/src` source root.
 *
 * Using `__dirname + '..'` is unreliable: under `ng test --coverage` the
 * test bundle is rewritten such that `__dirname` resolves one or two
 * levels higher than expected (`desktop/src/` or even `desktop/`). A naive
 * walker then descends into `node_modules/@angular/`, `e2e/helpers/`, or
 * `src-tauri/build-context/mcp-servers/` which contain forbidden patterns
 * in their docstrings.
 *
 * The recovery walks upward until we find a directory containing both
 * this spec at the canonical relative path AND the `services/` directory
 * — the combination is unique to `desktop/src/src`. If no such directory
 * is found within ten levels we panic rather than scan a wrong tree.
 */
function findSrcRoot(): string {
  // Try several candidate roots starting from __dirname and walking upward.
  // Under coverage, __dirname can resolve to `desktop/src/src/app`,
  // `desktop/src/src`, or `desktop/src` depending on bundling. The
  // canonical root is `desktop/src/src`, identified by containing both
  // this spec under `app/` and the `app/services/` directory.
  const candidates: string[] = [];
  let dir = __dirname;
  for (let depth = 0; depth < 6; depth++) {
    candidates.push(dir);
    candidates.push(join(dir, 'src')); // when __dirname == desktop/src
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
  throw new Error(
    `forbidden-patterns: could not locate desktop/src/src starting from ${__dirname}`
  );
}

const SRC_ROOT = findSrcRoot();
/**
 * Directory names skipped during the recursive scan. `node_modules` is the
 * obvious one; `e2e`, `src-tauri`, and `coverage` show up because some
 * `__dirname` resolutions under coverage walk land above the canonical
 * `src` root, and those siblings contain forbidden patterns in code we
 * don't own (Playwright fixtures, vendored MCP servers under
 * `build-context/`).
 */
const EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  'coverage',
  'dist',
  'out-tsc',
  'e2e',
  'src-tauri',
];

/**
 * Recursively walks a directory, returning absolute paths of every file whose
 * extension matches one of the supplied suffixes.
 * @param dir - The absolute directory path to start walking from.
 * @param extensions - File suffixes (e.g. `.ts`, `.html`) to include.
 */
function walk(dir: string, extensions: readonly string[]): string[] {
  const entries = readdirSync(dir);
  const out: string[] = [];
  for (const entry of entries) {
    if (EXCLUDED_DIRS.includes(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full, extensions));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN: readonly ForbiddenPattern[] = [
  {
    label: 'structural directive *ngIf/*ngFor/*ngSwitch (use @if/@for/@switch)',
    regex: /\*ng(If|For|Switch)\b/,
    extensions: ['.ts', '.html'],
    ignoreFiles: ['forbidden-patterns.spec.ts'],
  },
  {
    label: '[ngClass]/[ngStyle] (use [class.foo]="..." / [style.foo]="...")',
    regex: /\[ngClass\]|\[ngStyle\]/,
    extensions: ['.ts', '.html'],
    ignoreFiles: ['forbidden-patterns.spec.ts'],
  },
  {
    label: ': any / as any (use proper TypeScript types)',
    regex: /(:\s*any\b|\bas\s+any\b)/,
    extensions: ['.ts'],
    ignoreFiles: ['forbidden-patterns.spec.ts'],
  },
  {
    label: '.mutate( on signals (signal.mutate was removed in Angular 19)',
    regex: /\.mutate\s*\(/,
    extensions: ['.ts'],
    ignoreFiles: ['forbidden-patterns.spec.ts'],
  },
  {
    label: 'TODO/FIXME/HACK/XXX marker comment',
    // Match only as a standalone word in comments or JSDoc, not inside strings
    // used as test fixtures. `lineExemptions` filter any accidental matches.
    regex: /\b(TODO|FIXME|HACK|XXX)\b/,
    extensions: ['.ts', '.html', '.css'],
    ignoreFiles: ['forbidden-patterns.spec.ts'],
    lineExemptions: [
      // Test-only strings containing the word as data
      'input_json: \'{"pattern":"TODO"}\'',
      "expect(component.headerSummary).toBe('TODO')",
      'service.normalize(\'Grep\', \'{"pattern":"TODO"',
      "expect(result).toEqual({ kind: 'grep', pattern: 'TODO'",
      // The Grep tool fixture used in tool-block tests echoes the user's
      // search pattern; "TODO" here is data, not a marker.
      'input_json: \'{"pattern":"TODO","include":"*.rs"}\'',
      "expect(el.querySelector('[data-testid=\"pattern\"]')?.textContent?.trim()).toBe('TODO')",
    ],
  },
  {
    label: '@deprecated JSDoc/TSDoc (rewrite the code instead)',
    regex: /@deprecated\b/,
    extensions: ['.ts'],
    ignoreFiles: ['forbidden-patterns.spec.ts'],
  },
];

/**
 * Scans every source file under SRC_ROOT and returns lines that match the
 * forbidden pattern (subject to per-pattern file and line exemptions).
 * @param pattern - The forbidden-pattern descriptor to enforce.
 */
function gatherViolations(pattern: ForbiddenPattern): string[] {
  const files = walk(SRC_ROOT, pattern.extensions);
  const violations: string[] = [];
  for (const file of files) {
    const name = file.split('/').pop() ?? file;
    if (pattern.ignoreFiles?.includes(name)) continue;
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!pattern.regex.test(line)) continue;
      if (pattern.lineExemptions?.some((ex) => line.includes(ex))) continue;
      violations.push(`${relative(SRC_ROOT, file)}:${i + 1}: ${line.trim()}`);
    }
  }
  return violations;
}

describe('forbidden-patterns — static-analysis guardrail', () => {
  for (const pattern of FORBIDDEN) {
    it(`no occurrences of: ${pattern.label}`, () => {
      const violations = gatherViolations(pattern);
      expect(violations, violations.join('\n')).toEqual([]);
    });
  }
});
