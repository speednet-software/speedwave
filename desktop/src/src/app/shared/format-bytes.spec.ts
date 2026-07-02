import { describe, it, expect } from 'vitest';
import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it('formats sub-KB byte counts (happy path)', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3_145_728)).toBe('3.0 MB');
  });

  it('formats GB-range sizes', () => {
    // 3 GiB exactly.
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(formatBytes(1_610_612_736)).toBe('1.5 GB');
  });

  it('handles the 0-byte edge', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('handles unit boundaries', () => {
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });
});
