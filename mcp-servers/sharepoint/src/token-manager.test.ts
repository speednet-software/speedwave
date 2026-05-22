/**
 * Health-status accessor tests for TokenManager (post-ADR-060).
 *
 * Refresh logic moved to the host-side `oauth` worker — those code paths are
 * tested in `mcp-servers/shared/src/oauth-client.test.ts`. The SharePoint
 * worker's own refresh round-trip is tested in `client.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { TokenManager } from './token-manager.js';

describe('TokenManager (health-only after ADR-060)', () => {
  it('starts with no error', () => {
    const tm = new TokenManager();
    expect(tm.getLastTokenSaveError()).toBeNull();
    expect(tm.getHealthStatus()).toEqual({ tokenSaveError: null });
  });

  it('exposes a recorded error on the health endpoint', () => {
    const tm = new TokenManager();
    const err = new Error('refresh worker rejected request');
    tm.setLastTokenSaveError(err);
    expect(tm.getLastTokenSaveError()?.message).toBe('refresh worker rejected request');
    expect(tm.getHealthStatus().tokenSaveError).toBe('refresh worker rejected request');
  });

  it('clears the recorded error', () => {
    const tm = new TokenManager();
    tm.setLastTokenSaveError(new Error('boom'));
    tm.clearTokenSaveError();
    expect(tm.getLastTokenSaveError()).toBeNull();
    expect(tm.getHealthStatus()).toEqual({ tokenSaveError: null });
  });
});
