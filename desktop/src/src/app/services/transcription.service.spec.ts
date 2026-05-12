import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranscriptionService } from './transcription.service';
import { TauriService } from './tauri.service';
import { ChatStateService } from './chat-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import type { Segment, TranscriptSession } from '../models/transcript';

/** Minimal ChatStateService stand-in — only `sendMessage` is exercised here. */
class MockChatState {
  sendMessage = vi.fn(async (_text: string, _label?: string) => undefined);
}

function seg(start: number, end: number, text: string, speaker: number | null = null): Segment {
  return {
    start: { secs: start, nanos: 0 },
    end: { secs: end, nanos: 0 },
    text,
    words: [],
    speaker,
  };
}

function snapshot(overrides: Partial<TranscriptSession> = {}): TranscriptSession {
  return {
    id: 'sess-1',
    created_at: '2026-05-12T00:00:00Z',
    language: 'pl',
    audio_source: { source: { kind: 'system_wide' }, label: 'System', app_id: null },
    status: { state: 'recording' },
    live_segments: [],
    final_segments: null,
    audio_path: '/tmp/sess-1/audio.wav',
    speaker_names: {},
    models_used: {
      live: null,
      finalize: null,
      diarization_segmentation: null,
      diarization_embedding: null,
    },
    last_seq: 0,
    ...overrides,
  } as TranscriptSession;
}

describe('TranscriptionService', () => {
  let svc: TranscriptionService;
  let mockTauri: MockTauriService;
  let mockChat: MockChatState;

  beforeEach(() => {
    mockTauri = new MockTauriService();
    mockChat = new MockChatState();
    mockTauri.invokeHandler = async () => undefined;

    TestBed.configureTestingModule({
      providers: [
        TranscriptionService,
        { provide: TauriService, useValue: mockTauri },
        { provide: ChatStateService, useValue: mockChat },
      ],
    });
    svc = TestBed.inject(TranscriptionService);
  });

  /**
   * Subscribes the service to a session with the given snapshot, returns the event name.
   * @param snap - the snapshot the mocked `subscribe_transcript` should return.
   */
  async function subscribeWith(snap: TranscriptSession): Promise<string> {
    mockTauri.invokeHandler = async (cmd) => {
      if (cmd === 'subscribe_transcript') {
        return { event_name: 'transcript_event::sess-1', snapshot: snap };
      }
      return undefined;
    };
    const ack = await svc.subscribeToTranscript('sess-1');
    return ack.event_name;
  }

  it('should create', () => {
    expect(svc).toBeTruthy();
  });

  describe('startRecording', () => {
    it('forwards the source object (incl. a mixed source) to start_transcription', async () => {
      const ack = {
        session_id: 'sess-1',
        event_name: 'transcript_event::sess-1',
        snapshot: snapshot(),
      };
      mockTauri.invokeHandler = async (cmd) => (cmd === 'start_transcription' ? ack : undefined);
      const spy = vi.spyOn(mockTauri, 'invoke');
      const mixed = { kind: 'mixed' as const, system: { kind: 'system_wide' as const }, mic: null };
      await svc.startRecording(mixed, 'pl');
      expect(spy).toHaveBeenCalledWith('start_transcription', {
        source: mixed,
        language: 'pl',
        liveModelOverride: null,
      });
    });
  });

  describe('isEnabled / setEnabled', () => {
    it('reads the toggle via transcription_enabled', async () => {
      mockTauri.invokeHandler = async (cmd) => (cmd === 'transcription_enabled' ? true : undefined);
      expect(await svc.isEnabled()).toBe(true);
    });

    it('persists via set_transcription_enabled', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      await svc.setEnabled(false);
      expect(spy).toHaveBeenCalledWith('set_transcription_enabled', { enabled: false });
    });
  });

  describe('subscribeToTranscript', () => {
    it('applies the snapshot and resets lastSeq', async () => {
      await subscribeWith(snapshot({ last_seq: 5, live_segments: [seg(0, 1, 'hi')] }));
      expect(svc.active()?.last_seq).toBe(5);
      expect(svc.active()?.live_segments.length).toBe(1);
      // A stale event (seq <= 5) is ignored.
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'segment_appended',
        seq: 5,
        segment: seg(1, 2, 'late'),
      });
      expect(svc.active()?.live_segments.length).toBe(1);
    });
  });

  describe('applyEvent (idempotent reducer)', () => {
    beforeEach(async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
    });

    it('appends a live segment', () => {
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'segment_appended',
        seq: 1,
        segment: seg(0, 2, 'first'),
      });
      expect(svc.active()?.live_segments).toEqual([seg(0, 2, 'first')]);
      expect(svc.active()?.last_seq).toBe(1);
    });

    it('ignores events with seq <= lastSeq', () => {
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'segment_appended',
        seq: 1,
        segment: seg(0, 2, 'a'),
      });
      // Out-of-order / replayed event — dropped.
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'segment_appended',
        seq: 1,
        segment: seg(0, 2, 'dup'),
      });
      expect(svc.active()?.live_segments.length).toBe(1);
      expect(svc.active()?.live_segments[0].text).toBe('a');
    });

    it('replaces the tail on segments_replaced', () => {
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'segment_appended',
        seq: 1,
        segment: seg(0, 2, 'keep'),
      });
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'segments_replaced',
        seq: 2,
        from_index: 1,
        segments: [seg(2, 4, 'new1'), seg(4, 6, 'new2')],
      });
      expect(svc.active()?.live_segments.map((s) => s.text)).toEqual(['keep', 'new1', 'new2']);
    });

    it('stamps a speaker via speaker_assigned', () => {
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'segment_appended',
        seq: 1,
        segment: seg(0, 2, 'x'),
      });
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'speaker_assigned',
        seq: 2,
        segment_index: 0,
        speaker: 1,
      });
      expect(svc.active()?.live_segments[0].speaker).toBe(1);
    });

    it('updates status on status_changed and finalize_progress', () => {
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'finalize_progress',
        seq: 1,
        progress: 0.5,
      });
      expect(svc.active()?.status).toEqual({ state: 'finalizing', progress: 0.5 });
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'finished',
        seq: 2,
      });
      expect(svc.active()?.status).toEqual({ state: 'done' });
    });

    it('converts the wire pair-array into a record on speaker_relabeled', () => {
      // The Rust event sends [[id, name], …]; the reducer must normalise it
      // to the { id: name } shape the snapshot uses.
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'speaker_relabeled',
        seq: 1,
        speaker_names: [
          [0, 'Ola'],
          [1, 'Bartek'],
        ],
      });
      expect(svc.active()?.speaker_names).toEqual({ 0: 'Ola', 1: 'Bartek' });
    });

    it('swaps in final_segments on final_segments_ready (pair-array → record)', () => {
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'segment_appended',
        seq: 1,
        segment: seg(0, 5, 'live-text'),
      });
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'final_segments_ready',
        seq: 2,
        segments: [seg(0, 5, 'higher-quality', 0)],
        speaker_names: [[0, 'Ola']],
      });
      const s = svc.active()!;
      expect(s.final_segments).toEqual([seg(0, 5, 'higher-quality', 0)]);
      expect(s.speaker_names).toEqual({ 0: 'Ola' });
      // live_segments untouched (the offline pass doesn't rewrite them).
      expect(s.live_segments[0].text).toBe('live-text');
    });
  });

  describe('sendToChat', () => {
    it('renders markdown and forwards it to ChatStateService.sendMessage', async () => {
      mockTauri.invokeHandler = async (cmd) =>
        cmd === 'get_transcript_markdown' ? '# Meeting transcript' : undefined;
      await svc.sendToChat('sess-1');
      expect(mockChat.sendMessage).toHaveBeenCalledWith(
        '# Meeting transcript',
        'Meeting transcript'
      );
    });
  });

  describe('detach', () => {
    it('stops listening (a later event is ignored)', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      await svc.detach();
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'segment_appended',
        seq: 1,
        segment: seg(0, 1, 'after-detach'),
      });
      expect(svc.active()?.live_segments.length).toBe(0);
    });
  });
});
