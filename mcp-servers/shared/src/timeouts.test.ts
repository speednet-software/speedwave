/**
 * Tests for TIMEOUTS module - SSOT for timeout configuration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TIMEOUTS } from './timeouts.js';

describe('timeouts', () => {
  describe('TIMEOUTS keys', () => {
    it('should export all required timeout keys', () => {
      expect(TIMEOUTS).toHaveProperty('API_CALL_MS');
      expect(TIMEOUTS).toHaveProperty('TOKEN_REFRESH_MS');
      expect(TIMEOUTS).toHaveProperty('HEALTH_CHECK_MS');
      expect(TIMEOUTS).toHaveProperty('CACHE_TTL_MS');
      expect(TIMEOUTS).toHaveProperty('MIN_MS');
      expect(TIMEOUTS).toHaveProperty('EXECUTION_MS');
      expect(TIMEOUTS).toHaveProperty('WORKER_REQUEST_MS');
      expect(TIMEOUTS).toHaveProperty('LONG_OPERATION_MS');
      expect(TIMEOUTS).toHaveProperty('ASYNC_JOB_MS');
    });

    it('should have exactly 11 timeout keys', () => {
      expect(Object.keys(TIMEOUTS)).toHaveLength(11);
    });
  });

  describe('default values (no env var)', () => {
    it('API_CALL_MS is 30000 (30s)', () => {
      expect(TIMEOUTS.API_CALL_MS).toBe(30000);
    });

    it('TOKEN_REFRESH_MS is 30000 (30s)', () => {
      expect(TIMEOUTS.TOKEN_REFRESH_MS).toBe(30000);
    });

    it('HEALTH_CHECK_MS is 5000 (5s)', () => {
      expect(TIMEOUTS.HEALTH_CHECK_MS).toBe(5000);
    });

    it('CACHE_TTL_MS is 60000 (1 min)', () => {
      expect(TIMEOUTS.CACHE_TTL_MS).toBe(60000);
    });

    it('MIN_MS is 1000 (1s)', () => {
      expect(TIMEOUTS.MIN_MS).toBe(1000);
    });

    it('EXECUTION_MS is 120000 (2 min, based on default BASE_MS)', () => {
      expect(TIMEOUTS.EXECUTION_MS).toBe(120000);
    });

    it('WORKER_REQUEST_MS is 120000 (2 min, based on default BASE_MS)', () => {
      expect(TIMEOUTS.WORKER_REQUEST_MS).toBe(120000);
    });

    it('LONG_OPERATION_MS is 600000 (10 min default, BASE_MS * 5)', () => {
      expect(TIMEOUTS.LONG_OPERATION_MS).toBe(600000);
    });

    it('ASYNC_JOB_MS is 900000 (15 min default, BASE_MS * 7.5)', () => {
      expect(TIMEOUTS.ASYNC_JOB_MS).toBe(900000);
    });
  });

  describe('all values are positive numbers', () => {
    it('all timeout values should be positive integers', () => {
      for (const [key, value] of Object.entries(TIMEOUTS)) {
        expect(typeof value).toBe('number');
        expect(value).toBeGreaterThan(0);
        expect(Number.isInteger(value)).toBe(true);
      }
    });
  });

  describe('SPEEDWAVE_TIMEOUT_MS env var', () => {
    const originalEnv = process.env.SPEEDWAVE_TIMEOUT_MS;

    afterEach(() => {
      // Restore original env
      if (originalEnv !== undefined) {
        process.env.SPEEDWAVE_TIMEOUT_MS = originalEnv;
      } else {
        delete process.env.SPEEDWAVE_TIMEOUT_MS;
      }
    });

    it('should use env var value when set', async () => {
      process.env.SPEEDWAVE_TIMEOUT_MS = '60000';
      vi.resetModules();

      const { TIMEOUTS: freshTimeouts } = await import('./timeouts.js');

      // Values derived from BASE_MS should reflect the env var
      expect(freshTimeouts.EXECUTION_MS).toBe(60000);
      expect(freshTimeouts.WORKER_REQUEST_MS).toBe(60000);
      expect(freshTimeouts.LONG_OPERATION_MS).toBe(300000); // 60000 * 5
      expect(freshTimeouts.ASYNC_JOB_MS).toBe(450000); // 60000 * 7.5
    });

    it('should keep fixed values unchanged regardless of env var', async () => {
      process.env.SPEEDWAVE_TIMEOUT_MS = '60000';
      vi.resetModules();

      const { TIMEOUTS: freshTimeouts } = await import('./timeouts.js');

      // Fixed values should not change
      expect(freshTimeouts.API_CALL_MS).toBe(30000);
      expect(freshTimeouts.TOKEN_REFRESH_MS).toBe(30000);
      expect(freshTimeouts.HEALTH_CHECK_MS).toBe(5000);
      expect(freshTimeouts.CACHE_TTL_MS).toBe(60000);
      expect(freshTimeouts.MIN_MS).toBe(1000);
    });

    it('should fallback to default when env var is non-numeric', async () => {
      process.env.SPEEDWAVE_TIMEOUT_MS = 'invalid';
      vi.resetModules();

      const { TIMEOUTS: freshTimeouts } = await import('./timeouts.js');

      // Invalid values should fall back to default 120000
      expect(freshTimeouts.EXECUTION_MS).toBe(120000);
      expect(freshTimeouts.WORKER_REQUEST_MS).toBe(120000);
    });

    it('should fallback to default when env var is empty string', async () => {
      process.env.SPEEDWAVE_TIMEOUT_MS = '';
      vi.resetModules();

      const { TIMEOUTS: freshTimeouts } = await import('./timeouts.js');

      // Empty string should fall back to default
      expect(freshTimeouts.EXECUTION_MS).toBe(120000);
      expect(freshTimeouts.WORKER_REQUEST_MS).toBe(120000);
    });

    it('should fallback to default for negative values', async () => {
      process.env.SPEEDWAVE_TIMEOUT_MS = '-1000';
      vi.resetModules();

      const { TIMEOUTS: freshTimeouts } = await import('./timeouts.js');

      // Negative values are invalid and should fall back to default
      expect(freshTimeouts.EXECUTION_MS).toBe(120000);
      expect(freshTimeouts.WORKER_REQUEST_MS).toBe(120000);
    });

    it('should fallback to default for zero value', async () => {
      process.env.SPEEDWAVE_TIMEOUT_MS = '0';
      vi.resetModules();

      const { TIMEOUTS: freshTimeouts } = await import('./timeouts.js');

      // Zero timeout is invalid and should fall back to default
      expect(freshTimeouts.EXECUTION_MS).toBe(120000);
      expect(freshTimeouts.WORKER_REQUEST_MS).toBe(120000);
    });

    it('should handle floating point by truncating (if positive)', async () => {
      process.env.SPEEDWAVE_TIMEOUT_MS = '123.456';
      vi.resetModules();

      const { TIMEOUTS: freshTimeouts } = await import('./timeouts.js');

      // parseInt truncates floating point values to integer
      expect(freshTimeouts.EXECUTION_MS).toBe(123);
      expect(freshTimeouts.WORKER_REQUEST_MS).toBe(123);
    });

    it('should handle values with leading/trailing spaces', async () => {
      process.env.SPEEDWAVE_TIMEOUT_MS = '  90000  ';
      vi.resetModules();

      const { TIMEOUTS: freshTimeouts } = await import('./timeouts.js');

      // parseInt handles whitespace
      expect(freshTimeouts.EXECUTION_MS).toBe(90000);
    });
  });

  describe('timeout keys are valid', () => {
    it('should have all expected keys defined as numbers', () => {
      const keys = [
        'API_CALL_MS',
        'TOKEN_REFRESH_MS',
        'HEALTH_CHECK_MS',
        'CACHE_TTL_MS',
        'MIN_MS',
        'EXECUTION_MS',
        'WORKER_REQUEST_MS',
        'LONG_OPERATION_MS',
        'ASYNC_JOB_MS',
      ] as const;

      keys.forEach((key) => {
        expect(TIMEOUTS[key]).toBeDefined();
        expect(typeof TIMEOUTS[key]).toBe('number');
      });
    });
  });
});
