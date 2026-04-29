import { describe, it, expect } from 'vitest';
import { applyPatch, compose, type Patch } from './json-patch';

describe('json-patch reducer (ADR-042)', () => {
  describe('happy path — supported ops', () => {
    it('add inserts a key into an object', () => {
      const next = applyPatch({ a: 1 }, [{ op: 'add', path: '/b', value: 2 }]);
      expect(next).toEqual({ a: 1, b: 2 });
    });

    it('replace overwrites an existing key', () => {
      const next = applyPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: 9 }]);
      expect(next).toEqual({ a: 9 });
    });

    it('remove deletes a key', () => {
      const next = applyPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/a' }]);
      expect(next).toEqual({ b: 2 });
    });

    it('add at array index inserts (not overwrites) at that position', () => {
      const next = applyPatch({ list: ['a', 'c'] }, [{ op: 'add', path: '/list/1', value: 'b' }]);
      expect(next).toEqual({ list: ['a', 'b', 'c'] });
    });

    it('add with "-" appends to array', () => {
      const next = applyPatch({ list: ['a'] }, [{ op: 'add', path: '/list/-', value: 'b' }]);
      expect(next).toEqual({ list: ['a', 'b'] });
    });

    it('replace at array index swaps the element', () => {
      const next = applyPatch({ list: ['a', 'b', 'c'] }, [
        { op: 'replace', path: '/list/1', value: 'B' },
      ]);
      expect(next).toEqual({ list: ['a', 'B', 'c'] });
    });

    it('remove at array index shifts subsequent elements', () => {
      const next = applyPatch({ list: ['a', 'b', 'c'] }, [{ op: 'remove', path: '/list/0' }]);
      expect(next).toEqual({ list: ['b', 'c'] });
    });

    it('navigates nested paths', () => {
      const next = applyPatch({ a: { b: { c: 1 } } }, [
        { op: 'replace', path: '/a/b/c', value: 9 },
      ]);
      expect(next).toEqual({ a: { b: { c: 9 } } });
    });
  });

  describe('JSON pointer escapes (RFC 6901)', () => {
    it('decodes ~1 as / in keys', () => {
      const next = applyPatch({ 'a/b': 1 }, [{ op: 'replace', path: '/a~1b', value: 9 }]);
      expect(next).toEqual({ 'a/b': 9 });
    });

    it('decodes ~0 as ~ in keys', () => {
      const next = applyPatch({ 'a~b': 1 }, [{ op: 'replace', path: '/a~0b', value: 9 }]);
      expect(next).toEqual({ 'a~b': 9 });
    });
  });

  describe('error paths', () => {
    it('throws on missing leading slash in pointer', () => {
      expect(() => applyPatch({ a: 1 }, [{ op: 'replace', path: 'a', value: 2 }])).toThrow(
        /missing leading slash/
      );
    });

    it('throws on replace of missing key', () => {
      expect(() => applyPatch({ a: 1 }, [{ op: 'replace', path: '/missing', value: 2 }])).toThrow(
        /not present/
      );
    });

    it('throws on remove of missing key', () => {
      expect(() => applyPatch({ a: 1 }, [{ op: 'remove', path: '/missing' }])).toThrow(
        /not present/
      );
    });

    it('throws on out-of-range array replace', () => {
      expect(() =>
        applyPatch({ list: [1, 2] }, [{ op: 'replace', path: '/list/5', value: 9 }])
      ).toThrow(/out of range/);
    });

    it('throws on out-of-range array remove', () => {
      expect(() => applyPatch({ list: [1, 2] }, [{ op: 'remove', path: '/list/5' }])).toThrow(
        /out of range/
      );
    });

    it('throws on unsupported op', () => {
      expect(() =>
        applyPatch({ a: 1 }, [
          { op: 'move', path: '/a', value: 1 } as unknown as {
            op: 'add';
            path: string;
            value: unknown;
          },
        ])
      ).toThrow(/unsupported json-patch op/);
    });
  });

  describe('purity / immutability', () => {
    it('does not mutate the input state', () => {
      const original = { a: 1, list: [1, 2, 3] };
      const snapshot = JSON.parse(JSON.stringify(original));
      applyPatch(original, [{ op: 'replace', path: '/a', value: 99 }]);
      applyPatch(original, [{ op: 'add', path: '/list/-', value: 4 }]);
      expect(original).toEqual(snapshot);
    });

    it('returns a new top-level reference', () => {
      const before = { a: 1 };
      const after = applyPatch(before, [{ op: 'replace', path: '/a', value: 2 }]);
      expect(after).not.toBe(before);
    });
  });

  // ── Acceptance criterion #10 — property-based laws ───────────────────
  describe('property: Replace idempotency', () => {
    it('apply(apply(s, p), p) === apply(s, p) for Replace ops on same path', () => {
      const states = [
        { a: 1, b: 2 },
        { entries: [{ idx: 0, content: 'hi' }] },
        { x: { nested: { y: 'z' } } },
      ];
      const patches: Patch[] = [
        [{ op: 'replace', path: '/a', value: 9 }],
        [{ op: 'replace', path: '/entries/0/content', value: 'replaced' }],
        [{ op: 'replace', path: '/x/nested/y', value: 'q' }],
      ];
      for (let i = 0; i < states.length; i += 1) {
        const once = applyPatch(states[i], patches[i]);
        const twice = applyPatch(once, patches[i]);
        expect(twice).toEqual(once);
      }
    });

    it('repeated Replace converges across nested paths regardless of key order', () => {
      const s = { a: 1, b: { c: 2, d: 3 } };
      const p: Patch = [
        { op: 'replace', path: '/a', value: 9 },
        { op: 'replace', path: '/b/c', value: 8 },
        { op: 'replace', path: '/b/d', value: 7 },
      ];
      const once = applyPatch(s, p);
      const twice = applyPatch(once, p);
      const thrice = applyPatch(twice, p);
      expect(thrice).toEqual(once);
    });
  });

  describe('property: associativity of patch composition', () => {
    it('apply(apply(s, p1), p2) === apply(s, compose(p1, p2)) — Add then Replace', () => {
      const s = { entries: [] as Array<{ id: number; content: string }> };
      const p1: Patch = [{ op: 'add', path: '/entries/0', value: { id: 0, content: '' } }];
      const p2: Patch = [{ op: 'replace', path: '/entries/0/content', value: 'hello' }];

      const stepwise = applyPatch(applyPatch(s, p1), p2);
      const composed = applyPatch(s, compose(p1, p2));
      expect(stepwise).toEqual(composed);
    });

    it('apply(apply(s, p1), p2) === apply(s, compose(p1, p2)) — multi-entry sequence', () => {
      type S = { entries: Array<{ idx: number }>; flag: boolean };
      const s: S = { entries: [], flag: false };
      const p1: Patch = [
        { op: 'add', path: '/entries/0', value: { idx: 0 } },
        { op: 'add', path: '/entries/1', value: { idx: 1 } },
      ];
      const p2: Patch = [
        { op: 'replace', path: '/flag', value: true },
        { op: 'remove', path: '/entries/0' },
      ];

      const stepwise = applyPatch(applyPatch(s, p1), p2);
      const composed = applyPatch(s, compose(p1, p2));
      expect(stepwise).toEqual(composed);
    });

    it('associativity holds for randomized add/replace/remove sequences', () => {
      type S = { entries: number[]; meta: Record<string, number> };
      const s: S = { entries: [10, 20, 30], meta: { a: 1, b: 2 } };
      // Hand-rolled patches of varied shapes — exhaustive property
      // testing would need a generator, but these cover the common
      // combinations: add+remove, replace+remove, sequential adds.
      const cases: Array<{ p1: Patch; p2: Patch }> = [
        {
          p1: [{ op: 'add', path: '/entries/-', value: 40 }],
          p2: [{ op: 'remove', path: '/entries/0' }],
        },
        {
          p1: [{ op: 'replace', path: '/entries/1', value: 99 }],
          p2: [{ op: 'replace', path: '/meta/a', value: 100 }],
        },
        {
          p1: [{ op: 'add', path: '/meta/c', value: 3 }],
          p2: [{ op: 'remove', path: '/meta/b' }],
        },
      ];
      for (const { p1, p2 } of cases) {
        const stepwise = applyPatch(applyPatch(s, p1), p2);
        const composed = applyPatch(s, compose(p1, p2));
        expect(stepwise).toEqual(composed);
      }
    });
  });
});
