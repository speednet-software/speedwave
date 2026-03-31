/**
 * SSOT for user-facing error messages across all MCP workers.
 * All servers import from here — no hardcoded "speedwave setup" strings elsewhere.
 * @module shared/errors
 */

/** Guidance shown when a service is not configured. Private — use helpers below. */
const SETUP_GUIDANCE =
  'Configure this integration in the Speedwave Desktop app (Integrations tab).';

/**
 * Build a "not configured" error message for a given service.
 * @param service - Display name (e.g. "GitLab", "Slack")
 */
export function notConfiguredMessage(service: string): string {
  return `${service} not configured. ${SETUP_GUIDANCE}`;
}

/**
 * Append setup guidance to an action-specific message.
 * @param action - What the user should check (e.g. "Authentication failed. Check your GitLab token.")
 */
export function withSetupGuidance(action: string): string {
  return `${action} ${SETUP_GUIDANCE}`;
}
