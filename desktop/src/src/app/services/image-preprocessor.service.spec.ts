import { describe, it, expect } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  NATIVE_LONG_EDGE,
  ERROR_TOO_LARGE,
  ERROR_UNSUPPORTED_TYPE,
} from './image-preprocessor.service';

describe('NATIVE_LONG_EDGE', () => {
  it('mirrors Anthropic Vision docs (Opus 4.7 = 2576, Sonnet/Haiku = 1568)', () => {
    expect(NATIVE_LONG_EDGE.opus).toBe(2576);
    expect(NATIVE_LONG_EDGE.sonnet).toBe(1568);
    expect(NATIVE_LONG_EDGE.haiku).toBe(1568);
  });
});

describe('limit constants', () => {
  it('per-image binary cap is 3 MiB (tidy + fast file read; ADR-065)', () => {
    expect(MAX_IMAGE_BYTES).toBe(3 * 1024 * 1024);
  });
});

describe('error message constants', () => {
  it('ERROR_TOO_LARGE references the 3 MB threshold so the toast tells the user what to do', () => {
    expect(ERROR_TOO_LARGE).toContain('3 MB');
  });

  it('ERROR_UNSUPPORTED_TYPE lists the four supported formats', () => {
    expect(ERROR_UNSUPPORTED_TYPE).toMatch(/JPEG.*PNG.*GIF.*WebP/);
  });
});
