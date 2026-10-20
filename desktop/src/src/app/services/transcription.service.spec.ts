import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import {
  LIVE_TRANSCRIPT_STORAGE_KEY,
  RECORDING_CHOICE_STORAGE_KEY,
  TranscriptionService,
} from './transcription.service';
import { TauriService } from './tauri.service';
import { CHAT_TAB_CLOSED, ChatStateService } from './chat-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { createDeferred } from '../testing/deferred';
import { makeTranscriptSession as snapshot } from '../testing/transcript-session';
import type {
  CaptureWarning,
  Segment,
  TranscriptSession,
  TranscriptStatus,
  TranscriptSummary,
} from '../models/transcript';
import type { StagedTranscript } from '../models/chat';

/** One chat tab's staging fields, as `ChatSessionStore` carries them. */
interface MockTab {
  stagedTranscript: WritableSignal<StagedTranscript | null>;
  stageTranscript: (transcript: StagedTranscript) => void;
  composerPromptDraft: WritableSignal<string>;
}

/** Minimal ChatStateService stand-in: tab tracking plus the new-chat entry point. */
class MockChatState {
  readonly isStreamingFromState = signal(false);
  calls: string[] = [];
  /** Whether `openNewChat` opens a new tab (beta) instead of restarting the active one. */
  opensTab = false;
  private readonly tabStores = new Map<string, MockTab>([['tab-1', mockTab()]]);
  private active = 'tab-1';
  private nextTab = 2;
  activeTabId = (): string => this.active;
  tabs = (): ReadonlyMap<string, MockTab> => new Map(this.tabStores);
  activateTab = vi.fn((tabId: string) => {
    if (this.tabStores.has(tabId)) this.active = tabId;
  });
  claimTab = vi.fn((tabId: string): MockTab => {
    const tab = this.tabStores.get(tabId);
    if (!tab) throw new Error(CHAT_TAB_CLOSED);
    this.active = tabId;
    return tab;
  });
  openNewChat = vi.fn(async (originTabId: string): Promise<string> => {
    this.calls.push(`openNewChat:${originTabId}`);
    if (!this.opensTab) {
      this.claimTab(originTabId);
      return originTabId;
    }
    const tabId = `tab-${this.nextTab++}`;
    this.switchToNewTab(tabId);
    return tabId;
  });
  sendMessage = vi.fn(async (_text: string, _label?: string) => {
    this.calls.push('sendMessage');
  });

  /**
   * Test helper: the staging fields of one tab.
   * @param tabId - id of an open tab.
   */
  tab(tabId: string): MockTab {
    const tab = this.tabStores.get(tabId);
    if (!tab) throw new Error(`no tab ${tabId}`);
    return tab;
  }

  /**
   * Test helper: opens another tab and makes it active, as the tab strip does.
   * @param tabId - id of the new tab to open and activate.
   */
  switchToNewTab(tabId: string): void {
    this.tabStores.set(tabId, mockTab());
    this.active = tabId;
  }

  /**
   * Test helper: simulates the user closing a tab.
   * @param tabId - id of the tab to close.
   */
  closeTab(tabId: string): void {
    this.tabStores.delete(tabId);
  }
}

function mockTab(): MockTab {
  const stagedTranscript = signal<StagedTranscript | null>(null);
  return {
    stagedTranscript,
    stageTranscript: (transcript) => stagedTranscript.set(transcript),
    composerPromptDraft: signal(''),
  };
}

function seg(start: number, end: number, text: string): Segment {
  return {
    start: { secs: start, nanos: 0 },
    end: { secs: end, nanos: 0 },
    text,
    words: [],
  };
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
      await svc.startRecording(mixed, 'pl', true);
      expect(spy).toHaveBeenCalledWith('start_transcription', {
        params: {
          source: mixed,
          language: 'pl',
          live: true,
        },
      });
      expect(svc.recordingSessionId()).toBe('sess-1');
      expect(svc.recordingSource()).toEqual(mixed);
      expect(svc.recordingLanguage()).toBe('pl');
    });

    it('stops the already-started backend capture when attachListener rejects', async () => {
      const ack = {
        session_id: 'sess-1',
        event_name: 'transcript_event::sess-1',
        snapshot: snapshot(),
      };
      const invoked: string[] = [];
      mockTauri.invokeHandler = async (cmd) => {
        invoked.push(cmd);
        return cmd === 'start_transcription' ? ack : undefined;
      };
      mockTauri.listen = vi.fn(async () => {
        throw new Error('ipc down');
      });
      await expect(svc.startRecording({ kind: 'system_wide' }, 'pl', true)).rejects.toThrow(
        'ipc down'
      );
      expect(invoked).toContain('stop_transcription');
      expect(svc.recordingSessionId()).toBeNull();
      expect(svc.recordingSource()).toBeNull();
      expect(svc.recordingLanguage()).toBeNull();
    });

    it('keeps the session id when both attachListener and the rollback stop fail', async () => {
      const ack = {
        session_id: 'sess-1',
        event_name: 'transcript_event::sess-1',
        snapshot: snapshot(),
      };
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'start_transcription') return ack;
        if (cmd === 'stop_transcription') throw new Error('stop failed');
        return undefined;
      };
      mockTauri.listen = vi.fn(async () => {
        throw new Error('ipc down');
      });
      await expect(svc.startRecording({ kind: 'system_wide' }, 'pl', true)).rejects.toThrow(
        'ipc down'
      );
      expect(svc.recordingSessionId()).toBe('sess-1');
    });
  });

  describe('recordingLive tracks how the recording actually started', () => {
    async function startWithLiveModel(live: string | null): Promise<void> {
      const ack = {
        session_id: 'sess-1',
        event_name: 'transcript_event::sess-1',
        snapshot: snapshot({ models_used: { live, finalize: null } }),
      };
      mockTauri.invokeHandler = async (cmd) => (cmd === 'start_transcription' ? ack : undefined);
      await svc.startRecording({ kind: 'system_wide' }, 'pl', true);
    }

    it('is null while nothing is recording', () => {
      expect(svc.recordingLive()).toBeNull();
    });

    it('is true when the session snapshot names a live model', async () => {
      await startWithLiveModel('small');
      expect(svc.recordingLive()).toBe(true);
    });

    it('is false for a record-only session even though live was requested', async () => {
      await startWithLiveModel(null);
      expect(svc.recordingLive()).toBe(false);
    });

    it('clears on stopRecording', async () => {
      await startWithLiveModel('small');
      mockTauri.invokeHandler = async () => undefined;
      await svc.stopRecording('sess-1');
      expect(svc.recordingLive()).toBeNull();
    });

    it('clears when the session ends on its own', async () => {
      await startWithLiveModel('small');
      mockTauri.dispatchEvent('transcript_event::sess-1', { kind: 'finished', seq: 1 });
      expect(svc.recording()).toBe(false);
      expect(svc.recordingLive()).toBeNull();
    });

    it('stamps when the recording started and clears the stamp when it stops', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000);
      await startWithLiveModel(null);
      expect(svc.recordingStartedAt()).toBe(1_000);
      mockTauri.invokeHandler = async () => undefined;
      await svc.stopRecording('sess-1');
      expect(svc.recordingStartedAt()).toBeNull();
      vi.restoreAllMocks();
    });

    it('clears when a failed start rolls back successfully', async () => {
      await startWithLiveModel('small');
      expect(svc.recordingLive()).toBe(true);
      mockTauri.listen = vi.fn(async () => {
        throw new Error('ipc down');
      });
      await expect(svc.startRecording({ kind: 'system_wide' }, 'pl', true)).rejects.toThrow(
        'ipc down'
      );
      expect(svc.recordingLive()).toBeNull();
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
      await svc.startRecording({ kind: 'system_wide' }, 'pl', true);
    }

    it('stopRecording clears the tracked id, source, and language', async () => {
      await startWith('sess-1');
      expect(svc.recordingSessionId()).toBe('sess-1');
      expect(svc.recordingSource()).toEqual({ kind: 'system_wide' });
      expect(svc.recordingLanguage()).toBe('pl');
      mockTauri.invokeHandler = async () => undefined;
      await svc.stopRecording('sess-1');
      expect(svc.recordingSessionId()).toBeNull();
      expect(svc.recordingSource()).toBeNull();
      expect(svc.recordingLanguage()).toBeNull();
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

    it('keeps the live stream needed after stopRecording until the offline pass ends', async () => {
      await startWith('sess-1');
      mockTauri.invokeHandler = async () => undefined;
      await svc.stopRecording('sess-1');
      expect(svc.recording()).toBe(false);
      expect(svc.liveStreamNeeded()).toBe(true);

      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'status_changed',
        seq: 1,
        status: { state: 'finalizing', progress: 0 },
      });
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'finalize_progress',
        seq: 2,
        progress: 0.47,
      });
      expect(svc.liveStreamNeeded()).toBe(true);

      mockTauri.dispatchEvent('transcript_event::sess-1', { kind: 'finished', seq: 3 });
      expect(svc.liveStreamNeeded()).toBe(false);
    });

    it('clears the tracked recording when the driver fails on its own', async () => {
      await startWith('sess-1');
      expect(svc.recording()).toBe(true);

      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'status_changed',
        seq: 1,
        status: { state: 'failed', reason: 'capture device lost' },
      });

      expect(svc.recording()).toBe(false);
      expect(svc.recordingSessionId()).toBeNull();
      expect(svc.recordingSource()).toBeNull();
      expect(svc.recordingLanguage()).toBeNull();
    });

    it('clears the tracked recording when the session finishes', async () => {
      await startWith('sess-1');
      mockTauri.dispatchEvent('transcript_event::sess-1', { kind: 'finished', seq: 1 });
      expect(svc.recording()).toBe(false);
    });

    it('keeps the tracked recording while the status stays recording', async () => {
      await startWith('sess-1');
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'status_changed',
        seq: 1,
        status: { state: 'recording' },
      });
      expect(svc.recordingSessionId()).toBe('sess-1');
      expect(svc.recording()).toBe(true);
    });

    it('clears the tracked recording when a snapshot shows it already ended', async () => {
      await startWith('sess-1');
      await svc.detach();
      mockTauri.invokeHandler = async () => ({
        event_name: 'transcript_event::sess-1',
        snapshot: snapshot({ id: 'sess-1', status: { state: 'done' } }),
      });
      await svc.subscribeToTranscript('sess-1');
      expect(svc.recording()).toBe(false);
      expect(svc.recordingSessionId()).toBeNull();
      expect(svc.liveDraft()).toBe('');
      expect(svc.audioLevels()).toBeNull();
    });

    it('keeps the tracked recording when the snapshot is still recording', async () => {
      await startWith('sess-1');
      await svc.detach();
      mockTauri.invokeHandler = async () => ({
        event_name: 'transcript_event::sess-1',
        snapshot: snapshot({ id: 'sess-1' }),
      });
      await svc.subscribeToTranscript('sess-1');
      expect(svc.recordingSessionId()).toBe('sess-1');
    });

    it('resumeActiveRecording re-subscribes to a still-running recording', async () => {
      await startWith('sess-1');
      await svc.detach();
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

    it('opens another recording while one records, and keeps following the recording', async () => {
      await startWith('sess-1');
      mockTauri.invokeHandler = async (cmd) =>
        cmd === 'subscribe_transcript'
          ? {
              event_name: 'transcript_event::sess-2',
              snapshot: snapshot({ id: 'sess-2', status: { state: 'done' } }),
            }
          : undefined;
      await svc.subscribeToTranscript('sess-2');
      expect(svc.active()?.id).toBe('sess-2');
      expect(svc.recordingSessionId()).toBe('sess-1');

      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'audio_level',
        seq: 1,
        levels: [0.2],
      });
      expect(svc.audioLevels()).toEqual([0.2]);
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'capture_warning',
        seq: 2,
        warning: 'microphone_stalled',
      });
      expect(svc.captureWarnings()).toEqual(['microphone_stalled']);
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'status_changed',
        seq: 3,
        status: { state: 'finalizing', progress: 0 },
      });
      expect(svc.recording()).toBe(false);
      expect(svc.audioLevels()).toBeNull();
      expect(svc.captureWarnings()).toEqual([]);
      expect(svc.active()?.id).toBe('sess-2');
    });

    it('ignores recording events it has already applied', async () => {
      await startWith('sess-1');
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'audio_level',
        seq: 2,
        levels: [0.5],
      });
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'audio_level',
        seq: 2,
        levels: [0.9],
      });
      expect(svc.audioLevels()).toEqual([0.5]);
    });

    it('subscribeToTranscript still works for the recording own session while recording', async () => {
      await startWith('sess-1');
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'subscribe_transcript') {
          return {
            event_name: 'transcript_event::sess-1',
            snapshot: snapshot({ id: 'sess-1', last_seq: 3 }),
          };
        }
        return undefined;
      };
      const ack = await svc.subscribeToTranscript('sess-1');
      expect(ack.event_name).toBe('transcript_event::sess-1');
      expect(svc.active()?.last_seq).toBe(3);
    });

    it('resubscribing to the same in-progress recording preserves the live draft', async () => {
      await startWith('sess-1');
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'live_draft',
        seq: 1,
        text: 'not yet committed',
      });
      expect(svc.liveDraft()).toBe('not yet committed');

      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'subscribe_transcript') {
          return {
            event_name: 'transcript_event::sess-1',
            snapshot: snapshot({ id: 'sess-1', last_seq: 1 }),
          };
        }
        return undefined;
      };
      await svc.subscribeToTranscript('sess-1');
      expect(svc.liveDraft()).toBe('not yet committed');
    });

    it('subscribeToTranscript switches sessions freely once nothing is recording', async () => {
      await startWith('sess-1');
      await svc.stopRecording('sess-1');
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'subscribe_transcript') {
          return {
            event_name: 'transcript_event::sess-2',
            snapshot: snapshot({ id: 'sess-2' }),
          };
        }
        return undefined;
      };
      await svc.subscribeToTranscript('sess-2');
      expect(svc.active()?.id).toBe('sess-2');
    });
  });

  describe('recommendedModel', () => {
    it('reads the recommended model via recommended_transcription_model', async () => {
      const ack = {
        live: {
          key: 'large-v3',
          display_name: 'Large v3',
          size_bytes: 3_100_000_000,
          downloaded: false,
          downloading: false,
        },
        finalize: null,
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
      expect(s.live_segments[0].text).toBe('live-text');
    });

    it('leaves loudness to the running recording, so an opened session sets none', () => {
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'audio_level',
        seq: 1,
        levels: [0.12, 0.03],
      });
      expect(svc.audioLevels()).toBeNull();
      expect(svc.active()?.last_seq).toBe(1);
    });
  });

  describe('pause and resume', () => {
    function row(id: string, overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
      return {
        id,
        created_at: '2026-10-13T08:30:00Z',
        title: null,
        language: 'pl',
        source_label: 'System',
        status: { state: 'done' },
        duration_secs: 754,
        segment_count: 0,
        preview: null,
        size_bytes: 1,
        finalize_model: null,
        queued: false,
        ...overrides,
      };
    }

    it('pauses through pause_transcription, ends the capture and finds the paused row', async () => {
      const ack = {
        session_id: 'sess-1',
        event_name: 'transcript_event::sess-1',
        snapshot: snapshot(),
      };
      let rows: TranscriptSummary[] = [];
      const seen: string[] = [];
      mockTauri.invokeHandler = async (cmd) => {
        seen.push(cmd);
        if (cmd === 'start_transcription') return ack;
        if (cmd === 'pause_transcription') rows = [row('sess-1', { status: { state: 'paused' } })];
        if (cmd === 'list_transcripts') return rows;
        return undefined;
      };
      await svc.startRecording({ kind: 'system_wide' }, 'pl', false);
      expect(svc.captureOpen()).toBe(true);
      await svc.pauseRecording('sess-1');
      expect(seen).toContain('pause_transcription');
      expect(svc.recording()).toBe(false);
      expect(svc.pausedRecording()?.id).toBe('sess-1');
      expect(svc.captureOpen()).toBe(true);
    });

    it('clears the capture even when the pause call fails', async () => {
      const ack = {
        session_id: 'sess-1',
        event_name: 'transcript_event::sess-1',
        snapshot: snapshot(),
      };
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'start_transcription') return ack;
        if (cmd === 'pause_transcription') throw new Error('not capturing');
        return undefined;
      };
      await svc.startRecording({ kind: 'system_wide' }, 'pl', false);
      await expect(svc.pauseRecording('sess-1')).rejects.toThrow('not capturing');
      expect(svc.recording()).toBe(false);
    });

    it('resumes with the clock going on from the length already recorded', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'list_transcripts') return [row('sess-1', { status: { state: 'paused' } })];
        if (cmd === 'resume_transcription') {
          return {
            session_id: 'sess-1',
            event_name: 'transcript_event::sess-1',
            snapshot: snapshot({ id: 'sess-1' }),
          };
        }
        return undefined;
      };
      await svc.refreshRecordings();
      await svc.resumeRecording('sess-1', false);
      expect(svc.recordingStartedAt()).toBe(1_000_000 - 754_000);
      vi.restoreAllMocks();
    });

    it('lists the recordings still being transcribed', async () => {
      mockTauri.invokeHandler = async (cmd) =>
        cmd === 'list_transcripts'
          ? [
              row('a', { status: { state: 'finalizing', progress: 0.2 } }),
              row('b'),
              row('c', { status: { state: 'finalizing', progress: 0 }, queued: true }),
            ]
          : undefined;
      await svc.refreshRecordings();
      expect(svc.transcribing().map((r) => r.id)).toEqual(['a', 'c']);
      expect(svc.pausedRecording()).toBeNull();
      expect(svc.captureOpen()).toBe(false);
    });
  });

  describe('remembered recording choice', () => {
    beforeEach(() => localStorage.removeItem(RECORDING_CHOICE_STORAGE_KEY));

    it('round-trips language, source and microphone', () => {
      expect(svc.recordingChoice()).toBeNull();
      svc.setRecordingChoice({ language: 'en', source: 'mixed', mic: 'usb' });
      expect(svc.recordingChoice()).toEqual({ language: 'en', source: 'mixed', mic: 'usb' });
    });

    it('ignores a stored value it does not recognise', () => {
      localStorage.setItem(RECORDING_CHOICE_STORAGE_KEY, '{"language":"de","source":"mixed"}');
      expect(svc.recordingChoice()).toBeNull();
      localStorage.setItem(RECORDING_CHOICE_STORAGE_KEY, '{"language":"pl","source":"tv"}');
      expect(svc.recordingChoice()).toBeNull();
      localStorage.setItem(RECORDING_CHOICE_STORAGE_KEY, 'not json');
      expect(svc.recordingChoice()).toBeNull();
      localStorage.setItem(
        RECORDING_CHOICE_STORAGE_KEY,
        '{"language":"pl","source":"mixed","mic":7}'
      );
      expect(svc.recordingChoice()).toEqual({ language: 'pl', source: 'mixed', mic: null });
    });
  });

  describe('high-quality model', () => {
    const entry = (key: string, downloaded: boolean) => ({
      key,
      display_name: key,
      size_bytes: 1,
      downloaded,
      downloading: false,
    });

    it('is the offline-pass model when the host has one, else the live model', async () => {
      expect(svc.highQualityModel()).toBeNull();
      mockTauri.invokeHandler = async () => ({
        live: entry('small', true),
        finalize: entry('large', false),
        accel_label: 'CPU',
      });
      await svc.loadRecommendedModel();
      expect(svc.highQualityModel()?.key).toBe('large');
      mockTauri.invokeHandler = async () => ({
        live: entry('turbo', true),
        finalize: null,
        accel_label: 'Metal',
      });
      await svc.loadRecommendedModel();
      expect(svc.highQualityModel()?.key).toBe('turbo');
    });

    it('keeps the last read when a re-read fails', async () => {
      mockTauri.invokeHandler = async () => ({
        live: entry('small', true),
        finalize: entry('large', true),
        accel_label: 'CPU',
      });
      await svc.loadRecommendedModel();
      mockTauri.invokeHandler = async () => {
        throw new Error('ipc down');
      };
      await svc.loadRecommendedModel();
      expect(svc.highQualityModel()?.key).toBe('large');
    });

    it('re-reads it after a download finishes', async () => {
      let downloaded = false;
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'download_transcription_model') downloaded = true;
        if (cmd === 'recommended_transcription_model') {
          return {
            live: entry('small', true),
            finalize: entry('large', downloaded),
            accel_label: 'CPU',
          };
        }
        return undefined;
      };
      await svc.downloadModel('large');
      expect(svc.highQualityModel()?.downloaded).toBe(true);
    });
  });

  describe('live-transcript preference', () => {
    beforeEach(() => {
      localStorage.removeItem(LIVE_TRANSCRIPT_STORAGE_KEY);
    });

    it('is off when nothing is stored', () => {
      expect(svc.liveTranscriptPreferred()).toBe(false);
    });

    it('a stored choice round-trips under the v2 key', () => {
      svc.setLiveTranscriptPreferred(true);
      expect(svc.liveTranscriptPreferred()).toBe(true);
      expect(localStorage.getItem(LIVE_TRANSCRIPT_STORAGE_KEY)).toBe('on');
      svc.setLiveTranscriptPreferred(false);
      expect(svc.liveTranscriptPreferred()).toBe(false);
      expect(localStorage.getItem(LIVE_TRANSCRIPT_STORAGE_KEY)).toBe('off');
    });

    it('drops the pre-v2 default-on choice once, so it never applies again', () => {
      localStorage.setItem('speedwave-live-transcript', 'on');
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          TranscriptionService,
          { provide: TauriService, useValue: mockTauri },
          { provide: ChatStateService, useValue: mockChat },
        ],
      });
      const fresh = TestBed.inject(TranscriptionService);
      expect(localStorage.getItem('speedwave-live-transcript')).toBeNull();
      expect(fresh.liveTranscriptPreferred()).toBe(false);
    });

    it('reads as off when storage throws', () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied');
      });
      expect(svc.liveTranscriptPreferred()).toBe(false);
      spy.mockRestore();
    });
  });

  describe('recordings list', () => {
    function summary(id: string, overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
      return {
        id,
        created_at: '2026-10-12T07:28:04Z',
        title: null,
        language: 'pl',
        source_label: 'System',
        status: { state: 'done' },
        duration_secs: 60,
        segment_count: 3,
        preview: 'hej',
        size_bytes: 1000,
        finalize_model: null,
        queued: false,
        ...overrides,
      };
    }

    it('loads the list and re-reads it on every transcripts_changed event', async () => {
      let rows = [summary('a')];
      const invoked: string[] = [];
      mockTauri.invokeHandler = async (cmd) => {
        invoked.push(cmd);
        return cmd === 'list_transcripts' ? rows : undefined;
      };
      await svc.watchRecordings();
      expect(svc.recordings().map((r) => r.id)).toEqual(['a']);

      rows = [summary('b'), summary('a')];
      mockTauri.dispatchEvent('transcripts_changed', 'b');
      await svc.refreshRecordings();
      expect(svc.recordings().map((r) => r.id)).toEqual(['b', 'a']);
      expect(invoked.filter((c) => c === 'list_transcripts').length).toBeGreaterThanOrEqual(2);
    });

    it('attaches the change listener once however often it is asked to watch', async () => {
      mockTauri.invokeHandler = async () => [];
      const listen = vi.spyOn(mockTauri, 'listen');
      await svc.watchRecordings();
      await svc.watchRecordings();
      expect(listen).toHaveBeenCalledTimes(1);
    });

    it('coalesces refreshes requested while one is reading into a single follow-up read', async () => {
      const gate = createDeferred<TranscriptSummary[]>();
      let calls = 0;
      mockTauri.invokeHandler = async () => {
        calls += 1;
        return calls === 1 ? gate.promise : [summary('late')];
      };
      const first = svc.refreshRecordings();
      void svc.refreshRecordings();
      void svc.refreshRecordings();
      gate.resolve([summary('early')]);
      await first;
      expect(calls).toBe(2);
      expect(svc.recordings().map((r) => r.id)).toEqual(['late']);
    });

    it('keeps the last good list and reports why a read failed', async () => {
      mockTauri.invokeHandler = async () => [summary('a')];
      await svc.refreshRecordings();
      mockTauri.invokeHandler = async () => {
        throw new Error('disk gone');
      };
      await svc.refreshRecordings();
      expect(svc.recordings().map((r) => r.id)).toEqual(['a']);
      expect(svc.recordingsError()).toBe('disk gone');
    });

    it('rename stores the backend title on the list row and the open session', async () => {
      await subscribeWith(snapshot({ status: { state: 'done' } }));
      mockTauri.invokeHandler = async (cmd) =>
        cmd === 'list_transcripts' ? [summary('sess-1')] : undefined;
      await svc.refreshRecordings();
      mockTauri.invokeHandler = async (cmd, args) => {
        expect(cmd).toBe('rename_transcript');
        expect(args).toEqual({ sessionId: 'sess-1', title: '  Retro ' });
        return 'Retro';
      };
      expect(await svc.rename('sess-1', '  Retro ')).toBe('Retro');
      expect(svc.active()?.title).toBe('Retro');
      expect(svc.recordings()[0].title).toBe('Retro');
    });

    it('rename leaves everything as it was when the backend refuses', async () => {
      mockTauri.invokeHandler = async (cmd) =>
        cmd === 'list_transcripts' ? [summary('a')] : undefined;
      await svc.refreshRecordings();
      mockTauri.invokeHandler = async () => {
        throw new Error('no such transcript session');
      };
      await expect(svc.rename('a', 'x')).rejects.toThrow('no such transcript session');
      expect(svc.recordings()[0].title).toBeNull();
    });

    it('delete drops the row at once', async () => {
      mockTauri.invokeHandler = async (cmd) =>
        cmd === 'list_transcripts' ? [summary('a'), summary('b')] : undefined;
      await svc.refreshRecordings();
      await svc.delete('a');
      expect(svc.recordings().map((r) => r.id)).toEqual(['b']);
    });
  });

  describe('transcribe, export and reveal', () => {
    it('transcribe asks the backend, then re-attaches the open session to show progress', async () => {
      await subscribeWith(snapshot({ status: { state: 'failed', reason: 'interrupted' } }));
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd) => {
        calls.push(cmd);
        if (cmd === 'subscribe_transcript') {
          return {
            event_name: 'transcript_event::sess-1',
            snapshot: snapshot({ status: { state: 'finalizing', progress: 0 } }),
          };
        }
        return undefined;
      };
      await svc.transcribe('sess-1');
      expect(calls).toEqual(['transcribe_transcript', 'subscribe_transcript']);
      expect(svc.active()?.status).toEqual({ state: 'finalizing', progress: 0 });
    });

    it('transcribe of a recording that is not open does not touch the pane', async () => {
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd) => {
        calls.push(cmd);
        return undefined;
      };
      await svc.transcribe('other');
      expect(calls).toEqual(['transcribe_transcript']);
      expect(svc.active()).toBeNull();
    });

    it('postpone puts the transcription off through the backend', async () => {
      const calls: [string, unknown][] = [];
      mockTauri.invokeHandler = async (cmd, args) => {
        calls.push([cmd, args]);
        return undefined;
      };
      await svc.postpone('sess-1');
      expect(calls).toEqual([['postpone_transcription', { sessionId: 'sess-1' }]]);
    });

    it('postpone surfaces the backend refusal', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('only a recording that is being transcribed can be put off');
      };
      await expect(svc.postpone('x')).rejects.toThrow('being transcribed');
    });

    it('stops following a session once its transcription is put off', async () => {
      await subscribeWith(snapshot({ status: { state: 'finalizing', progress: 0.3 } }));
      expect(svc.liveStreamNeeded()).toBe(true);
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'status_changed',
        seq: 1,
        status: { state: 'postponed' },
      });
      expect(svc.active()?.status).toEqual({ state: 'postponed' });
      expect(svc.liveStreamNeeded()).toBe(false);
    });

    it('transcribe surfaces the backend refusal', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('only a failed recording can be transcribed again');
      };
      await expect(svc.transcribe('x')).rejects.toThrow('only a failed recording');
    });

    it('export and reveal address the backend by session id', async () => {
      const calls: [string, unknown][] = [];
      mockTauri.invokeHandler = async (cmd, args) => {
        calls.push([cmd, args]);
        return cmd === 'export_transcript' ? false : undefined;
      };
      expect(await svc.exportMarkdown('s')).toBe(false);
      await svc.revealAudio('s');
      expect(calls).toEqual([
        ['export_transcript', { sessionId: 's' }],
        ['reveal_transcript_audio', { sessionId: 's' }],
      ]);
    });
  });

  describe('stageForChat', () => {
    /**
     * Answers the two transcript reads a staging call performs.
     * @param language - session language the snapshot reports.
     */
    function transcriptHandler(language: 'pl' | 'en') {
      return async (cmd: string) => {
        if (cmd === 'get_transcript') return snapshot({ language });
        if (cmd === 'get_transcript_markdown') return '# Meeting transcript';
        return undefined;
      };
    }

    /**
     * Holds the markdown read until the returned gate resolves, so a test can act mid-flow.
     * @returns the gate the markdown read waits on.
     */
    function gateMarkdown() {
      const markdownGate = createDeferred<string>();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_transcript') return snapshot({ language: 'en' });
        if (cmd === 'get_transcript_markdown') return markdownGate.promise;
        return undefined;
      };
      return markdownGate;
    }

    beforeEach(() => {
      mockTauri.invokeHandler = transcriptHandler('en');
    });

    it('stages the Polish default prompt and the transcript in the tab, sending nothing', async () => {
      mockTauri.invokeHandler = transcriptHandler('pl');
      await svc.stageForChat('sess-1');
      expect(mockChat.tab('tab-1').composerPromptDraft()).toContain('podsumowanie');
      expect(mockChat.tab('tab-1').stagedTranscript()?.markdown).toBe('# Meeting transcript');
      expect(mockChat.sendMessage).not.toHaveBeenCalled();
    });

    it('says the transcript is attached, not "below", in both languages', async () => {
      await svc.stageForChat('sess-1');
      expect(mockChat.tab('tab-1').composerPromptDraft()).toMatch(
        /^Attached is a meeting transcript\./
      );
      mockTauri.invokeHandler = transcriptHandler('pl');
      await svc.stageForChat('sess-1');
      const prompt = mockChat.tab('tab-1').composerPromptDraft();
      expect(prompt).toMatch(/^W załączniku transkrypt spotkania\./);
      expect(prompt).not.toContain('Poniżej');
    });

    it('names the staged transcript after the recording', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_transcript') return snapshot({ language: 'en', title: 'Sprint review' });
        if (cmd === 'get_transcript_markdown') return '# Sprint review';
        return undefined;
      };
      await svc.stageForChat('sess-1');
      expect(mockChat.tab('tab-1').stagedTranscript()?.name).toBe('Sprint review');
    });

    it('names an untitled transcript by its start time', async () => {
      await svc.stageForChat('sess-1');
      const name = mockChat.tab('tab-1').stagedTranscript()?.name ?? '';
      expect(name).not.toBe('');
      expect(name).not.toContain('T00:00:00Z');
    });

    it('uses the English default prompt for an English session', async () => {
      await svc.stageForChat('sess-1');
      expect(mockChat.tab('tab-1').composerPromptDraft()).toContain('summary');
      expect(mockChat.tab('tab-1').composerPromptDraft()).toContain('action item');
    });

    it('opens a new chat before staging, by default', async () => {
      await svc.stageForChat('sess-1');
      expect(mockChat.calls).toEqual(['openNewChat:tab-1']);
    });

    it('stages into the tab a new chat opened and leaves the origin tab untouched', async () => {
      mockChat.opensTab = true;
      await svc.stageForChat('sess-1');
      expect(mockChat.activeTabId()).toBe('tab-2');
      expect(mockChat.tab('tab-2').stagedTranscript()?.markdown).toBe('# Meeting transcript');
      expect(mockChat.tab('tab-2').composerPromptDraft()).toContain('summary');
      expect(mockChat.tab('tab-1').stagedTranscript()).toBeNull();
      expect(mockChat.tab('tab-1').composerPromptDraft()).toBe('');
    });

    it('keeps the active conversation when the caller asks for it', async () => {
      await svc.stageForChat('sess-1', 'current-chat');
      expect(mockChat.openNewChat).not.toHaveBeenCalled();
      expect(mockChat.tab('tab-1').stagedTranscript()?.markdown).toBe('# Meeting transcript');
    });

    it('leaves the conversation untouched when the transcript cannot be read', async () => {
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'get_transcript') throw new Error('transcript gone');
        return undefined;
      };
      await expect(svc.stageForChat('sess-1')).rejects.toThrow('transcript gone');
      expect(mockChat.openNewChat).not.toHaveBeenCalled();
      expect(mockChat.tab('tab-1').stagedTranscript()).toBeNull();
      expect(mockChat.tab('tab-1').composerPromptDraft()).toBe('');
    });

    it('stages nothing when the new chat fails to open', async () => {
      mockChat.openNewChat.mockRejectedValueOnce(new Error('no session'));
      await expect(svc.stageForChat('sess-1')).rejects.toThrow('no session');
      expect(mockChat.tab('tab-1').stagedTranscript()).toBeNull();
      expect(mockChat.tab('tab-1').composerPromptDraft()).toBe('');
    });

    it('replaces an earlier staging in the same tab with the newest transcript', async () => {
      await svc.stageForChat('sess-1');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_transcript') return snapshot({ language: 'en' });
        if (cmd === 'get_transcript_markdown') return '# Second meeting';
        return undefined;
      };
      await svc.stageForChat('sess-1', 'current-chat');
      expect(mockChat.tab('tab-1').stagedTranscript()?.markdown).toBe('# Second meeting');
    });

    it('delivers the transcript to the tab that was active when staging started, even if the user switches tabs mid-flow', async () => {
      const markdownGate = gateMarkdown();
      const staging = svc.stageForChat('sess-1', 'current-chat');
      await new Promise((r) => setTimeout(r, 0));

      mockChat.switchToNewTab('tab-2');
      markdownGate.resolve('# Meeting transcript');
      await staging;

      expect(mockChat.claimTab).toHaveBeenCalledWith('tab-1');
      expect(mockChat.activeTabId()).toBe('tab-1');
      expect(mockChat.tab('tab-1').stagedTranscript()?.markdown).toBe('# Meeting transcript');
      expect(mockChat.tab('tab-2').stagedTranscript()).toBeNull();
    });

    it('re-targets the origin tab before opening the new chat, not whichever tab is active at that point', async () => {
      const markdownGate = gateMarkdown();
      const staging = svc.stageForChat('sess-1');
      await new Promise((r) => setTimeout(r, 0));

      mockChat.switchToNewTab('tab-2');
      markdownGate.resolve('# Meeting transcript');
      await staging;

      expect(mockChat.calls).toEqual(['openNewChat:tab-1']);
      expect(mockChat.tab('tab-1').stagedTranscript()).not.toBeNull();
    });

    it('fails instead of misattaching the transcript when the origin tab was closed mid-flow', async () => {
      const markdownGate = gateMarkdown();
      const staging = svc.stageForChat('sess-1', 'current-chat');
      await new Promise((r) => setTimeout(r, 0));

      mockChat.switchToNewTab('tab-2');
      mockChat.closeTab('tab-1');
      markdownGate.resolve('# Meeting transcript');

      await expect(staging).rejects.toThrow(CHAT_TAB_CLOSED);
      expect(mockChat.tab('tab-2').stagedTranscript()).toBeNull();
      expect(mockChat.tab('tab-2').composerPromptDraft()).toBe('');
    });

    it('still attaches to a new tab when the origin tab, which a new tab does not use, closed mid-flow', async () => {
      mockChat.opensTab = true;
      const markdownGate = gateMarkdown();
      const staging = svc.stageForChat('sess-1');
      await new Promise((r) => setTimeout(r, 0));

      mockChat.switchToNewTab('tab-9');
      mockChat.closeTab('tab-1');
      markdownGate.resolve('# Meeting transcript');
      await staging;

      expect(mockChat.activeTabId()).toBe('tab-2');
      expect(mockChat.tab('tab-2').stagedTranscript()?.markdown).toBe('# Meeting transcript');
      expect(mockChat.tab('tab-9').stagedTranscript()).toBeNull();
    });

    it('fails instead of staging elsewhere when the new tab closed before staging landed', async () => {
      mockChat.openNewChat.mockImplementationOnce(async () => {
        mockChat.switchToNewTab('tab-2');
        mockChat.closeTab('tab-2');
        mockChat.activateTab('tab-1');
        return 'tab-2';
      });
      await expect(svc.stageForChat('sess-1')).rejects.toThrow(CHAT_TAB_CLOSED);
      expect(mockChat.tab('tab-1').stagedTranscript()).toBeNull();
      expect(mockChat.tab('tab-1').composerPromptDraft()).toBe('');
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

  describe('liveStreamNeeded', () => {
    it('is false without an active session', () => {
      expect(svc.liveStreamNeeded()).toBe(false);
    });

    it.each<[TranscriptStatus, boolean]>([
      [{ state: 'recording' }, true],
      [{ state: 'finalizing', progress: 0.4 }, true],
      [{ state: 'done' }, false],
      [{ state: 'failed', reason: 'decoder crashed' }, false],
    ])('follows a %j snapshot (needed: %s)', async (status, needed) => {
      await subscribeWith(snapshot({ status }));
      expect(svc.recording()).toBe(false);
      expect(svc.liveStreamNeeded()).toBe(needed);
    });

    it('stays needed through finalize_progress and ends with finished', async () => {
      await subscribeWith(snapshot({ status: { state: 'finalizing', progress: 0.1 } }));
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'finalize_progress',
        seq: 1,
        progress: 0.6,
      });
      expect(svc.liveStreamNeeded()).toBe(true);
      mockTauri.dispatchEvent('transcript_event::sess-1', { kind: 'finished', seq: 2 });
      expect(svc.liveStreamNeeded()).toBe(false);
      expect(svc.active()?.status).toEqual({ state: 'done' });
    });

    it('ends when the offline pass fails', async () => {
      await subscribeWith(snapshot({ status: { state: 'finalizing', progress: 0.1 } }));
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'status_changed',
        seq: 1,
        status: { state: 'failed', reason: 'decoder crashed' },
      });
      expect(svc.liveStreamNeeded()).toBe(false);
      expect(svc.active()?.status).toEqual({ state: 'failed', reason: 'decoder crashed' });
    });

    it('keeps applying the offline pass events while the stream stays attached', async () => {
      await subscribeWith(snapshot({ status: { state: 'finalizing', progress: 0.05 } }));
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'finalize_progress',
        seq: 1,
        progress: 0.9,
      });
      expect(svc.active()?.status).toEqual({ state: 'finalizing', progress: 0.9 });
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'final_segments_ready',
        seq: 2,
        segments: [seg(0, 5, 'higher-quality')],
      });
      mockTauri.dispatchEvent('transcript_event::sess-1', { kind: 'finished', seq: 3 });
      const s = svc.active()!;
      expect(s.final_segments).toEqual([seg(0, 5, 'higher-quality')]);
      expect(s.status).toEqual({ state: 'done' });
      expect(s.last_seq).toBe(3);
    });
  });

  describe('delete', () => {
    it('clears the shown session and stops listening when it is the one deleted', async () => {
      await subscribeWith(snapshot({ status: { state: 'finalizing', progress: 0.47 } }));
      mockTauri.invokeHandler = async () => undefined;
      await svc.delete('sess-1');
      expect(svc.active()).toBeNull();
      expect(svc.liveStreamNeeded()).toBe(false);
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'finalize_progress',
        seq: 1,
        progress: 0.6,
      });
      expect(svc.active()).toBeNull();
    });

    it('keeps the shown session when another one is deleted', async () => {
      await subscribeWith(snapshot({ status: { state: 'finalizing', progress: 0.47 } }));
      mockTauri.invokeHandler = async () => undefined;
      await svc.delete('sess-2');
      mockTauri.dispatchEvent('transcript_event::sess-1', {
        kind: 'finalize_progress',
        seq: 1,
        progress: 0.6,
      });
      expect(svc.active()?.status).toEqual({ state: 'finalizing', progress: 0.6 });
    });

    it('keeps the shown session when the backend refuses the delete', async () => {
      await subscribeWith(snapshot());
      mockTauri.invokeHandler = async () => {
        throw new Error('stop the recording before deleting it');
      };
      await expect(svc.delete('sess-1')).rejects.toThrow('stop the recording before deleting it');
      expect(svc.active()?.id).toBe('sess-1');
      expect(svc.liveStreamNeeded()).toBe(true);
    });
  });

  describe('capture warnings', () => {
    /**
     * Dispatches a raise/clear event on the subscribed session.
     * @param kind - which transition to send.
     * @param warning - the warning variant.
     * @param seq - event sequence number.
     */
    function warn(
      kind: 'capture_warning' | 'capture_warning_cleared',
      warning: CaptureWarning,
      seq: number
    ): void {
      mockTauri.dispatchEvent('transcript_event::sess-1', { kind, seq, warning });
    }

    it('capture_warning events add to the raised set', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      expect(svc.captureWarnings()).toEqual([]);
      warn('capture_warning', 'system_audio_silent', 1);
      expect(svc.captureWarnings()).toEqual(['system_audio_silent']);
    });

    it('two different warnings coexist, in arrival order', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      warn('capture_warning', 'microphone_stalled', 1);
      warn('capture_warning', 'audio_dropped', 2);
      expect(svc.captureWarnings()).toEqual(['microphone_stalled', 'audio_dropped']);
    });

    it('re-raising the same warning does not duplicate it', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      warn('capture_warning', 'microphone_stalled', 1);
      warn('capture_warning', 'microphone_stalled', 2);
      expect(svc.captureWarnings()).toEqual(['microphone_stalled']);
    });

    it('capture_warning_cleared removes the matching banner', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      warn('capture_warning', 'system_audio_silent', 1);
      expect(svc.captureWarnings()).toEqual(['system_audio_silent']);
      warn('capture_warning_cleared', 'system_audio_silent', 2);
      expect(svc.captureWarnings()).toEqual([]);
    });

    it('clearing one warning leaves the other still raised', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      warn('capture_warning', 'microphone_stalled', 1);
      warn('capture_warning', 'system_audio_stalled', 2);
      warn('capture_warning_cleared', 'system_audio_stalled', 3);
      expect(svc.captureWarnings()).toEqual(['microphone_stalled']);
    });

    it('capture_warning_cleared leaves a different active banner alone', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      warn('capture_warning', 'microphone_stalled', 1);
      warn('capture_warning_cleared', 'system_audio_silent', 2);
      expect(svc.captureWarnings()).toEqual(['microphone_stalled']);
    });

    it('a snapshot rebuilds the raised set instead of blanking it', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      warn('capture_warning', 'microphone_stalled', 1);
      await subscribeWith(
        snapshot({ last_seq: 0, active_warnings: ['audio_dropped', 'system_audio_silent'] })
      );
      expect(svc.captureWarnings()).toEqual(['audio_dropped', 'system_audio_silent']);
    });

    it('a snapshot without warnings clears the previous ones', async () => {
      await subscribeWith(snapshot({ last_seq: 0 }));
      warn('capture_warning', 'microphone_stalled', 1);
      expect(svc.captureWarnings()).toEqual(['microphone_stalled']);
      await subscribeWith(snapshot({ last_seq: 0 }));
      expect(svc.captureWarnings()).toEqual([]);
    });

    it('ignores a stale capture_warning (seq below the snapshot)', async () => {
      await subscribeWith(snapshot({ last_seq: 5 }));
      warn('capture_warning', 'system_audio_silent', 3);
      expect(svc.captureWarnings()).toEqual([]);
    });
  });

  describe('model download tracking', () => {
    it('downloadModel tracks the key + progress, then clears on completion', async () => {
      const pendingDownload = createDeferred();
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'download_transcription_model') return pendingDownload.promise;
        return undefined;
      };
      const done = svc.downloadModel('large-v3');
      await new Promise((r) => setTimeout(r, 0));
      expect(svc.downloadingModelKey()).toBe('large-v3');
      mockTauri.dispatchEvent('transcription_model_status', {
        model_key: 'large-v3',
        downloaded_bytes: 42,
        total_bytes: 100,
      });
      expect(svc.downloadProgress()?.downloaded_bytes).toBe(42);
      pendingDownload.resolve();
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
      const pendingDownload = createDeferred();
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'download_transcription_model') return pendingDownload.promise;
        return undefined;
      };
      const first = svc.downloadModel('large-v3');
      await new Promise((r) => setTimeout(r, 0));
      await expect(svc.downloadModel('large-v3')).rejects.toThrow('already in progress');
      pendingDownload.resolve();
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
      svc.clearDownloadTracking();
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
      svc.clearDownloadTracking();
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

    describe('resumeDownloadTracking completion polling', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('clears tracking once the backend reports the resumed download finished', async () => {
        mockTauri.invokeHandler = async (cmd) =>
          cmd === 'recommended_transcription_model'
            ? {
                live: {
                  key: 'large-v3',
                  display_name: 'Large v3',
                  size_bytes: 3_100_000_000,
                  downloaded: true,
                  downloading: false,
                },
                finalize: null,
                accel_label: 'Metal (GPU)',
              }
            : undefined;
        await svc.resumeDownloadTracking('large-v3');
        expect(svc.downloadingModelKey()).toBe('large-v3');
        await vi.advanceTimersByTimeAsync(2000);
        expect(svc.downloadingModelKey()).toBeNull();
      });

      it('keeps tracking while the backend still reports the resumed download in progress', async () => {
        mockTauri.invokeHandler = async (cmd) =>
          cmd === 'recommended_transcription_model'
            ? {
                live: {
                  key: 'large-v3',
                  display_name: 'Large v3',
                  size_bytes: 3_100_000_000,
                  downloaded: false,
                  downloading: true,
                },
                finalize: null,
                accel_label: 'Metal (GPU)',
              }
            : undefined;
        await svc.resumeDownloadTracking('large-v3');
        await vi.advanceTimersByTimeAsync(2000);
        expect(svc.downloadingModelKey()).toBe('large-v3');
      });

      it('tracks a download of the offline-pass model, which is a separate ack entry', async () => {
        let downloading = true;
        mockTauri.invokeHandler = async (cmd) =>
          cmd === 'recommended_transcription_model'
            ? {
                live: {
                  key: 'small',
                  display_name: 'Small',
                  size_bytes: 487_601_967,
                  downloaded: true,
                  downloading: false,
                },
                accel_label: 'CPU',
                finalize: {
                  key: 'large-v3-turbo',
                  display_name: 'Large v3 Turbo',
                  size_bytes: 1_624_555_275,
                  downloaded: !downloading,
                  downloading,
                },
              }
            : undefined;
        await svc.resumeDownloadTracking('large-v3-turbo');
        await vi.advanceTimersByTimeAsync(2000);
        expect(svc.downloadingModelKey()).toBe('large-v3-turbo');
        downloading = false;
        await vi.advanceTimersByTimeAsync(2000);
        expect(svc.downloadingModelKey()).toBeNull();
      });

      it('stops polling once tracking is cleared by another path', async () => {
        mockTauri.invokeHandler = async () => undefined;
        const spy = vi.spyOn(mockTauri, 'invoke');
        await svc.resumeDownloadTracking('large-v3');
        svc.clearDownloadTracking();
        spy.mockClear();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(spy).not.toHaveBeenCalledWith('recommended_transcription_model');
      });
    });
  });
});
