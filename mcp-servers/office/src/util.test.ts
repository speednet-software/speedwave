/**
 * Tests for the shared utility helpers.
 * @module mcp-office/util.test
 */

import { describe, it, expect } from 'vitest';
import { ignoreError } from './util.js';

describe('ignoreError', () => {
  it('returns undefined and does not throw, suitable as a .catch handler', async () => {
    expect(ignoreError()).toBeUndefined();
    await expect(Promise.reject(new Error('x')).catch(ignoreError)).resolves.toBeUndefined();
  });
});
