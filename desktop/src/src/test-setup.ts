/**
 * Node ≥ 25 exposes an unavailable `localStorage`/`sessionStorage` global that vitest's jsdom
 * environment does not override (it only fills keys missing from the Node global), so give each spec
 * file a fresh in-memory `Storage` whenever the jsdom one is absent.
 */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}

for (const key of ['localStorage', 'sessionStorage'] as const) {
  const current = (globalThis as Record<string, unknown>)[key];
  if (typeof Storage === 'function' && current instanceof Storage) {
    continue;
  }
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: memoryStorage(),
  });
}
