/** What the organisation's management provider applies on this machine — `get_management_status` (ADR-091). */

/** A use case's evidence status in the provider's registry (its approval) and its risk category. */
export interface ManagedCompliance {
  state: 'AWAITING_PROFILES' | 'INCOMPLETE' | 'COMPLETE' | 'NOT_REGISTERED' | string;
  open?: number;
  requirementsOpen?: number;
  documentsMissing?: number;
  risksOverAppetite?: number;
  riskCategory?: string | null;
}

/** An AI deployment registered with the provider (where a project's requests go). */
export interface ManagedDeployment {
  id: string;
  name: string | null;
  deploymentType?: string | null;
  providerName?: string | null;
  providerCode?: string | null;
  models?: string[];
  region?: string | null;
  dataScope?: string | null;
}

/** A use case placed on this machine, as the provider attributes and judges it. */
export interface ManagedUseCase {
  node_id: string;
  name: string | null;
  attribution?: string;
  state?: string;
  reason?: string | null;
  compliance?: ManagedCompliance | null;
}

/** What the gateway applies to one project: its use case, deployment and models. */
export interface ManagedProject {
  name: string | null;
  use_case: ManagedUseCase | null;
  deployment: ManagedDeployment | null;
  models: string[];
  default_model: string | null;
  pinned: boolean;
  access: 'ALLOWED' | 'SUSPENDED' | string;
}

/** The answer of `get_management_status`; `managed: false` = no managed policy on the machine. */
export interface ManagementStatus {
  managed: boolean;
  reachable: boolean;
  error: string | null;
  /** The management provider's name. */
  provider: string | null;
  console_url: string | null;
  status_url: string | null;
  latency_ms: number | null;
  checked_at: string | null;
  organization: string | null;
  host: { id?: string; name?: string | null; hostType?: string | null } | null;
  access: {
    state?: string;
    mode?: string;
    reason?: string | null;
    models?: string[];
    pinned_model?: string | null;
    default_model?: string | null;
  } | null;
  deployments: ManagedDeployment[];
  use_cases: ManagedUseCase[];
  project: ManagedProject | null;
  package_version: string | null;
}

/** How a status reads: fine, needs attention, blocking, unknown. */
export type Tone = 'ok' | 'warn' | 'bad' | 'none';

/**
 * The registry's approval of a use case, in the provider's words.
 * @param c - The use case's evidence status.
 * @returns The label.
 */
export function complianceLabel(c: ManagedCompliance | null | undefined): string {
  if (!c) return 'Compliance unknown';
  switch (c.state) {
    case 'COMPLETE':
      return 'Evidence complete';
    case 'INCOMPLETE':
      return `Evidence incomplete · ${c.open ?? 0} open`;
    case 'AWAITING_PROFILES':
      return 'Awaiting profiles';
    case 'NOT_REGISTERED':
      return 'Not in the registry';
    default:
      return c.state;
  }
}

/**
 * How a use case's compliance reads.
 * @param c - The use case's evidence status.
 * @returns The tone.
 */
export function complianceTone(c: ManagedCompliance | null | undefined): Tone {
  if (!c) return 'none';
  if (c.riskCategory === 'UNACCEPTABLE') return 'bad';
  if (c.state === 'COMPLETE') return 'ok';
  if (c.state === 'NOT_REGISTERED') return 'bad';
  return 'warn';
}

/**
 * The risk category, in words.
 * @param category - The category code (NOT_CLASSIFIED, MINIMAL, LIMITED, HIGH, UNACCEPTABLE).
 * @returns The label.
 */
export function riskLabel(category: string | null | undefined): string {
  if (!category || category === 'NOT_CLASSIFIED') return 'Not classified';
  return category.charAt(0) + category.slice(1).toLowerCase().replace(/_/g, ' ');
}

/**
 * A deployment in one line: name · provider · kind · region.
 * @param d - The deployment.
 * @returns The label.
 */
export function deploymentLabel(d: ManagedDeployment | null | undefined): string {
  if (!d) return '—';
  const kind =
    d.deploymentType === 'SUBSCRIPTION' ? 'subscription' : d.deploymentType?.toLowerCase();
  return [d.name, d.providerName, kind, d.region].filter(Boolean).join(' · ');
}

/** Allow or deny, as the organisation's policy says (ADR-091). */
export type PolicyAccess = 'allow' | 'deny';

/** A block of the policy: the default for a name no rule names, and a rule per name or key. */
export interface ManagedAccessList {
  default: PolicyAccess;
  rules: Record<string, PolicyAccess>;
}

/** The answer of `get_managed_access`: what the organisation's policy lets run on this machine. */
export interface ManagedAccess {
  managed: boolean;
  provider: string | null;
  error: string | null;
  projects: ManagedAccessList | null;
  services: ManagedAccessList | null;
  agents: ManagedAccessList | null;
}

/** The lamp beside a managed project, service, integration, plugin or agent. */
export type ManagedLamp = 'allowed' | 'not-allowed';
