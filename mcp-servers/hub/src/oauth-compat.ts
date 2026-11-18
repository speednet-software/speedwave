import type { Request, Response } from 'express';

export const OAUTH_COMPAT_PATH = '/oauth-compat';

const DEFAULT_WAIT_MS = 15_000;
const DEFAULT_MAX_WAITING = 16;

/** Tuning for {@link createOAuthCompatHandler}. */
export interface OAuthCompatOptions {
  waitMs?: number;
  maxWaiting?: number;
}

interface CompatRequestBody {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown };
}

/**
 * Build the express handler for {@link OAUTH_COMPAT_PATH}.
 * @param options - wait and concurrency limits
 */
export function createOAuthCompatHandler(
  options: OAuthCompatOptions = {}
): (req: Request, res: Response) => void {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const maxWaiting = options.maxWaiting ?? DEFAULT_MAX_WAITING;
  let waiting = 0;

  return (req, res) => {
    const body = req.body as CompatRequestBody | undefined;
    if (body?.method !== 'tools/call' || body.params?.name !== 'refresh') {
      res.status(400).json({ error: 'Bad Request' });
      return;
    }
    if (waiting >= maxWaiting) {
      res.status(429).json({ error: 'Too Many Requests' });
      return;
    }
    waiting += 1;
    const timer = setTimeout(() => {
      res.json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ expiresIn: 0, grantedScopes: [] }) }],
        },
      });
    }, waitMs);
    res.once('close', () => {
      clearTimeout(timer);
      waiting -= 1;
    });
  };
}
