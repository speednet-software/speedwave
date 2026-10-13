import type { TranscriptStatus } from '../models/transcript';

/** How a status chip is drawn: its text, the tooltip that explains it, and its colour. */
export interface StatusChip {
  label: string;
  tooltip: string;
  tone: 'live' | 'busy' | 'muted' | 'error';
}

/** Shortcut that starts or stops a recording while the recordings view is open. */
export const RECORD_SHORTCUT_HINT = '⌘⇧R';

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Start time of a recording in the user's local time zone, relative to `now`: "Today 09:28",
 * "Yesterday 11:02", "Mon 6 Oct 11:31", or with the year once it is not the current one.
 * @param createdAt - RFC 3339 UTC timestamp from the backend.
 * @param now - the reference moment (injected for tests).
 */
export function formatRecordingDate(createdAt: string, now: Date = new Date()): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return createdAt;
  const time = TIME.format(at);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThatDay = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const daysAgo = Math.round((startOfToday - startOfThatDay) / 86_400_000);
  if (daysAgo === 0) return `Today ${time}`;
  if (daysAgo === 1) return `Yesterday ${time}`;
  if (at.getFullYear() === now.getFullYear()) {
    return `${WEEKDAY.format(at)} ${DAY_MONTH.format(at)} ${time}`;
  }
  return `${DAY_MONTH_YEAR.format(at)} ${time}`;
}

/**
 * The name a recording is shown under: the user's title, else its local start time.
 * @param rec - anything carrying the backend `title` and `created_at`.
 * @param rec.title - user-given title, if any.
 * @param rec.created_at - RFC 3339 UTC start time.
 * @param now - the reference moment (injected for tests).
 */
export function recordingName(
  rec: { title?: string | null; created_at: string },
  now: Date = new Date()
): string {
  return rec.title?.trim() || formatRecordingDate(rec.created_at, now);
}

/**
 * Recording length as "45 s", "12 min" or "1 h 05 min"; '' for no audio yet.
 * @param secs - seconds of recorded audio.
 */
export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const total = Math.round(secs);
  if (total < 60) return `${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/**
 * A running clock for the recording view: "04:07", or "1:02:03" past an hour.
 * @param ms - elapsed milliseconds.
 */
export function formatClock(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(secs / 3600);
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

/** Whether a transcript was made with this machine's best model, or with a smaller fallback. */
export type TranscriptQuality = 'high' | 'smaller';

/**
 * Quality of a transcript from the model its offline pass ran with; null when no pass ran yet or
 * the best model is not known.
 * @param finalizeModel - `models_used.finalize` of the recording.
 * @param bestModel - key of this machine's high-quality model.
 */
export function transcriptQuality(
  finalizeModel: string | null | undefined,
  bestModel: string | null | undefined
): TranscriptQuality | null {
  if (!finalizeModel || !bestModel) return null;
  return finalizeModel === bestModel ? 'high' : 'smaller';
}

/**
 * Heading of the day group a recording falls in: "Today", "Yesterday", "Mon 12 Oct", or with the
 * year once it is not the current one.
 * @param createdAt - RFC 3339 UTC timestamp from the backend.
 * @param now - the reference moment (injected for tests).
 */
export function dayGroupLabel(createdAt: string, now: Date = new Date()): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return '';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThatDay = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const daysAgo = Math.round((startOfToday - startOfThatDay) / 86_400_000);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  if (at.getFullYear() === now.getFullYear()) {
    return `${WEEKDAY.format(at)} ${DAY_MONTH.format(at)}`;
  }
  return DAY_MONTH_YEAR.format(at);
}

/**
 * Local start time of a recording, "09:03".
 * @param createdAt - RFC 3339 UTC timestamp from the backend.
 */
export function formatStartTime(createdAt: string): string {
  const at = new Date(createdAt);
  return Number.isNaN(at.getTime()) ? '' : TIME.format(at);
}

/**
 * The list chip of a recording, only for a state worth a look: recording, paused, transcribing or
 * queued, failed, or made with the smaller model. A good finished transcript gets none.
 * @param rec - the list row.
 * @param rec.status - its lifecycle status.
 * @param rec.queued - whether its offline pass waits for another one.
 * @param rec.finalize_model - the model its offline pass ran with.
 * @param bestModel - key of this machine's high-quality model, when known.
 */
export function statusChip(
  rec: { status: TranscriptStatus; queued?: boolean; finalize_model?: string | null },
  bestModel: string | null = null
): StatusChip | null {
  const status = rec.status;
  switch (status.state) {
    case 'recording':
      return { label: 'Recording', tooltip: 'Capture in progress.', tone: 'live' };
    case 'paused':
      return {
        label: 'Paused',
        tooltip: 'Nothing is being recorded. Resume or stop it in the bar above.',
        tone: 'busy',
      };
    case 'finalizing':
      return rec.queued
        ? {
            label: 'Queued',
            tooltip: 'Transcription starts when the one before it finishes.',
            tone: 'muted',
          }
        : {
            label: `Transcribing ${Math.round(status.progress * 100)}%`,
            tooltip: 'The audio is being transcribed on this machine.',
            tone: 'busy',
          };
    case 'done':
      return transcriptQuality(rec.finalize_model, bestModel) === 'smaller'
        ? {
            label: 'Smaller model',
            tooltip:
              'Transcribed with the smaller model because the high-quality one was not downloaded.',
            tone: 'busy',
          }
        : null;
    case 'failed':
      return { label: 'Not transcribed', tooltip: status.reason, tone: 'error' };
  }
}
