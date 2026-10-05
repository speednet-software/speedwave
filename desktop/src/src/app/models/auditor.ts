/** What Auditor (the organisation's AI control point) applies on this machine — `get_auditor_status`. */

/** A use case's evidence status in Auditor's registry (its approval) and its risk category. */
export interface AuditorCompliance {
  state: 'AWAITING_PROFILES' | 'INCOMPLETE' | 'COMPLETE' | 'NOT_REGISTERED' | string;
  open?: number;
  requirementsOpen?: number;
  documentsMissing?: number;
  risksOverAppetite?: number;
  riskCategory?: string | null;
}

/** An AI deployment registered in Auditor (where a project's requests go). */
export interface AuditorDeployment {
  id: string;
  name: string | null;
  deploymentType?: string | null;
  providerName?: string | null;
  providerCode?: string | null;
  models?: string[];
  region?: string | null;
  dataScope?: string | null;
}

/** A use case placed on this machine, as Auditor attributes and judges it. */
export interface AuditorUseCase {
  node_id: string;
  name: string | null;
  attribution?: string;
  state?: string;
  reason?: string | null;
  compliance?: AuditorCompliance | null;
}

/** What the gateway applies to one project: its use case, deployment and models. */
export interface AuditorProject {
  name: string | null;
  use_case: AuditorUseCase | null;
  deployment: AuditorDeployment | null;
  models: string[];
  default_model: string | null;
  pinned: boolean;
  access: 'ALLOWED' | 'SUSPENDED' | string;
}

/** The answer of `get_auditor_status`; `managed: false` = no Auditor policy on the machine. */
export interface AuditorStatus {
  managed: boolean;
  reachable: boolean;
  error: string | null;
  auditor_url: string | null;
  agent_version: string | null;
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
  deployments: AuditorDeployment[];
  use_cases: AuditorUseCase[];
  project: AuditorProject | null;
  package_version: string | null;
}

/** How a status reads: fine, needs attention, blocking, unknown. */
export type Tone = 'ok' | 'warn' | 'bad' | 'none';

/**
 * The registry's approval of a use case, in the words Auditor uses.
 * @param c - The use case's evidence status.
 * @returns The label.
 */
export function complianceLabel(c: AuditorCompliance | null | undefined): string {
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
export function complianceTone(c: AuditorCompliance | null | undefined): Tone {
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
export function deploymentLabel(d: AuditorDeployment | null | undefined): string {
  if (!d) return '—';
  const kind =
    d.deploymentType === 'SUBSCRIPTION' ? 'subscription' : d.deploymentType?.toLowerCase();
  return [d.name, d.providerName, kind, d.region].filter(Boolean).join(' · ');
}
