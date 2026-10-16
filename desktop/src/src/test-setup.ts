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

/**
 * jsdom does not implement `URL.createObjectURL`/`revokeObjectURL` itself, so the global falls
 * through to Node's own Blob-URL registry, which expects a Node-native `Blob`/`File` — whether a
 * jsdom-constructed `File` (what `new File(...)` gives a spec) is accepted is a Node point-release
 * detail, not a documented contract (seen passing on Node 24.16, throwing `Cannot read properties
 * of undefined (reading '_buffer')` on Node 24.20). Replace both with a deterministic,
 * version-independent pair so a spec building attachments from real `File` objects never depends
 * on that interaction.
 */
let mockObjectUrlSeq = 0;
Object.defineProperty(URL, 'createObjectURL', {
  configurable: true,
  writable: true,
  value: () => `blob:mock-${++mockObjectUrlSeq}`,
});
Object.defineProperty(URL, 'revokeObjectURL', {
  configurable: true,
  writable: true,
  value: () => undefined,
});
