import { describe, it, expect } from 'vitest';
import { lintPattern } from './pattern-lint.js';
import { PII_PATTERNS } from './patterns.js';

describe('lintPattern', () => {
  describe('accepts safe custom patterns', () => {
    it('accepts a simple bounded pattern', () => {
      expect(lintPattern('\\bEMP-\\d{4,8}\\b')).toEqual({ ok: true });
    });

    it('accepts a pattern with a bounded group repeat', () => {
      expect(lintPattern('(?:\\d{4}[\\s-]?){3}\\d{4}')).toEqual({ ok: true });
    });

    it('accepts a bare unbounded quantifier at top level (not nested)', () => {
      expect(lintPattern('[a-zA-Z0-9-]+')).toEqual({ ok: true });
    });

    it('accepts a literal group repeated without an inner quantifier', () => {
      expect(lintPattern('(ab)+')).toEqual({ ok: true });
    });

    it('accepts an atom quantifier above 128 (unambiguous, linear-time regardless of count)', () => {
      expect(lintPattern('x{1,200}')).toEqual({ ok: true });
    });

    it('accepts all 7 built-in PII_PATTERNS sources against their own lint', () => {
      for (const [type, regex] of Object.entries(PII_PATTERNS)) {
        const result = lintPattern(regex!.source);
        expect(result, `built-in ${type} pattern should pass its own lint`).toEqual({ ok: true });
      }
      expect(Object.keys(PII_PATTERNS)).toHaveLength(7);
    });
  });

  describe('rejects unsafe custom patterns', () => {
    it('rejects a pattern shorter than 3 chars', () => {
      expect(lintPattern('ab')).toMatchObject({ ok: false, code: 'TOO_LONG' });
    });

    it('rejects a pattern longer than 256 chars', () => {
      expect(lintPattern('a'.repeat(257))).toMatchObject({ ok: false, code: 'TOO_LONG' });
    });

    it('rejects a pattern that fails to compile', () => {
      expect(lintPattern('(unterminated')).toMatchObject({ ok: false, code: 'SYNTAX' });
    });

    it('rejects a numeric backreference', () => {
      expect(lintPattern('(a)\\1')).toMatchObject({ ok: false, code: 'BACKREF' });
    });

    it('rejects a named backreference', () => {
      expect(lintPattern('(?<x>a)\\k<x>')).toMatchObject({ ok: false, code: 'BACKREF' });
    });

    it('rejects a lookahead', () => {
      expect(lintPattern('a(?=b)')).toMatchObject({ ok: false, code: 'LOOKAROUND' });
    });

    it('rejects a negative lookahead', () => {
      expect(lintPattern('a(?!b)')).toMatchObject({ ok: false, code: 'LOOKAROUND' });
    });

    it('rejects a lookbehind', () => {
      expect(lintPattern('(?<=a)b')).toMatchObject({ ok: false, code: 'LOOKAROUND' });
    });

    it('rejects a negative lookbehind', () => {
      expect(lintPattern('(?<!a)b')).toMatchObject({ ok: false, code: 'LOOKAROUND' });
    });

    it('rejects a group quantifier above 128', () => {
      expect(lintPattern('(?:ab){129}')).toMatchObject({ ok: false, code: 'UNBOUNDED_REPEAT' });
    });

    it('rejects a group range quantifier above 128', () => {
      expect(lintPattern('(?:ab){1,200}')).toMatchObject({ ok: false, code: 'UNBOUNDED_REPEAT' });
    });

    it('rejects the classic (a+)+ nested-quantifier class', () => {
      expect(lintPattern('(a+)+')).toMatchObject({ ok: false, code: 'NESTED_QUANTIFIER' });
    });

    it('rejects (a*)+ nested quantifiers', () => {
      expect(lintPattern('(a*)+')).toMatchObject({ ok: false, code: 'NESTED_QUANTIFIER' });
    });

    it('rejects (\\d+)* nested quantifiers', () => {
      expect(lintPattern('(\\d+)*')).toMatchObject({ ok: false, code: 'NESTED_QUANTIFIER' });
    });

    it('rejects a pattern that matches the empty string', () => {
      expect(lintPattern('a*b*')).toMatchObject({ ok: false, code: 'EMPTY_MATCH' });
    });

    it('rejects an all-optional pattern that matches the empty string', () => {
      expect(lintPattern('x?y?')).toMatchObject({ ok: false, code: 'EMPTY_MATCH' });
    });
  });

  describe('caseInsensitive flag', () => {
    it('is accepted and does not change accept/reject outcome', () => {
      expect(lintPattern('EMP-\\d{4,8}', true)).toEqual({ ok: true });
      expect(lintPattern('(a+)+', true)).toMatchObject({ code: 'NESTED_QUANTIFIER' });
    });
  });
});
