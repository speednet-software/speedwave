import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computed, signal, type Signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RecordingControlsComponent } from './recording-controls.component';
import { TranscriptionService } from '../../services/transcription.service';
import { LoggerService } from '../../services/logger.service';
import type {
  AudioSource,
  AudioSourceInfo,
  Language,
  MicPermission,
  StartAck,
} from '../../models/transcript';

const SOURCES: AudioSourceInfo[] = [
  { source: { kind: 'system_wide' }, label: 'System (everything)' },
  {
    source: { kind: 'microphone', device: null },
    label: 'Microphone (default input)',
  },
];

/** Sources list led by a "Whole meeting" mixed entry (the real backends do this). */
const SOURCES_WITH_MIXED: AudioSourceInfo[] = [
  {
    source: { kind: 'mixed', mic: null },
    label: 'Whole meeting (system audio + your microphone)',
  },
  { source: { kind: 'system_wide' }, label: 'System (everything)' },
  {
    source: { kind: 'microphone', device: null },
    label: 'Microphone (default input)',
  },
];

/** Mixed default + two named mics (the shape macOS/Windows now emit). */
const SOURCES_WITH_MICS: AudioSourceInfo[] = [
  {
    source: { kind: 'mixed', mic: null },
    label: 'Whole meeting (system audio + your microphone)',
  },
  {
    source: { kind: 'microphone', device: 'BuiltInMicrophoneDevice' },
    label: 'Microphone: MacBook Pro Microphone (default)',
  },
  {
    source: { kind: 'microphone', device: 'AppleUSBAudioEngine:USB MIC:1' },
    label: 'Microphone: USB MIC',
  },
];

describe('RecordingControlsComponent', () => {
  let component: RecordingControlsComponent;
  let fixture: ComponentFixture<RecordingControlsComponent>;
  let recordingSessionId: ReturnType<typeof signal<string | null>>;
  let recordingSource: ReturnType<typeof signal<AudioSource | null>>;
  let recordingLanguage: ReturnType<typeof signal<Language | null>>;
  let recordingLive: ReturnType<typeof signal<boolean | null>>;
  let recordingStartedAt: ReturnType<typeof signal<number | null>>;
  let audioLevels: ReturnType<typeof signal<number[] | null>>;
  let svc: {
    liveTranscriptPreferred: ReturnType<typeof vi.fn>;
    listAudioSources: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
    recommendedModel: ReturnType<typeof vi.fn>;
    startRecording: ReturnType<typeof vi.fn>;
    stopRecording: ReturnType<typeof vi.fn>;
    requestMicrophonePermission: ReturnType<typeof vi.fn>;
    openMicrophonePrivacyPane: ReturnType<typeof vi.fn>;
    recordingSessionId: typeof recordingSessionId;
    recording: Signal<boolean>;
    recordingSource: typeof recordingSource;
    recordingLanguage: typeof recordingLanguage;
    recordingLive: typeof recordingLive;
    recordingStartedAt: typeof recordingStartedAt;
    audioLevels: typeof audioLevels;
  };
  let logger: {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  /** A model list with at least one downloaded Whisper model. */
  const modelsWithSmall = {
    whisper: [{ key: 'small', downloaded: true, size_bytes: 488_000_000, path: '/m/small' }],
    total_bytes_used: 488_000_000,
  };
  /** A model list with nothing downloaded. */
  const modelsEmpty = {
    whisper: [{ key: 'small', downloaded: false, size_bytes: 488_000_000, path: null }],
    total_bytes_used: 0,
  };
  /** Recommended pair with both passes covered — no finalize warning. */
  const recAllDownloaded = {
    live: {
      key: 'small',
      display_name: 'Small',
      size_bytes: 1,
      downloaded: true,
      downloading: false,
    },
    finalize: {
      key: 'large-v3',
      display_name: 'Large v3',
      size_bytes: 1,
      downloaded: true,
      downloading: false,
    },
    accel_label: 'CPU',
  };
  /** Recommended pair whose finalize model is absent and not downloading. */
  const recFinalizeMissing = {
    ...recAllDownloaded,
    finalize: { ...recAllDownloaded.finalize, downloaded: false },
  };

  beforeEach(async () => {
    recordingSessionId = signal<string | null>(null);
    recordingSource = signal<AudioSource | null>(null);
    recordingLanguage = signal<Language | null>(null);
    recordingLive = signal<boolean | null>(null);
    recordingStartedAt = signal<number | null>(null);
    audioLevels = signal<number[] | null>(null);
    svc = {
      liveTranscriptPreferred: vi.fn(() => true),
      listAudioSources: vi.fn(async () => SOURCES),
      listModels: vi.fn(async () => modelsWithSmall),
      recommendedModel: vi.fn(async () => recAllDownloaded),
      startRecording: vi.fn(async (source: AudioSource, language: Language): Promise<StartAck> => {
        recordingSessionId.set('sess-1');
        recordingSource.set(source);
        recordingLanguage.set(language);
        return {
          session_id: 'sess-1',
          event_name: 'transcript_event::sess-1',
          snapshot: {} as never,
        };
      }),
      stopRecording: vi.fn(async (id: string) => {
        if (recordingSessionId() === id) {
          recordingSessionId.set(null);
          recordingSource.set(null);
          recordingLanguage.set(null);
          recordingLive.set(null);
        }
      }),
      requestMicrophonePermission: vi.fn(async (): Promise<MicPermission> => 'granted'),
      openMicrophonePrivacyPane: vi.fn(async () => undefined),
      recordingSessionId,
      recording: computed(() => recordingSessionId() !== null),
      recordingSource,
      recordingLanguage,
      recordingLive,
      recordingStartedAt,
      audioLevels,
    };
    logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [RecordingControlsComponent],
      providers: [
        { provide: TranscriptionService, useValue: svc },
        { provide: LoggerService, useValue: logger },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(RecordingControlsComponent);
    component = fixture.componentInstance;
  });

  it('loads the sources and defaults to System', async () => {
    await component.ngOnInit();
    expect(component.sources().length).toBe(2);
    expect(component.sourceIndex()).toBe(0);
  });

  it('starts with the live preference from Settings and has no live checkbox of its own', async () => {
    svc.liveTranscriptPreferred.mockReturnValue(false);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="live-transcript-toggle"]')
    ).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="accel-badge"]')).toBeNull();
    await component.start();
    expect(svc.startRecording.mock.calls.at(-1)?.[2]).toBe(false);
  });

  it('defaults to the "Whole meeting" mixed source when the backend offers it', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MIXED);
    await component.ngOnInit();
    expect(component.sourceIndex()).toBe(0);
    expect(component.sources()[component.sourceIndex()].source.kind).toBe('mixed');
    expect(component.mixedSourceSelected()).toBe(true);
  });

  it('falls back to index 0 (and does not crash) when neither mixed nor system is offered', async () => {
    svc.listAudioSources.mockResolvedValueOnce([
      { source: { kind: 'microphone', device: 'mic-a' }, label: 'Mic A' },
      { source: { kind: 'microphone', device: 'mic-b' }, label: 'Mic B' },
    ]);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.sourceIndex()).toBe(0);
    expect(component.mixedSourceSelected()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="mixed-source-note"]')).toBeNull();
  });

  it('does not crash with an empty sources list', async () => {
    svc.listAudioSources.mockResolvedValueOnce([]);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.sources().length).toBe(0);
    expect(component.mixedSourceSelected()).toBe(false);
  });

  it('shows the mixed-source permission note only when the mixed source is selected', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MIXED);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="mixed-source-note"]')).not.toBeNull();
    component.onSource(1);
    fixture.detectChanges();
    expect(component.mixedSourceSelected()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="mixed-source-note"]')).toBeNull();
  });

  it('start() forwards the mixed source object to startRecording', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MIXED);
    await component.ngOnInit();
    await component.start();
    expect(svc.startRecording).toHaveBeenCalledWith({ kind: 'mixed', mic: null }, 'pl', true);
  });

  it('derives named mics from the source list and strips the "Microphone:" prefix', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MICS);
    await component.ngOnInit();
    expect(component.mics().map((m) => m.name)).toEqual([
      'MacBook Pro Microphone (default)',
      'USB MIC',
    ]);
    expect(component.mics()[1].uid).toBe('AppleUSBAudioEngine:USB MIC:1');
  });

  it('shows the mic picker only when the source uses a mic', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MICS);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="mic-select"]')).not.toBeNull();
    expect(component.micSelectable()).toBe(true);
  });

  it('overlays the chosen mic onto the mixed source at start()', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MICS);
    await component.ngOnInit();
    component.onMic('AppleUSBAudioEngine:USB MIC:1');
    await component.start();
    expect(svc.startRecording).toHaveBeenCalledWith(
      {
        kind: 'mixed',
        mic: 'AppleUSBAudioEngine:USB MIC:1',
      },
      'pl',
      true
    );
  });

  it('overlays the chosen mic onto a mic-only source at start()', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MICS);
    await component.ngOnInit();
    component.onSource(1);
    component.onMic('AppleUSBAudioEngine:USB MIC:1');
    await component.start();
    expect(svc.startRecording).toHaveBeenCalledWith(
      { kind: 'microphone', device: 'AppleUSBAudioEngine:USB MIC:1' },
      'pl',
      true
    );
  });

  it('keeps the system default mic (null) when none is picked', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MICS);
    await component.ngOnInit();
    await component.start();
    expect(svc.startRecording).toHaveBeenCalledWith({ kind: 'mixed', mic: null }, 'pl', true);
  });

  it('shows the language toggle while idle', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="language-select"]')).not.toBeNull();
  });

  it('starts recording the chosen source + language and emits started', async () => {
    await component.ngOnInit();
    component.onLanguage('en');
    component.onSource(1);
    const spy = vi.fn();
    component.started.subscribe(spy);
    await component.start();
    expect(svc.startRecording).toHaveBeenCalledWith(SOURCES[1].source, 'en', true);
    expect(component.recording()).toBe(true);
    expect(spy).toHaveBeenCalledWith('sess-1');
  });

  it('stops the in-progress recording and emits stopped', async () => {
    await component.ngOnInit();
    await component.start();
    const spy = vi.fn();
    component.stopped.subscribe(spy);
    await component.stop();
    expect(svc.stopRecording).toHaveBeenCalledWith('sess-1');
    expect(component.recording()).toBe(false);
    expect(spy).toHaveBeenCalledWith('sess-1');
  });

  it('a freshly-mounted control reflects a recording already in progress', async () => {
    recordingSessionId.set('sess-live');
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.recording()).toBe(true);
    const stopBtn = fixture.nativeElement.querySelector('[data-testid="stop-btn"]');
    expect(stopBtn).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="start-btn"]')).toBeNull();
    await component.stop();
    expect(svc.stopRecording).toHaveBeenCalledWith('sess-live');
  });

  it('a freshly-mounted control restores source/mic/language of a recording in progress', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MICS);
    recordingSessionId.set('sess-live');
    recordingSource.set({ kind: 'microphone', device: 'AppleUSBAudioEngine:USB MIC:1' });
    recordingLanguage.set('en');
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.sources()[component.sourceIndex()].source.kind).toBe('microphone');
    expect(component.micDevice()).toBe('AppleUSBAudioEngine:USB MIC:1');
    expect(component.language()).toBe('en');
  });

  it('a freshly-mounted control restores a mixed-source recording mic', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MICS);
    recordingSessionId.set('sess-live');
    recordingSource.set({ kind: 'mixed', mic: 'AppleUSBAudioEngine:USB MIC:1' });
    recordingLanguage.set('pl');
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.sources()[component.sourceIndex()].source.kind).toBe('mixed');
    expect(component.micDevice()).toBe('AppleUSBAudioEngine:USB MIC:1');
  });

  describe('recording view', () => {
    it('replaces the pickers with the elapsed time, a meter per channel and Stop', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(10_000 + 247_000);
      svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MIXED);
      recordingSessionId.set('sess-live');
      recordingSource.set({ kind: 'mixed', mic: null });
      recordingStartedAt.set(10_000);
      audioLevels.set([0.1, 0.001]);
      recordingLive.set(false);
      await component.ngOnInit();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="source-select"]')).toBeNull();
      expect(el.querySelector('[data-testid="recording-clock"]')!.textContent).toContain('04:07');
      const meter = el.querySelector('[data-testid="audio-level-meter"]')!;
      expect(meter.textContent).toContain('Meeting');
      expect(meter.textContent).toContain('You');
      expect(component.meterBars()).toEqual([
        { label: 'Meeting', pct: 67 },
        { label: 'You', pct: 0 },
      ]);
      expect(el.querySelector('[data-testid="stop-btn"]')!.textContent).toContain('Stop');
      expect(el.querySelector('[data-testid="after-stop-note"]')!.textContent).toContain(
        'Transcript appears after you stop.'
      );
      vi.restoreAllMocks();
    });

    it('drops the "appears after you stop" line when live text is on', async () => {
      recordingSessionId.set('sess-live');
      recordingLive.set(true);
      await component.ngOnInit();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="after-stop-note"]')).toBeNull();
    });

    it('labels a mono capture by its source and shows a flat bar before the first level', async () => {
      recordingSessionId.set('sess-live');
      recordingSource.set({ kind: 'microphone', device: null });
      await component.ngOnInit();
      expect(component.meterBars()).toEqual([{ label: 'You', pct: 0 }]);
      recordingSource.set({ kind: 'system_wide' });
      audioLevels.set([1]);
      expect(component.meterBars()).toEqual([{ label: 'Meeting', pct: 100 }]);
    });

    it('shows 00:00 until the start time is known', () => {
      expect(component.clock()).toBe('00:00');
    });
  });

  describe('keyboard shortcut', () => {
    function press(init: KeyboardEventInit): KeyboardEvent {
      const ev = new KeyboardEvent('keydown', { key: 'R', ...init, cancelable: true });
      component.onKeydown(ev);
      return ev;
    }

    it('⌘⇧R / Ctrl+Shift+R starts a recording and then stops it', async () => {
      await component.ngOnInit();
      const ev = press({ metaKey: true, shiftKey: true });
      expect(ev.defaultPrevented).toBe(true);
      await fixture.whenStable();
      expect(svc.startRecording).toHaveBeenCalledTimes(1);
      press({ ctrlKey: true, shiftKey: true });
      await fixture.whenStable();
      expect(svc.stopRecording).toHaveBeenCalledWith('sess-1');
    });

    it('ignores R without both modifiers', async () => {
      await component.ngOnInit();
      expect(press({ metaKey: true }).defaultPrevented).toBe(false);
      expect(press({ shiftKey: true }).defaultPrevented).toBe(false);
      expect(svc.startRecording).not.toHaveBeenCalled();
    });

    it('does not start while Start is unavailable', async () => {
      svc.listModels.mockResolvedValue(modelsEmpty);
      await component.ngOnInit();
      press({ metaKey: true, shiftKey: true });
      expect(svc.startRecording).not.toHaveBeenCalled();
    });
  });

  it('a freshly-mounted control with no recording keeps the compile-time defaults', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MICS);
    await component.ngOnInit();
    expect(component.sources()[component.sourceIndex()].source.kind).toBe('mixed');
    expect(component.language()).toBe('pl');
  });

  it('surfaces a start error instead of swallowing it', async () => {
    await component.ngOnInit();
    svc.startRecording.mockRejectedValueOnce(new Error('model not downloaded'));
    const errSpy = vi.fn();
    component.errorOccurred.subscribe(errSpy);
    await component.start();
    expect(errSpy).toHaveBeenCalledWith('model not downloaded');
    expect(component.recording()).toBe(false);
  });

  describe('mic consent gate', () => {
    it('resolves mic consent before starting a mic-including source', async () => {
      svc.listAudioSources.mockResolvedValue(SOURCES_WITH_MIXED);
      await component.ngOnInit();
      await component.start();
      expect(svc.requestMicrophonePermission).toHaveBeenCalledTimes(1);
      expect(svc.startRecording).toHaveBeenCalledTimes(1);
    });

    it('skips the consent check for a system-only source', async () => {
      await component.ngOnInit();
      await component.start();
      expect(svc.requestMicrophonePermission).not.toHaveBeenCalled();
      expect(svc.startRecording).toHaveBeenCalledTimes(1);
    });

    it('blocks the start and surfaces the error when consent is denied', async () => {
      svc.listAudioSources.mockResolvedValue(SOURCES_WITH_MIXED);
      svc.requestMicrophonePermission.mockResolvedValueOnce('denied');
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      await component.ngOnInit();
      await component.start();
      expect(svc.startRecording).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('microphone permission'));
      expect(svc.openMicrophonePrivacyPane).not.toHaveBeenCalled();
      expect(component.busy()).toBe(false);
    });

    it('deep-links to System Settings when consent was refused earlier', async () => {
      svc.listAudioSources.mockResolvedValue(SOURCES_WITH_MIXED);
      svc.requestMicrophonePermission.mockResolvedValueOnce('previously_denied');
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      await component.ngOnInit();
      await component.start();
      expect(svc.startRecording).not.toHaveBeenCalled();
      expect(svc.openMicrophonePrivacyPane).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('microphone permission'));
    });

    it('surfaces a consent-check failure as a start error', async () => {
      svc.listAudioSources.mockResolvedValue(SOURCES_WITH_MIXED);
      svc.requestMicrophonePermission.mockRejectedValueOnce(new Error('ipc down'));
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      await component.ngOnInit();
      await component.start();
      expect(svc.startRecording).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith('ipc down');
      expect(component.busy()).toBe(false);
    });
  });

  it('onLanguage ignores invalid values', async () => {
    await component.ngOnInit();
    component.onLanguage('de');
    expect(component.language()).toBe('pl');
  });

  it('enables Start when a Whisper model is downloaded; no "download a model" note', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.hasModel()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="no-model-note"]')).toBeNull();
    const start = fixture.nativeElement.querySelector('[data-testid="start-btn"]');
    expect(start.disabled).toBe(false);
  });

  it('disables Start and shows the "download a model" note when nothing is downloaded', async () => {
    svc.listModels.mockResolvedValue(modelsEmpty);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.hasModel()).toBe(false);
    const note = fixture.nativeElement.querySelector('[data-testid="no-model-note"]');
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('Settings');
    expect(note.textContent).not.toContain('Models panel');
    expect(fixture.nativeElement.querySelector('[data-testid="start-btn"]').disabled).toBe(true);
  });

  it('refreshModelAvailability re-enables Start once a model is downloaded', async () => {
    svc.listModels.mockResolvedValue(modelsEmpty);
    await component.ngOnInit();
    expect(component.hasModel()).toBe(false);
    svc.listModels.mockResolvedValue(modelsWithSmall);
    await component.refreshModelAvailability();
    expect(component.hasModel()).toBe(true);
  });

  it('refreshModelAvailability fails open (modelsKnown=false) on a listModels error', async () => {
    await component.ngOnInit();
    svc.listModels.mockRejectedValueOnce(new Error('boom'));
    await component.refreshModelAvailability();
    expect(component.modelsKnown()).toBe(false);
  });

  it('a recommendedModel failure clears the finalize warning and is logged, never silent', async () => {
    await component.ngOnInit();
    svc.recommendedModel.mockRejectedValueOnce(new Error('ipc down'));
    await component.refreshModelAvailability();
    expect(component.missingFinalizeModel()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ipc down'));
  });

  it('warns when the finalize model is missing: Start stays enabled, the quality cost is named', async () => {
    svc.recommendedModel.mockResolvedValue(recFinalizeMissing);
    await component.ngOnInit();
    fixture.detectChanges();
    const warn = fixture.nativeElement.querySelector('[data-testid="finalize-model-warning"]');
    expect(warn).not.toBeNull();
    expect(warn.textContent).toContain('Large v3');
    expect(warn.textContent).toContain('lower-quality live model');
    expect(fixture.nativeElement.querySelector('[data-testid="start-btn"]').disabled).toBe(false);
  });

  it('no finalize warning when the pair is downloaded, downloading, or single-model', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    const sel = '[data-testid="finalize-model-warning"]';
    expect(fixture.nativeElement.querySelector(sel)).toBeNull();
    svc.recommendedModel.mockResolvedValue({
      ...recAllDownloaded,
      finalize: { ...recAllDownloaded.finalize, downloaded: false, downloading: true },
    });
    await component.refreshModelAvailability();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(sel)).toBeNull();
    svc.recommendedModel.mockResolvedValue({ ...recAllDownloaded, finalize: null });
    await component.refreshModelAvailability();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(sel)).toBeNull();
  });

  it('finalize warning is suppressed while no model at all is downloaded (the no-model note owns that)', async () => {
    svc.listModels.mockResolvedValue(modelsEmpty);
    svc.recommendedModel.mockResolvedValue(recFinalizeMissing);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="no-model-note"]')).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="finalize-model-warning"]')
    ).toBeNull();
  });
});
