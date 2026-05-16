/**
 * Derive WORKER_<SID>_URL env var name from a service id.
 * Mirrors Rust SSOT `plugin::derive_worker_env` (crates/speedwave-runtime/src/plugin.rs:431).
 * Hyphens normalize to underscores so `my-plugin` → `WORKER_MY_PLUGIN_URL`.
 * @param serviceId - service id, may contain hyphens (e.g. 'my-plugin')
 * @returns env var name (e.g. 'WORKER_MY_PLUGIN_URL')
 */
export function deriveWorkerEnv(serviceId: string): string {
  return `WORKER_${serviceId.toUpperCase().replace(/-/g, '_')}_URL`;
}
