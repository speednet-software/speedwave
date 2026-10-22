/**
 * Tool gate for third-party MCP servers: definition hashing, per-tool allow decisions, name mapping and sanitation of upstream definitions and results.
 * @module shared/tool-gate
 */

import { createHash } from 'node:crypto';
import type { Tool } from './types.js';
import { LEGACY_META_KEYS, META_KEYS } from './meta-keys.js';
import { validateToolName } from './security.js';
import { errorResult } from './server.js';

/** Decision a policy records for one tool. */
export type PolicyToolState = 'allowed' | 'pending' | 'blocked';

/** Effective state of one tool: the policy decision, or `changed` for an allowed tool whose live definition differs from the approved one; only `allowed` may be called. */
export type ToolState = PolicyToolState | 'changed';

/** How `tools/list` shows gated tools: drop everything not allowed, or list all with a state marker. */
export type ToolListMode = 'allowed-only' | 'annotate';

/** One approved-or-not tool in a gate policy, keyed by its upstream name. */
export interface ToolPolicyEntry {
  /** Decision recorded by the user. */
  state: PolicyToolState;
  /** `sha256:<hex>` of the definition the decision was made for. */
  defHash: string;
  /** Exposed name the decision was made for; a different computed name demotes the tool to pending. */
  exposedName?: string;
}

/** The part of a gate policy the tool gate consumes. */
export interface ToolGatePolicy {
  /** Decisions keyed by upstream tool name. */
  tools: ReadonlyMap<string, ToolPolicyEntry>;
  /** Upper bound on a serialized tool result, in bytes. */
  maxResultBytes: number;
}

/** An upstream tool rewritten for exposure, with the data needed to call it upstream. */
export interface ExposedTool {
  /** Sanitized definition under its exposed name. */
  tool: Tool;
  /** Name the upstream server knows the tool by. */
  upstreamName: string;
  /** `sha256:<hex>` of the upstream definition. */
  defHash: string;
}

/** Result of a `tools/call` authorization. */
export type GateDecision =
  | { allowed: true; upstreamName: string }
  | { allowed: false; result: ReturnType<typeof errorResult> };

/** Options for {@link createToolGate}. */
export interface ToolGateOptions {
  /** Current policy, or null when no valid policy is loaded (every tool is then blocked). */
  policy: () => ToolGatePolicy | null;
  /** `tools/list` presentation (default `annotate`). */
  listMode?: ToolListMode;
}

/** Tool gate consumed by the JSON-RPC handler's optional `toolGate` hook. */
export interface ToolGate {
  /** Replace the known upstream tools and return their exposed forms; invalid definitions are dropped, an empty description becomes the placeholder before hashing. */
  ingestUpstreamTools(upstream: readonly unknown[]): ExposedTool[];
  /** Effective state of an exposed tool under the current policy. */
  stateOf(exposedName: string): ToolState;
  /** Apply the list mode to the tools a `tools/list` would return. */
  filterToolsList(tools: readonly Tool[]): Tool[];
  /** Allow or deny a `tools/call` for an exposed tool name. */
  authorizeCall(exposedName: string): GateDecision;
  /** Sanitize a tool result before it leaves the gate. */
  sanitizeCallResult(result: unknown): unknown;
}

/** Maximum UTF-8 byte length of an exposed tool description. */
export const MAX_DESCRIPTION_BYTES = 1024;

/** Default upper bound on a serialized tool result, in bytes. */
export const DEFAULT_MAX_RESULT_BYTES = 262_144;

const MAX_RESULT_BYTES_CEILING = 16 * 1024 * 1024;
const MAX_NESTING_DEPTH = 64;
const MAX_UPSTREAM_NAME_LENGTH = 512;
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const DEF_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const TOOL_STATES: ReadonlySet<string> = new Set(['allowed', 'pending', 'blocked']);
const SPEEDWAVE_META_PREFIX = 'speedwave.pl/';
const HASHED_NAME_LENGTHS = [8, 16, 32, 64] as const;

const DESCRIPTION_STRIP_RE =
  // eslint-disable-next-line no-control-regex -- intentional: strip C0/C1 controls, bidi and zero-width characters from untrusted descriptions
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/** Thrown when a value nests deeper than the gate accepts. */
class NestingTooDeepError extends Error {}

/**
 * Compare two strings by Unicode code point (UTF-8 byte order), the order a Rust `BTreeMap<String, _>` uses.
 * @param a - First string.
 * @param b - Second string.
 */
function compareCodePoints(a: string, b: string): number {
  const byBytes = Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  if (byBytes !== 0) return byBytes;
  return a < b ? -1 : 1;
}

/**
 * Serialize one value of a canonical JSON document.
 * @param value - Value to serialize.
 * @param depth - Current nesting depth.
 */
function encodeCanonical(value: unknown, depth: number): string {
  if (depth > MAX_NESTING_DEPTH) throw new NestingTooDeepError('value nests too deeply');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError('canonical JSON cannot encode a non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => encodeCanonical(item, depth + 1)).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort(compareCodePoints);
      const members = keys.map(
        (key) => `${JSON.stringify(key)}:${encodeCanonical(record[key], depth + 1)}`
      );
      return `{${members.join(',')}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot encode a ${typeof value}`);
  }
}

/**
 * Canonical JSON: object keys sorted by code point, no whitespace, arrays in order, strings and numbers as `JSON.stringify` writes them.
 * @param value - A JSON value (undefined object members are skipped; other non-JSON values throw).
 */
export function canonicalJson(value: unknown): string {
  return encodeCanonical(value, 0);
}

/**
 * Hex SHA-256 of a string's UTF-8 bytes.
 * @param text - Input text.
 */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Cut a string to at most `maxBytes` UTF-8 bytes without splitting a code point.
 * @param text - Input text.
 * @param maxBytes - Byte budget.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let used = 0;
  let out = '';
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > maxBytes) break;
    used += size;
    out += char;
  }
  return out;
}

/**
 * Strip control (except tab and newline), bidi and zero-width characters, then cut to {@link MAX_DESCRIPTION_BYTES} UTF-8 bytes.
 * @param description - Untrusted description text.
 */
export function sanitizeDescription(description: string): string {
  return truncateUtf8(description.replace(DESCRIPTION_STRIP_RE, ''), MAX_DESCRIPTION_BYTES);
}

/** Description shown for a tool whose sanitized upstream description is empty; the hub drops tools without one. */
export const EMPTY_DESCRIPTION_PLACEHOLDER = 'No description provided by the server.';

/**
 * Put {@link EMPTY_DESCRIPTION_PLACEHOLDER} into a raw upstream definition whose sanitized description is empty, before it is hashed, so the catalog and every hash see the same text.
 * @param raw - Untrusted upstream definition.
 */
export function withDescriptionPlaceholder(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const { description } = raw;
  if (description !== undefined && typeof description !== 'string') return raw;
  if (sanitizeDescription(description ?? '').trim() !== '') return raw;
  return { ...raw, description: EMPTY_DESCRIPTION_PLACEHOLDER };
}

/** Definition fields covered by a tool definition hash. */
export interface HashableToolDefinition {
  /** Upstream tool name. */
  name: string;
  /** Raw description; sanitized before hashing. */
  description?: string;
  /** Raw input schema (null when absent). */
  inputSchema?: Record<string, unknown> | null;
  /** Raw annotations (null when absent). */
  annotations?: Record<string, unknown> | null;
  /** Raw output schema (null when absent). */
  outputSchema?: Record<string, unknown> | null;
}

/**
 * The exact document a definition hash covers: `{name, description (sanitized), inputSchema, annotations, outputSchema}`, absent fields as null and description as "".
 * @param tool - Upstream definition.
 */
export function definitionHashInput(tool: HashableToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: sanitizeDescription(tool.description ?? ''),
    inputSchema: tool.inputSchema ?? null,
    annotations: tool.annotations ?? null,
    outputSchema: tool.outputSchema ?? null,
  };
}

/**
 * `sha256:<hex>` over the canonical JSON of {@link definitionHashInput}; the value a gate policy pins.
 * @param tool - Upstream definition.
 */
export function definitionHash(tool: HashableToolDefinition): string {
  return `sha256:${sha256Hex(canonicalJson(definitionHashInput(tool)))}`;
}

/**
 * Whether a value is a non-null, non-array object.
 * @param value - Value to test.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copy a JSON value without `__proto__`, `constructor` and `prototype` keys at any depth.
 * @param value - JSON value.
 * @param depth - Current nesting depth.
 */
function stripDangerousKeys(value: unknown, depth = 0): unknown {
  if (depth > MAX_NESTING_DEPTH) throw new NestingTooDeepError('value nests too deeply');
  if (Array.isArray(value)) return value.map((item) => stripDangerousKeys(item, depth + 1));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    out[key] = stripDangerousKeys(value[key], depth + 1);
  }
  return out;
}

/**
 * Whether a JSON value carries a `__proto__`, `constructor` or `prototype` key at any depth.
 * @param value - JSON value.
 * @param keys - Key names to look for.
 * @param depth - Current nesting depth.
 */
function containsKey(value: unknown, keys: ReadonlySet<string>, depth = 0): boolean {
  if (depth > MAX_NESTING_DEPTH) throw new NestingTooDeepError('value nests too deeply');
  if (Array.isArray(value)) return value.some((item) => containsKey(item, keys, depth + 1));
  if (!isRecord(value)) return false;
  return Object.keys(value).some(
    (key) => keys.has(key) || containsKey(value[key], keys, depth + 1)
  );
}

/**
 * Drop every `speedwave.pl/*` key, every legacy key and prototype-polluting keys from an upstream `_meta`; undefined when nothing remains.
 * @param meta - Untrusted `_meta` value.
 */
export function sanitizeMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!isRecord(meta)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(meta)) {
    if (key.startsWith(SPEEDWAVE_META_PREFIX) || LEGACY_META_KEYS.includes(key)) continue;
    if (DANGEROUS_KEYS.has(key)) continue;
    out[key] = stripDangerousKeys(meta[key]);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The hub's camelCase form of a tool name; two names with the same form would collide in the hub.
 * @param name - Exposed tool name.
 */
function collisionKey(name: string): string {
  return name.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Map upstream tool names to unique `validateToolName`-compatible names; valid names are kept, others (and prototype keys) get a hash suffix. Deterministic for a given name set.
 * @param upstreamNames - Upstream tool names (duplicates ignored).
 */
export function mapToolNames(upstreamNames: readonly string[]): Map<string, string> {
  const names = [...new Set(upstreamNames)].sort(compareCodePoints);
  const taken = new Set<string>();
  const mapped = new Map<string, string>();
  const rest: string[] = [];

  for (const name of names) {
    if (
      validateToolName(name) &&
      !DANGEROUS_KEYS.has(name) &&
      !DANGEROUS_KEYS.has(collisionKey(name)) &&
      !taken.has(collisionKey(name))
    ) {
      taken.add(collisionKey(name));
      mapped.set(name, name);
    } else {
      rest.push(name);
    }
  }

  for (const name of rest) {
    const digest = sha256Hex(name);
    const base = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    for (const length of HASHED_NAME_LENGTHS) {
      const candidate = `${base.slice(0, 98 - length)}_${digest.slice(0, length)}`;
      if (!taken.has(collisionKey(candidate))) {
        taken.add(collisionKey(candidate));
        mapped.set(name, candidate);
        break;
      }
    }
  }

  return mapped;
}

/** Upstream definition fields the gate reads after shape validation. */
interface UpstreamDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  _meta?: unknown;
}

/**
 * Validate the shape of an untrusted upstream tool definition; null when it cannot be exposed. A null `annotations` or `outputSchema` is the same as an absent one, as in the hash.
 * @param raw - Untrusted definition from upstream `tools/list`.
 */
function parseUpstreamDefinition(raw: unknown): UpstreamDefinition | null {
  if (!isRecord(raw)) return null;
  const { name, description, inputSchema } = raw;
  const annotations = raw.annotations ?? undefined;
  const outputSchema = raw.outputSchema ?? undefined;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_UPSTREAM_NAME_LENGTH) {
    return null;
  }
  if (description !== undefined && typeof description !== 'string') return null;
  if (!isRecord(inputSchema)) return null;
  if (annotations !== undefined && !isRecord(annotations)) return null;
  if (outputSchema !== undefined && !isRecord(outputSchema)) return null;
  try {
    if (containsKey({ inputSchema, annotations, outputSchema }, new Set(['__proto__']))) {
      return null;
    }
    canonicalJson({ inputSchema, annotations, outputSchema });
  } catch {
    return null;
  }
  return { name, description, inputSchema, annotations, outputSchema, _meta: raw._meta };
}

/**
 * Validate a gate policy document; throws on anything malformed so a caller can keep its last good copy.
 * @param raw - Parsed policy JSON.
 */
export function parseToolGatePolicy(raw: unknown): ToolGatePolicy {
  if (!isRecord(raw) || !isRecord(raw.tools)) {
    throw new Error('tool gate policy must be an object with a "tools" object');
  }
  const tools = new Map<string, ToolPolicyEntry>();
  for (const [name, entry] of Object.entries(raw.tools)) {
    if (!isRecord(entry)) throw new Error('tool gate policy entry must be an object');
    const { state, defHash, exposedName } = entry;
    if (typeof state !== 'string' || !TOOL_STATES.has(state)) {
      throw new Error('tool gate policy entry has an invalid state');
    }
    if (typeof defHash !== 'string' || !DEF_HASH_RE.test(defHash)) {
      throw new Error('tool gate policy entry has an invalid defHash');
    }
    if (
      exposedName !== undefined &&
      (typeof exposedName !== 'string' || !validateToolName(exposedName))
    ) {
      throw new Error('tool gate policy entry has an invalid exposedName');
    }
    tools.set(name, {
      state: state as PolicyToolState,
      defHash,
      ...(exposedName !== undefined ? { exposedName } : {}),
    });
  }
  const maxResultBytes = raw.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  if (
    typeof maxResultBytes !== 'number' ||
    !Number.isInteger(maxResultBytes) ||
    maxResultBytes <= 0 ||
    maxResultBytes > MAX_RESULT_BYTES_CEILING
  ) {
    throw new Error(
      `tool gate policy maxResultBytes must be an integer in 1..${MAX_RESULT_BYTES_CEILING}`
    );
  }
  return { tools, maxResultBytes };
}

/**
 * The deny result for a tool that is not allowed, written so the model asks the user instead of retrying.
 * @param exposedName - Exposed tool name (already validated by the dispatcher).
 * @param state - Effective state of the tool.
 */
function denyResult(
  exposedName: string,
  state: Exclude<ToolState, 'allowed'>
): ReturnType<typeof errorResult> {
  if (state === 'changed') {
    return errorResult(
      `Tool "${exposedName}" changed since the user approved it, so it is blocked until they review it again in Speedwave Desktop. ` +
        'Do not retry it; tell the user the tool definition changed and continue without it.'
    );
  }
  if (state === 'blocked') {
    return errorResult(
      `Tool "${exposedName}" is blocked in this project. ` +
        'The user decides which tools of this server may run, in Speedwave Desktop. ' +
        'Do not retry it; continue without this tool or ask the user to allow it.'
    );
  }
  return errorResult(
    `Tool "${exposedName}" is not approved in this project yet. ` +
      'The user approves tools of this server in Speedwave Desktop. ' +
      'Tell the user which tool you need and why, and do not retry until they confirm it is allowed.'
  );
}

/**
 * Sanitize a tool result: text content only, structured content without prototype keys, size-capped; anything else becomes an error result.
 * @param result - Untrusted `tools/call` result.
 * @param maxBytes - Upper bound on the serialized result.
 */
export function sanitizeToolResult(result: unknown, maxBytes: number): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return errorResult('The server returned a malformed tool result.');
  }
  try {
    const content: Array<{ type: 'text'; text: string }> = [];
    for (const item of result.content) {
      if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') {
        const type = isRecord(item) && typeof item.type === 'string' ? item.type : '';
        const shown = /^[a-z_]{1,32}$/.test(type) ? `"${type}"` : 'non-text';
        return errorResult(
          `The server returned ${shown} content, which Speedwave does not pass through; only text and JSON results are allowed.`
        );
      }
      content.push({ type: 'text', text: sanitizeResultText(item.text) });
    }
    const out: Record<string, unknown> = { content };
    if (result.structuredContent !== undefined) {
      if (!isRecord(result.structuredContent)) {
        return errorResult('The server returned structured content that is not a JSON object.');
      }
      out.structuredContent = stripDangerousKeys(result.structuredContent);
    }
    if (result.isError === true) out.isError = true;
    const size = Buffer.byteLength(JSON.stringify(out), 'utf8');
    if (size > maxBytes) {
      return errorResult(
        `The tool result was ${size} bytes, above the ${maxBytes}-byte limit for this server. Ask for less data, for example a narrower query or a smaller page.`
      );
    }
    return out;
  } catch (error) {
    if (error instanceof NestingTooDeepError) {
      return errorResult('The server returned a result nested too deeply to pass through.');
    }
    throw error;
  }
}

/**
 * Re-serialize a JSON text item without prototype-polluting keys; other text passes unchanged.
 * @param text - Text content of one result item.
 */
function sanitizeResultText(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!containsKey(parsed, DANGEROUS_KEYS)) return text;
  return JSON.stringify(stripDangerousKeys(parsed));
}

/**
 * Create a tool gate over a policy source; exposed tools must be ingested before they can be allowed.
 * @param options - Policy source and list mode.
 */
export function createToolGate(options: ToolGateOptions): ToolGate {
  const listMode = options.listMode ?? 'annotate';
  let live = new Map<string, { upstreamName: string; defHash: string }>();

  function resolve(
    exposedName: string
  ): { state: 'allowed'; upstreamName: string } | { state: Exclude<ToolState, 'allowed'> } {
    const policy = options.policy();
    if (!policy) return { state: 'blocked' };
    const known = live.get(exposedName);
    if (!known) return { state: 'pending' };
    const entry = policy.tools.get(known.upstreamName);
    if (!entry) return { state: 'pending' };
    if (entry.state !== 'allowed') return { state: entry.state };
    const nameDrift = entry.exposedName !== undefined && entry.exposedName !== exposedName;
    if (nameDrift || entry.defHash !== known.defHash) return { state: 'changed' };
    return { state: 'allowed', upstreamName: known.upstreamName };
  }

  const stateOf = (exposedName: string): ToolState => resolve(exposedName).state;

  return {
    ingestUpstreamTools(upstream) {
      const parsed: UpstreamDefinition[] = [];
      const seen = new Set<string>();
      for (const raw of upstream) {
        const definition = parseUpstreamDefinition(withDescriptionPlaceholder(raw));
        if (!definition || seen.has(definition.name)) continue;
        seen.add(definition.name);
        parsed.push(definition);
      }
      const names = mapToolNames(parsed.map((definition) => definition.name));
      const exposed: ExposedTool[] = [];
      const next = new Map<string, { upstreamName: string; defHash: string }>();
      for (const definition of parsed) {
        const exposedName = names.get(definition.name);
        if (exposedName === undefined) continue;
        const defHash = definitionHash(definition);
        const meta = sanitizeMeta(definition._meta);
        const tool: Tool = {
          name: exposedName,
          description: sanitizeDescription(definition.description ?? ''),
          inputSchema: definition.inputSchema as Tool['inputSchema'],
          ...(definition.annotations !== undefined
            ? { annotations: definition.annotations as Tool['annotations'] }
            : {}),
          ...(definition.outputSchema !== undefined
            ? { outputSchema: definition.outputSchema }
            : {}),
          ...(meta ? { _meta: meta } : {}),
        };
        next.set(exposedName, { upstreamName: definition.name, defHash });
        exposed.push({ tool, upstreamName: definition.name, defHash });
      }
      live = next;
      return exposed;
    },

    stateOf,

    filterToolsList(tools) {
      if (listMode === 'allowed-only') {
        return tools.filter((tool) => stateOf(tool.name) === 'allowed');
      }
      return tools.map((tool) => ({
        ...tool,
        _meta: { ...(tool._meta ?? {}), [META_KEYS.TOOL_STATE]: stateOf(tool.name) },
      }));
    },

    authorizeCall(exposedName) {
      const resolved = resolve(exposedName);
      if (resolved.state === 'allowed') {
        return { allowed: true, upstreamName: resolved.upstreamName };
      }
      return { allowed: false, result: denyResult(exposedName, resolved.state) };
    },

    sanitizeCallResult(result) {
      const maxBytes = options.policy()?.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
      return sanitizeToolResult(result, maxBytes);
    },
  };
}
