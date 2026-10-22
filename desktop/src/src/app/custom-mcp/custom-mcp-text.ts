import type {
  CustomMcpEgressDenyReason,
  CustomMcpEgressRefusal,
  CustomMcpEntryState,
  CustomMcpSource,
  CustomPiiMode,
  CustomWorkspaceMode,
} from '../models/custom-mcp';

/** Prefix of every Custom MCP service id. Mirrors Rust `consts::CUSTOM_MCP_SERVICE_PREFIX`. */
export const CUSTOM_MCP_SERVICE_PREFIX = 'custom-';

/** Longest repository or server string the UI shows in one place. */
export const MAX_UNTRUSTED_CHARS = 200;

/** Server name rule. Mirrors Rust `custom_mcp::model::validate_server_name`. */
export const SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

/** Label of everything a repository's `.mcp.json` proposed. */
export const PROPOSED_BY_REPO_LABEL = 'proposed by repository file';

/** Pill text of a field the organization policy forces. */
export const ENFORCED_LABEL = 'Enforced by organization';

/** Pill text of a feature the organization policy turns off. */
export const ORG_DISABLED_LABEL = 'Disabled by your organization';

/** Banner shown wherever a server running on this computer is reviewed or configured. */
export const HOST_WARNING_TEXT =
  'Host server warning. Enabling a server that runs on this computer lets Claude reach every tool it exposes, not only the ones you allow here: on macOS the Claude container can open any port on this machine directly, so the allow list below cannot be enforced until host-port isolation ships. Enable it only if you trust every tool this server offers. Organization admins can disable host servers.';

/** Confirmation a user gives before granting read access to the project. */
export const FILE_READ_CONFIRMATION =
  'This server will read every project file, including .env and credentials.';

/** Confirmation a user gives before granting write access to the project. */
export const FILE_WRITE_CONFIRMATION =
  'This server can change .git/hooks and CI files; code it writes runs on your machine and in CI.';

/** Row text of a tool whose definition changed since the user decided on it. */
export const CHANGED_TOOL_TEXT = 'Definition changed since approval; blocked until you review it.';

/** Note under the read-only preset. */
export const READ_ONLY_PRESET_NOTE = "Based on the server's own readOnlyHint; unverified.";

/** One radio option of a consented setting. */
export interface ChoiceOption<T extends string> {
  /** The wire value. */
  value: T;
  /** What the radio says. */
  label: string;
}

/** The PII radio, safest first. */
export const PII_OPTIONS: readonly ChoiceOption<CustomPiiMode>[] = [
  {
    value: 'tokens',
    label:
      'Send tokens (recommended): personal data stays tokenized; the server never sees names, e-mails or IDs.',
  },
  {
    value: 'plaintext',
    label:
      'Send plaintext: the server receives real values and can forward them to its allowed domains.',
  },
];

/** The project files radio, least access first. */
export const FILE_ACCESS_OPTIONS: readonly ChoiceOption<CustomWorkspaceMode>[] = [
  { value: 'none', label: 'None' },
  { value: 'read_only', label: 'Read-only' },
  { value: 'read_write', label: 'Read & write' },
];

const WORKSPACE_RANK: Record<CustomWorkspaceMode, number> = {
  none: 0,
  read_only: 1,
  read_write: 2,
};

/**
 * Whether the organization's project access limit allows `mode`.
 * @param mode - the access the user picks
 * @param max - the organization's limit, `null` when none is set
 */
export function workspaceModeAllowed(
  mode: CustomWorkspaceMode,
  max: CustomWorkspaceMode | null
): boolean {
  return max === null || WORKSPACE_RANK[mode] <= WORKSPACE_RANK[max];
}

/**
 * The confirmations a project access level needs before it is granted.
 * @param mode - the access the user picks
 */
export function confirmationsFor(mode: CustomWorkspaceMode): string[] {
  if (mode === 'read_only') return [FILE_READ_CONFIRMATION];
  if (mode === 'read_write') return [FILE_READ_CONFIRMATION, FILE_WRITE_CONFIRMATION];
  return [];
}

/**
 * Why a server name is refused, `null` when its shape is valid; the backend has the last word.
 * @param name - the typed name
 */
export function serverNameError(name: string): string | null {
  if (name === '') return 'Enter a name.';
  if (!SERVER_NAME_PATTERN.test(name) || name.endsWith('-') || name.includes('--')) {
    return "Start with a lowercase letter; use at most 31 lowercase letters, digits or single '-'.";
  }
  if (name.endsWith('-up') || name.endsWith('-egress')) {
    return 'A name must not end in -up or -egress.';
  }
  return null;
}

/**
 * Cuts untrusted text to `max` characters, marking the cut.
 * @param value - repository or server text
 * @param max - the most characters shown
 */
export function capText(value: string | null | undefined, max = MAX_UNTRUSTED_CHARS): string {
  if (!value) return '';
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * One-line description of where a configured server runs.
 * @param source - the server's source
 */
export function sourceLabel(source: CustomMcpSource): string {
  return source.kind === 'npm'
    ? `npm ${capText(source.package, 80)}@${capText(source.version, 40)}`
    : `host :${source.port} ${capText(source.path, 80)}`;
}

/**
 * Status pill colour class of a server state.
 * @param state - the server's lifecycle state
 */
export function statePillClass(state: CustomMcpEntryState): string {
  switch (state) {
    case 'approved':
      return 'green';
    case 'pending':
    case 'changed':
      return 'amber';
    default:
      return '';
  }
}

/**
 * Status dot of a server: full when it runs, half for a running host server (its allow list
 * cannot be enforced), empty otherwise.
 * @param entry - the server
 * @param entry.state - its lifecycle state
 * @param entry.enabled - whether it is on
 * @param entry.source - where it runs
 */
export function statusDot(entry: {
  state: CustomMcpEntryState;
  enabled: boolean;
  source: CustomMcpSource;
}): { glyph: string; colour: string } {
  if (entry.state !== 'approved' || !entry.enabled) {
    return { glyph: '○', colour: 'var(--ink-mute)' };
  }
  return entry.source.kind === 'host'
    ? { glyph: '◐', colour: 'var(--amber)' }
    : { glyph: '●', colour: 'var(--green)' };
}

/**
 * Splits a typed `host[:port]` target; the port defaults to 443.
 * @param raw - the typed target
 * @returns the host and port, or `null` when the shape is wrong
 */
export function parseDomainTarget(raw: string): { host: string; port: number } | null {
  const trimmed = raw.trim().toLowerCase();
  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(trimmed);
  if (!match || !match[1].includes('.')) return null;
  const port = match[2] === undefined ? 443 : Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

/**
 * Splits a stored `host:port` domain.
 * @param domain - the stored target
 */
export function splitDomain(domain: string): { host: string; port: number } {
  const idx = domain.lastIndexOf(':');
  return { host: domain.slice(0, idx), port: Number(domain.slice(idx + 1)) };
}

const REASON_TEXT: Record<string, string> = {
  not_approved: 'Waiting for your approval.',
  consent_changed: 'Approved settings changed; review the server again.',
  disabled: 'Turned off.',
  beta_disabled: 'Beta features are off.',
  managed_disabled: 'Your organization turned off custom MCP servers.',
  host_servers_disabled: 'Your organization turned off servers running on this computer.',
  scope_not_allowed: "Your organization does not allow this package's scope.",
  workspace_mode_above_limit: "Its project file access is above your organization's limit.",
  over_limit: 'More servers are on than a project may run.',
  invalid: 'Its configuration is invalid.',
};

/**
 * Human text of an exclusion reason tag, the raw tag when it is unknown.
 * @param tag - the backend's reason tag
 */
export function reasonText(tag: string | null): string {
  if (!tag) return '';
  return REASON_TEXT[tag] ?? capText(tag, 60);
}

/** Helper text over the hosts the egress proxy refused. */
export const BLOCKED_HOSTS_HELP =
  'These hosts were requested by the server. Allow only domains you recognize.';

const EGRESS_REASON_TEXT: Record<CustomMcpEgressDenyReason, string> = {
  bad_request: 'malformed request',
  method: 'not a CONNECT request',
  ip_literal: 'IP literal',
  config_unavailable: 'allowlist not loaded yet',
  not_allowlisted: 'not on the allowlist',
  dns_failure: 'name did not resolve',
  private_address: 'private address',
  connect_failed: 'connection failed',
  not_client_hello: 'not a TLS connection',
  no_sni: 'no server name',
  sni_mismatch: 'server name mismatch',
};

/**
 * One line summing up the refusals that name no host, e.g. `private address ×2, IP literal ×1`.
 * @param other - the per-reason counts
 */
export function otherRefusalsText(other: readonly CustomMcpEgressRefusal[]): string {
  return other
    .map((r) => `${EGRESS_REASON_TEXT[r.reason] ?? capText(r.reason, 40)} ×${r.count}`)
    .join(', ');
}

/**
 * Message shown when a server on this computer does not answer.
 * @param name - the configured server name
 */
export function hostAppNotRunning(name: string): string {
  return `${capText(name, 40)} is not running. Start it and its MCP server, then retry.`;
}

/**
 * The text of a rejected Tauri call.
 * @param e - what the invoke rejected with
 */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
