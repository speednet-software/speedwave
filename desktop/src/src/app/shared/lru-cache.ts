/** Map-backed least-recently-used cache: a read refreshes an entry, a write past capacity evicts the oldest. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  /**
   * Creates an empty cache.
   * @param capacity - Maximum number of entries kept; a positive integer.
   */
  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`LruCache capacity must be a positive integer, got ${capacity}`);
    }
  }

  /**
   * Returns the cached value and marks it most recently used.
   * @param key - Entry key.
   * @returns The value, or `undefined` when the key is not cached.
   */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /**
   * Stores a value as most recently used, evicting the least recently used entry past capacity.
   * @param key - Entry key.
   * @param value - Value to store.
   */
  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value as K);
    }
  }
}
