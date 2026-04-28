/**
 * Minimal RFC 6902 JSON Patch reducer (ADR-042).
 *
 * Supports the subset emitted by the Rust `ConversationPatch` helpers:
 * `add`, `remove`, `replace`. Other ops (`move`, `copy`, `test`) are
 * accepted by serde on the wire but never produced by our backend, so
 * this reducer rejects them — surfacing accidental new ops at the
 * boundary instead of silently no-oping.
 *
 * Design notes:
 * - Pure function. The input state is cloned before mutation so existing
 *   references remain valid (Angular signal equality cares about
 *   reference, not deep value).
 * - Path parsing follows RFC 6901: `/` separator, `~1` → `/`, `~0` → `~`.
 * - For `add` on an array, `-` appends; numeric segments insert at index.
 * - Failures throw — the caller (`chat-state.service`) catches and logs.
 *
 * Why no fast-json-patch dependency:
 * - The state-tree's surface is tiny (entries, totals, queue, session_id,
 *   model, is_streaming). A 100-line in-house reducer is cheaper and
 *   auditable than pulling in another library that ships its own
 *   prototype-pollution mitigation.
 * @see docs/adr/ADR-042-json-patch-stream-protocol.md
 */

/** A single RFC 6902 operation. */
export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

/** A complete RFC 6902 patch — array of ops applied in order. */
export type Patch = readonly PatchOp[];

/**
 * Apply a patch to `state`, returning the new state. Pure function.
 * Throws when the patch references a missing path or contains an
 * unsupported op.
 * @param state - Initial state to patch (not mutated).
 * @param patch - RFC 6902 ops applied in order.
 */
export function applyPatch<T>(state: T, patch: Patch): T {
  // Deep-clone so existing object references aren't mutated. Patches are
  // applied to the clone so the caller can replace its signal reference.
  // structuredClone is supported in jsdom 22+ and modern browsers.
  const next = structuredClone(state);
  for (const op of patch) {
    applyOp(next as unknown, op);
  }
  return next;
}

function applyOp(root: unknown, op: PatchOp): void {
  const tokens = parsePointer(op.path);
  if (op.op === 'add') {
    setOrInsert(root, tokens, op.value);
    return;
  }
  if (op.op === 'replace') {
    replaceAt(root, tokens, op.value);
    return;
  }
  if (op.op === 'remove') {
    removeAt(root, tokens);
    return;
  }
  // Unsupported op — TS exhaustiveness check would have caught this at
  // compile time, but the patch is foreign data so a runtime guard is
  // necessary.
  throw new Error(`unsupported json-patch op: ${(op as { op: string }).op}`);
}

/**
 * Parse RFC 6901 JSON Pointer to an array of unescaped tokens.
 * @param path - JSON pointer literal (must start with `/` or be empty).
 */
function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) {
    throw new Error(`invalid json pointer (missing leading slash): ${path}`);
  }
  return path
    .slice(1)
    .split('/')
    .map((tok) => tok.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * Walks `tokens` (except the last) into `root`, returning a `[parent, key]`
 * pair where `parent[key]` is the target. Returns `null` for the
 * root-level case (empty path).
 * @param root - The mutable state being navigated.
 * @param tokens - Pointer tokens, already unescaped per RFC 6901.
 */
function navigate(
  root: unknown,
  tokens: readonly string[]
): { parent: Record<string, unknown> | unknown[]; key: string } | null {
  if (tokens.length === 0) return null;
  let cur: unknown = root;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    cur = step(cur, tokens[i]);
  }
  if (cur === null || cur === undefined || typeof cur !== 'object') {
    throw new Error(`json-patch: parent at depth ${tokens.length - 1} not an object`);
  }
  return { parent: cur as Record<string, unknown> | unknown[], key: tokens[tokens.length - 1] };
}

/**
 * Index into `cur` by token (array index or object key).
 * @param cur - The current node being walked.
 * @param token - Pointer token (numeric index or object key).
 */
function step(cur: unknown, token: string): unknown {
  if (Array.isArray(cur)) {
    if (token === '-') {
      throw new Error('json-patch: "-" only valid as last token in `add` ops');
    }
    const idx = Number(token);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
      throw new Error(`json-patch: array index ${token} out of range`);
    }
    return cur[idx];
  }
  if (cur === null || cur === undefined || typeof cur !== 'object') {
    throw new Error(`json-patch: cannot descend into ${String(cur)} for key ${token}`);
  }
  return (cur as Record<string, unknown>)[token];
}

function setOrInsert(root: unknown, tokens: readonly string[], value: unknown): void {
  const target = navigate(root, tokens);
  if (target === null) {
    // RFC 6902 root replace via `add ""` would assign root, but the
    // immutable wrapper at applyPatch handles cloning — we don't support
    // root replacement here.
    throw new Error('json-patch: cannot add at root');
  }
  const { parent, key } = target;
  if (Array.isArray(parent)) {
    if (key === '-') {
      parent.push(value);
      return;
    }
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) {
      throw new Error(`json-patch: add index ${key} out of range for array`);
    }
    parent.splice(idx, 0, value);
    return;
  }
  (parent as Record<string, unknown>)[key] = value;
}

function replaceAt(root: unknown, tokens: readonly string[], value: unknown): void {
  const target = navigate(root, tokens);
  if (target === null) {
    throw new Error('json-patch: cannot replace at root');
  }
  const { parent, key } = target;
  if (Array.isArray(parent)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
      throw new Error(`json-patch: replace index ${key} out of range`);
    }
    parent[idx] = value;
    return;
  }
  if (!(key in (parent as Record<string, unknown>))) {
    throw new Error(`json-patch: replace key "${key}" not present`);
  }
  (parent as Record<string, unknown>)[key] = value;
}

function removeAt(root: unknown, tokens: readonly string[]): void {
  const target = navigate(root, tokens);
  if (target === null) {
    throw new Error('json-patch: cannot remove root');
  }
  const { parent, key } = target;
  if (Array.isArray(parent)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
      throw new Error(`json-patch: remove index ${key} out of range`);
    }
    parent.splice(idx, 1);
    return;
  }
  if (!(key in (parent as Record<string, unknown>))) {
    throw new Error(`json-patch: remove key "${key}" not present`);
  }
  delete (parent as Record<string, unknown>)[key];
}

/**
 * Compose two patches into one — for the property test of associativity.
 * @param a - First patch (applied first).
 * @param b - Second patch (applied after `a`).
 */
export function compose(a: Patch, b: Patch): Patch {
  return [...a, ...b];
}
