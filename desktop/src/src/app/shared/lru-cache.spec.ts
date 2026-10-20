import { describe, it, expect } from 'vitest';
import { LruCache } from './lru-cache';

describe('LruCache', () => {
  it('returns a stored value and undefined for a missing key', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
  });

  it('evicts the least recently written entry past capacity', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('keeps an entry that was read since it was written', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
  });

  it('overwrites an existing key without growing and refreshes it', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    cache.set('c', 3);
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBeUndefined();
  });

  it('caches falsy values and tells them apart from a miss', () => {
    const cache = new LruCache<string, number | null>(3);
    cache.set('zero', 0);
    cache.set('null', null);
    expect(cache.get('zero')).toBe(0);
    expect(cache.get('null')).toBeNull();
  });

  it('holds one entry at capacity 1', () => {
    const cache = new LruCache<string, string>(1);
    cache.set('ü', 'first');
    cache.set('ß', 'second');
    expect(cache.get('ü')).toBeUndefined();
    expect(cache.get('ß')).toBe('second');
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects capacity %s', (capacity) => {
    expect(() => new LruCache<string, string>(capacity)).toThrow(RangeError);
  });
});
