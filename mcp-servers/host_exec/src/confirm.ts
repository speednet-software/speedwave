/**
 * The per-recipe confirmation channel (ADR-054 §Confirmation flow). Before a
 * recipe runs, the worker sends a confirm-request to the Tauri side and blocks
 * for the reply. The Tauri side either auto-replies (recipe `confirm: always`,
 * or the `(project, recipe, argv, cwd, config-hash)` cache is warm) or pops the
 * per-call dialog and replies with the user's choice. If the reply does not
 * arrive within the worker's guard timeout, the worker **fails closed** (the
 * caller turns that into the MCP tool error "confirmation unavailable") — it
 * never runs the recipe without an answer.
 *
 * Transport: requests go out on **fd 3** (an extra pipe the Tauri side wires
 * up), one newline-delimited JSON object per request; replies come in on
 * **stdin** (otherwise unused), one newline-delimited JSON object per reply,
 * each carrying the `id` it answers. The transport is behind an interface so
 * tests can drive it without real fds; `realConfirmChannel()` builds the
 * production one.
 * @module host_exec/confirm
 */

import * as fs from 'node:fs';
import { ts } from '@speedwave/mcp-shared';
import { CONFIRM_TIMEOUT_MS } from './constants.js';

/** A confirm-request the worker sends to the Tauri side. */
export interface ConfirmRequest {
  type: 'confirm';
  /** Correlation id (the reply carries the same `id`). */
  id: string;
  /** Recipe name. */
  recipe: string;
  /** The fully-resolved argv (`exec` first, then args with parameters substituted). */
  argv: string[];
  /** The working directory label (`'.'` or the `cwdSub`). */
  cwd: string;
}

/** The user's (or the auto-resolver's) decision. */
export type ConfirmDecision = 'allow' | 'allow-session' | 'deny';

/** A reply the worker reads from the Tauri side. */
export interface ConfirmReply {
  type: 'confirm-reply';
  /** Correlation id matching a {@link ConfirmRequest}. */
  id: string;
  /** The decision. */
  decision: ConfirmDecision;
}

/**
 * The transport the confirmation channel uses. Production wires this to fd 3
 * (out) and stdin (in); tests provide a fake.
 */
export interface ConfirmTransport {
  /** Send one request line (the implementation adds the newline). */
  send(req: ConfirmRequest): void;
  /**
   * Subscribe to incoming reply objects. The returned function unsubscribes.
   * The transport is responsible for newline-delimited JSON framing on its end.
   */
  onReply(cb: (reply: ConfirmReply) => void): () => void;
}

/**
 * Asks the Tauri side to confirm a recipe run and waits (up to the guard
 * timeout) for the reply.
 * @param transport - The confirm transport.
 * @param req - The request (its `id` correlates the reply).
 * @param timeoutMs - Optional override for the guard timeout (default {@link CONFIRM_TIMEOUT_MS}).
 * @returns The decision. On timeout, resolves to `'deny'` (fail closed) — the
 *   caller distinguishes "user denied" from "no answer" by also tracking
 *   whether a reply was ever seen; see {@link awaitConfirmation}.
 */
export function requestConfirmation(
  transport: ConfirmTransport,
  req: ConfirmRequest,
  timeoutMs: number = CONFIRM_TIMEOUT_MS
): Promise<ConfirmDecision> {
  return new Promise<ConfirmDecision>((resolve) => {
    let settled = false;
    const unsubscribe = transport.onReply((reply) => {
      if (settled || reply.id !== req.id) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(reply.decision);
    });
    const timer = setTimeout(() => {
      /* c8 ignore next — `settled` is set together with `clearTimeout(timer)`
         in the reply handler, so this guard only matters in the microtask race
         where the timer is already queued when the reply lands; not
         reproducible with fake timers. */
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve('deny'); // fail closed
    }, timeoutMs);
    transport.send(req);
  });
}

/**
 * Like {@link requestConfirmation} but distinguishes a real `deny` from a
 * timeout: returns `{ allowed: boolean, timedOut: boolean }`. The caller uses
 * `timedOut` to emit "confirmation unavailable" vs "denied by user".
 * @param transport - The confirm transport.
 * @param req - The request.
 * @param timeoutMs - Optional guard-timeout override.
 * @returns `{ allowed, timedOut }`.
 */
export async function awaitConfirmation(
  transport: ConfirmTransport,
  req: ConfirmRequest,
  timeoutMs: number = CONFIRM_TIMEOUT_MS
): Promise<{ allowed: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const unsubscribe = transport.onReply((reply) => {
      if (settled || reply.id !== req.id) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve({ allowed: reply.decision !== 'deny', timedOut: false });
    });
    const timer = setTimeout(() => {
      /* c8 ignore next — see the matching guard in requestConfirmation: only
         hit in a microtask race that fake timers can't reproduce. */
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve({ allowed: false, timedOut: true });
    }, timeoutMs);
    transport.send(req);
  });
}

/** A minimal readable interface for the reply stream — what `realConfirmChannel` needs. */
export interface ReplyReadable {
  setEncoding(enc: BufferEncoding): unknown;
  on(event: 'data', cb: (chunk: string) => void): unknown;
  unref?: () => void;
}

/* c8 ignore start — `openFd3` is intrinsically environment-bound: in production
   fd 3 is the extra pipe the Tauri parent wires up; under vitest fd 3 is the
   test runner's own IPC channel, so this function MUST NOT be exercised in
   tests (opening a write stream on it would corrupt vitest's IPC). The
   behaviour `realConfirmChannel` actually depends on — "send a request, or drop
   it and let the guard timeout fail closed" — is fully covered by passing a
   fake `out` (and `undefined`) to `realConfirmChannel` in confirm.test.ts. */
/**
 * Open a write stream on fd 3 (the extra pipe the Tauri parent wires up). If
 * fd 3 is not available, `fstatSync(3)` throws `EBADF` and this returns
 * `undefined`; `realConfirmChannel` then drops `send`s and the guard timeout
 * makes confirmations fail closed, so a misconfigured launch cannot turn into
 * "runs without confirmation".
 * @returns The fd-3 write stream, or `undefined` if fd 3 is not open.
 */
export function openFd3(): NodeJS.WritableStream | undefined {
  try {
    fs.fstatSync(3); // throws EBADF if fd 3 is not open
    return fs.createWriteStream('', { fd: 3 });
  } catch {
    return undefined;
  }
}
/* c8 ignore stop */

/**
 * Build the confirm transport: requests written to `out` (fd 3 in production,
 * via {@link openFd3}) as newline-delimited JSON; replies parsed from
 * `replyStream` (stdin in production) as newline-delimited JSON. Both sources
 * are passed in so the production wiring lives in `index.ts` and tests can
 * inject fakes without `openFd3` ever touching fd 3 (which under vitest is the
 * test runner's IPC channel). If `out` is undefined, `send` logs and drops —
 * combined with the guard timeout this fails closed, so a misconfigured launch
 * cannot turn into "runs without confirmation".
 * @param out - The write stream for requests, or `undefined` if fd 3 is unavailable.
 * @param replyStream - The readable stream for replies.
 * @returns The transport.
 */
export function realConfirmChannel(
  out: NodeJS.WritableStream | undefined,
  replyStream: ReplyReadable
): ConfirmTransport {
  const replyCallbacks = new Set<(r: ConfirmReply) => void>();
  let buf = '';
  replyStream.setEncoding('utf-8');
  replyStream.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        console.error(`${ts()} host_exec: ignoring malformed reply line on the confirm channel`);
        continue;
      }
      if (
        typeof obj === 'object' &&
        obj !== null &&
        (obj as { type?: unknown }).type === 'confirm-reply' &&
        typeof (obj as { id?: unknown }).id === 'string' &&
        ['allow', 'allow-session', 'deny'].includes(
          (obj as { decision?: unknown }).decision as string
        )
      ) {
        const reply = obj as ConfirmReply;
        for (const cb of replyCallbacks) cb(reply);
      }
    }
  });
  // Don't let an open reply stream keep the process alive on its own.
  replyStream.unref?.();

  return {
    send(req: ConfirmRequest): void {
      if (!out) {
        console.error(
          `${ts()} host_exec: confirm fd (3) not available — confirmation will time out (fail closed)`
        );
        return;
      }
      out.write(JSON.stringify(req) + '\n');
    },
    onReply(cb): () => void {
      replyCallbacks.add(cb);
      return () => replyCallbacks.delete(cb);
    },
  };
}
