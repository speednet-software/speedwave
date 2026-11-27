/**
 * Authenticates the `claude` container on the hub's MCP endpoint: the caller token sits in a tmpfs
 * slot file that is read on every request, so a rotation at project start needs no hub restart.
 */

import { readFileSync } from 'node:fs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { safeTokenCompare, ts } from '@speedwave/mcp-shared';

const CALLER_AUTH_HEADER = 'x-speedwave-proxy-auth';
const CALLER_TOKEN_PATH = '/secrets/caller-token';

function readCallerToken(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Express middleware that answers 401 unless the request carries the caller token; a missing or
 * empty token file rejects every request.
 * @param tokenPath - file holding the caller token
 */
export function createCallerAuth(tokenPath: string = CALLER_TOKEN_PATH): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = readCallerToken(tokenPath);
    const presented = req.header(CALLER_AUTH_HEADER);
    if (
      expected !== undefined &&
      presented !== undefined &&
      safeTokenCompare(presented, expected)
    ) {
      next();
      return;
    }
    console.warn(`${ts()} AUTH rejected ${req.method} with missing or invalid caller auth`);
    res.status(401).json({ error: 'Unauthorized' });
  };
}
