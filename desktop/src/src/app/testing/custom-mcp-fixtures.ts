import type {
  CustomMcpEntry,
  CustomMcpForced,
  CustomMcpList,
  CustomMcpPreview,
  CustomMcpTool,
} from '../models/custom-mcp';

/** The test project every Custom MCP fixture belongs to. */
export const CUSTOM_MCP_PROJECT = 'test-project';

/** An organization policy that forces nothing. */
export function noForced(): CustomMcpForced {
  return {
    pii_mode: null,
    workspace_mode_max: null,
    host_servers_disabled: false,
    allowed_domains: null,
    allowed_scopes: null,
  };
}

/**
 * A listed tool.
 * @param name - the upstream and exposed name
 * @param over - fields to override
 */
export function makeTool(name: string, over: Partial<CustomMcpTool> = {}): CustomMcpTool {
  return {
    exposed_name: name,
    upstream_name: name,
    state: 'pending',
    read_only_hint: null,
    description_preview: `${name} description`,
    definition_hash: `hash-${name}`,
    ...over,
  };
}

/**
 * An approved npm server named `figma` with two tools.
 * @param over - fields to override
 */
export function makeNpmEntry(over: Partial<CustomMcpEntry> = {}): CustomMcpEntry {
  return {
    name: 'figma',
    service_id: 'custom-figma',
    source: {
      kind: 'npm',
      package: 'figma-developer-mcp',
      version: '0.6.1',
      integrity: 'sha512-AAAA',
    },
    state: 'approved',
    reason: null,
    enabled: true,
    tools_available: true,
    tools: [
      makeTool('get_file', { state: 'allowed', read_only_hint: true }),
      makeTool('post_comment', { read_only_hint: false }),
    ],
    pii_mode: 'tokens',
    workspace_mode: 'none',
    domains: ['api.figma.com:443'],
    domains_blocked_by_policy: [],
    warnings: [],
    host_warning: false,
    host_app_available: null,
    proposed_by_repo: false,
    approved_at: '2026-10-01T00:00:00Z',
    forced: noForced(),
    ...over,
  };
}

/**
 * An approved host server named `desk` on port 3845.
 * @param over - fields to override
 */
export function makeHostEntry(over: Partial<CustomMcpEntry> = {}): CustomMcpEntry {
  return makeNpmEntry({
    name: 'desk',
    service_id: 'custom-desk',
    source: { kind: 'host', port: 3845, path: '/mcp' },
    tools: [],
    tools_available: false,
    domains: [],
    host_warning: true,
    host_app_available: true,
    ...over,
  });
}

/**
 * The list `custom_mcp_get` returns.
 * @param servers - the servers
 * @param over - fields to override
 */
export function makeList(
  servers: CustomMcpEntry[],
  over: Partial<CustomMcpList> = {}
): CustomMcpList {
  return {
    project: CUSTOM_MCP_PROJECT,
    beta_enabled: true,
    managed_disabled: false,
    servers,
    ...over,
  };
}

/**
 * An npm review of `figma-developer-mcp@0.6.1` named `figma`.
 * @param over - fields to override
 */
export function makeNpmPreview(over: Partial<CustomMcpPreview> = {}): CustomMcpPreview {
  return {
    preview_id: 'preview-1',
    expires_at: '2026-10-08T12:00:00Z',
    project: CUSTOM_MCP_PROJECT,
    name: 'figma',
    details: {
      kind: 'npm',
      package: 'figma-developer-mcp',
      version: '0.6.1',
      integrity: 'sha512-AAAA',
      published_at: '2026-09-01T00:00:00.000Z',
      license: 'MIT',
      dependency_count: 42,
      publisher: 'glips',
      maintainers: ['glips'],
      provenance: true,
      previous_version: null,
      previous_publisher: null,
      publisher_changed: false,
      has_install_script: false,
      args: ['--stdio'],
      env_keys: ['FIGMA_API_KEY'],
      image_tag: 'speedwave-mcp-custom-figma:0.6.1-0123456789abcdef',
      before_date: '2026-10-01T00:00:00.000Z',
      lockfile_sha256: 'a'.repeat(64),
    },
    host_warning: false,
    proposed_by_repo: false,
    forced: noForced(),
    warnings: [],
    ...over,
  };
}

/**
 * A host review of port 3845 named `desk`.
 * @param over - fields to override
 */
export function makeHostPreview(over: Partial<CustomMcpPreview> = {}): CustomMcpPreview {
  return makeNpmPreview({
    preview_id: 'preview-host',
    name: 'desk',
    details: { kind: 'host', port: 3845, path: '/mcp', upstream_reachable: true },
    host_warning: true,
    ...over,
  });
}
