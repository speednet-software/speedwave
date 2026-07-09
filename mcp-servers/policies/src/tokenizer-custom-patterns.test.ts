import { describe, it, expect } from 'vitest';
import { createPIIContext, tokenizePII, detokenizePII } from './tokenizer.js';
import { compilePolicy, defaultResolvedPolicy } from './resolved-policy.js';
import type { ResolvedPolicy } from './types.js';

describe('custom pattern tokenization', () => {
  it('round-trips a custom pattern through tokenize/detokenize', () => {
    const policy: ResolvedPolicy = {
      ...defaultResolvedPolicy(),
      customPatterns: [
        {
          id: 'EMPLOYEE_ID',
          displayName: 'Employee ID',
          pattern: '\\bEMP-\\d{4,8}\\b',
          caseInsensitive: false,
          forced: false,
        },
      ],
    };
    const context = createPIIContext(compilePolicy(policy));

    const original = { note: 'Badge EMP-12345 issued' };
    const tokenized = tokenizePII(original, context) as { note: string };

    expect(tokenized.note).toMatch(/\[EMPLOYEE_ID:TOKEN_[A-F0-9]+\]/);
    expect(tokenized.note).not.toContain('EMP-12345');

    const restored = detokenizePII(tokenized, context) as { note: string };
    expect(restored).toEqual(original);
  });

  it('matches case-insensitively when caseInsensitive is set', () => {
    const policy: ResolvedPolicy = {
      ...defaultResolvedPolicy(),
      customPatterns: [
        {
          id: 'BADGE_ID',
          displayName: 'Badge ID',
          pattern: '\\bbadge-\\d{4}\\b',
          caseInsensitive: true,
          forced: false,
        },
      ],
    };
    const context = createPIIContext(compilePolicy(policy));

    const tokenized = tokenizePII({ text: 'Visitor BADGE-9876 checked in' }, context) as {
      text: string;
    };

    expect(tokenized.text).toMatch(/\[BADGE_ID:TOKEN_[A-F0-9]+\]/);
    expect(tokenized.text).not.toContain('BADGE-9876');
  });

  it('does not match case-insensitively when caseInsensitive is false', () => {
    const policy: ResolvedPolicy = {
      ...defaultResolvedPolicy(),
      customPatterns: [
        {
          id: 'BADGE_ID',
          displayName: 'Badge ID',
          pattern: '\\bbadge-\\d{4}\\b',
          caseInsensitive: false,
          forced: false,
        },
      ],
    };
    const context = createPIIContext(compilePolicy(policy));

    const tokenized = tokenizePII({ text: 'Visitor BADGE-9876 checked in' }, context) as {
      text: string;
    };

    expect(tokenized.text).toBe('Visitor BADGE-9876 checked in');
  });
});

describe('zero-length-match backstop', () => {
  it('does not spin forever and skips a zero-length match from a hand-built CompiledPolicy', () => {
    // EMPTY_MATCH lint rejects such patterns before compilePolicy, so exercise the runtime
    // backstop directly with a hand-built CompiledPolicy that bypasses lint.
    const policy = compilePolicy(defaultResolvedPolicy());
    const contextPolicy = {
      ...policy,
      patterns: [{ type: 'ZERO_WIDTH', regex: /x?/g }],
    };
    const context = createPIIContext(contextPolicy);

    const start = Date.now();
    const result = tokenizePII('abc', context) as string;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    // No non-empty match exists ('x' is absent), so nothing is tokenized.
    expect(result).toBe('abc');
    expect(context.tokens.size).toBe(0);
  });
});
