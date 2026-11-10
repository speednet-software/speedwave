/**
 * Access rules: startup read of `access.json`, the sibling of `POLICY_FILE`.
 * @module access-config
 *
 * Absent `POLICY_FILE` or an absent file means every service is `full`. A present file that
 * cannot be read or fails validation throws; `index.ts` is the single process-death point, so this
 * module never calls `process.exit`. The validation mirrors `crates/access-policy` (`parse_access_file`).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Access mode of a service. */
export type AccessMode = 'full' | 'read_only';

/** The composed access rules of a project. */
export interface AccessRules {
  default: AccessMode;
  services: Record<string, AccessMode>;
}

const ACCESS_FILE = 'access.json';
const ACCESS_FILE_VERSION = 1;
const MAX_ACCESS_FILE_BYTES = 65_536;
const MAX_SERVICES = 256;
const SERVICE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const KEYS = new Set(['version', 'default', 'services']);

const ALL_FULL: AccessRules = { default: 'full', services: {} };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMode(value: unknown, what: string): AccessMode {
  if (value === 'full' || value === 'read_only') return value;
  throw new Error(`${what} must be "full" or "read_only"`);
}

/**
 * Parse and validate the content of `access.json`.
 * @param text - File content
 * @returns The access rules
 */
export function parseAccessRules(text: string): AccessRules {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_ACCESS_FILE_BYTES) {
    throw new Error(`access file is ${bytes} bytes, limit is ${MAX_ACCESS_FILE_BYTES}`);
  }
  const file: unknown = JSON.parse(text);
  if (!isObject(file)) throw new Error('access file must be an object');
  for (const key of Object.keys(file)) {
    if (!KEYS.has(key)) throw new Error(`unknown key "${key}" in access file`);
  }
  if (file.version !== ACCESS_FILE_VERSION) {
    throw new Error(`unsupported access file version, expected ${ACCESS_FILE_VERSION}`);
  }
  const defaultMode = file.default === undefined ? 'full' : toMode(file.default, 'default');
  const entries = file.services === undefined ? {} : file.services;
  if (!isObject(entries)) throw new Error('services must be an object');
  const ids = Object.keys(entries);
  if (ids.length > MAX_SERVICES) {
    throw new Error(`too many access services: ${ids.length} exceeds limit of ${MAX_SERVICES}`);
  }
  const services: Record<string, AccessMode> = {};
  for (const id of ids) {
    if (!SERVICE_ID.test(id)) throw new Error(`invalid access service id "${id}"`);
    services[id] = toMode(entries[id], `mode of "${id}"`);
  }
  return { default: defaultMode, services };
}

function readAccessFile(path: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Load the access rules next to `POLICY_FILE`.
 * @param env - Environment to read `POLICY_FILE` from
 * @returns The access rules; every service `full` when there is no file
 */
export function loadAccessRules(
  env: Record<string, string | undefined> = process.env
): AccessRules {
  const policyFile = env.POLICY_FILE;
  if (!policyFile) return ALL_FULL;
  const path = join(dirname(policyFile), ACCESS_FILE);
  try {
    const text = readAccessFile(path);
    return text === undefined ? ALL_FULL : parseAccessRules(text);
  } catch (e) {
    throw new Error(
      `Access config ${path} is invalid: ${e instanceof Error ? e.message : String(e)}`,
      {
        cause: e,
      }
    );
  }
}

let rules: AccessRules | undefined;

/** Load the access rules for this process at server startup; throws when the file is invalid. */
export function loadAccess(): void {
  rules = loadAccessRules();
}

/**
 * The access rules in effect for this process, loaded from `access.json` if `loadAccess()` has not run.
 * @returns The access rules
 */
export function getAccessRules(): AccessRules {
  rules ??= loadAccessRules();
  return rules;
}
