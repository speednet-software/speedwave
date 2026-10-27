import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computed, signal, type Signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RecordingControlsComponent } from './recording-controls.component';
import { TranscriptionService } from '../../services/transcription.service';
import type {
  AudioSource,
  AudioSourceInfo,
  Language,
  MicPermission,
  StartAck,
  TranscriptSummary,
  RecommendedModelAck,
} from '../../models/transcript';
import type { RecordingChoice } from '../../services/transcription.service';

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
    modelReady: ReturnType<typeof signal<boolean | null>>;
    recommended: ReturnType<typeof signal<RecommendedModelAck | null>>;
    startRecording: ReturnType<typeof vi.fn>;
    importFile: ReturnType<typeof vi.fn>;
    stopRecording: ReturnType<typeof vi.fn>;
    requestMicrophonePermission: ReturnType<typeof vi.fn>;
    openMicrophonePrivacyPane: ReturnType<typeof vi.fn>;
    recordingChoice: ReturnType<typeof vi.fn>;
    setRecordingChoice: ReturnType<typeof vi.fn>;
    transcribing: ReturnType<typeof signal<TranscriptSummary[]>>;
    postpone: ReturnType<typeof vi.fn>;
    recordingSessionId: typeof recordingSessionId;
    recording: Signal<boolean>;
    captureOpen: Signal<boolean>;
    recordingSource: typeof recordingSource;
    recordingLanguage: typeof recordingLanguage;
    recordingLive: typeof recordingLive;
    recordingStartedAt: typeof recordingStartedAt;
    audioLevels: typeof audioLevels;
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
    diarization: {
      key: 'nemotron-3-diarization-q8_0',
      display_name: 'Nemotron-3 Diarization',
      size_bytes: 1,
      downloaded: false,
      downloading: false,
    },
    accel_label: 'CPU',
    gpu_class: 'none' as const,
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
      modelReady: signal<boolean | null>(true),
      recommended: signal<RecommendedModelAck | null>(recAllDownloaded),
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
      importFile: vi.fn(async (): Promise<string | null> => 'imported-1'),
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
      recordingChoice: vi.fn((): RecordingChoice | null => null),
      setRecordingChoice: vi.fn(),
      transcribing: signal<TranscriptSummary[]>([]),
      postpone: vi.fn(async () => undefined),
      recordingSessionId,
      recording: computed(() => recordingSessionId() !== null),
      captureOpen: computed(() => recordingSessionId() !== null),
      recordingSource,
      recordingLanguage,
      recordingLive,
      recordingStartedAt,
      audioLevels,
    };
    await TestBed.configureTestingModule({
      imports: [RecordingControlsComponent],
      providers: [{ provide: TranscriptionService, useValue: svc }],
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
    component.optionsOpen.set(true);
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
    component.optionsOpen.set(true);
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

  it('keeps the pickers behind the chooser until it is opened', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="language-select"]')).toBeNull();
    (el.querySelector('[data-testid="recording-options"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="language-select"]')).not.toBeNull();
    expect(
      el.querySelector('[data-testid="recording-options"]')!.getAttribute('aria-expanded')
    ).toBe('true');
  });

  it('names the language and source of the next recording on the chooser', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MIXED);
    await component.ngOnInit();
    expect(component.choiceLabel()).toBe('Polish · Whole meeting');
    component.onLanguage('en');
    component.onSource(1);
    expect(component.choiceLabel()).toBe('English · Other people only');
  });

  it('closes the pickers on a click outside them and on Escape', async () => {
    await component.ngOnInit();
    component.optionsOpen.set(true);
    fixture.detectChanges();
    const inside = fixture.nativeElement.querySelector('[data-testid="language-select"]');
    component.onDocumentClick({ target: inside } as unknown as MouseEvent);
    expect(component.optionsOpen()).toBe(true);
    component.onDocumentClick({ target: document.body } as unknown as MouseEvent);
    expect(component.optionsOpen()).toBe(false);
    component.optionsOpen.set(true);
    component.onKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(component.optionsOpen()).toBe(false);
  });

  describe('remembered choice', () => {
    it('restores the last language, source and microphone', async () => {
      svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MICS);
      svc.recordingChoice.mockReturnValue({
        language: 'en',
        source: 'microphone',
        mic: 'AppleUSBAudioEngine:USB MIC:1',
      });
      await component.ngOnInit();
      expect(component.language()).toBe('en');
      expect(component.sources()[component.sourceIndex()].source.kind).toBe('microphone');
      expect(component.micDevice()).toBe('AppleUSBAudioEngine:USB MIC:1');
    });

    it('falls back to the system default for a microphone that is gone', async () => {
      svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MICS);
      svc.recordingChoice.mockReturnValue({ language: 'pl', source: 'mixed', mic: 'unplugged' });
      await component.ngOnInit();
      expect(component.micDevice()).toBeNull();
    });

    it('keeps the language but picks the default source when the saved one is not offered', async () => {
      svc.recordingChoice.mockReturnValue({ language: 'en', source: 'mixed', mic: null });
      await component.ngOnInit();
      expect(component.language()).toBe('en');
      expect(component.sources()[component.sourceIndex()].source.kind).toBe('system_wide');
    });

    it('remembers every change and the choice a recording starts with', async () => {
      svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MICS);
      await component.ngOnInit();
      component.onLanguage('en');
      expect(svc.setRecordingChoice).toHaveBeenLastCalledWith({
        language: 'en',
        source: 'mixed',
        mic: null,
      });
      component.onMic('AppleUSBAudioEngine:USB MIC:1');
      component.onSource(1);
      expect(svc.setRecordingChoice).toHaveBeenLastCalledWith({
        language: 'en',
        source: 'microphone',
        mic: 'AppleUSBAudioEngine:USB MIC:1',
      });
      svc.setRecordingChoice.mockClear();
      await component.start();
      expect(svc.setRecordingChoice).toHaveBeenCalledTimes(1);
    });
  });

  describe('between meetings', () => {
    const busy = (id: string, title: string | null): TranscriptSummary => ({
      id,
      created_at: '2026-10-13T07:03:00Z',
      title,
      language: 'pl',
      source_label: 'System',
      status: { state: 'finalizing', progress: 0.4 },
      duration_secs: 780,
      segment_count: 0,
      preview: null,
      size_bytes: 1,
      finalize_model: 'large',
      queued: false,
    });

    it('shows a running transcription as a muted status and keeps Record enabled', async () => {
      svc.transcribing.set([busy('a', 'Daily Speednet')]);
      await component.ngOnInit();
      fixture.detectChanges();
      const note: HTMLElement = fixture.nativeElement.querySelector(
        '[data-testid="transcribing-note"]'
      );
      expect(note.textContent).toContain('Transcribing Daily Speednet · 40%');
      expect(note.textContent).not.toContain('"');
      expect(note.className).toContain('text-[var(--ink-mute)]');
      expect(note.className).not.toContain('amber');
      expect(fixture.nativeElement.querySelector('[data-testid="start-btn"]').disabled).toBe(false);
    });

    it('says a lone queued transcription waits, counts several, and says nothing for none', async () => {
      await component.ngOnInit();
      expect(component.transcribingNote()).toBe('');
      svc.transcribing.set([{ ...busy('a', 'Retro'), queued: true }]);
      expect(component.transcribingNote()).toBe('Waiting to transcribe Retro');
      svc.transcribing.set([busy('a', null), busy('b', null)]);
      expect(component.transcribingNote()).toBe('Transcribing 2 recordings');
    });

    it('puts every running or queued transcription off from the note', async () => {
      svc.transcribing.set([busy('a', null), { ...busy('b', null), queued: true }]);
      await component.ngOnInit();
      fixture.detectChanges();
      (
        fixture.nativeElement.querySelector('[data-testid="postpone-all"]') as HTMLButtonElement
      ).click();
      await fixture.whenStable();
      expect(svc.postpone.mock.calls).toEqual([['a'], ['b']]);
      expect(component.postponing()).toBe(false);
    });

    it('still puts the rest off when one refuses, and names the recording it could not', async () => {
      svc.postpone.mockRejectedValueOnce(new Error('disk full'));
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      svc.transcribing.set([busy('a', 'Daily'), busy('b', null)]);
      await component.postponeAll();
      expect(svc.postpone).toHaveBeenCalledTimes(2);
      expect(errSpy).toHaveBeenCalledWith('Could not put off "Daily": disk full');
      expect(component.postponing()).toBe(false);
    });

    it('says nothing when the refused recording finished transcribing meanwhile', async () => {
      svc.postpone.mockImplementationOnce(async () => {
        svc.transcribing.set([busy('b', null)]);
        throw new Error('only a recording that is being transcribed can be put off');
      });
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      svc.transcribing.set([busy('a', 'Daily'), busy('b', null)]);
      await component.postponeAll();
      expect(svc.postpone).toHaveBeenCalledTimes(2);
      expect(errSpy).not.toHaveBeenCalled();
    });
  });

  it('cannot start while a recording captures or waits paused', async () => {
    await component.ngOnInit();
    expect(component.canStart()).toBe(true);
    recordingSessionId.set('sess-live');
    expect(component.canStart()).toBe(false);
  });

  it('starts recording the chosen source + language and emits started', async () => {
    await component.ngOnInit();
    component.onLanguage('en');
    component.onSource(1);
    const spy = vi.fn();
    component.started.subscribe(spy);
    await component.start();
    expect(svc.startRecording).toHaveBeenCalledWith(SOURCES[1].source, 'en', true);
    expect(svc.captureOpen()).toBe(true);
    expect(spy).toHaveBeenCalledWith('sess-1');
  });

  describe('keyboard shortcut', () => {
    function press(init: KeyboardEventInit): KeyboardEvent {
      const ev = new KeyboardEvent('keydown', { key: 'R', ...init, cancelable: true });
      component.onKeydown(ev);
      return ev;
    }

    it('⌘⇧R / Ctrl+Shift+R starts a recording, once', async () => {
      await component.ngOnInit();
      const ev = press({ metaKey: true, shiftKey: true });
      expect(ev.defaultPrevented).toBe(true);
      await fixture.whenStable();
      expect(svc.startRecording).toHaveBeenCalledTimes(1);
      press({ ctrlKey: true, shiftKey: true });
      await fixture.whenStable();
      expect(svc.startRecording).toHaveBeenCalledTimes(1);
      expect(svc.stopRecording).not.toHaveBeenCalled();
    });

    it('ignores R without both modifiers', async () => {
      await component.ngOnInit();
      expect(press({ metaKey: true }).defaultPrevented).toBe(false);
      expect(press({ shiftKey: true }).defaultPrevented).toBe(false);
      expect(svc.startRecording).not.toHaveBeenCalled();
    });

    it('does not start while Start is unavailable', async () => {
      svc.modelReady.set(false);
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
    expect(svc.captureOpen()).toBe(false);
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

  describe('import file', () => {
    const importBtn = (): HTMLButtonElement =>
      fixture.nativeElement.querySelector('[data-testid="import-btn"]');

    it('imports in the chosen language and emits the new recording', async () => {
      await component.ngOnInit();
      component.onLanguage('en');
      const imported = vi.fn();
      component.imported.subscribe(imported);
      fixture.detectChanges();

      importBtn().click();
      await fixture.whenStable();

      expect(svc.importFile).toHaveBeenCalledWith('en');
      expect(imported).toHaveBeenCalledWith('imported-1');
      expect(component.importing()).toBe(false);
    });

    it('emits nothing when the file picker is closed', async () => {
      svc.importFile.mockResolvedValueOnce(null);
      const imported = vi.fn();
      const errors = vi.fn();
      component.imported.subscribe(imported);
      component.errorOccurred.subscribe(errors);

      await component.importFile();

      expect(imported).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    });

    it('surfaces an import error in the banner and frees the button', async () => {
      svc.importFile.mockRejectedValueOnce(
        new Error('Could not import "call.wma": this file type is not supported')
      );
      const errors = vi.fn();
      component.errorOccurred.subscribe(errors);

      await component.importFile();

      expect(errors).toHaveBeenCalledWith(
        'Could not import "call.wma": this file type is not supported'
      );
      expect(component.importing()).toBe(false);
      expect(component.canImport()).toBe(true);
    });

    it('says it is importing and blocks a second import while the file is decoded', async () => {
      let finish: (id: string | null) => void = () => undefined;
      svc.importFile.mockImplementationOnce(
        () => new Promise<string | null>((resolve) => (finish = resolve))
      );
      fixture.detectChanges();

      const pending = component.importFile();
      fixture.detectChanges();

      expect(importBtn().disabled).toBe(true);
      expect(importBtn().textContent).toContain('Importing…');
      expect(importBtn().getAttribute('aria-busy')).toBe('true');
      finish(null);
      await pending;
      fixture.detectChanges();
      expect(importBtn().disabled).toBe(false);
      expect(importBtn().textContent).toContain('Import audio');
    });

    it('blocks Record and its shortcut while an import is picked or decoded', async () => {
      await component.ngOnInit();
      let finish: (id: string | null) => void = () => undefined;
      svc.importFile.mockImplementationOnce(
        () => new Promise<string | null>((resolve) => (finish = resolve))
      );
      fixture.detectChanges();

      const pending = component.importFile();
      fixture.detectChanges();
      const startBtn: HTMLButtonElement = fixture.nativeElement.querySelector(
        '[data-testid="start-btn"]'
      );
      expect(startBtn.disabled).toBe(true);
      component.onKeydown(
        new KeyboardEvent('keydown', { key: 'R', metaKey: true, shiftKey: true })
      );
      expect(svc.startRecording).not.toHaveBeenCalled();

      finish('imported-1');
      await pending;
      fixture.detectChanges();
      expect(startBtn.disabled).toBe(false);
    });

    it('imports in the remembered language even before the source list arrives', async () => {
      svc.recordingChoice.mockReturnValue({ language: 'en', source: 'mixed', mic: null });
      let sources: (list: AudioSourceInfo[]) => void = () => undefined;
      svc.listAudioSources.mockImplementationOnce(
        () => new Promise<AudioSourceInfo[]>((resolve) => (sources = resolve))
      );

      const init = component.ngOnInit();
      await component.importFile();

      expect(svc.importFile).toHaveBeenCalledWith('en');
      sources(SOURCES_WITH_MIXED);
      await init;
      expect(component.language()).toBe('en');
    });

    it('keeps a language picked before the source list arrives', async () => {
      svc.recordingChoice.mockReturnValue({ language: 'pl', source: 'mixed', mic: null });
      let sources: (list: AudioSourceInfo[]) => void = () => undefined;
      svc.listAudioSources.mockImplementationOnce(
        () => new Promise<AudioSourceInfo[]>((resolve) => (sources = resolve))
      );

      const init = component.ngOnInit();
      component.onLanguage('en');
      sources(SOURCES_WITH_MIXED);
      await init;

      expect(component.language()).toBe('en');
    });

    it('remembers the language for imports on a host that offers no capture source', async () => {
      svc.recordingChoice.mockReturnValue({ language: 'pl', source: 'system_wide', mic: null });
      svc.listAudioSources.mockResolvedValueOnce([]);
      await component.ngOnInit();

      component.onLanguage('en');

      expect(svc.setRecordingChoice).toHaveBeenLastCalledWith({
        language: 'en',
        source: 'system_wide',
        mic: null,
      });
    });

    it('is disabled while no Whisper model is downloaded, like Record', async () => {
      svc.modelReady.set(false);
      fixture.detectChanges();

      expect(importBtn().disabled).toBe(true);
    });

    it('needs no capture source, so it works on a host that offers none', async () => {
      svc.listAudioSources.mockResolvedValueOnce([]);
      await component.ngOnInit();
      fixture.detectChanges();

      expect(component.canStart()).toBe(false);
      expect(importBtn().disabled).toBe(false);
    });

    it('names the formats and the chooser language in its tooltip', async () => {
      await component.ngOnInit();
      expect(component.importTooltip()).toContain('WAV, MP3, M4A, MP4, FLAC or OGG');
      expect(component.importTooltip()).toContain('in Polish, the language set on the left');
      component.onLanguage('en');
      expect(component.importTooltip()).toContain('in English, the language set on the left');
    });

    it('sits after the chooser, so the language on the chooser reads as set for both actions', async () => {
      await component.ngOnInit();
      fixture.detectChanges();
      const order = Array.from(
        fixture.nativeElement.querySelectorAll(
          '[data-testid="recording-options"], [data-testid="import-btn"], [data-testid="start-btn"]'
        ) as NodeListOf<HTMLElement>
      ).map((e) => e.dataset['testid']);
      expect(order).toEqual(['recording-options', 'import-btn', 'start-btn']);
    });

    it('says on the chooser and in its panel that the language also applies to Import audio', async () => {
      await component.ngOnInit();
      fixture.detectChanges();
      const chooser: HTMLButtonElement = fixture.nativeElement.querySelector(
        '[data-testid="recording-options"]'
      );
      expect(chooser.getAttribute('aria-label')).toContain('Record and Import audio');
      chooser.click();
      fixture.detectChanges();
      const panel: HTMLElement = fixture.nativeElement.querySelector(
        '[data-testid="recording-options-panel"]'
      );
      expect(panel.textContent).toContain('Language spoken, for Record and Import audio');
      expect(panel.textContent).toContain('Remembered for your next recording and import.');
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
    svc.modelReady.set(false);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.hasModel()).toBe(false);
    const note = fixture.nativeElement.querySelector('[data-testid="no-model-note"]');
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('Settings');
    expect(note.textContent).not.toContain('Models panel');
    expect(fixture.nativeElement.querySelector('[data-testid="start-btn"]').disabled).toBe(true);
  });

  it('re-enables Start as soon as the service sees a model, with no read of its own', async () => {
    svc.modelReady.set(false);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.hasModel()).toBe(false);
    svc.modelReady.set(true);
    fixture.detectChanges();
    expect(component.hasModel()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="start-btn"]').disabled).toBe(false);
  });

  it('keeps Start available and shows no note while the model state is unknown', async () => {
    svc.modelReady.set(null);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.modelsKnown()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="no-model-note"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="start-btn"]').disabled).toBe(false);
  });

  it('warns when the finalize model is missing: Start stays enabled, the quality cost is named', async () => {
    svc.recommended.set(recFinalizeMissing);
    await component.ngOnInit();
    fixture.detectChanges();
    const warn = fixture.nativeElement.querySelector('[data-testid="finalize-model-warning"]');
    expect(warn).not.toBeNull();
    expect(warn.textContent).toContain('Large v3');
    expect(warn.textContent).toContain('made with the smaller model');
    expect(fixture.nativeElement.querySelector('[data-testid="start-btn"]').disabled).toBe(false);
  });

  it('no finalize warning when the pair is downloaded, downloading, or single-model', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    const sel = '[data-testid="finalize-model-warning"]';
    expect(fixture.nativeElement.querySelector(sel)).toBeNull();
    svc.recommended.set({
      ...recAllDownloaded,
      finalize: { ...recAllDownloaded.finalize, downloaded: false, downloading: true },
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(sel)).toBeNull();
    svc.recommended.set({ ...recAllDownloaded, finalize: null });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(sel)).toBeNull();
  });

  it('finalize warning is suppressed while no model at all is downloaded (the no-model note owns that)', async () => {
    svc.modelReady.set(false);
    svc.recommended.set(recFinalizeMissing);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="no-model-note"]')).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="finalize-model-warning"]')
    ).toBeNull();
  });
});
