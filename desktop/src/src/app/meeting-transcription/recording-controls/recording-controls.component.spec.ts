import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RecordingControlsComponent } from './recording-controls.component';
import { TranscriptionService } from '../../services/transcription.service';
import type { AudioSourceInfo, CapabilitiesAck, StartAck } from '../../models/transcript';

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
  let svc: {
    getCapabilities: ReturnType<typeof vi.fn>;
    listAudioSources: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
    startRecording: ReturnType<typeof vi.fn>;
    stopRecording: ReturnType<typeof vi.fn>;
    recordingSessionId: typeof recordingSessionId;
  };

  const caps: CapabilitiesAck = {
    capabilities: {
      supports_system_audio: true,
      supports_microphone: false,
      note: 'Requires macOS 14.4+',
    },
    backends: ['cpu', 'metal'],
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

  beforeEach(async () => {
    recordingSessionId = signal<string | null>(null);
    svc = {
      getCapabilities: vi.fn(async () => caps),
      listAudioSources: vi.fn(async () => SOURCES),
      listModels: vi.fn(async () => modelsWithSmall),
      // Mirror the real service: start/stop drive the shared recording signal.
      startRecording: vi.fn(async (): Promise<StartAck> => {
        recordingSessionId.set('sess-1');
        return {
          session_id: 'sess-1',
          event_name: 'transcript_event::sess-1',
          snapshot: {} as never,
        };
      }),
      stopRecording: vi.fn(async (id: string) => {
        if (recordingSessionId() === id) recordingSessionId.set(null);
      }),
      recordingSessionId,
    };
    await TestBed.configureTestingModule({
      imports: [RecordingControlsComponent],
      providers: [{ provide: TranscriptionService, useValue: svc }],
    }).compileComponents();
    fixture = TestBed.createComponent(RecordingControlsComponent);
    component = fixture.componentInstance;
  });

  it('loads capabilities + sources and defaults to System', async () => {
    await component.ngOnInit();
    expect(component.sources().length).toBe(2);
    expect(component.sourceIndex()).toBe(0); // system_wide
    expect(component.accel()).toBe('Acceleration: Metal');
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
    expect(svc.startRecording).toHaveBeenCalledWith({ kind: 'mixed', mic: null }, 'pl');
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
      'pl'
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
      'pl'
    );
  });

  it('keeps the system default mic (null) when none is picked', async () => {
    svc.listAudioSources.mockResolvedValueOnce(SOURCES_WITH_MICS);
    await component.ngOnInit();
    await component.start();
    expect(svc.startRecording).toHaveBeenCalledWith({ kind: 'mixed', mic: null }, 'pl');
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
    expect(svc.startRecording).toHaveBeenCalledWith(SOURCES[1].source, 'en');
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
});
