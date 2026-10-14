import { describe, it, expect, vi } from 'vitest';

describe('SharePoint test network guard', () => {
  it('rejects a fetch call that the test did not mock', async () => {
    await expect(fetch('https://graph.microsoft.com/v1.0/me')).rejects.toThrow(
      'Unexpected network call in a SharePoint test'
    );
  });

  it('lets a test replace fetch directly for its own duration', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    await expect(fetch('https://graph.microsoft.com/v1.0/me')).resolves.toEqual({ ok: true });
  });

  it('rejects unmocked fetch calls again in the test after one that replaced fetch', async () => {
    expect(vi.isMockFunction(fetch)).toBe(true);
    await expect(fetch('https://graph.microsoft.com/v1.0/me')).rejects.toThrow(
      'Unexpected network call in a SharePoint test'
    );
  });
});
