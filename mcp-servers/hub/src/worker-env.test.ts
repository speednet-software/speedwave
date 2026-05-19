import { describe, it, expect } from 'vitest';
import { deriveWorkerEnv } from './worker-env.js';

describe('deriveWorkerEnv', () => {
  it('handles no-separator slug', () => {
    expect(deriveWorkerEnv('presale')).toBe('WORKER_PRESALE_URL');
  });

  it('normalizes hyphens to underscores', () => {
    expect(deriveWorkerEnv('my-plugin')).toBe('WORKER_MY_PLUGIN_URL');
  });

  it('normalizes multiple hyphens', () => {
    expect(deriveWorkerEnv('mcp-host-exec')).toBe('WORKER_MCP_HOST_EXEC_URL');
  });

  it('preserves existing underscores', () => {
    expect(deriveWorkerEnv('host_exec')).toBe('WORKER_HOST_EXEC_URL');
  });

  it('handles short slug', () => {
    expect(deriveWorkerEnv('crm')).toBe('WORKER_CRM_URL');
  });

  it('matches Rust SSOT derive_worker_env behavior (crates/speedwave-runtime/src/plugin.rs:431)', () => {
    // Mirrors Rust test cases in plugin.rs:2177-2181
    expect(deriveWorkerEnv('presale')).toBe('WORKER_PRESALE_URL');
    expect(deriveWorkerEnv('my-plugin')).toBe('WORKER_MY_PLUGIN_URL');
    expect(deriveWorkerEnv('crm')).toBe('WORKER_CRM_URL');
  });
});
