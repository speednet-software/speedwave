import { describe, it, expect } from 'vitest';
import { errorText } from './error-text';

describe('errorText', () => {
  it('returns the message of an Error', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
  });

  it('stringifies anything else', () => {
    expect(errorText('plain')).toBe('plain');
    expect(errorText(42)).toBe('42');
  });
});
