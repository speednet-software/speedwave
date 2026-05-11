import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ConfirmReply, ConfirmRequest, ConfirmTransport, ReplyReadable } from './confirm.js';
import { awaitConfirmation, realConfirmChannel, requestConfirmation } from './confirm.js';

/**
 * A controllable in-memory confirm transport for tests: records sent requests
 * and lets the test inject replies.
 */
function fakeTransport(): ConfirmTransport & {
  sent: ConfirmRequest[];
  reply: (r: ConfirmReply) => void;
} {
  const cbs = new Set<(r: ConfirmReply) => void>();
  const sent: ConfirmRequest[] = [];
  return {
    sent,
    send(req) {
      sent.push(req);
    },
    onReply(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    reply(r) {
      for (const cb of cbs) cb(r);
    },
  };
}

const REQ: ConfirmRequest = {
  type: 'confirm',
  id: 'abc',
  recipe: 'test',
  argv: ['./gradlew', 'test'],
  cwd: '.',
};

describe('requestConfirmation', () => {
  it('resolves with the decision when a matching reply arrives', async () => {
    const t = fakeTransport();
    const p = requestConfirmation(t, REQ, 1000);
    expect(t.sent).toEqual([REQ]);
    t.reply({ type: 'confirm-reply', id: 'abc', decision: 'allow-session' });
    await expect(p).resolves.toBe('allow-session');
  });

  it('ignores replies with a different id', async () => {
    vi.useFakeTimers();
    const t = fakeTransport();
    const p = requestConfirmation(t, REQ, 1000);
    t.reply({ type: 'confirm-reply', id: 'someone-else', decision: 'allow' });
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBe('deny'); // timed out → fail closed
    vi.useRealTimers();
  });

  it('fails closed (deny) on timeout', async () => {
    vi.useFakeTimers();
    const t = fakeTransport();
    const p = requestConfirmation(t, REQ, 500);
    vi.advanceTimersByTime(500);
    await expect(p).resolves.toBe('deny');
    vi.useRealTimers();
  });

  it('a late reply after timeout does not change the result', async () => {
    vi.useFakeTimers();
    const t = fakeTransport();
    const p = requestConfirmation(t, REQ, 100);
    vi.advanceTimersByTime(100);
    t.reply({ type: 'confirm-reply', id: 'abc', decision: 'allow' });
    await expect(p).resolves.toBe('deny');
    vi.useRealTimers();
  });
});

describe('awaitConfirmation', () => {
  it('distinguishes allow / deny / timeout', async () => {
    {
      const t = fakeTransport();
      const p = awaitConfirmation(t, REQ, 1000);
      t.reply({ type: 'confirm-reply', id: 'abc', decision: 'allow' });
      await expect(p).resolves.toEqual({ allowed: true, timedOut: false });
    }
    {
      const t = fakeTransport();
      const p = awaitConfirmation(t, REQ, 1000);
      t.reply({ type: 'confirm-reply', id: 'abc', decision: 'allow-session' });
      await expect(p).resolves.toEqual({ allowed: true, timedOut: false });
    }
    {
      const t = fakeTransport();
      const p = awaitConfirmation(t, REQ, 1000);
      t.reply({ type: 'confirm-reply', id: 'abc', decision: 'deny' });
      await expect(p).resolves.toEqual({ allowed: false, timedOut: false });
    }
    {
      vi.useFakeTimers();
      const t = fakeTransport();
      const p = awaitConfirmation(t, REQ, 200);
      vi.advanceTimersByTime(200);
      await expect(p).resolves.toEqual({ allowed: false, timedOut: true });
      vi.useRealTimers();
    }
  });

  it('ignores a reply with the wrong id, then times out', async () => {
    vi.useFakeTimers();
    const t = fakeTransport();
    const p = awaitConfirmation(t, REQ, 300);
    t.reply({ type: 'confirm-reply', id: 'nope', decision: 'allow' });
    vi.advanceTimersByTime(300);
    await expect(p).resolves.toEqual({ allowed: false, timedOut: true });
    vi.useRealTimers();
  });
});

/** A fake reply-stream: an EventEmitter that records `setEncoding`/`unref`. */
class FakeReplyStream extends EventEmitter implements ReplyReadable {
  encoding: BufferEncoding | undefined;
  unreffed = false;
  setEncoding(enc: BufferEncoding): this {
    this.encoding = enc;
    return this;
  }
  unref(): void {
    this.unreffed = true;
  }
  /** Helper to push a chunk as if it arrived on the wire. */
  push(s: string): void {
    this.emit('data', s);
  }
}

/** A fake fd-3 write stream that records what was written. */
class FakeOut {
  written: string[] = [];
  write(s: string): boolean {
    this.written.push(s);
    return true;
  }
}

describe('realConfirmChannel', () => {
  it('writes requests to the fd-3 stream as newline-delimited JSON', () => {
    const out = new FakeOut();
    const replies = new FakeReplyStream();
    const ch = realConfirmChannel(out as unknown as NodeJS.WritableStream, replies);
    ch.send(REQ);
    expect(out.written).toHaveLength(1);
    expect(out.written[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(out.written[0])).toEqual(REQ);
    // sets encoding + unrefs the reply stream
    expect(replies.encoding).toBe('utf-8');
    expect(replies.unreffed).toBe(true);
  });

  it('parses replies arriving on the reply stream, including split across chunks', async () => {
    const out = new FakeOut();
    const replies = new FakeReplyStream();
    const ch = realConfirmChannel(out as unknown as NodeJS.WritableStream, replies);
    const p = requestConfirmation(ch, REQ, 1000);
    // reply delivered in two chunks, with a newline frame
    replies.push('{"type":"confirm-reply","id":"a');
    replies.push('bc","decision":"allow-session"}\n');
    await expect(p).resolves.toBe('allow-session');
  });

  it('handles multiple newline-framed replies in one chunk', async () => {
    const out = new FakeOut();
    const replies = new FakeReplyStream();
    const ch = realConfirmChannel(out as unknown as NodeJS.WritableStream, replies);
    const reqs: ConfirmRequest[] = [
      { ...REQ, id: 'one' },
      { ...REQ, id: 'two' },
    ];
    const p1 = requestConfirmation(ch, reqs[0], 1000);
    const p2 = requestConfirmation(ch, reqs[1], 1000);
    replies.push(
      '{"type":"confirm-reply","id":"one","decision":"allow"}\n{"type":"confirm-reply","id":"two","decision":"deny"}\n'
    );
    await expect(p1).resolves.toBe('allow');
    await expect(p2).resolves.toBe('deny');
  });

  it('ignores malformed and non-reply lines on the reply stream', async () => {
    vi.useFakeTimers();
    const out = new FakeOut();
    const replies = new FakeReplyStream();
    const ch = realConfirmChannel(out as unknown as NodeJS.WritableStream, replies);
    const p = requestConfirmation(ch, REQ, 500);
    replies.push('not json\n'); // malformed
    replies.push('{"type":"something-else"}\n'); // not a confirm-reply
    replies.push('{"type":"confirm-reply","id":"abc","decision":"bogus"}\n'); // bad decision
    replies.push('   \n'); // blank
    vi.advanceTimersByTime(500);
    await expect(p).resolves.toBe('deny'); // none matched → timed out
    vi.useRealTimers();
  });

  it('when fd 3 is unavailable, send drops and confirmations fail closed', async () => {
    vi.useFakeTimers();
    const replies = new FakeReplyStream();
    // `out` undefined simulates "fd 3 not wired up"
    const ch = realConfirmChannel(undefined, replies);
    const p = requestConfirmation(ch, REQ, 400);
    vi.advanceTimersByTime(400);
    await expect(p).resolves.toBe('deny');
    vi.useRealTimers();
  });
});
