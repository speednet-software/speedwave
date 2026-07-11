/**
 * Shared Jira DTO normalisers used by more than one domain module.
 * @module mcp-atlassian/domains/normalizers
 */

import type { JiraTransition, JiraUser } from '../types.js';

/**
 * Map a raw Jira user object (Atlassian REST API shape) to {@link JiraUser}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 * @returns The normalised user.
 */
export function mapUser(raw: unknown): JiraUser {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    account_id: String(o.accountId ?? ''),
    display_name: String(o.displayName ?? ''),
    email_address: o.emailAddress ? String(o.emailAddress) : undefined,
    active: Boolean(o.active ?? true),
  };
}

/**
 * Map a raw Jira workflow transition (Atlassian REST API shape) to {@link JiraTransition}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 * @returns The normalised transition.
 */
export function mapTransition(raw: unknown): JiraTransition {
  const o = (raw ?? {}) as Record<string, unknown>;
  const to = (o.to ?? {}) as Record<string, unknown>;
  return { id: String(o.id ?? ''), name: String(o.name ?? ''), to_status: String(to.name ?? '') };
}
