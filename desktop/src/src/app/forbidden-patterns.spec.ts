import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

interface ForbiddenPattern {
  readonly label: string;
  readonly regex: RegExp;
  readonly extensions: readonly string[];
  readonly ignoreFiles?: readonly string[];
  readonly lineExemptions?: readonly string[];
}

function findSrcRoot(): string {
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
    } catch {
      // missing path — try the next candidate.
    }
  }
  throw new Error(
    `forbidden-patterns: could not locate desktop/src/src starting from ${__dirname}`
  );
}

const SRC_ROOT = findSrcRoot();
const EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  'coverage',
  'dist',
  'out-tsc',
  'e2e',
  'src-tauri',
];

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
    regex: /\b(TODO|FIXME|HACK|XXX)\b/,
    extensions: ['.ts', '.html', '.css'],
    ignoreFiles: ['forbidden-patterns.spec.ts'],
    lineExemptions: [
      'input_json: \'{"pattern":"TODO"}\'',
      "expect(component.headerSummary).toBe('TODO')",
      'service.normalize(\'Grep\', \'{"pattern":"TODO"',
      "expect(result).toEqual({ kind: 'grep', pattern: 'TODO'",
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
  {
    label:
      'Save is allowed, but chat will fail (SPEED-555: a missing Messages API now blocks Save)',
    regex: /Save is allowed, but chat/,
    extensions: ['.ts'],
    ignoreFiles: ['forbidden-patterns.spec.ts'],
  },
];

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
