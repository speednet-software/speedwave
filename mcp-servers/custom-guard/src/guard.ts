/**
 * The custom MCP guard: answers the hub with a filtered protocol surface, lists upstream tools with guard-owned state, and forwards only allowed calls.
 * @module custom-guard/guard
 */

import {
  JSONRPCErrorBuilder,
  JSONRPCErrorCode,
  JSONRPCHandler,
  MAX_DESCRIPTION_BYTES,
  McpClientError,
  META_KEYS,
  TIMEOUTS,
  createToolGate,
  createWorkspacePathMapper,
  errorResult,
  sanitizeDescription,
  ts,
  validateJSONRPCMessage,
  validateToolName,
  type ExposedTool,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type McpClient,
  type ProcessRequestResult,
  type Tool,
  type ToolGate,
  type ToolHandlerContext,
  type WorkspacePathMapper,
} from '@speedwave/mcp-shared';
import type { GuardConfig } from './config.js';
import type { GuardPolicy, PolicyStore } from './policy.js';
import {
  createFixedUpstream,
  createRelayUpstream,
  type ClientFactory,
  type UpstreamSource,
} from './upstream.js';

/** Sentence appended to every tool description of a host-mode server. */
export const HOST_PATH_NOTE = 'Paths inside file contents are not rewritten.';

/** Requests the guard answers; everything else is refused. */
export const SUPPORTED_REQUESTS: ReadonlySet<string> = new Set([
  'initialize',
  'ping',
  'tools/list',
  'tools/call',
]);

/** The only notification the guard processes; others are dropped. */
export const SUPPORTED_NOTIFICATION = 'notifications/initialized';

/** How long a live upstream listing is trusted for routing calls before it is fetched again. */
export const LIVE_LISTING_TTL_MS = 60_000;

/** Upstream `tools/list` timeout; shorter than the hub's discovery timeout so the policy fallback still answers in time. */
export const LIST_TIMEOUT_MS = Math.floor(TIMEOUTS.TOOL_DISCOVERY_MS * 0.6);

/** Upstream `tools/call` timeout; the hub enforces the per-tool budget on its side. */
export const CALL_TIMEOUT_MS = TIMEOUTS.LONG_OPERATION_MS;

/** Why an upstream could not serve a request. */
export type UpstreamFailure =
  | 'relay-unavailable'
  | 'host-app-unavailable'
  | 'server-unreachable'
  | 'timeout'
  | 'upstream-error';

/** Dependencies of {@link CustomGuardHandler}. */
export interface CustomGuardOptions {
  /** Resolved configuration. */
  config: GuardConfig;
  /** Policy source. */
  policy: PolicyStore;
  /** Upstream source. */
  upstream: UpstreamSource;
  /** Clock (tests). */
  now?: () => number;
}

/** Outcome of one `tools/call`, before it becomes a JSON-RPC response. */
interface CallOutcome {
  result: unknown;
  decision: string;
}

/**
 * Whether a value is a non-null, non-array object.
 * @param value - Value to test.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Cut a string to at most `maxBytes` UTF-8 bytes without splitting a code point.
 * @param text - Input text.
 * @param maxBytes - Byte budget.
 */
function fitUtf8(text: string, maxBytes: number): string {
  let used = 0;
  let out = '';
  for (const char of text) {
    used += Buffer.byteLength(char, 'utf8');
    if (used > maxBytes) break;
    out += char;
  }
  return out;
}

/**
 * A sanitized description with {@link HOST_PATH_NOTE} appended, kept within the description byte limit so the note always survives.
 * @param description - Raw upstream description.
 */
export function appendHostPathNote(description: string): string {
  const suffix = ` ${HOST_PATH_NOTE}`;
  const budget = MAX_DESCRIPTION_BYTES - Buffer.byteLength(suffix, 'utf8');
  const base = fitUtf8(sanitizeDescription(description), budget).trimEnd();
  return base === '' ? HOST_PATH_NOTE : `${base}${suffix}`;
}

/**
 * Add the host path note to one raw upstream definition before it is hashed, so the hub catalog and the guard hash the same text.
 * @param raw - Untrusted upstream definition.
 */
function withHostPathNote(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const { description } = raw;
  if (description !== undefined && typeof description !== 'string') return raw;
  return { ...raw, description: appendHostPathNote(description ?? '') };
}

/**
 * Classify an upstream error without reading its text.
 * @param error - Thrown value.
 * @param hostMode - Whether the upstream is the Desktop relay.
 */
export function classifyUpstreamError(error: unknown, hostMode: boolean): UpstreamFailure {
  if (!(error instanceof McpClientError)) return 'upstream-error';
  if (error.kind === 'timeout') return 'timeout';
  const status = error.details.status;
  if (hostMode && error.kind === 'http' && status === 502) return 'host-app-unavailable';
  if (hostMode && (error.kind === 'network' || status === 401 || status === 403)) {
    return 'relay-unavailable';
  }
  if (error.kind === 'network') return 'server-unreachable';
  return 'upstream-error';
}

/**
 * The teaching error for an upstream failure; never carries upstream text.
 * @param failure - Failure class.
 * @param serverName - Server name chosen by the user.
 */
export function upstreamFailureResult(
  failure: UpstreamFailure,
  serverName: string
): ReturnType<typeof errorResult> {
  switch (failure) {
    case 'relay-unavailable':
      return errorResult(
        `Host server "${serverName}" is available only while Speedwave Desktop is running. ` +
          'Ask the user to start Speedwave Desktop, then retry.'
      );
    case 'host-app-unavailable':
      return errorResult(
        `The application behind host server "${serverName}" is not running. ` +
          'Ask the user to start it and its MCP server, then retry.'
      );
    case 'timeout':
      return errorResult(
        `Server "${serverName}" did not answer in time. Retry once; if it times out again, continue without this tool.`
      );
    case 'server-unreachable':
      return errorResult(
        `Server "${serverName}" is not reachable right now. Retry once; if it fails again, continue without this tool and tell the user.`
      );
    case 'upstream-error':
      return errorResult(
        `Server "${serverName}" could not handle the request. Retry once; if it fails again, continue without this tool and tell the user.`
      );
  }
}

/** JSON-RPC handler of the guard: protocol filter, gated tool listing and gated calls. */
export class CustomGuardHandler extends JSONRPCHandler {
  private readonly config: GuardConfig;
  private readonly policyStore: PolicyStore;
  private readonly upstream: UpstreamSource;
  private readonly now: () => number;
  private readonly gate: ToolGate;
  private readonly mapper: WorkspacePathMapper | null;
  private snapshot: GuardPolicy | null = null;
  private exposed = new Map<string, ExposedTool>();
  private source: 'none' | 'upstream' | 'policy' = 'none';
  private listedAt = 0;
  private lastFailure: UpstreamFailure = 'upstream-error';

  /**
   * Create the handler.
   * @param options - Configuration, policy source, upstream source and clock.
   */
  constructor(options: CustomGuardOptions) {
    super({ name: `mcp-${options.config.serviceId}`, version: '1.0.0' });
    this.config = options.config;
    this.policyStore = options.policy;
    this.upstream = options.upstream;
    this.now = options.now ?? Date.now;
    this.gate = createToolGate({ policy: () => this.snapshot, listMode: 'annotate' });
    const upstream = options.config.upstream;
    this.mapper =
      upstream.mode === 'host'
        ? createWorkspacePathMapper({ hostDir: upstream.hostDir, style: upstream.pathStyle })
        : null;
  }

  /**
   * Process one JSON-RPC message: only `initialize`, `ping`, `tools/list`, `tools/call` and `notifications/initialized` pass.
   * @param body - Parsed message.
   * @param sessionId - Session id from the transport.
   * @param context - Caller context from the transport.
   */
  override async processRequest(
    body: unknown,
    sessionId: string | null,
    context?: ToolHandlerContext
  ): Promise<ProcessRequestResult> {
    const method = isRecord(body) && typeof body.method === 'string' ? body.method : undefined;
    if (method === undefined) return super.processRequest(body, sessionId, context);

    if (!('id' in (body as Record<string, unknown>))) {
      return method === SUPPORTED_NOTIFICATION
        ? super.processRequest(body, sessionId, context)
        : { response: null };
    }

    if (!SUPPORTED_REQUESTS.has(method)) {
      const id = (body as Record<string, unknown>).id;
      const shown = /^[A-Za-z0-9_./-]{1,64}$/.test(method) ? method : 'unknown';
      return {
        response: {
          jsonrpc: '2.0',
          id: typeof id === 'string' || typeof id === 'number' ? id : null,
          error: {
            code: JSONRPCErrorCode.MethodNotFound,
            message: `Method not supported by this server: ${shown}`,
          },
        },
      };
    }

    if ((method === 'tools/list' || method === 'tools/call') && validateJSONRPCMessage(body)) {
      const request = body as JSONRPCRequest;
      if (method === 'tools/list') {
        return {
          response: { jsonrpc: '2.0', id: request.id, result: { tools: await this.listTools() } },
        };
      }
      return { response: await this.handleCall(request) };
    }

    const result = await super.processRequest(body, sessionId, context);
    if (method === 'initialize' && result.response && isRecord(result.response.result)) {
      result.response.result.capabilities = { tools: { listChanged: false } };
    }
    return result;
  }

  /** Take the policy for this request; the gate reads the same snapshot. */
  private loadPolicy(): GuardPolicy | null {
    this.snapshot = this.policyStore.current();
    return this.snapshot;
  }

  /**
   * Remember an ingested listing.
   * @param exposed - Exposed tools.
   * @param source - Where the definitions came from.
   */
  private remember(exposed: ExposedTool[], source: 'upstream' | 'policy'): ExposedTool[] {
    this.exposed = new Map(exposed.map((entry) => [entry.tool.name, entry]));
    this.source = source;
    this.listedAt = this.now();
    return exposed;
  }

  /**
   * Fetch and ingest the upstream listing; null (and `lastFailure` set) when the upstream cannot answer.
   * @param client - Upstream client.
   */
  private async refreshFromUpstream(client: McpClient): Promise<ExposedTool[] | null> {
    try {
      const raw = await client.listTools({ timeoutMs: LIST_TIMEOUT_MS });
      const prepared = this.mapper ? raw.map(withHostPathNote) : raw;
      return this.remember(this.gate.ingestUpstreamTools(prepared), 'upstream');
    } catch (error) {
      this.lastFailure = classifyUpstreamError(error, this.mapper !== null);
      console.warn(
        `${ts()} [custom-guard] service=${this.config.serviceId} upstream tools/list failed: ${this.lastFailure}`
      );
      return null;
    }
  }

  /**
   * Ingest the approved definitions stored in the policy (used while the upstream is unreachable).
   * @param policy - Current policy.
   */
  private ingestFromPolicy(policy: GuardPolicy): ExposedTool[] {
    const definitions = [...policy.toolOptions.values()]
      .map((options) => options.definition)
      .filter((definition) => definition !== undefined);
    return this.remember(this.gate.ingestUpstreamTools(definitions), 'policy');
  }

  /**
   * One exposed tool as the hub sees it: upstream `_meta` dropped, guard-owned keys set.
   * @param entry - Exposed tool.
   * @param policy - Current policy.
   */
  private present(entry: ExposedTool, policy: GuardPolicy): Tool {
    const tool: Tool = { ...entry.tool };
    delete tool._meta;
    const options = policy.toolOptions.get(entry.upstreamName);
    return {
      ...tool,
      _meta: {
        [META_KEYS.TOOL_STATE]: this.gate.stateOf(tool.name),
        [META_KEYS.UPSTREAM_NAME]: entry.upstreamName,
        [META_KEYS.DEFER_LOADING]: options?.deferLoading ?? true,
        [META_KEYS.TIMEOUT_CLASS]: options?.timeoutClass ?? 'standard',
      },
    };
  }

  /** Answer `tools/list`: the live upstream listing, or the approved definitions from the policy when the upstream is unreachable. */
  private async listTools(): Promise<Tool[]> {
    const policy = this.loadPolicy();
    if (!policy) return [];
    const resolved = this.upstream.resolve();
    const live = resolved.ok ? await this.refreshFromUpstream(resolved.client) : null;
    const exposed = live ?? this.ingestFromPolicy(policy);
    return exposed.map((entry) => this.present(entry, policy));
  }

  /**
   * Validate a `tools/call` request, run it, and log the decision.
   * @param request - JSON-RPC request.
   */
  private async handleCall(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    const started = this.now();
    const params = request.params;
    if (!isRecord(params) || typeof params.name !== 'string' || !validateToolName(params.name)) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: JSONRPCErrorBuilder.invalidParams('tools/call requires a valid params.name'),
      };
    }
    const rawArgs = params.arguments;
    if (rawArgs !== undefined && rawArgs !== null && !isRecord(rawArgs)) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: JSONRPCErrorBuilder.invalidParams(
          'tools/call arguments must be an object of named parameters'
        ),
      };
    }
    const name = params.name;
    const outcome = await this.runCall(name, (rawArgs as Record<string, unknown>) ?? {});
    console.log(
      `${ts()} [custom-guard] service=${this.config.serviceId} tool=${name} decision=${outcome.decision} duration_ms=${this.now() - started}`
    );
    return { jsonrpc: '2.0', id: request.id, result: outcome.result };
  }

  /**
   * Authorize, map and forward one call.
   * @param name - Exposed tool name.
   * @param args - Call arguments.
   */
  private async runCall(name: string, args: Record<string, unknown>): Promise<CallOutcome> {
    const policy = this.loadPolicy();
    if (!policy) {
      return {
        result: errorResult(
          `Server "${this.config.serverName}" has no tool policy loaded, so every tool is blocked. ` +
            'The user reviews its tools in Speedwave Desktop. Do not retry.'
        ),
        decision: 'deny:no-policy',
      };
    }

    const resolved = this.upstream.resolve();
    let failure: UpstreamFailure | null = resolved.ok ? null : 'relay-unavailable';
    if (resolved.ok && this.needsRefresh(name)) {
      if (!(await this.refreshFromUpstream(resolved.client))) failure = this.lastFailure;
    }
    if (failure !== null || !resolved.ok) {
      this.ingestFromPolicy(policy);
      const state = this.gate.stateOf(name);
      const decision = this.gate.authorizeCall(name);
      if (!decision.allowed) return { result: decision.result, decision: `deny:${state}` };
      const reason = failure ?? 'relay-unavailable';
      return {
        result: upstreamFailureResult(reason, this.config.serverName),
        decision: `error:${reason}`,
      };
    }

    const state = this.gate.stateOf(name);
    const decision = this.gate.authorizeCall(name);
    if (!decision.allowed) return { result: decision.result, decision: `deny:${state}` };

    let callArgs = args;
    if (this.mapper) {
      const rewritten = this.mapper.rewriteArgs(args, this.exposed.get(name)?.tool.inputSchema);
      if (!rewritten.ok) {
        return { result: rewritten.error, decision: `deny:path-${rewritten.reason}` };
      }
      callArgs = rewritten.args;
    }

    try {
      const raw = await resolved.client.callTool(decision.upstreamName, callArgs, {
        timeoutMs: CALL_TIMEOUT_MS,
      });
      const mapped = this.mapper ? this.mapper.rewriteResult(raw) : raw;
      return { result: this.gate.sanitizeCallResult(mapped), decision: 'allow' };
    } catch (error) {
      const reason = classifyUpstreamError(error, this.mapper !== null);
      return {
        result: upstreamFailureResult(reason, this.config.serverName),
        decision: `error:${reason}`,
      };
    }
  }

  /**
   * Whether routing a call needs a fresh upstream listing.
   * @param name - Exposed tool name.
   */
  private needsRefresh(name: string): boolean {
    return (
      this.source !== 'upstream' ||
      !this.exposed.has(name) ||
      this.now() - this.listedAt > LIVE_LISTING_TTL_MS
    );
  }
}

/**
 * Build the guard handler for a configuration.
 * @param config - Resolved configuration.
 * @param policy - Policy source.
 * @param factory - MCP client factory (tests).
 */
export function createGuardHandler(
  config: GuardConfig,
  policy: PolicyStore,
  factory?: ClientFactory
): CustomGuardHandler {
  const upstream =
    config.upstream.mode === 'npm'
      ? createFixedUpstream(config.upstream.url, config.upstream.authToken, factory)
      : createRelayUpstream(config.upstream.relayDir, factory);
  return new CustomGuardHandler({ config, policy, upstream });
}
