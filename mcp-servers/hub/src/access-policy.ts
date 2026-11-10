import { buildTeachingMessage } from '@speedwave/mcp-shared';
import { getAccessRules, type AccessMode, type AccessRules } from './access-config.js';
import { OS_CATEGORIES, type DenialReason, type ToolMetadata } from './hub-types.js';

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

const OS_SERVICE = 'os';

const OS_CATEGORY_LABELS = {
  reminders: 'Reminders',
  calendar: 'Calendar',
  mail: 'Mail',
  notes: 'Notes',
} as const;

/**
 * Decide with the access rules loaded at startup.
 * @param metadata - Tool metadata from the registry
 * @returns Allowed, or denied with a teaching message
 */
export function checkToolAccess(metadata: ToolMetadata): AccessDecision {
  return decideAccess(getAccessRules(), metadata);
}

/**
 * Decide whether the agent may call a tool.
 * @param rules - Composed access rules
 * @param metadata - Tool metadata from the registry
 * @returns Allowed, or denied with a teaching message
 */
export function decideAccess(rules: AccessRules, metadata: ToolMetadata): AccessDecision {
  const { service, name: tool } = metadata;
  if (toolAccessMode(rules, metadata) === 'full') return { allowed: true };
  if (metadata.annotations?.readOnlyHint === true) return { allowed: true };
  return {
    allowed: false,
    reason: 'read-only',
    service,
    tool,
    message: buildTeachingMessage({
      nextStep: `Read-only mode is on for ${deniedLabel(metadata)}, so ${service}.${tool} did not run: ${blockedBecause(metadata)}. Reads still work. ${turnOffHint(rules, metadata)}`,
    }),
  };
}

/**
 * The services among `services` whose mode is read-only; `os` is listed with its read-only sub-integrations.
 * @param rules - Composed access rules
 * @param services - Service names to check
 * @param disabledOs - OS sub-integrations that are switched off
 * @returns Service names, `os` as `os (mail, calendar)`
 */
export function readOnlyServices(
  rules: AccessRules,
  services: readonly string[],
  disabledOs: ReadonlySet<string> = new Set()
): string[] {
  return services.flatMap((s) => {
    if (s !== OS_SERVICE) return isReadOnly(rules, s) ? [s] : [];
    const categories = OS_CATEGORIES.filter(
      (c) => !disabledOs.has(c) && isReadOnly(rules, osKey(c))
    );
    return categories.length > 0 ? [`${OS_SERVICE} (${categories.join(', ')})`] : [];
  });
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

function toolAccessMode(rules: AccessRules, metadata: ToolMetadata): AccessMode {
  if (metadata.service !== OS_SERVICE) return serviceAccessMode(rules, metadata.service);
  if (metadata.osCategory) return serviceAccessMode(rules, osKey(metadata.osCategory));
  return OS_CATEGORIES.some((c) => isReadOnly(rules, osKey(c))) ? 'read_only' : 'full';
}

function serviceAccessMode(rules: AccessRules, service: string): AccessMode {
  return rules.services[service] ?? rules.default;
}

function isReadOnly(rules: AccessRules, service: string): boolean {
  return serviceAccessMode(rules, service) === 'read_only';
}

function osKey(category: string): string {
  return `${OS_SERVICE}-${category}`;
}

function deniedLabel(metadata: ToolMetadata): string {
  return metadata.osCategory ? OS_CATEGORY_LABELS[metadata.osCategory] : metadata.service;
}

function blockedBecause(metadata: ToolMetadata): string {
  return metadata.annotations ? 'it can change data' : 'it has no read-only annotation';
}

function turnOffHint(rules: AccessRules, metadata: ToolMetadata): string {
  const perService = modeEntryKeys(metadata).some((key) => rules.services[key] === 'read_only');
  return perService
    ? 'Turn it off in Speedwave Desktop: the Always read-only switch of this integration.'
    : "Turn it off in Speedwave Desktop: Settings, Read-only integrations, and this integration's Always read-only switch if on. The organization may enforce the mode.";
}

function modeEntryKeys(metadata: ToolMetadata): string[] {
  if (metadata.service !== OS_SERVICE) return [metadata.service];
  return metadata.osCategory ? [osKey(metadata.osCategory)] : OS_CATEGORIES.map(osKey);
}
