# ADR-029: Sandbox Prototype Chain Hardening

> **Status:** Accepted

---

## Context

The MCP Hub executor (`executor.ts`) runs model-generated JavaScript in a sandbox using `new AsyncFunction(...)` with a regex denylist (`FORBIDDEN_PATTERNS`). The denylist blocks direct access to `eval`, `require`, `process`, `globalThis`, `global` (Node.js global object), and other dangerous APIs (see `FORBIDDEN_PATTERNS` in `mcp-servers/hub/src/executor.ts` for the canonical list).

However, prototype chain traversal bypasses these patterns. For example:

```javascript
({}).constructor.constructor('return this')();
```

This reaches the `Function` constructor via the prototype chain — without ever writing the word `Function` — and returns `globalThis`. From there, an attacker can access `process`, `require('http')`, and call MCP workers directly, bypassing audit logging and PII tokenization.

Other traversal vectors include `.__proto__`, `Object.getPrototypeOf()`, `Reflect` APIs, and `Proxy` (which can intercept property access to exfiltrate sandbox internals).

## Decision

Add the following patterns to `FORBIDDEN_PATTERNS`:

### Dot-notation patterns

| Pattern                | Blocks                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `/\.constructor\b/`    | Prototype chain escapes via dot notation (`({}).constructor.constructor(...)`, `[].find.constructor(...)`, `(async()=>{}).constructor(...)`) |
| `/\.__proto__\b/`      | Direct prototype access via dot notation                                                                                                     |
| `/\bgetPrototypeOf\b/` | `Object.getPrototypeOf()` and `Reflect.getPrototypeOf()`                                                                                     |
| `/\bsetPrototypeOf\b/` | `Object.setPrototypeOf()` and `Reflect.setPrototypeOf()`                                                                                     |
| `/\bProxy\s*\(/`       | `new Proxy()` interception                                                                                                                   |
| `/\bReflect\b/`        | All `Reflect` APIs including `Reflect.construct(Function, [...])` [^1]                                                                       |

### Bracket-notation patterns

| Pattern                                   | Blocks                      |
| ----------------------------------------- | --------------------------- |
| `/\[\s*['"\x60]constructor['"\x60]\s*\]/` | `obj["constructor"]` bypass |
| `/\[\s*['"\x60]__proto__['"\x60]\s*\]/`   | `obj["__proto__"]` bypass   |
| `/\[\s*['"\x60]prototype['"\x60]\s*\]/`   | `obj["prototype"]` bypass   |

### Why dot-notation `.constructor` is sufficient for chain escapes via attribute access

Every known dot-notation prototype chain escape requires `.constructor` — it is the only way to reach the `Function` constructor from an arbitrary object using attribute access [^2]. Without `.constructor`, there is no dot-notation path from a user-space object to `Function`. The bracket-notation patterns close the equivalent vector via computed property access (`obj["constructor"]`).

Note: string-concatenation bypasses (e.g., `obj["con"+"structor"]`) remain theoretically possible. See **Accepted Risk** for why this is acceptable.

### Why legitimate code is not affected

Claude generates orchestration calls (`redmine.listIssueIds()`, `gitlab.getMrFull()`), not prototype operations. The string `.constructor` does not appear in normal API orchestration code.

### Internal exemption

The executor itself uses `Object.getPrototypeOf(async function(){}).constructor` to obtain the `AsyncFunction` reference at module initialization. This is safe: it runs in the trusted executor context before any user code is validated, and `FORBIDDEN_PATTERNS` only applies to user-submitted code strings. The exemption is documented with an inline comment at the `AsyncFunction` constant definition.

## Rejected Alternatives

| Alternative                | Reason for rejection                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `isolated-vm` (V8 Isolate) | In maintenance mode as of early 2025; prebuilt binaries have ABI mismatch with Node 24. Reassess if active development resumes [^3] |
| `quickjs-emscripten`       | Single async suspension breaks `batch()` (Promise.allSettled wrapper) [^4]                                                          |
| `worker_threads` + `vm`    | Node.js `vm` module is explicitly not a security sandbox [^5]                                                                       |

## Security Context

The regex denylist is **defense-in-depth**, not the sole security barrier. The executor runs inside a Docker container with:

- `cap_drop: ALL` — no Linux capabilities
- `no-new-privileges` — cannot escalate
- `read_only` filesystem
- Zero tokens — hub container has no service credentials
- Isolated network — cannot reach external services directly

Even if the regex is bypassed, the attacker lands in an empty container with no credentials and no outbound network access.

## Accepted Risk

Regex-based validation can potentially be bypassed by novel vectors (e.g., string concatenation to construct property names dynamically: `obj["con"+"structor"]`). This risk is acceptable because:

1. Code is generated by Claude (controlled by Anthropic), not arbitrary user input
2. Even after sandbox escape, the container has no tokens, no capabilities, and a read-only filesystem
3. Audit logging at the HTTP bridge layer provides a secondary detection mechanism for successful bypasses that proceed to make tool calls

Failed bypass attempts that throw exceptions are logged at `console.error` severity inside the container but are not surfaced to external monitoring.

## Future Considerations

If a mature, actively maintained V8 isolate library emerges with Node 24+ support, proper async semantics, and stable ABI bindings, it should be evaluated as a replacement for the regex-based approach. Concrete blockers to resolve: Node 24 native addon ABI compatibility, async generator/`Promise.allSettled` support within the isolate.

## References

[^1]: [MDN: Reflect](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Reflect) — `Reflect.construct()` can invoke any constructor including `Function`

[^2]: [OWASP Prototype Pollution](https://owasp.org/www-community/attacks/Prototype_Pollution) — documents `.constructor` as the standard chain escape mechanism

[^3]: [isolated-vm GitHub](https://github.com/laverdet/isolated-vm) — repository shows maintenance-mode status and Node.js ABI compatibility issues

[^4]: [quickjs-emscripten GitHub](https://github.com/nicolo-ribaudo/quickjs-emscripten) — async execution limitations documented in README

[^5]: [Node.js vm module documentation](https://nodejs.org/api/vm.html#vm-executing-javascript) — "The node:vm module is not a security mechanism. Do not use it to run untrusted code."

- Issue #30: Prototype chain traversal sandbox escape
