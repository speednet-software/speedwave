import { describe, it, expect } from 'vitest';
import {
  dayGroupLabel,
  formatClock,
  formatDuration,
  formatRecordingDate,
  formatStartTime,
  modelLabel,
  recordingName,
  statusChip,
  transcriptQuality,
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

describe('dayGroupLabel', () => {
  it('names today, yesterday, a date this year and one in an earlier year', () => {
    expect(dayGroupLabel(utc(2026, 9, 12, 0, 1), NOW)).toBe('Today');
    expect(dayGroupLabel(utc(2026, 9, 11, 23, 59), NOW)).toBe('Yesterday');
    expect(dayGroupLabel(utc(2026, 9, 5, 11, 31), NOW)).toBe('Mon 5 Oct');
    expect(dayGroupLabel(utc(2025, 11, 30, 8, 5), NOW)).toBe('30 Dec 2025');
  });

  it('is empty for a value it cannot parse', () => {
    expect(dayGroupLabel('nope', NOW)).toBe('');
  });
});

describe('formatStartTime', () => {
  it('shows the local start time, empty when unparsable', () => {
    expect(formatStartTime(utc(2026, 9, 12, 9, 3))).toBe('09:03');
    expect(formatStartTime('nope')).toBe('');
  });
});

describe('transcriptQuality', () => {
  it('compares the model the pass ran with to the best one', () => {
    expect(transcriptQuality('large-v3-turbo', 'large-v3-turbo')).toBe('high');
    expect(transcriptQuality('small', 'large-v3-turbo')).toBe('smaller');
  });

  it('is unknown before a pass ran or while the best model is not known', () => {
    expect(transcriptQuality(null, 'large-v3-turbo')).toBeNull();
    expect(transcriptQuality(undefined, 'large-v3-turbo')).toBeNull();
    expect(transcriptQuality('small', null)).toBeNull();
  });
});

describe('statusChip', () => {
  const done = { state: 'done' } as const;

  it('gives a good finished transcript no chip', () => {
    expect(statusChip({ status: done, finalize_model: 'large' }, 'large')).toBeNull();
    expect(statusChip({ status: done, finalize_model: null }, 'large')).toBeNull();
    expect(statusChip({ status: done, finalize_model: 'small' }, null)).toBeNull();
  });

  it('flags a transcript made with the smaller model', () => {
    expect(statusChip({ status: done, finalize_model: 'small' }, 'large')?.label).toBe(
      'Smaller model'
    );
  });

  it('labels capture, pause, transcription, queue and failure', () => {
    expect(statusChip({ status: { state: 'recording' } })).toEqual({
      label: 'Recording',
      tooltip: 'Capture in progress.',
      tone: 'live',
    });
    expect(statusChip({ status: { state: 'paused' } })?.label).toBe('Paused');
    expect(statusChip({ status: { state: 'finalizing', progress: 0.424 } })?.label).toBe(
      'Transcribing 42%'
    );
    expect(
      statusChip({ status: { state: 'finalizing', progress: 0 }, queued: true })
    ).toMatchObject({ label: 'Queued', tone: 'muted' });
    expect(statusChip({ status: { state: 'failed', reason: 'no model' } })).toEqual({
      label: 'Not transcribed',
      tooltip: 'no model',
      tone: 'error',
    });
  });

  it('marks a put-off transcription as muted, not as an error', () => {
    expect(statusChip({ status: { state: 'postponed' } })).toMatchObject({
      label: 'Not transcribed yet',
      tone: 'muted',
    });
  });
});

describe('modelLabel', () => {
  it.each([
    ['large-v3-turbo', 'Large v3 Turbo'],
    ['large-v3', 'Large v3'],
    ['small', 'Small'],
    ['medium-q5_0', 'Medium (quantised)'],
    ['large-v3-turbo-q5_0', 'Large v3 Turbo (quantised)'],
    ['', ''],
  ])('names %j as %j', (key, label) => {
    expect(modelLabel(key)).toBe(label);
  });
});
