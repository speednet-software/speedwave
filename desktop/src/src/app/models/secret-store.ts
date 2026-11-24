/** Health of the encrypted secret store; mirrors the `state` of the Rust `SecretStoreStatus`. */
export type SecretStoreState = 'ready' | 'keyMissing' | 'plaintextInStore' | 'keyUnreadable';

/** One integration whose encrypted credentials lost their key. */
export interface SecretStoreIntegration {
  project: string;
  service: string;
}

/** Result of `get_secret_store_status` and `reset_secret_store`. */
export interface SecretStoreStatus {
  state: SecretStoreState;
  integrations: SecretStoreIntegration[];
  plaintextCount: number;
  unreadable: string[];
}

/** Integrations of one project that are affected by the missing key. */
export interface SecretStoreProjectGroup {
  project: string;
  services: string[];
}

const SECRET_STORE_STATES: readonly string[] = [
  'ready',
  'keyMissing',
  'plaintextInStore',
  'keyUnreadable',
];

/**
 * Narrows an IPC payload to a well-formed status; anything else is treated as "no status".
 * @param value - Raw value returned by the backend.
 */
export function isSecretStoreStatus(value: unknown): value is SecretStoreStatus {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['state'] === 'string' &&
    SECRET_STORE_STATES.includes(candidate['state']) &&
    typeof candidate['plaintextCount'] === 'number' &&
    Array.isArray(candidate['integrations']) &&
    Array.isArray(candidate['unreadable'])
  );
}

/**
 * Groups affected integrations by project, projects and services in input order without repeats.
 * @param integrations - Integrations listed by the backend.
 */
export function groupByProject(
  integrations: readonly SecretStoreIntegration[]
): SecretStoreProjectGroup[] {
  const groups = new Map<string, string[]>();
  for (const { project, service } of integrations) {
    const services = groups.get(project) ?? [];
    if (!services.includes(service)) services.push(service);
    groups.set(project, services);
  }
  return [...groups].map(([project, services]) => ({ project, services }));
}
