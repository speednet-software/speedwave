import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { countTokenSpans, TOKEN_SPAN_RE_SOURCE } from './token-spans.js';

const SCAN_RS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../crates/pii-engine/src/scan.rs'
);

describe('TOKEN_SPAN_RE_SOURCE', () => {
  it('matches the Rust TOKEN_SPAN_RE byte for byte', () => {
    const source = readFileSync(SCAN_RS, 'utf-8');
    const match = source.match(/pub const TOKEN_SPAN_RE: &str = r"(.*)";/);
    expect(match).not.toBeNull();
    expect(TOKEN_SPAN_RE_SOURCE).toBe(match![1]);
  });
});

describe('countTokenSpans', () => {
  it('counts token spans per category anywhere in the value', () => {
    const detections = countTokenSpans({
      to: '[EMAIL:TOKEN_abc-_1]',
      cc: ['[EMAIL:TOKEN_def]', 'x [PHONE_NUMBER:TOKEN_Zz9] y'],
      nested: { note: 'plain text', iban: '[IBAN:TOKEN_q]' },
    });
    expect(detections).toEqual([
      { category: 'EMAIL', action: 'tokenized', count: 2 },
      { category: 'PHONE_NUMBER', action: 'tokenized', count: 1 },
      { category: 'IBAN', action: 'tokenized', count: 1 },
    ]);
  });

  it.each([
    ['no tokens', { text: 'alice@example.com' }],
    ['an empty object', {}],
    ['undefined', undefined],
    ['null', null],
    ['a lowercase category', { t: '[email:TOKEN_abc]' }],
    ['an empty payload', { t: '[EMAIL:TOKEN_]' }],
    ['a payload with a forbidden character', { t: '[EMAIL:TOKEN_a+b]' }],
  ])('finds nothing in %s', (_label, value) => {
    expect(countTokenSpans(value)).toEqual([]);
  });

  it('never returns the token payload itself', () => {
    const detections = countTokenSpans({ t: '[EMAIL:TOKEN_secretpayload]' });
    expect(JSON.stringify(detections)).not.toContain('secretpayload');
  });
});
