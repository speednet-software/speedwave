/**
 * Access policy: the one place that decides whether a tool call is allowed (ADR-108).
 * Pure over the composed `access` rules the host wrote into policy.json.
 * @module access-policy
 */

import { buildTeachingMessage } from '@speedwave/mcp-shared';
import type { AccessMode, AccessRules } from '@speedwave/policy-engine';
import type { ToolMetadata } from './hub-types.js';
import { getEngine } from './policy.js';

/** Why a call was denied; the audit trail records it verbatim. */
export type DenialReason = 'read-only';

/** Outcome of an access decision: allowed, or denied with the reason and a teaching message. */
export type AccessDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: DenialReason;
      service: string;
      tool: string;
      message: string;
    };

const CUSTOM_SERVICE_PREFIX = 'custom-';

/**
 * Access mode of a service: its own entry, else the default.
 * @param rules - Composed access rules from policy.json
 * @param service - Service name
 */
export function serviceAccessMode(rules: AccessRules, service: string): AccessMode {
  return rules.services[service] ?? rules.default;
}

const OS_SERVICE = 'os';
const OS_CATEGORIES = ['reminders', 'calendar', 'mail', 'notes'] as const;

/**
 * The access rules key of a tool: `os-<category>` for a tool of an OS sub-integration, else its service.
 * @param service - Service name
 * @param osCategory - OS sub-integration of the tool, if any
 */
function accessKey(service: string, osCategory?: string): string {
  return service === OS_SERVICE && osCategory ? `${OS_SERVICE}-${osCategory}` : service;
}

/**
 * The services among `services` whose mode is read-only; the `os` service counts per enabled sub-integration.
 * @param rules - Composed access rules from policy.json
 * @param services - Service names to check
 * @param disabledOs - OS sub-integrations that are switched off
 */
export function readOnlyServices(
  rules: AccessRules,
  services: readonly string[],
  disabledOs: ReadonlySet<string> = new Set()
): string[] {
  return services
    .flatMap((s) =>
      s === OS_SERVICE
        ? OS_CATEGORIES.filter((c) => !disabledOs.has(c)).map((c) => accessKey(s, c))
        : [s]
    )
    .filter((key) => serviceAccessMode(rules, key) === 'read_only');
}

/**
 * The sentence `search_tools` leads with while some service is read-only.
 * @param blocked - Services in read-only mode
 * @returns The sentence, or undefined when `blocked` is empty
 */
export function readOnlyNotice(blocked: readonly string[]): string | undefined {
  if (blocked.length === 0) return undefined;
  return `Read-only mode is on: tools that change data are blocked for ${blocked.join(', ')} and marked blocked below, reads still work.`;
}

/**
 * Why read-only mode blocks this tool, in words for the model.
 * @param service - Service name
 * @param metadata - Tool metadata from the registry
 */
function blockedBecause(service: string, metadata: ToolMetadata): string {
  if (service.startsWith(CUSTOM_SERVICE_PREFIX)) {
    return 'tools of custom MCP servers are blocked entirely in this mode';
  }
  if (!metadata.annotations) {
    return 'it has no read-only annotation';
  }
  return 'it can change data';
}

/**
 * Decide whether the agent may call a tool.
 * @param rules - Composed access rules from policy.json
 * @param metadata - Tool metadata from the registry
 */
export function decideAccess(rules: AccessRules, metadata: ToolMetadata): AccessDecision {
  const { service, name: tool } = metadata;
  if (serviceAccessMode(rules, accessKey(service, metadata.osCategory)) === 'full')
    return { allowed: true };
  if (!service.startsWith(CUSTOM_SERVICE_PREFIX) && metadata.annotations?.readOnlyHint === true) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: 'read-only',
    service,
    tool,
    message: buildTeachingMessage({
      nextStep: `Read-only mode is on for ${service}, so ${service}.${tool} did not run: ${blockedBecause(service, metadata)}. Reads from ${service} still work, use a tool that only reads. Tell the user to turn the mode off in Speedwave Desktop (Project settings, Agent access, Read-only mode) if the change is wanted; an organization policy can lock it.`,
    }),
  };
}

/**
 * Decide with the rules of the loaded policy.json.
 * @param metadata - Tool metadata from the registry
 */
export function checkToolAccess(metadata: ToolMetadata): AccessDecision {
  return decideAccess(getEngine().access, metadata);
}
