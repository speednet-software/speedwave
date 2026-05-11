/**
 * Tests for the `withValidation` tool-handler wrapper.
 */

import { describe, it, expect, vi } from 'vitest';
import { withValidation } from './validation.js';
import { AtlassianClient } from '../client.js';
import { ScopeError } from '../scope.js';

const FAKE_CLIENT = {} as AtlassianClient;

describe('withValidation', () => {
  it('returns a not-configured error when the client is null (handler never invoked)', async () => {
    const handler = vi.fn();
    const wrapped = withValidation(null, handler);
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not configured|configure/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes the client and params through to the handler on success', async () => {
    const wrapped = withValidation(FAKE_CLIENT, async (c, p: { x: number }) => {
      expect(c).toBe(FAKE_CLIENT);
      return { content: [{ type: 'text' as const, text: String(p.x) }] };
    });
    const res = await wrapped({ x: 7 });
    expect(res).toEqual({ content: [{ type: 'text', text: '7' }] });
  });

  it('turns a thrown Error into a sanitized error result', async () => {
    const wrapped = withValidation(FAKE_CLIENT, async () => {
      throw new Error('boom near ATATT3xLEAKEDtokenABCDEFGHIJ1234567890');
    });
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/REDACTED_ATLASSIAN_TOKEN/);
    expect(res.content[0].text).not.toMatch(/ATATT3xLEAKED/);
  });

  it('passes a ScopeError message through verbatim', async () => {
    const wrapped = withValidation(FAKE_CLIENT, async () => {
      throw new ScopeError("Jira project 'OTHER' is outside the allowed list (PROJ)");
    });
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('outside the allowed list (PROJ)');
  });
});
