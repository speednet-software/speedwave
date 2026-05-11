/**
 * Tests for TokenManager — OAuth token lifecycle: refresh, persistence, error tracking.
 * Covers happy path, retry logic, save-failure handling, and error state accessors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenManager } from './token-manager.js';
import fs from 'fs/promises';

vi.mock('fs/promises');
const mockFs = vi.mocked(fs);

const makeConfig = () => ({
  clientId: 'test-client-id',
  tenantId: 'test-tenant-id',
  tokensDir: '/test/tokens',
});

describe('TokenManager', () => {
  let manager: TokenManager;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new TokenManager(makeConfig());
    fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── getLastTokenSaveError / clearTokenSaveError / getHealthStatus ────────────

  describe('error state accessors', () => {
    it('getLastTokenSaveError returns null on a fresh instance', () => {
      expect(manager.getLastTokenSaveError()).toBeNull();
    });

    it('getHealthStatus returns null tokenSaveError on a fresh instance', () => {
      expect(manager.getHealthStatus()).toEqual({ tokenSaveError: null });
    });

    it('clearTokenSaveError is a no-op when there is no error', () => {
      manager.clearTokenSaveError();
      expect(manager.getLastTokenSaveError()).toBeNull();
    });

    it('getLastTokenSaveError returns the stored error after a failed save', async () => {
      mockFs.writeFile.mockRejectedValue(new Error('EACCES: permission denied'));

      await expect(manager.saveTokensWithRetry('tok', 'ref', 0)).rejects.toThrow(
        'EACCES: permission denied'
      );

      const err = manager.getLastTokenSaveError();
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toBe('EACCES: permission denied');
    });

    it('getHealthStatus returns the error message after a failed save', async () => {
      mockFs.writeFile.mockRejectedValue(new Error('Read-only file system'));

      await expect(manager.saveTokensWithRetry('tok', 'ref', 0)).rejects.toThrow();

      expect(manager.getHealthStatus()).toEqual({
        tokenSaveError: 'Read-only file system',
      });
    });

    it('clearTokenSaveError resets stored error to null', async () => {
      mockFs.writeFile.mockRejectedValue(new Error('disk full'));
      await expect(manager.saveTokensWithRetry('tok', 'ref', 0)).rejects.toThrow();

      expect(manager.getLastTokenSaveError()).not.toBeNull();

      manager.clearTokenSaveError();
      expect(manager.getLastTokenSaveError()).toBeNull();
      expect(manager.getHealthStatus()).toEqual({ tokenSaveError: null });
    });

    it('getHealthStatus returns null after clearTokenSaveError', async () => {
      mockFs.writeFile.mockRejectedValue(new Error('io error'));
      await expect(manager.saveTokensWithRetry('tok', 'ref', 0)).rejects.toThrow();

      manager.clearTokenSaveError();
      expect(manager.getHealthStatus().tokenSaveError).toBeNull();
    });
  });

  // ─── saveTokensWithRetry ──────────────────────────────────────────────────────

  describe('saveTokensWithRetry', () => {
    it('saves access_token and refresh_token on success', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);

      await manager.saveTokensWithRetry('new-access', 'new-refresh');

      expect(mockFs.writeFile).toHaveBeenCalledWith('/test/tokens/access_token', 'new-access', {
        mode: 0o600,
      });
      expect(mockFs.writeFile).toHaveBeenCalledWith('/test/tokens/refresh_token', 'new-refresh', {
        mode: 0o600,
      });
      // Success clears any prior error
      expect(manager.getLastTokenSaveError()).toBeNull();
    });

    it('saves only access_token when refreshToken is undefined', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);

      await manager.saveTokensWithRetry('new-access');

      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      expect(mockFs.writeFile).toHaveBeenCalledWith('/test/tokens/access_token', 'new-access', {
        mode: 0o600,
      });
    });

    it('retries on failure and succeeds on second attempt', async () => {
      // attempt 0: access_token write fails
      // attempt 1: access_token write succeeds, then refresh_token write succeeds
      mockFs.writeFile
        .mockRejectedValueOnce(new Error('transient error'))
        .mockResolvedValueOnce(undefined) // access_token on retry
        .mockResolvedValueOnce(undefined); // refresh_token on retry

      await expect(manager.saveTokensWithRetry('tok', 'ref', 1, 0)).resolves.toBeUndefined();

      // 3 calls total: 1 fail + access_token success + refresh_token success
      expect(mockFs.writeFile).toHaveBeenCalledTimes(3);
      expect(manager.getLastTokenSaveError()).toBeNull();
    });

    it('throws and stores error after all retries exhausted', async () => {
      mockFs.writeFile.mockRejectedValue(new Error('persistent error'));

      await expect(manager.saveTokensWithRetry('tok', 'ref', 2, 0)).rejects.toThrow(
        'persistent error'
      );

      // 3 attempts total (0, 1, 2)
      expect(mockFs.writeFile).toHaveBeenCalledTimes(3);
      expect(manager.getLastTokenSaveError()!.message).toBe('persistent error');
    });

    it('clears lastTokenSaveError on eventual success', async () => {
      // Plant a prior error first
      mockFs.writeFile.mockRejectedValueOnce(new Error('old error'));
      await expect(manager.saveTokensWithRetry('tok', undefined, 0, 0)).rejects.toThrow(
        'old error'
      );
      expect(manager.getLastTokenSaveError()).not.toBeNull();

      // Now succeed — clears the stored error
      mockFs.writeFile.mockResolvedValue(undefined);
      await manager.saveTokensWithRetry('tok2', undefined, 0, 0);
      expect(manager.getLastTokenSaveError()).toBeNull();
    });

    it('wraps non-Error thrown objects in an Error and stores/throws them', async () => {
      // When a non-Error is thrown (e.g. a string), the code converts it:
      //   lastError = error instanceof Error ? error : new Error(String(error))
      // Then throws lastError (the wrapped Error)
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      mockFs.writeFile.mockRejectedValueOnce('string error');

      await expect(manager.saveTokensWithRetry('tok', 'ref', 0, 0)).rejects.toThrow('string error');

      // The lastTokenSaveError is stored as a wrapped Error
      const stored = manager.getLastTokenSaveError();
      expect(stored).toBeInstanceOf(Error);
      expect(stored!.message).toBe('string error');
    });
  });

  // ─── refreshAccessToken ───────────────────────────────────────────────────────

  describe('refreshAccessToken', () => {
    it('returns new access and refresh tokens on success', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      const tokens = await manager.refreshAccessToken('old-refresh');

      expect(tokens.accessToken).toBe('new-access');
      expect(tokens.refreshToken).toBe('new-refresh');
    });

    it('keeps current refresh token when server does not return a new one', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          // no refresh_token
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      const tokens = await manager.refreshAccessToken('keep-this-refresh');

      expect(tokens.accessToken).toBe('new-access');
      expect(tokens.refreshToken).toBe('keep-this-refresh');
    });

    it('throws "Failed to refresh access token" when server returns non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'invalid_grant', error_description: 'expired' }),
      });

      await expect(manager.refreshAccessToken('bad-refresh')).rejects.toThrow(
        'Failed to refresh access token'
      );
    });

    it('throws timeout error when fetch is aborted (AbortError)', async () => {
      fetchMock.mockImplementationOnce(() => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      });

      await expect(manager.refreshAccessToken('refresh-token')).rejects.toThrow(/timeout/i);
    });

    it('fires the token refresh timeout callback via fake timers (line 145)', async () => {
      vi.useFakeTimers();

      // Make fetch hang until signal aborts
      fetchMock.mockImplementationOnce((_url: string, opts: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const refreshPromise = manager.refreshAccessToken('refresh-token');

      // Fire all pending timers so the setTimeout(() => controller.abort(), ...) runs
      vi.runAllTimers();

      await expect(refreshPromise).rejects.toThrow(/timeout/i);
      vi.useRealTimers();
    });

    it('saves access and refresh tokens after successful refresh', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'saved-access',
          refresh_token: 'saved-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      await manager.refreshAccessToken('old-refresh');

      expect(mockFs.writeFile).toHaveBeenCalledWith('/test/tokens/access_token', 'saved-access', {
        mode: 0o600,
      });
      expect(mockFs.writeFile).toHaveBeenCalledWith('/test/tokens/refresh_token', 'saved-refresh', {
        mode: 0o600,
      });
    });

    it('returns tokens even when token save to disk fails (graceful degradation)', async () => {
      mockFs.writeFile.mockRejectedValue(new Error('Read-only mount'));
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'in-memory-access',
          refresh_token: 'in-memory-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      // Should not throw — save failure is logged but tokens are valid in memory
      const tokens = await manager.refreshAccessToken('old-refresh');

      expect(tokens.accessToken).toBe('in-memory-access');
      expect(tokens.refreshToken).toBe('in-memory-refresh');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save refreshed tokens'),
        expect.objectContaining({
          error: 'Read-only mount',
          consequence: expect.stringContaining('Tokens valid in memory'),
        })
      );
    });

    it('logs the error message when save fails with a wrapped Error', async () => {
      // saveTokensWithRetry always wraps non-Errors, so saveError is always an Error instance
      // This verifies the logging path for the error.message accessor
      mockFs.writeFile.mockRejectedValue(new Error('DISK_FULL'));
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      // Still returns tokens (graceful degradation)
      const tokens = await manager.refreshAccessToken('old-refresh');
      expect(tokens.accessToken).toBe('access');

      // The error message is logged
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save refreshed tokens'),
        expect.objectContaining({
          error: 'DISK_FULL',
        })
      );
    });

    it('sends correct OAuth parameters in the request body', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'tok',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      await manager.refreshAccessToken('my-refresh');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('login.microsoftonline.com/test-tenant-id/oauth2/v2.0/token'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );

      const callArgs = fetchMock.mock.calls[0][1];
      const body = callArgs.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('client_id')).toBe('test-client-id');
      expect(body.get('refresh_token')).toBe('my-refresh');
    });
  });
});
