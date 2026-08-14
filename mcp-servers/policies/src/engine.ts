/**
 * Thin wrapper over the compiled WASM PII engine: loads policy.json + the sibling key file
 * (or the engine's compiled-in default when absent) and exposes tokenize/detokenize,
 * both keyword-aware (mask on tokenize, unmask on detokenize) like the proxy.
 * @module engine
 */

import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  PiiEngine as WasmPiiEngine,
  default_policy_json,
} from '../wasm-pkg/speedwave_pii_engine_wasm.js';

/** One category's tokenize/pass-through outcome, as reported by the WASM engine. */
export interface Detection {
  /** Built-in category id or a custom pattern's id */
  category: string;
  /** Whether hits in this category were sealed into tokens or left untouched */
  action: 'tokenized' | 'passed';
  /** Number of hits in this category */
  count: number;
}

/** Result of scanning a value: the (possibly tokenized) value plus its detections. */
export interface TokenizeResult {
  /** The scanned value, with tokenize-flagged hits replaced by tokens */
  value: unknown;
  /** Per-category detection aggregate */
  detections: Detection[];
}

/** A policy-bound PII engine instance, ready to scan or detokenize values. */
export interface PiiEngine {
  /**
   * Tokenize any value (string/object/array); policy keywords are then masked (match → alias).
   * @param value - Value to scan
   */
  tokenize(value: unknown): TokenizeResult;
  /**
   * Detokenize after unmasking keyword aliases (alias → match); throws (fail-closed) on any
   * bad/foreign token.
   * @param value - Value containing tokens/aliases to resolve back to their original values
   */
  detokenize(value: unknown): unknown;
}

/**
 * Reason a value could not be turned into a message string (non-Error throw).
 * @param err - The caught value
 * @returns A best-effort message string
 */
function reasonOf(err: unknown): string {
  /* c8 ignore next: fs sync calls and the WASM engine only ever throw a real Error instance */
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read the 64-hex tokenization key from the `key` file next to `policyFile`.
 * @param policyFile - Absolute path to the resolved POLICY_FILE
 * @returns The trimmed hex key
 */
function readKeyNextTo(policyFile: string): string {
  const keyFile = join(dirname(policyFile), 'key');
  if (!existsSync(keyFile)) {
    throw new Error(`policy key "${keyFile}" not found next to POLICY_FILE`);
  }
  try {
    return readFileSync(keyFile, 'utf-8').trim();
  } catch (err) {
    throw new Error(`policy key "${keyFile}" could not be read: ${reasonOf(err)}`);
  }
}

/**
 * Resolve the policy.json contents and tokenization key for this process. Absent `POLICY_FILE`
 * uses the engine's compiled-in default policy with an ephemeral random key (dev/fail-safe).
 * @param env - Environment to read `POLICY_FILE` from
 * @returns The policy.json v3 document text and the 64-hex tokenization key
 */
function resolvePolicyAndKey(env: Record<string, string | undefined>): {
  policyJson: string;
  keyHex: string;
} {
  const policyFile = env.POLICY_FILE;
  if (!policyFile || !existsSync(policyFile)) {
    return { policyJson: default_policy_json(), keyHex: randomBytes(32).toString('hex') };
  }

  let policyJson: string;
  try {
    policyJson = readFileSync(policyFile, 'utf-8');
  } catch (err) {
    throw new Error(`policy file "${policyFile}" could not be read: ${reasonOf(err)}`);
  }

  return { policyJson, keyHex: readKeyNextTo(policyFile) };
}

/**
 * Load the PII engine for this process: `POLICY_FILE` + its sibling `key` file when present,
 * otherwise the compiled-in default policy with an ephemeral key. Throws (fail-closed) on an
 * unreadable/invalid policy or key, or on any WASM engine construction failure.
 * @param env - Environment to read `POLICY_FILE` from (defaults to `process.env`)
 * @returns The loaded PII engine
 */
export function loadEngine(env: Record<string, string | undefined> = process.env): PiiEngine {
  const { policyJson, keyHex } = resolvePolicyAndKey(env);

  let wasmEngine: WasmPiiEngine;
  try {
    wasmEngine = new WasmPiiEngine(policyJson, keyHex);
  } catch (err) {
    throw new Error(`PII policy engine failed to initialize: ${reasonOf(err)}`);
  }

  return {
    tokenize(value: unknown): TokenizeResult {
      if (value === undefined) {
        return { value: undefined, detections: [] };
      }
      return JSON.parse(wasmEngine.tokenize(JSON.stringify(value))) as TokenizeResult;
    },
    detokenize(value: unknown): unknown {
      if (value === undefined) {
        return undefined;
      }
      return JSON.parse(wasmEngine.detokenize(JSON.stringify(value)));
    },
  };
}
