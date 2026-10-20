import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computed, signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RecordingBarComponent } from './recording-bar.component';
import { TranscriptionService } from '../../services/transcription.service';
import type { AudioSource, Language, TranscriptSummary } from '../../models/transcript';

/**
 * A list row for the recording the bar controls.
 * @param overrides - fields to replace.
 */
function row(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
  return {
    id: 'sess-1',
    created_at: '2026-10-13T08:30:00Z',
    title: 'Retro',
    language: 'pl',
    source_label: 'Whole meeting',
    status: { state: 'recording' },
    duration_secs: 0,
    segment_count: 0,
    preview: null,
    size_bytes: 1,
    finalize_model: null,
    queued: false,
    ...overrides,
  };
}

describe('RecordingBarComponent', () => {
  let fixture: ComponentFixture<RecordingBarComponent>;
  let component: RecordingBarComponent;
  let el: HTMLElement;
  let recordingSessionId: WritableSignal<string | null>;
  let recordings: WritableSignal<TranscriptSummary[]>;
  let svc: {
    recordingSessionId: WritableSignal<string | null>;
    recording: ReturnType<typeof computed<boolean>>;
    pausedRecording: ReturnType<typeof computed<TranscriptSummary | null>>;
    recordings: WritableSignal<TranscriptSummary[]>;
    active: WritableSignal<null>;
    recordingLanguage: WritableSignal<Language | null>;
    recordingSource: WritableSignal<AudioSource | null>;
    recordingStartedAt: WritableSignal<number | null>;
    audioLevels: WritableSignal<number[] | null>;
    liveTranscriptPreferred: ReturnType<typeof vi.fn>;
    pauseRecording: ReturnType<typeof vi.fn>;
    resumeRecording: ReturnType<typeof vi.fn>;
    stopRecording: ReturnType<typeof vi.fn>;
  };

  const q = (testId: string): HTMLElement | null => el.querySelector(`[data-testid="${testId}"]`);
  const press = (key: string, init: KeyboardEventInit = { metaKey: true, shiftKey: true }) => {
    const ev = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
    component.onKeydown(ev);
    return ev;
  };

  /** Moves the mock to the paused state, as the backend's status event would. */
  const pauseNow = (): void => {
    recordingSessionId.set(null);
    recordings.set([row({ status: { state: 'paused' }, duration_secs: 754 })]);
  };

  beforeEach(async () => {
    recordingSessionId = signal<string | null>('sess-1');
    recordings = signal<TranscriptSummary[]>([row()]);
    svc = {
      recordingSessionId,
      recording: computed(() => recordingSessionId() !== null),
      pausedRecording: computed(
        () => recordings().find((r) => r.status.state === 'paused') ?? null
      ),
      recordings,
      active: signal(null),
      recordingLanguage: signal<Language | null>('pl'),
      recordingSource: signal<AudioSource | null>({ kind: 'mixed', mic: null }),
      recordingStartedAt: signal<number | null>(null),
      audioLevels: signal<number[] | null>(null),
      liveTranscriptPreferred: vi.fn(() => false),
      pauseRecording: vi.fn(async () => pauseNow()),
      resumeRecording: vi.fn(async () => {
        recordingSessionId.set('sess-1');
        recordings.set([row()]);
      }),
      stopRecording: vi.fn(async () => {
        recordingSessionId.set(null);
        recordings.set([row({ status: { state: 'finalizing', progress: 0 } })]);
      }),
    };
    await TestBed.configureTestingModule({
      imports: [RecordingBarComponent],
      providers: [{ provide: TranscriptionService, useValue: svc }],
    }).compileComponents();
    fixture = TestBed.createComponent(RecordingBarComponent);
    component = fixture.componentInstance;
    el = fixture.nativeElement;
  });

  afterEach(() => vi.restoreAllMocks());

  it('shows the name, language and source, the clock, a meter per channel, Pause and Stop', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000 + 247_000);
    svc.recordingStartedAt.set(10_000);
    svc.audioLevels.set([0.1, 0.001]);
    fixture.detectChanges();
    expect(q('recording-view')!.getAttribute('data-state')).toBe('recording');
    expect(q('recording-label')!.textContent).toContain('Recording: Retro');
    expect(q('recording-label')!.textContent).toContain('Polish · Whole meeting');
    expect(q('recording-clock')!.textContent).toContain('04:07');
    expect(component.meterBars()).toEqual([
      { label: 'Meeting', pct: 67 },
      { label: 'You', pct: 0 },
    ]);
    expect(q('pause-btn')).not.toBeNull();
    expect(q('stop-btn')!.textContent).toContain('Stop');
    expect(q('resume-btn')).toBeNull();
  });

  it('labels a mono capture by its source and shows a flat bar before the first level', () => {
    svc.recordingSource.set({ kind: 'microphone', device: null });
    expect(component.meterBars()).toEqual([{ label: 'You', pct: 0 }]);
    svc.recordingSource.set({ kind: 'system_wide' });
    svc.audioLevels.set([1]);
    expect(component.meterBars()).toEqual([{ label: 'Meeting', pct: 100 }]);
  });

  it('shows 00:00 until the start time is known', () => {
    expect(component.clock()).toBe('00:00');
  });

  it('names a recording the list does not have yet "New recording"', () => {
    recordings.set([]);
    expect(component.name()).toBe('New recording');
  });

  it('pauses: the bar turns to Resume and Stop and transcribe with the stopped clock', async () => {
    fixture.detectChanges();
    await component.pause();
    fixture.detectChanges();
    expect(svc.pauseRecording).toHaveBeenCalledWith('sess-1');
    expect(q('recording-view')!.getAttribute('data-state')).toBe('paused');
    expect(q('recording-label')!.textContent).toContain('Paused: Retro');
    expect(q('recording-label')!.textContent).toContain('The microphone is off.');
    expect(q('recording-clock')!.textContent).toContain('12:34');
    expect(q('audio-level-meter')).toBeNull();
    expect(q('resume-btn')).not.toBeNull();
    expect(q('stop-btn')!.textContent).toContain('Stop and transcribe');
  });

  it('resumes the paused recording with the live preference from Settings', async () => {
    pauseNow();
    svc.liveTranscriptPreferred.mockReturnValue(true);
    await component.resume();
    expect(svc.resumeRecording).toHaveBeenCalledWith('sess-1', true);
    expect(component.paused()).toBe(false);
  });

  it('stops a capture and a paused recording alike, and emits stopped', async () => {
    const spy = vi.fn();
    component.stopped.subscribe(spy);
    await component.stop();
    expect(svc.stopRecording).toHaveBeenCalledWith('sess-1');
    expect(spy).toHaveBeenCalledWith('sess-1');

    pauseNow();
    await component.stop();
    expect(svc.stopRecording).toHaveBeenCalledTimes(2);
  });

  it('reports a failed transition and emits no stop', async () => {
    svc.stopRecording.mockRejectedValueOnce(new Error('driver gone'));
    const err = vi.fn();
    const stopped = vi.fn();
    component.errorOccurred.subscribe(err);
    component.stopped.subscribe(stopped);
    await component.stop();
    expect(err).toHaveBeenCalledWith('driver gone');
    expect(stopped).not.toHaveBeenCalled();
    expect(component.busy()).toBe(false);
  });

  it('opens the recording from its name', () => {
    const spy = vi.fn();
    component.opened.subscribe(spy);
    fixture.detectChanges();
    q('recording-label')!.click();
    expect(spy).toHaveBeenCalledWith('sess-1');
  });

  describe('keyboard shortcuts', () => {
    it('⌘⇧P pauses a capture and ⌘⇧R stops it', async () => {
      expect(press('P').defaultPrevented).toBe(true);
      await fixture.whenStable();
      expect(svc.pauseRecording).toHaveBeenCalledTimes(1);

      recordingSessionId.set('sess-1');
      recordings.set([row()]);
      press('r', { ctrlKey: true, shiftKey: true });
      await fixture.whenStable();
      expect(svc.stopRecording).toHaveBeenCalledTimes(1);
    });

    it('both shortcuts resume a paused recording, so ⌘⇧R never stops it by surprise', async () => {
      pauseNow();
      press('R');
      await fixture.whenStable();
      expect(svc.resumeRecording).toHaveBeenCalledTimes(1);
      expect(svc.stopRecording).not.toHaveBeenCalled();
    });

    it('ignores other keys and a missing modifier', () => {
      expect(press('S').defaultPrevented).toBe(false);
      expect(press('P', { metaKey: true }).defaultPrevented).toBe(false);
      expect(svc.pauseRecording).not.toHaveBeenCalled();
    });
  });
});
