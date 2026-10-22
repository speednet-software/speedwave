/**
 * Guard policy: parse `policy.json`, re-read it on every request, keep the last good copy when a newer one is invalid, deny everything once the file is gone.
 * @module custom-guard/policy
 */

import { readFileSync, statSync } from 'node:fs';
import { parseToolGatePolicy, ts, type ToolGatePolicy } from '@speedwave/mcp-shared';
import type { GuardMode } from './config.js';

/** Hub timeout class a policy may assign to a tool. */
export type GuardTimeoutClass = 'standard' | 'long';

/** Guard-only settings of one tool, keyed by upstream name. */
export interface GuardToolOptions {
  /** Approved upstream definition (`name` = upstream name), served while the upstream is unreachable. */
  definition?: Record<string, unknown>;
  /** Hub defer-loading flag for the tool (default true). */
  deferLoading?: boolean;
  /** Hub timeout class for the tool (default standard). */
  timeoutClass?: GuardTimeoutClass;
}

/** A validated guard policy. */
export interface GuardPolicy extends ToolGatePolicy {
  /** Guard-only settings per upstream tool name. */
  toolOptions: ReadonlyMap<string, GuardToolOptions>;
}

/** What the policy must match to be accepted. */
export interface PolicyExpectation {
  /** Hub service id of this guard. */
  service: string;
  /** Upstream mode of this guard. */
  mode: GuardMode;
}

/** Source of the current policy. */
export interface PolicyStore {
  /** The newest valid policy, the last good one when the file is now invalid, or null when the file cannot be read or none was ever loaded. */
  current(): GuardPolicy | null;
}

/** Schema version this guard understands. */
export const POLICY_VERSION = 1;

/** Upper bound on the policy file size, in bytes. */
export const MAX_POLICY_BYTES = 8 * 1024 * 1024;

/**
 * Whether a value is a non-null, non-array object.
 * @param value - Value to test.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the guard-only fields of one tool entry.
 * @param upstreamName - Key of the entry.
 * @param entry - Raw entry.
 */
function parseToolOptions(upstreamName: string, entry: Record<string, unknown>): GuardToolOptions {
  const { definition, deferLoading, timeoutClass } = entry;
  const options: GuardToolOptions = {};
  if (definition !== undefined) {
    if (!isRecord(definition) || definition.name !== upstreamName) {
      throw new Error('policy tool definition must be an object named like its entry');
    }
    options.definition = definition;
  }
  if (deferLoading !== undefined) {
    if (typeof deferLoading !== 'boolean') {
      throw new Error('policy tool deferLoading must be a boolean');
    }
    options.deferLoading = deferLoading;
  }
  if (timeoutClass !== undefined) {
    if (timeoutClass !== 'standard' && timeoutClass !== 'long') {
      throw new Error('policy tool timeoutClass must be standard or long');
    }
    options.timeoutClass = timeoutClass;
  }
  return options;
}

/**
 * Validate a guard policy document; throws on anything malformed or meant for another server or mode.
 * @param raw - Parsed policy JSON.
 * @param expected - Service id and mode this guard runs with.
 */
export function parseGuardPolicy(raw: unknown, expected: PolicyExpectation): GuardPolicy {
  if (!isRecord(raw)) throw new Error('policy must be a JSON object');
  if (raw.version !== POLICY_VERSION) {
    throw new Error(`policy version must be ${POLICY_VERSION}`);
  }
  if (raw.service !== expected.service) throw new Error('policy is for another service');
  if (raw.mode !== expected.mode) throw new Error('policy is for another mode');
  const gate = parseToolGatePolicy(raw);
  const toolOptions = new Map<string, GuardToolOptions>();
  for (const [name, entry] of Object.entries(raw.tools as Record<string, unknown>)) {
    toolOptions.set(name, parseToolOptions(name, entry as Record<string, unknown>));
  }
  return { ...gate, toolOptions };
}

/**
 * Identity of the file's current version; an atomic rename changes the inode, an in-place write the mtime or size.
 * @param file - Policy file path.
 */
function fileKey(file: string): string | null {
  try {
    const stat = statSync(file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Create a store that re-reads one exact policy file whenever it changes and never reads anything else in its directory; a missing file denies every tool, even after a valid load.
 * @param file - Policy file path.
 * @param expected - Service id and mode the policy must match.
 */
export function createPolicyStore(file: string, expected: PolicyExpectation): PolicyStore {
  let good: GuardPolicy | null = null;
  let goodKey: string | null = null;
  let reportedKey: string | undefined;

  function report(key: string, reason: string): void {
    if (key === reportedKey) return;
    reportedKey = key;
    const kept = good ? 'keeping the last valid policy' : 'denying every tool';
    console.warn(`${ts()} [custom-guard] policy ${file} ${reason}; ${kept}`);
  }

  return {
    current() {
      const key = fileKey(file);
      if (key === null) {
        good = null;
        goodKey = null;
        report('missing', 'cannot be read');
        return null;
      }
      if (key === goodKey) return good;
      try {
        const size = statSync(file).size;
        if (size > MAX_POLICY_BYTES) throw new Error(`is larger than ${MAX_POLICY_BYTES} bytes`);
        const parsed = parseGuardPolicy(JSON.parse(readFileSync(file, 'utf8')), expected);
        good = parsed;
        goodKey = key;
        reportedKey = undefined;
      } catch (error) {
        const reason = error instanceof SyntaxError ? 'not valid JSON' : (error as Error).message;
        report(key, `is invalid (${reason})`);
      }
      return good;
    },
  };
}
