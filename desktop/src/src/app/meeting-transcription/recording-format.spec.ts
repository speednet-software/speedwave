import { describe, it, expect } from 'vitest';
import {
  formatClock,
  formatDuration,
  formatRecordingDate,
  recordingName,
  statusChip,
} from './recording-format';

const NOW = new Date(2026, 9, 12, 14, 0, 0);

function utc(year: number, month: number, day: number, h: number, m: number): string {
  return new Date(year, month, day, h, m).toISOString();
}

describe('formatRecordingDate', () => {
  it('names today and yesterday in local time', () => {
    expect(formatRecordingDate(utc(2026, 9, 12, 9, 28), NOW)).toBe('Today 09:28');
    expect(formatRecordingDate(utc(2026, 9, 11, 23, 59), NOW)).toBe('Yesterday 23:59');
  });

  it('shows weekday and date earlier this year, and the year before that', () => {
    expect(formatRecordingDate(utc(2026, 9, 5, 11, 31), NOW)).toBe('Mon 5 Oct 11:31');
    expect(formatRecordingDate(utc(2025, 11, 30, 8, 5), NOW)).toBe('30 Dec 2025 08:05');
  });

  it('treats local midnight as the day boundary, not UTC', () => {
    expect(formatRecordingDate(utc(2026, 9, 12, 0, 1), NOW)).toBe('Today 00:01');
  });

  it('returns the raw value it cannot parse', () => {
    expect(formatRecordingDate('not a date', NOW)).toBe('not a date');
  });
});

describe('recordingName', () => {
  it('prefers the title and falls back to the local start time', () => {
    const created_at = utc(2026, 9, 12, 9, 28);
    expect(recordingName({ title: 'Sprint review', created_at }, NOW)).toBe('Sprint review');
    expect(recordingName({ title: null, created_at }, NOW)).toBe('Today 09:28');
    expect(recordingName({ title: '   ', created_at }, NOW)).toBe('Today 09:28');
    expect(recordingName({ created_at }, NOW)).toBe('Today 09:28');
  });
});

describe('formatDuration', () => {
  it('scales from seconds to hours', () => {
    expect(formatDuration(45.4)).toBe('45 s');
    expect(formatDuration(12 * 60 + 10)).toBe('12 min');
    expect(formatDuration(65 * 60)).toBe('1 h 05 min');
  });

  it('is empty for no audio and for nonsense input', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(-3)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
});

describe('formatClock', () => {
  it('pads minutes and seconds and adds hours past an hour', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(247_900)).toBe('04:07');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatClock(-5)).toBe('00:00');
  });
});

describe('statusChip', () => {
  it('maps every status to a label, a tooltip and a tone', () => {
    expect(statusChip({ state: 'recording' })).toEqual({
      label: 'recording',
      tooltip: 'Capture in progress.',
      tone: 'live',
    });
    expect(statusChip({ state: 'finalizing', progress: 0.424 }).label).toBe('transcribing 42%');
    expect(statusChip({ state: 'done' }).tone).toBe('ok');
    expect(statusChip({ state: 'failed', reason: 'no model' })).toEqual({
      label: 'failed',
      tooltip: 'no model',
      tone: 'error',
    });
  });
});
