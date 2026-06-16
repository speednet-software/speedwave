import { describe, it, expect } from 'vitest';
import { deriveWorkerEnv } from './worker-env.js';

describe('deriveWorkerEnv', () => {
  it('handles single-token slug', () => {
    expect(deriveWorkerEnv('example')).toBe('WORKER_EXAMPLE_URL');
  });

  it('normalizes hyphens to underscores', () => {
    expect(deriveWorkerEnv('my-plugin')).toBe('WORKER_MY_PLUGIN_URL');
  });

  it('normalizes multiple hyphens', () => {
    expect(deriveWorkerEnv('mcp-data-sync')).toBe('WORKER_MCP_DATA_SYNC_URL');
  });

  it('preserves existing underscores', () => {
    expect(deriveWorkerEnv('my_worker')).toBe('WORKER_MY_WORKER_URL');
  });

  it('handles short slug', () => {
    expect(deriveWorkerEnv('crm')).toBe('WORKER_CRM_URL');
  });

  it('matches Rust SSOT derive_worker_env behavior (crates/speedwave-runtime/src/plugin.rs:431)', () => {
    // Mirrors Rust test cases in plugin.rs:2177-2181
    expect(deriveWorkerEnv('example')).toBe('WORKER_EXAMPLE_URL');
    expect(deriveWorkerEnv('my-plugin')).toBe('WORKER_MY_PLUGIN_URL');
    expect(deriveWorkerEnv('crm')).toBe('WORKER_CRM_URL');
  });
});
