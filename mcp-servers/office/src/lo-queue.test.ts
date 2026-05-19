/**
 * Tests for the LibreOffice serialization queue: tasks run one at a time, in order,
 * and a failing task does not break the chain.
 * @module mcp-office/lo-queue.test
 */

import { describe, it, expect } from 'vitest';
import { libreOfficeQueue } from './lo-queue.js';

describe('libreOfficeQueue', () => {
  it('serializes tasks and preserves order', async () => {
    const order: number[] = [];
    const mk = (n: number, delay: number) => () =>
      new Promise<number>((resolve) => {
        setTimeout(() => {
          order.push(n);
          resolve(n);
        }, delay);
      });
    // First task is slow, second fast — without serialization the order would be [2,1].
    const p1 = libreOfficeQueue.run(mk(1, 30));
    const p2 = libreOfficeQueue.run(mk(2, 1));
    await expect(p1).resolves.toBe(1);
    await expect(p2).resolves.toBe(2);
    expect(order).toEqual([1, 2]);
  });

  it('lets later tasks proceed after an earlier task rejects', async () => {
    const p1 = libreOfficeQueue.run<number>(() => Promise.reject(new Error('boom')));
    const p2 = libreOfficeQueue.run<number>(() => Promise.resolve(42));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe(42);
  });
});
