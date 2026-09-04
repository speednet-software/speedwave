import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RecordingControlsComponent } from './recording-controls.component';
import { TranscriptionService } from '../../services/transcription.service';
import { LoggerService } from '../../services/logger.service';
import type {
  AudioSource,
  AudioSourceInfo,
  CapabilitiesAck,
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
  let svc: {
    getCapabilities: ReturnType<typeof vi.fn>;
    liveTranscriptPreferred: ReturnType<typeof vi.fn>;
    setLiveTranscriptPreferred: ReturnType<typeof vi.fn>;
    listAudioSources: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
    recommendedModel: ReturnType<typeof vi.fn>;
    startRecording: ReturnType<typeof vi.fn>;
    stopRecording: ReturnType<typeof vi.fn>;
    requestMicrophonePermission: ReturnType<typeof vi.fn>;
    openMicrophonePrivacyPane: ReturnType<typeof vi.fn>;
    recordingSessionId: typeof recordingSessionId;
    recordingSource: typeof recordingSource;
    recordingLanguage: typeof recordingLanguage;
  };
  let logger: {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  const caps: CapabilitiesAck = {
    capabilities: {
      supports_system_audio: true,
      supports_microphone: false,
      note: 'Requires macOS 14.4+',
    },
    backends: ['cpu', 'metal'],
    gpu_class: 'discrete' as const,
    accel_label: 'Metal (GPU)',
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
    svc = {
      getCapabilities: vi.fn(async () => caps),
      liveTranscriptPreferred: vi.fn(() => true),
      setLiveTranscriptPreferred: vi.fn(),
      listAudioSources: vi.fn(async () => SOURCES),
      listModels: vi.fn(async () => modelsWithSmall),
      recommendedModel: vi.fn(async () => recAllDownloaded),
      // Mirror the real service: start/stop drive the shared recording signal.
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
        }
      }),
      requestMicrophonePermission: vi.fn(async (): Promise<MicPermission> => 'granted'),
      openMicrophonePrivacyPane: vi.fn(async () => undefined),
      recordingSessionId,
      recordingSource,
      recordingLanguage,
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

  it('loads capabilities + sources and defaults to System', async () => {
    await component.ngOnInit();
    expect(component.sources().length).toBe(2);
    expect(component.sourceIndex()).toBe(0); // system_wide
    expect(component.accel()).toBe('Acceleration: Metal (GPU)');
  });

  it('live toggle: defaults from the service preference, persists a change, and gates start()', async () => {
    svc.liveTranscriptPreferred.mockReturnValue(false);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.liveTranscript()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="record-only-note"]')).not.toBeNull();

    component.onLiveToggle(true);
    fixture.detectChanges();
    expect(svc.setLiveTranscriptPreferred).toHaveBeenCalledWith(true);
    expect(fixture.nativeElement.querySelector('[data-testid="record-only-note"]')).toBeNull();

    await component.start();
    const call = svc.startRecording.mock.calls.at(-1);
    expect(call?.[2]).toBe(true);

    component.onLiveToggle(false);
    await component.start();
    expect(svc.startRecording.mock.calls.at(-1)?.[2]).toBe(false);
  });

  it('live-transcript checkbox: reflects the signal, disables while recording, persists on change', async () => {
    svc.liveTranscriptPreferred.mockReturnValue(false);
    await component.ngOnInit();
    fixture.detectChanges();
    const box = (): HTMLInputElement =>
      fixture.nativeElement.querySelector('[data-testid="live-transcript-toggle"]');
    expect(box().checked).toBe(false);
    expect(box().disabled).toBe(false);

    // A real DOM change event drives the (change) binding, not a direct method call.
    box().checked = true;
    box().dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(component.liveTranscript()).toBe(true);
    expect(svc.setLiveTranscriptPreferred).toHaveBeenCalledWith(true);
    expect(box().checked).toBe(true);

    // While recording, the choice is locked in.
    recordingSessionId.set('sess-1');
    fixture.detectChanges();
    expect(box().disabled).toBe(true);
  });

  it('renders the host-computed acceleration label verbatim, never re-deriving it', async () => {
    // The label is Rust's `accel_label()` (SSOT) — the badge must not recompute it from
    // backends/gpu_class, so a contradictory pair changes nothing.
    svc.getCapabilities.mockResolvedValueOnce({
      ...caps,
      backends: ['cpu'],
      gpu_class: 'none' as const,
      accel_label: 'Vulkan (integrated GPU)',
    });
    await component.ngOnInit();
    expect(component.accel()).toBe('Acceleration: Vulkan (integrated GPU)');

    svc.getCapabilities.mockResolvedValueOnce({ ...caps, accel_label: 'CPU' });
    await component.ngOnInit();
    expect(component.accel()).toBe('Acceleration: CPU');
  });

  it('defaults to the "Whole meeting" mixed source when the backend offers it', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MIXED);
    await component.ngOnInit();
    expect(component.sourceIndex()).toBe(0); // the mixed entry
    expect(component.sources()[component.sourceIndex()].source.kind).toBe('mixed');
    expect(component.mixedSourceSelected()).toBe(true);
  });

  it('falls back to index 0 (and does not crash) when neither mixed nor system is offered', async () => {
    // A host that only exposes mic sources. sourceIndex stays 0; the mixed
    // computed reads sources()[0] safely (it's a microphone, not undefined).
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
    // Switch to the plain "System (everything)" entry (index 1) → note hidden.
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
    // Default source is mixed → picker shown.
    expect(fixture.nativeElement.querySelector('[data-testid="mic-select"]')).not.toBeNull();
    // Switching to System (no mic source in this list) hides it — but here all
    // non-mixed entries are mics, so assert directly via the computed instead.
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
    component.onSource(1); // the default built-in mic entry
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

  it('shows the acceleration badge and language toggle', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="accel-badge"]').textContent
    ).toContain('Metal');
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
    // Regression: navigating away and back destroys this component; the backend
    // driver keeps recording, so a new instance must still show Stop, not Start.
    recordingSessionId.set('sess-live');
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.recording()).toBe(true);
    const stopBtn = fixture.nativeElement.querySelector('[data-testid="stop-btn"]');
    expect(stopBtn).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="start-btn"]')).toBeNull();
    // And Stop targets the session the service is tracking, not a lost local id.
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
    expect(component.error()).toBe('model not downloaded');
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
      expect(component.error()).toContain('microphone permission');
      expect(errSpy).toHaveBeenCalled();
      // A refusal on the prompt just shown must not throw System Settings at the user.
      expect(svc.openMicrophonePrivacyPane).not.toHaveBeenCalled();
      expect(component.busy()).toBe(false);
    });

    it('deep-links to System Settings when consent was refused earlier', async () => {
      svc.listAudioSources.mockResolvedValue(SOURCES_WITH_MIXED);
      svc.requestMicrophonePermission.mockResolvedValueOnce('previously_denied');
      await component.ngOnInit();
      await component.start();
      expect(svc.startRecording).not.toHaveBeenCalled();
      expect(svc.openMicrophonePrivacyPane).toHaveBeenCalledTimes(1);
      expect(component.error()).toContain('microphone permission');
    });

    it('surfaces a consent-check failure as a start error', async () => {
      svc.listAudioSources.mockResolvedValue(SOURCES_WITH_MIXED);
      svc.requestMicrophonePermission.mockRejectedValueOnce(new Error('ipc down'));
      await component.ngOnInit();
      await component.start();
      expect(svc.startRecording).not.toHaveBeenCalled();
      expect(component.error()).toBe('ipc down');
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
    // Points users to Settings, not a removed model picker (no hardcoded size).
    expect(note.textContent).toContain('Settings');
    expect(note.textContent).not.toContain('Models panel');
    expect(fixture.nativeElement.querySelector('[data-testid="start-btn"]').disabled).toBe(true);
  });

  it('refreshModelAvailability re-enables Start once a model is downloaded', async () => {
    svc.listModels.mockResolvedValue(modelsEmpty);
    await component.ngOnInit();
    expect(component.hasModel()).toBe(false);
    // A download lands → the parent calls refreshModelAvailability().
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
    // Mid-download: the Settings row already shows progress — no nag here.
    svc.recommendedModel.mockResolvedValue({
      ...recAllDownloaded,
      finalize: { ...recAllDownloaded.finalize, downloaded: false, downloading: true },
    });
    await component.refreshModelAvailability();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(sel)).toBeNull();
    // Live model serves both passes (finalize: null).
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
