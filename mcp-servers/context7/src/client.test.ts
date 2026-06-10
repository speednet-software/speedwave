/**
 * Tests for Context7 REST client.
 *
 * Uses undici's built-in MockAgent — same approach as official undici docs,
 * no extra dependency on msw/nock. Each test creates a fresh mock and pins
 * it as the client's dispatcher so global state never leaks between tests.
 */

import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { Context7Client, Context7Error, clampTokens } from './client.js';
import { MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS } from './consts.js';

const ORIGIN = 'https://context7.com';

/** Build a MockAgent → Context7Client pair so tests can intercept HTTP. */
function makeClient(apiKey?: string): {
  client: Context7Client;
  mock: ReturnType<MockAgent['get']>;
  agent: MockAgent;
} {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const mock = agent.get(ORIGIN);
  const client = new Context7Client({ apiKey, dispatcher: agent });
  return { client, mock, agent };
}

describe('Context7Client.searchLibraries', () => {
  it('returns parsed results and tier on 200', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=hooks', method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          results: [{ id: '/facebook/react', title: 'React', description: 'UI library' }],
        }),
        { headers: { 'content-type': 'application/json', 'context7-quota-tier': 'anonymous' } }
      );

    const { data, tier } = await client.searchLibraries('react', 'hooks');
    expect(tier).toBe('anonymous');
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('/facebook/react');
  });

  it('caps results to top-10 even when server returns more', async () => {
    const { client, mock } = makeClient();
    const big = Array.from({ length: 25 }, (_, i) => ({
      id: `/owner/lib${i}`,
      title: `Lib ${i}`,
      description: '',
    }));
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=hooks', method: 'GET' })
      .reply(200, JSON.stringify({ results: big }), {
        headers: { 'content-type': 'application/json' },
      });

    const { data } = await client.searchLibraries('react', 'hooks');
    expect(data).toHaveLength(10);
  });

  it('sends Authorization header when api key set', async () => {
    const { client, mock } = makeClient('ctx7sk_test');
    mock
      .intercept({
        path: '/api/v2/libs/search?libraryName=react&query=h',
        method: 'GET',
        headers: { authorization: 'Bearer ctx7sk_test' },
      })
      .reply(200, JSON.stringify({ results: [] }));

    // If the header was missing, the intercept would not match and undici
    // would throw "no matching interceptor" — assertion via behaviour.
    await client.searchLibraries('react', 'h');
  });

  it('omits Authorization header in anonymous mode', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({
        path: '/api/v2/libs/search?libraryName=react&query=h',
        method: 'GET',
        headers: (headers) => !('authorization' in headers),
      })
      .reply(200, JSON.stringify({ results: [] }));

    await client.searchLibraries('react', 'h');
  });

  it('rejects empty libraryName before HTTP', async () => {
    const { client } = makeClient();
    await expect(client.searchLibraries('', 'q')).rejects.toThrow('libraryName');
  });

  it('rejects empty query before HTTP', async () => {
    const { client } = makeClient();
    await expect(client.searchLibraries('react', '')).rejects.toThrow('query');
  });

  it('URL-encodes special chars in libraryName', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({
        path: '/api/v2/libs/search?libraryName=spring%20boot&query=jwt',
        method: 'GET',
      })
      .reply(200, JSON.stringify({ results: [] }));

    await client.searchLibraries('spring boot', 'jwt');
  });

  it('returns empty list when body has no results array', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(200, JSON.stringify({ unexpected: true }), {
        headers: { 'content-type': 'application/json' },
      });

    const { data } = await client.searchLibraries('react', 'q');
    expect(data).toEqual([]);
  });
});

describe('Context7Client.getContext', () => {
  it('returns plain text body and tier on 200', async () => {
    const { client, mock } = makeClient('ctx7sk_test');
    mock
      .intercept({
        path: '/api/v2/context?libraryId=%2Ffacebook%2Freact&query=useState&tokens=5000',
        method: 'GET',
      })
      .reply(200, '### useState example\n\nconst [c, set] = useState(0)', {
        headers: { 'content-type': 'text/plain', 'context7-quota-tier': 'pro' },
      });

    const { data, tier } = await client.getContext('/facebook/react', 'useState', 5000);
    expect(tier).toBe('pro');
    expect(data).toContain('useState example');
  });

  it('clamps tokens to MAX_OUTPUT_TOKENS', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({
        path: `/api/v2/context?libraryId=%2Ffacebook%2Freact&query=q&tokens=${MAX_OUTPUT_TOKENS}`,
        method: 'GET',
      })
      .reply(200, 'docs');

    const { data } = await client.getContext('/facebook/react', 'q', 999_999);
    expect(data).toBe('docs');
  });

  it('clamps tokens up to MIN_OUTPUT_TOKENS', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({
        path: `/api/v2/context?libraryId=%2Ffacebook%2Freact&query=q&tokens=${MIN_OUTPUT_TOKENS}`,
        method: 'GET',
      })
      .reply(200, 'docs');

    await client.getContext('/facebook/react', 'q', 1);
  });

  it('rejects empty libraryId before HTTP', async () => {
    const { client } = makeClient();
    await expect(client.getContext('  ', 'q', 5000)).rejects.toThrow('libraryId');
  });

  it('rejects empty query before HTTP', async () => {
    const { client } = makeClient();
    await expect(client.getContext('/facebook/react', '   ', 5000)).rejects.toThrow('query');
  });
});

describe('Context7Client error mapping', () => {
  it('202 → indexing-in-progress, not retryable', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(202, '');
    await expect(client.searchLibraries('react', 'q')).rejects.toMatchObject({
      status: 202,
      retryable: false,
    });
  });

  it('301 → unexpected redirect (not followed)', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(301, '', { headers: { location: 'https://evil.example.com/' } });
    await expect(client.searchLibraries('react', 'q')).rejects.toMatchObject({
      status: 301,
      retryable: false,
    });
  });

  it('400 → bad request with extracted message', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(400, JSON.stringify({ message: 'missing libraryName' }), {
        headers: { 'content-type': 'application/json' },
      });
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(/missing libraryName/);
  });

  it('401 → invalid API key, retryable=false', async () => {
    const { client, mock } = makeClient('ctx7sk_bad');
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(401, '');
    await expect(client.searchLibraries('react', 'q')).rejects.toMatchObject({
      status: 401,
      retryable: false,
    });
  });

  it('403 → forbidden', async () => {
    const { client, mock } = makeClient('ctx7sk_x');
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(403, JSON.stringify({ message: 'private repo' }), {
        headers: { 'content-type': 'application/json' },
      });
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(/Forbidden/);
  });

  it('404 → library not found', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(404, '');
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(/not found/);
  });

  it('422 → unprocessable entity', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(422, JSON.stringify({ message: 'malformed libraryId' }), {
        headers: { 'content-type': 'application/json' },
      });
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(/malformed libraryId/);
  });

  it('429 → rate limit, message mentions tier + reset', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(429, '', {
        headers: {
          'context7-quota-tier': 'anonymous',
          'ratelimit-reset': '1780000000',
        },
      });
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(/Tier: anonymous/);
  });

  it('429 with API key → message suggests plan upgrade', async () => {
    const { client, mock } = makeClient('ctx7sk_test');
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(429, '', {
        headers: { 'context7-quota-tier': 'free', 'ratelimit-reset': '1780000000' },
      });
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(/Upgrade your plan/);
  });

  it('429 without ratelimit-reset header omits reset time', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(429, '', { headers: { 'context7-quota-tier': 'anonymous' } });
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(
      /^(?!.*Resets at).*Add an API key/
    );
  });

  it('429 with non-numeric ratelimit-reset omits reset time', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(429, '', {
        headers: { 'context7-quota-tier': 'anonymous', 'ratelimit-reset': 'not-a-number' },
      });
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(/^(?!.*Resets at)/);
  });

  it('429 with array header values uses the first element', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(429, '', {
        headers: {
          'context7-quota-tier': ['pro', 'free'],
          'ratelimit-reset': ['1780000000', '99'],
        },
      });
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(
      /Tier: pro\. Resets at 2026/
    );
  });

  it('unmapped status → generic Context7Error, not retryable', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(418, JSON.stringify({ message: 'teapot' }), {
        headers: { 'content-type': 'application/json' },
      });
    await expect(client.searchLibraries('react', 'q')).rejects.toMatchObject({
      status: 418,
      retryable: false,
      message: expect.stringMatching(/returned status 418: teapot/) as unknown,
    });
  });

  it('non-JSON error body is quoted raw in the message', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(400, 'plain text failure', { headers: { 'content-type': 'text/plain' } });
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(/plain text failure/);
  });

  it('oversized error body is truncated to 200 chars with ellipsis', async () => {
    const { client, mock } = makeClient();
    const long = 'e'.repeat(250);
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(400, long, { headers: { 'content-type': 'text/plain' } });
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(
      new RegExp(`${'e'.repeat(200)}…`)
    );
  });

  it('JSON error body with empty message falls back to raw body', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(400, JSON.stringify({ message: '' }), {
        headers: { 'content-type': 'application/json' },
      });
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(/\{"message":""\}/);
  });

  it('network error → retries then succeeds', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .replyWithError(new Error('socket hang up'));
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(200, JSON.stringify({ results: [{ id: '/x/y', title: 'X' }] }), {
        headers: { 'content-type': 'application/json' },
      });

    const { data } = await client.searchLibraries('react', 'q');
    expect(data).toHaveLength(1);
  }, 20_000);

  it('persistent network error across all retries throws status 0', async () => {
    const { client, mock } = makeClient();
    for (let i = 0; i < 4; i++) {
      mock
        .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
        .replyWithError(new Error('connect ECONNREFUSED'));
    }
    await expect(client.searchLibraries('react', 'q')).rejects.toMatchObject({
      status: 0,
      retryable: true,
      message: expect.stringMatching(/Context7 request failed: connect ECONNREFUSED/) as unknown,
    });
  }, 30_000);

  it('500 → retries then succeeds', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(500, '');
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(200, JSON.stringify({ results: [{ id: '/x/y', title: 'X' }] }), {
        headers: { 'content-type': 'application/json' },
      });

    const { data } = await client.searchLibraries('react', 'q');
    expect(data).toHaveLength(1);
  }, 20_000);

  it('503 → retries then succeeds', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(503, '');
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(200, JSON.stringify({ results: [] }));

    await client.searchLibraries('react', 'q');
  }, 20_000);

  it('504 → retries then succeeds', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(504, '');
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(200, JSON.stringify({ results: [] }));

    await client.searchLibraries('react', 'q');
  }, 20_000);

  it('persistent 500 across all retries throws Context7Error', async () => {
    const { client, mock } = makeClient();
    for (let i = 0; i < 5; i++) {
      mock
        .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
        .reply(500, JSON.stringify({ message: 'down' }), {
          headers: { 'content-type': 'application/json' },
        });
    }
    await expect(client.searchLibraries('react', 'q')).rejects.toMatchObject({
      status: 500,
      retryable: true,
    });
  }, 30_000);

  it('unparseable body produces non-JSON Context7Error on 200', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(200, '<html>oops</html>', { headers: { 'content-type': 'text/html' } });
    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(/non-JSON/);
  });

  it('reports tier=unknown when header absent', async () => {
    const { client, mock } = makeClient();
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(200, JSON.stringify({ results: [] }));
    const { tier } = await client.searchLibraries('react', 'q');
    expect(tier).toBe('unknown');
  });
});

describe('Context7Client misc', () => {
  it('anonymous getter reflects key presence', () => {
    expect(new Context7Client().anonymous).toBe(true);
    expect(new Context7Client({ apiKey: 'k' }).anonymous).toBe(false);
    expect(new Context7Client({ apiKey: '  ' }).anonymous).toBe(true);
  });

  it('Context7Error preserves status/tier/retryable', () => {
    const e = new Context7Error('msg', 429, 'anonymous', false);
    expect(e.status).toBe(429);
    expect(e.tier).toBe('anonymous');
    expect(e.retryable).toBe(false);
  });

  it('aborts when response body exceeds MAX_RESPONSE_BYTES — OOM regression guard', async () => {
    const { client, mock } = makeClient();
    // 6 MiB of payload — over the 5 MiB cap. The mock streams it as one chunk;
    // readBodyLimited must reject before buffering the whole thing.
    const oversized = 'x'.repeat(6 * 1024 * 1024);
    mock
      .intercept({ path: '/api/v2/libs/search?libraryName=react&query=q', method: 'GET' })
      .reply(200, oversized, { headers: { 'content-type': 'application/json' } });

    await expect(client.searchLibraries('react', 'q')).rejects.toThrow(/exceeded/);
  });
});

describe('clampTokens', () => {
  it('clamps to MIN when below', () => {
    expect(clampTokens(0)).toBe(MIN_OUTPUT_TOKENS);
    expect(clampTokens(-5)).toBe(MIN_OUTPUT_TOKENS);
  });

  it('clamps to MAX when above', () => {
    expect(clampTokens(999_999)).toBe(MAX_OUTPUT_TOKENS);
  });

  it('passes through values in range', () => {
    expect(clampTokens(5000)).toBe(5000);
  });

  it('floors fractional values', () => {
    expect(clampTokens(5000.7)).toBe(5000);
  });

  it('handles NaN', () => {
    expect(clampTokens(NaN)).toBe(MIN_OUTPUT_TOKENS);
  });
});
