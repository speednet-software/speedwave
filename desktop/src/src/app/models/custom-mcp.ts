/** PII mode of a Custom MCP server's tool arguments. Mirrors Rust `CustomPiiMode`. */
export type CustomPiiMode = 'tokens' | 'plaintext';

/** Project access a Custom MCP server gets at `/workspace`. Mirrors Rust `WorkspaceMode`. */
export type CustomWorkspaceMode = 'none' | 'read_only' | 'read_write';

/** Lifecycle state of a configured server. Mirrors Rust `CustomMcpEntryState`. */
export type CustomMcpEntryState =
  'pending' | 'approved' | 'changed' | 'disabled' | 'unavailable' | 'excluded';

/** What the user sees for one tool. Mirrors Rust `custom_mcp::catalog::ToolState`. */
export type CustomMcpToolState = 'pending' | 'allowed' | 'blocked' | 'changed';

/** A decision the user can record for a tool. Mirrors Rust `ToolDecisionState`. */
export type CustomMcpToolDecisionState = 'allowed' | 'blocked' | 'pending';

/** Readiness of a repository proposal. Mirrors Rust `custom_mcp::detect::ProposalStatus`. */
export type CustomMcpProposalStatus = 'ready' | 'needs_exact_version' | 'remote' | 'unsupported';

/** Fields the organization policy forces. */
export interface CustomMcpForced {
  pii_mode: CustomPiiMode | null;
  workspace_mode_max: CustomWorkspaceMode | null;
  host_servers_disabled: boolean;
  allowed_domains: string[] | null;
  allowed_scopes: string[] | null;
}

/** A pinned npm package. */
export interface CustomMcpNpmSource {
  kind: 'npm';
  package: string;
  version: string;
  integrity: string;
}

/** An HTTP MCP server already running on this computer. */
export interface CustomMcpHostSource {
  kind: 'host';
  port: number;
  path: string;
}

/** Where a configured server runs. */
export type CustomMcpSource = CustomMcpNpmSource | CustomMcpHostSource;

/** One tool of a server, as the hub last listed it. */
export interface CustomMcpTool {
  exposed_name: string;
  upstream_name: string;
  state: CustomMcpToolState;
  read_only_hint: boolean | null;
  description_preview: string;
  definition_hash: string;
}

/** One configured Custom MCP server. */
export interface CustomMcpEntry {
  name: string;
  service_id: string;
  source: CustomMcpSource;
  state: CustomMcpEntryState;
  reason: string | null;
  enabled: boolean;
  tools_available: boolean;
  tools: CustomMcpTool[];
  pii_mode: CustomPiiMode;
  workspace_mode: CustomWorkspaceMode;
  domains: string[];
  domains_blocked_by_policy: string[];
  warnings: string[];
  host_warning: boolean;
  host_app_available: boolean | null;
  proposed_by_repo: boolean;
  approved_at: string | null;
  forced: CustomMcpForced;
}

/** Every Custom MCP server of a project. */
export interface CustomMcpList {
  project: string;
  beta_enabled: boolean;
  managed_disabled: boolean;
  servers: CustomMcpEntry[];
}

/** Why the egress proxy refused a connection. Mirrors Rust `egress_log::EgressDenyReason`. */
export type CustomMcpEgressDenyReason =
  | 'bad_request'
  | 'method'
  | 'ip_literal'
  | 'config_unavailable'
  | 'not_allowlisted'
  | 'dns_failure'
  | 'private_address'
  | 'connect_failed'
  | 'not_client_hello'
  | 'no_sni'
  | 'sni_mismatch';

/** A host the server asked for that is not on its allowlist, as the egress log shows it. */
export interface CustomMcpDeniedHost {
  host: string;
  port: number;
  count: number;
  allowed_by_policy: boolean;
}

/** How many connections the egress proxy refused for one other reason. */
export interface CustomMcpEgressRefusal {
  reason: CustomMcpEgressDenyReason;
  count: number;
}

/** Connections a server's egress proxy refused since the container started. */
export interface CustomMcpEgressDenials {
  container_running: boolean;
  hosts: CustomMcpDeniedHost[];
  other: CustomMcpEgressRefusal[];
}

/** An npm package proposed by `.mcp.json`. */
export interface CustomMcpProposalNpmSource {
  kind: 'npm';
  package: string;
  version: string | null;
}

/** A remote server proposed by `.mcp.json` (unsupported for now). */
export interface CustomMcpProposalRemoteSource {
  kind: 'remote';
  host: string;
}

/** Any other `.mcp.json` entry. */
export interface CustomMcpProposalUnsupportedSource {
  kind: 'unsupported';
  command: string;
}

/** What a `.mcp.json` entry asks to run. */
export type CustomMcpProposalSource =
  CustomMcpProposalNpmSource | CustomMcpProposalRemoteSource | CustomMcpProposalUnsupportedSource;

/** One server a repository proposes; every string is untrusted repository text. */
export interface CustomMcpProposal {
  key: string;
  suggested_name: string | null;
  source: CustomMcpProposalSource;
  status: CustomMcpProposalStatus;
  args: string[];
  env_keys: string[];
  refused_env_keys: string[];
  builtin_integration: string | null;
  reason: string | null;
  configured_as: string | null;
}

/** Review facts of an npm package. */
export interface CustomMcpNpmPreview {
  kind: 'npm';
  package: string;
  version: string;
  integrity: string;
  published_at: string;
  license: string | null;
  dependency_count: number;
  publisher: string | null;
  maintainers: string[];
  provenance: boolean;
  previous_version: string | null;
  previous_publisher: string | null;
  publisher_changed: boolean;
  has_install_script: boolean;
  args: string[];
  env_keys: string[];
  image_tag: string;
  before_date: string;
  lockfile_sha256: string;
}

/** Review facts of a host server. */
export interface CustomMcpHostPreview {
  kind: 'host';
  port: number;
  path: string;
  upstream_reachable: boolean;
}

/** Review facts by source kind. */
export type CustomMcpPreviewDetails = CustomMcpNpmPreview | CustomMcpHostPreview;

/** A pending review, approved by `preview_id`. */
export interface CustomMcpPreview {
  preview_id: string;
  expires_at: string;
  project: string;
  name: string;
  details: CustomMcpPreviewDetails;
  host_warning: boolean;
  proposed_by_repo: boolean;
  forced: CustomMcpForced;
  warnings: string[];
}

/** An npm package to review. */
export interface CustomMcpNpmPreviewRequest {
  kind: 'npm';
  name: string;
  package: string;
  version: string;
  args: string[];
  env_keys: string[];
}

/** A host server to review. */
export interface CustomMcpHostPreviewRequest {
  kind: 'host';
  name: string;
  port: number;
  path: string;
}

/** What `custom_mcp_preview` reviews. */
export type CustomMcpPreviewRequest = CustomMcpNpmPreviewRequest | CustomMcpHostPreviewRequest;

/** The user's choices on the review screen. */
export interface CustomMcpApproveChoices {
  name: string;
  pii_mode: CustomPiiMode;
  workspace_mode: CustomWorkspaceMode;
  env_values: Record<string, string>;
}

/** A tool decision, pinned to the definition hash the user reviewed. */
export interface CustomMcpToolDecision {
  upstream_name: string;
  state: CustomMcpToolDecisionState;
  definition_hash: string;
}
