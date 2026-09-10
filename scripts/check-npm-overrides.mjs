#!/usr/bin/env node
// Guards npm `overrides` blocks: npm silently rewrites a dependent's declared
// range, so a forced version outside it is invisible to `npm ls`. See alignments.md.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const RANGE_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', '.git', '.angular', 'build']);
const SELF = fileURLToPath(import.meta.url);

/**
 * Deliberate overrides that force a version a dependent refuses, keyed
 * `<package.json path>::<override key>`. Each value states why.
 * @type {Record<string, string>}
 */
const DELIBERATE_FORCES = {
  'desktop/e2e/package.json::@puppeteer/browsers':
    'Keeps extract-zip (GHSA-7pqw-9j4j-h8q3, no patched release) out of the rig tree; @wdio/utils declares ^2.2.0, which re-adds it. See e2e-rigs.md.',
  'desktop/e2e/package.json::serialize-javascript':
    'mocha declares ^6.0.2; 7.x is the line that carries the XSS fix.',
};

/**
 * semver ships inside npm, so this needs no project node_modules.
 * @returns {{satisfies: Function, subset: Function}}
 */
function loadSemver() {
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return createRequire(SELF)(join(globalRoot, 'npm', 'node_modules', 'semver'));
}

/**
 * @param {string} dir directory to walk
 * @param {string[]} out accumulator
 * @returns {string[]} every package.json path under dir, skipping build trees
 */
function findManifests(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findManifests(join(dir, entry.name), out);
    } else if (entry.name === 'package.json') {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * @param {object} lock parsed package-lock.json
 * @param {string} key override key
 * @returns {{versions: string[], dependents: {path: string, field: string, range: string}[]}}
 */
function inspectLock(lock, key) {
  const versions = [];
  const dependents = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === `node_modules/${key}` || path.endsWith(`/node_modules/${key}`)) {
      if (entry.version) versions.push(entry.version);
    }
    for (const field of RANGE_FIELDS) {
      const range = entry[field]?.[key];
      if (range) dependents.push({ path: path || '<root>', field, range });
    }
  }
  return { versions, dependents };
}

const repoRoot = process.argv[2] ?? join(dirname(SELF), '..');
const allowlist = process.env.SPW_OVERRIDES_ALLOWLIST_JSON
  ? JSON.parse(process.env.SPW_OVERRIDES_ALLOWLIST_JSON)
  : DELIBERATE_FORCES;
const semver = loadSemver();
const failures = [];
const seenAllowKeys = new Set();

for (const manifestPath of findManifests(repoRoot)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.overrides || Object.keys(manifest.overrides).length === 0) continue;

  const rel = relative(repoRoot, manifestPath);
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(dirname(manifestPath), 'package-lock.json'), 'utf8'));
  } catch {
    failures.push(`${rel}: declares overrides but has no readable package-lock.json to verify them against`);
    continue;
  }

  for (const [key, spec] of Object.entries(manifest.overrides)) {
    const allowKey = `${rel}::${key}`;
    if (typeof spec !== 'string') {
      failures.push(`${allowKey}: nested override objects are not analyzed by this guard — flatten it or extend the guard`);
      continue;
    }

    const { versions, dependents } = inspectLock(lock, key);
    if (dependents.length === 0) {
      failures.push(`${allowKey}: nothing in the lockfile depends on "${key}" — the override is dead config, delete it`);
      continue;
    }

    if (allowKey in allowlist) {
      seenAllowKeys.add(allowKey);
      const stillForcing = dependents.some((d) => !versions.some((v) => semver.satisfies(v, d.range)));
      if (!stillForcing) {
        failures.push(
          `${allowKey}: every dependent already accepts the resolved version (${versions.join(', ')}) — the force is redundant, delete the override and its allowlist entry`,
        );
      }
      continue;
    }

    for (const d of dependents) {
      if (!semver.subset(spec, d.range)) {
        failures.push(
          `${allowKey}: override "${spec}" is not a subset of ${d.path}'s declared ${d.field} range "${d.range}", so it can resolve a version that dependent refuses. Narrow the override, or add it to DELIBERATE_FORCES in scripts/check-npm-overrides.mjs with the reason.`,
        );
      }
    }
  }
}

for (const allowKey of Object.keys(allowlist)) {
  if (!seenAllowKeys.has(allowKey)) {
    failures.push(`${allowKey}: allowlisted in DELIBERATE_FORCES but no such override exists — remove the stale entry`);
  }
}

if (failures.length > 0) {
  console.error('npm overrides guard failed:\n');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('npm overrides guard: all overrides are narrowing or justified');
