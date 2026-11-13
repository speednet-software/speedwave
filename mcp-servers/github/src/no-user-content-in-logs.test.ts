import { describe, it, expect, vi, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { GitHubClient } from './client.js';

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function spyOnConsole(): () => string {
  const spies = [...CONSOLE_METHODS.map((m) => vi.spyOn(console, m).mockImplementation(() => {}))];
  return () =>
    inspect(
      spies.map((s) => s.mock.calls),
      { depth: 8 }
    );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GitHub request log', () => {
  it('keeps the search query of a failed request out of every console method', async () => {
    const logged = spyOnConsole();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'Validation Failed' }), {
            status: 422,
            headers: {
              'content-type': 'application/json',
              'x-github-request-id': 'REQ-997',
            },
          })
      )
    );
    const client = new GitHubClient({ token: 'x' });

    await expect(client.searchCode('SENTINEL-997-query')).rejects.toThrow();

    expect(logged()).not.toContain('SENTINEL-997');
    expect(logged()).toMatch(/GET \/search\/code - 422 with id REQ-997/);
  });
});
