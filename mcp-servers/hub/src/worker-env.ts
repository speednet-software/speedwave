/**
 * Derive WORKER_<SID>_URL from a service id (hyphens → underscores). Mirrors Rust SSOT
 * `plugin::derive_worker_env` (crates/speedwave-runtime/src/plugin.rs).
 * @param serviceId - service id, may contain hyphens (e.g. 'my-plugin')
 * @returns env var name (e.g. 'WORKER_MY_PLUGIN_URL')
 */
export function deriveWorkerEnv(serviceId: string): string {
  return `WORKER_${serviceId.toUpperCase().replace(/-/g, '_')}_URL`;
}
