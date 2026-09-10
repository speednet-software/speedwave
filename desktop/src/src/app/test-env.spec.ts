// Guards the test-environment contract from test-setup.ts: specs get a working Web Storage
// regardless of whether the Node running vitest ships its own (unavailable) `localStorage` global.

describe('unit-test environment', () => {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    describe(name, () => {
      const storage = (): Storage => globalThis[name];

      it('is a usable Storage that round-trips values', () => {
        storage().setItem('spw-test-env', 'value');
        expect(storage().getItem('spw-test-env')).toBe('value');
        storage().removeItem('spw-test-env');
        expect(storage().getItem('spw-test-env')).toBeNull();
      });

      it('reports length and keys and clears', () => {
        storage().clear();
        storage().setItem('a', '1');
        storage().setItem('b', '2');
        expect(storage().length).toBe(2);
        expect([storage().key(0), storage().key(1)].sort()).toEqual(['a', 'b']);
        expect(storage().key(2)).toBeNull();
        storage().clear();
        expect(storage().length).toBe(0);
      });

      it('stringifies non-string values like the DOM Storage does', () => {
        storage().setItem('n', 42 as unknown as string);
        expect(storage().getItem('n')).toBe('42');
        storage().removeItem('n');
      });
    });
  }
});
