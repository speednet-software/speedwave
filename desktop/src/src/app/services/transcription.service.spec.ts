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

function seg(start: number, end: number, text: string): Segment {
  return {
    start: { secs: start, nanos: 0 },
    end: { secs: end, nanos: 0 },
    text,
    words: [],
  };
}

function snapshot(overrides: Partial<TranscriptSession> = {}): TranscriptSession {
  return {
    id: 'sess-1',
    created_at: '2026-05-12T00:00:00Z',
    language: 'pl',
    audio_source: { source: { kind: 'system_wide' }, label: 'System' },
    status: { state: 'recording' },
    live_segments: [],
    final_segments: null,
    audio_path: '/tmp/sess-1/audio.wav',
    models_used: {
      live: null,
      finalize: null,
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
      const mixed = { kind: 'mixed' as const, mic: null };
      await svc.startRecording(mixed, 'pl');
      expect(spy).toHaveBeenCalledWith('start_transcription', {
        params: {
          source: mixed,
          language: 'pl',
        },
      });
      // The recording id is tracked at service level so it survives a remount.
      expect(svc.recordingSessionId()).toBe('sess-1');
    });
  });

  describe('recording state survives a tab switch', () => {
    async function startWith(id: string): Promise<void> {
      const ack = {
        session_id: id,
        event_name: `transcript_event::${id}`,
        snapshot: snapshot({ id }),
      };
      mockTauri.invokeHandler = async (cmd) => (cmd === 'start_transcription' ? ack : undefined);
      await svc.startRecording({ kind: 'system_wide' }, 'pl');
    }

    it('stopRecording clears the tracked id', async () => {
      await startWith('sess-1');
      expect(svc.recordingSessionId()).toBe('sess-1');
      mockTauri.invokeHandler = async () => undefined;
      await svc.stopRecording('sess-1');
      expect(svc.recordingSessionId()).toBeNull();
    });

    it('stopRecording clears the id even if the backend call rejects', async () => {
      await startWith('sess-1');
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'stop_transcription') throw new Error('already stopping');
        return undefined;
      };
      await expect(svc.stopRecording('sess-1')).rejects.toThrow('already stopping');
      expect(svc.recordingSessionId()).toBeNull();
    });

    it('resumeActiveRecording re-subscribes to a still-running recording', async () => {
      await startWith('sess-1');
      await svc.detach(); // simulate the record tab being destroyed
      const seen: string[] = [];
      mockTauri.invokeHandler = async (cmd, args) => {
        seen.push(cmd);
        if (cmd === 'subscribe_transcript') {
          return {
            event_name: `transcript_event::${(args as { sessionId: string }).sessionId}`,
            snapshot: snapshot({ id: 'sess-1' }),
          };
        }
        return undefined;
      };
      await svc.resumeActiveRecording();
      expect(seen).toContain('subscribe_transcript');
    });

    it('resumeActiveRecording is a no-op when nothing is recording', async () => {
      const seen: string[] = [];
      mockTauri.invokeHandler = async (cmd) => {
        seen.push(cmd);
        return undefined;
      };
      await svc.resumeActiveRecording();
      expect(seen).toEqual([]);
    });
  });

  describe('recommendedModel', () => {
    it('reads the recommended model via recommended_transcription_model', async () => {
      const ack = {
        key: 'large-v3',
        display_name: 'Large v3',
        size_bytes: 3_100_000_000,
        downloaded: false,
        accel_label: 'Metal (GPU)',
      };
      mockTauri.invokeHandler = async (cmd) =>
        cmd === 'recommended_transcription_model' ? ack : undefined;
      expect(await svc.recommendedModel()).toEqual(ack);
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

    it('live_draft replaces the draft text wholesale', () => {
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'live_draft',
        seq: 1,
        text: 'first tail',
      });
      expect(svc.liveDraft()).toBe('first tail');
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'live_draft',
        seq: 2,
        text: 'longer second tail',
      });
      expect(svc.liveDraft()).toBe('longer second tail');
    });

    it('ignores a stale live_draft (seq below lastSeq)', () => {
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'live_draft',
        seq: 2,
        text: 'current',
      });
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'live_draft',
        seq: 1,
        text: 'stale',
      });
      expect(svc.liveDraft()).toBe('current');
    });

    it('a lifecycle change away from recording clears the draft', () => {
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'live_draft',
        seq: 1,
        text: 'tail',
      });
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'status_changed',
        seq: 2,
        status: { state: 'failed', reason: 'capture died' },
      });
      expect(svc.liveDraft()).toBe('');
    });

    it('a new session snapshot clears the previous draft', async () => {
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'live_draft',
        seq: 1,
        text: 'tail',
      });
      await subscribeWith(snapshot({ id: 'sess-2', last_seq: 0 }));
      expect(svc.liveDraft()).toBe('');
    });

    it('swaps in final_segments on final_segments_ready', () => {
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'segment_appended',
        seq: 1,
        segment: seg(0, 5, 'live-text'),
      });
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'final_segments_ready',
        seq: 2,
        segments: [seg(0, 5, 'higher-quality')],
      });
      const s = svc.active()!;
      expect(s.final_segments).toEqual([seg(0, 5, 'higher-quality')]);
      // live_segments untouched (the offline pass doesn't rewrite them).
      expect(s.live_segments[0].text).toBe('live-text');
    });
  });

  describe('sendToChat', () => {
    it('sends the transcript with a Polish summarization instruction on top', async () => {
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'get_transcript') return snapshot({ language: 'pl' });
        if (cmd === 'get_transcript_markdown') return '# Meeting transcript';
        return undefined;
      };
      await svc.sendToChat('sess-1');
      const [text, label] = mockChat.sendMessage.mock.calls[0];
      expect(label).toBe('Meeting transcript');
      expect(text).toContain('podsumowanie');
      expect(text.endsWith('# Meeting transcript')).toBe(true);
    });

    it('uses the English instruction for an English session', async () => {
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'get_transcript') return snapshot({ language: 'en' });
        if (cmd === 'get_transcript_markdown') return '# Meeting transcript';
        return undefined;
      };
      await svc.sendToChat('sess-1');
      const [text] = mockChat.sendMessage.mock.calls[0];
      expect(text).toContain('summary');
      expect(text).toContain('action item');
      expect(text.endsWith('# Meeting transcript')).toBe(true);
    });
  });

  describe('requestMicrophonePermission', () => {
    it('passes the backend verdict through', async () => {
      let invoked = '';
      mockTauri.invokeHandler = async (cmd) => {
        invoked = cmd;
        return 'previously_denied';
      };
      expect(await svc.requestMicrophonePermission()).toBe('previously_denied');
      expect(invoked).toBe('request_microphone_permission');
    });

    it('microphonePermissionStatus queries without prompting', async () => {
      let invoked = '';
      mockTauri.invokeHandler = async (cmd) => {
        invoked = cmd;
        return 'undetermined';
      };
      expect(await svc.microphonePermissionStatus()).toBe('undetermined');
      expect(invoked).toBe('microphone_permission_status');
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

  describe('capture warnings', () => {
    it('capture_warning events set the service signal', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      expect(svc.captureWarning()).toBeNull();
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'capture_warning',
        seq: 1,
        warning: 'system_audio_silent',
      });
      expect(svc.captureWarning()).toBe('system_audio_silent');
    });

    it('capture_warning_cleared removes the matching banner', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'capture_warning',
        seq: 1,
        warning: 'system_audio_silent',
      });
      expect(svc.captureWarning()).toBe('system_audio_silent');
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'capture_warning_cleared',
        seq: 2,
        warning: 'system_audio_silent',
      });
      expect(svc.captureWarning()).toBeNull();
    });

    it('capture_warning_cleared leaves a different active banner alone', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'capture_warning',
        seq: 1,
        warning: 'microphone_stalled',
      });
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'capture_warning_cleared',
        seq: 2,
        warning: 'system_audio_silent',
      });
      expect(svc.captureWarning()).toBe('microphone_stalled');
    });

    it('a new session snapshot clears the previous warning', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'capture_warning',
        seq: 1,
        warning: 'microphone_stalled',
      });
      expect(svc.captureWarning()).toBe('microphone_stalled');
      await subscribeWith(snapshot({ last_seq: 0 }));
      expect(svc.captureWarning()).toBeNull();
    });

    it('ignores a stale capture_warning (seq below the snapshot)', async () => {
      await subscribeWith(snapshot({ last_seq: 5 }));
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'capture_warning',
        seq: 3,
        warning: 'system_audio_silent',
      });
      expect(svc.captureWarning()).toBeNull();
    });
  });

  describe('model download tracking', () => {
    it('downloadModel tracks the key + progress, then clears on completion', async () => {
      let finish!: () => void;
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'download_transcription_model') {
          return new Promise<void>((resolve) => (finish = resolve));
        }
        return undefined;
      };
      const done = svc.downloadModel('large-v3');
      // A macrotask lets the listener attach AND the invoke start.
      await new Promise((r) => setTimeout(r, 0));
      expect(svc.downloadingModelKey()).toBe('large-v3');
      mockTauri.dispatchEvent('transcription_model_status', {
        model_key: 'large-v3',
        downloaded_bytes: 42,
        total_bytes: 100,
      });
      expect(svc.downloadProgress()?.downloaded_bytes).toBe(42);
      finish();
      await done;
      expect(svc.downloadingModelKey()).toBeNull();
      expect(svc.downloadProgress()).toBeNull();
    });

    it('clears tracking when the progress listener fails to attach', async () => {
      mockTauri.listen = vi.fn(async () => {
        throw new Error('ipc down');
      });
      await expect(svc.downloadModel('large-v3')).rejects.toThrow('ipc down');
      expect(svc.downloadingModelKey()).toBeNull();
    });

    it('clears tracking and rethrows when the backend download fails', async () => {
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'download_transcription_model') throw new Error('integrity check failed');
        return undefined;
      };
      await expect(svc.downloadModel('large-v3')).rejects.toThrow('integrity check');
      expect(svc.downloadingModelKey()).toBeNull();
    });

    it('rejects a second downloadModel while one is in flight', async () => {
      let finish!: () => void;
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'download_transcription_model') {
          return new Promise<void>((resolve) => (finish = resolve));
        }
        return undefined;
      };
      const first = svc.downloadModel('large-v3');
      await new Promise((r) => setTimeout(r, 0));
      await expect(svc.downloadModel('large-v3')).rejects.toThrow('already in progress');
      finish();
      await first;
    });

    it('ignores progress events for other model keys', async () => {
      await svc.resumeDownloadTracking('large-v3');
      mockTauri.dispatchEvent('transcription_model_status', {
        model_key: 'large-v3-turbo',
        downloaded_bytes: 7,
        total_bytes: 10,
      });
      expect(svc.downloadProgress()).toBeNull();
    });

    it('resumeDownloadTracking attaches without invoking the download command', async () => {
      const invoked: string[] = [];
      mockTauri.invokeHandler = async (cmd) => {
        invoked.push(cmd);
        return undefined;
      };
      await svc.resumeDownloadTracking('large-v3');
      expect(invoked).toEqual([]);
      expect(svc.downloadingModelKey()).toBe('large-v3');
      mockTauri.dispatchEvent('transcription_model_status', {
        model_key: 'large-v3',
        downloaded_bytes: 99,
        total_bytes: 100,
      });
      expect(svc.downloadProgress()?.downloaded_bytes).toBe(99);
    });

    it('clearDownloadTracking detaches the progress listener', async () => {
      await svc.resumeDownloadTracking('large-v3');
      svc.clearDownloadTracking();
      expect(svc.downloadingModelKey()).toBeNull();
      mockTauri.dispatchEvent('transcription_model_status', {
        model_key: 'large-v3',
        downloaded_bytes: 5,
        total_bytes: 10,
      });
      expect(svc.downloadProgress()).toBeNull();
    });
  });
});
