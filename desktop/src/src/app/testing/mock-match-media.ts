/** Handle returned by {@link mockMatchMedia} to drive and remove the stub. */
export interface MockMatchMedia {
  fireChange: (prefersDarkNow: boolean) => void;
  restore: () => void;
}

/**
 * Installs a controllable `matchMedia` on `window`; returns `fireChange` to simulate OS
 * theme toggles and `restore` to remove the stub.
 * @param prefersDark - Initial `matches` for `(prefers-color-scheme: dark)`.
 * @returns Handle to drive and remove the stub.
 */
export function mockMatchMedia(prefersDark: boolean): MockMatchMedia {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mq = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (
      _: string,
      fn: (e: MediaQueryListEvent) => void,
      options?: { signal?: AbortSignal }
    ) => {
      listeners.add(fn);
      options?.signal?.addEventListener('abort', () => listeners.delete(fn));
    },
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    addListener: (fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeListener: (fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => mq,
  });
  return {
    fireChange: (prefersDarkNow: boolean) => {
      (mq as unknown as { matches: boolean }).matches = prefersDarkNow;
      for (const fn of listeners) fn({ matches: prefersDarkNow } as MediaQueryListEvent);
    },
    restore: () => {
      if (original) {
        Object.defineProperty(window, 'matchMedia', original);
      } else {
        Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
      }
    },
  };
}
