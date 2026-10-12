import type { TranscriptSession } from '../models/transcript';

/**
 * Builds a recording `sess-1` session with no segments for specs.
 * @param overrides - fields that differ from the default session.
 */
export function makeTranscriptSession(
  overrides: Partial<TranscriptSession> = {}
): TranscriptSession {
  return {
    id: 'sess-1',
    created_at: '2026-05-12T00:00:00Z',
    language: 'pl',
    audio_source: { source: { kind: 'system_wide' }, label: 'System' },
    status: { state: 'recording' },
    live_segments: [],
    final_segments: null,
    audio_path: '/tmp/sess-1/audio.wav',
    models_used: { live: null, finalize: null },
    last_seq: 0,
    ...overrides,
  };
}
