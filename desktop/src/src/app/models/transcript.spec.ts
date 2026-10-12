import { describe, it, expect } from 'vitest';
import { isSessionOngoing, type TranscriptStatus } from './transcript';

describe('isSessionOngoing', () => {
  it.each<[TranscriptStatus, boolean]>([
    [{ state: 'recording' }, true],
    [{ state: 'finalizing', progress: 0 }, true],
    [{ state: 'finalizing', progress: 1 }, true],
    [{ state: 'done' }, false],
    [{ state: 'failed', reason: '' }, false],
  ])('classifies %j as ongoing: %s', (status, ongoing) => {
    expect(isSessionOngoing(status)).toBe(ongoing);
  });
});
