import { describe, it, expect } from 'vitest';
import { createDeferred, type Deferred } from './deferred';

describe('createDeferred', () => {
  it('stays pending until resolve is called, then settles with the value', async () => {
    const deferred = createDeferred<number>();
    const seen: number[] = [];
    void deferred.promise.then((v) => seen.push(v));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]);

    deferred.resolve(42);
    await expect(deferred.promise).resolves.toBe(42);
    expect(seen).toEqual([42]);
  });

  it('defaults T to void so a bare resolve() releases the gate', async () => {
    const gate: Deferred = createDeferred();
    gate.resolve();
    await expect(gate.promise).resolves.toBeUndefined();
  });

  it('rejects with the given reason', async () => {
    const deferred = createDeferred<string>();
    deferred.reject(new Error('boom'));
    await expect(deferred.promise).rejects.toThrow('boom');
  });

  it('adopts a promise-like passed to resolve', async () => {
    const deferred = createDeferred<string>();
    deferred.resolve(Promise.resolve('adopted'));
    await expect(deferred.promise).resolves.toBe('adopted');
  });

  it('keeps the first settlement and ignores later resolve/reject calls', async () => {
    const deferred = createDeferred<string>();
    deferred.resolve('first');
    deferred.reject(new Error('late'));
    deferred.resolve('second');
    await expect(deferred.promise).resolves.toBe('first');
  });

  it('returns independent instances', async () => {
    const a = createDeferred<string>();
    const b = createDeferred<string>();
    const settled: string[] = [];
    void b.promise.then((v) => settled.push(v));

    a.resolve('a');
    await a.promise;
    await Promise.resolve();
    expect(settled).toEqual([]);

    b.resolve('b');
    await expect(b.promise).resolves.toBe('b');
    expect(settled).toEqual(['b']);
  });
});
