import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { MeetingTranscriptionComponent } from './meeting-transcription.component';
import { TranscriptionService } from '../services/transcription.service';
import type {
  AudioSource,
  CaptureWarning,
  Language,
  TranscriptSession,
} from '../models/transcript';

describe('MeetingTranscriptionComponent', () => {
  let component: MeetingTranscriptionComponent;
  let fixture: ComponentFixture<MeetingTranscriptionComponent>;
  let svc: {
    active: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    subscribeToTranscript: ReturnType<typeof vi.fn>;
    resumeActiveRecording: ReturnType<typeof vi.fn>;
    recommendedModel: ReturnType<typeof vi.fn>;
    // The child components inject TranscriptionService too; stub the rest.
    getCapabilities: ReturnType<typeof vi.fn>;
    listAudioSources: ReturnType<typeof vi.fn>;
    liveTranscriptPreferred: ReturnType<typeof vi.fn>;
    setLiveTranscriptPreferred: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    openMicrophonePrivacyPane: ReturnType<typeof vi.fn>;
    openAudioCapturePrivacyPane: ReturnType<typeof vi.fn>;
    captureWarning: typeof captureWarningSig;
    recordingSessionId: typeof recordingSessionIdSig;
    recordingSource: typeof recordingSourceSig;
    recordingLanguage: typeof recordingLanguageSig;
  };
  const activeSig = signal<TranscriptSession | null>(null);
  const captureWarningSig = signal<CaptureWarning | null>(null);
  const recordingSessionIdSig = signal<string | null>(null);
  const recordingSourceSig = signal<AudioSource | null>(null);
  const recordingLanguageSig = signal<Language | null>(null);

  const recommended = (downloaded: boolean) => ({
    key: 'large-v3',
    display_name: 'Large v3',
    size_bytes: 3_100_000_000,
    downloaded,
    accel_label: 'CPU',
  });

  const models = (downloaded: boolean) => ({
    whisper: [{ key: 'large-v3', downloaded, size_bytes: 3_100_000_000, path: null }],
    total_bytes_used: downloaded ? 3_100_000_000 : 0,
  });

  beforeEach(async () => {
    activeSig.set(null);
    captureWarningSig.set(null);
    recordingSessionIdSig.set(null);
    recordingSourceSig.set(null);
    recordingLanguageSig.set(null);
    svc = {
      active: vi.fn(() => activeSig()),
      detach: vi.fn(async () => undefined),
      subscribeToTranscript: vi.fn(async () => ({ event_name: 'e', snapshot: {} as never })),
      resumeActiveRecording: vi.fn(async () => undefined),
      recommendedModel: vi.fn(async () => recommended(true)),
      getCapabilities: vi.fn(async () => ({
        capabilities: {
          supports_system_audio: true,
          supports_microphone: false,
          note: null,
        },
        backends: ['cpu'],
        gpu_class: 'none' as const,
      })),
      listAudioSources: vi.fn(async () => []),
      liveTranscriptPreferred: vi.fn(() => true),
      setLiveTranscriptPreferred: vi.fn(),
      // Gate predicate matches recording-controls hasModel — any downloaded model lifts it.
      listModels: vi.fn(async () => models(true)),
      list: vi.fn(async () => []),
      openMicrophonePrivacyPane: vi.fn(async () => undefined),
      openAudioCapturePrivacyPane: vi.fn(async () => undefined),
      captureWarning: captureWarningSig,
      recordingSessionId: recordingSessionIdSig,
      recordingSource: recordingSourceSig,
      recordingLanguage: recordingLanguageSig,
    };
    await TestBed.configureTestingModule({
      imports: [MeetingTranscriptionComponent],
      providers: [
        { provide: TranscriptionService, useValue: svc },
        provideRouter([{ path: '**', children: [] }]),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MeetingTranscriptionComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows the recording panes when a model is downloaded', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-recording-controls')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-live-transcript')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-session-list')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="model-required-gate"]')).toBeNull();
    // The model manager moved to Settings — no model UI in the tab.
    expect(fixture.nativeElement.querySelector('app-model-manager')).toBeNull();
  });

  it('shows the model-required gate (and hides the panes) when no model is downloaded', async () => {
    svc.listModels.mockResolvedValue(models(false));
    await component.ngOnInit();
    fixture.detectChanges();
    const gate = fixture.nativeElement.querySelector('[data-testid="model-required-gate"]');
    expect(gate).not.toBeNull();
    expect(gate.textContent.toLowerCase()).toContain('model required');
    // The link points at the transcription section in Settings.
    const link = fixture.nativeElement.querySelector('[data-testid="download-model-link"]');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toContain('/settings');
    // Neither the panes nor the header chrome render behind the gate.
    expect(fixture.nativeElement.querySelector('app-recording-controls')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="quality-disclaimer"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('header')).toBeNull();
  });

  it('fails open (shows the panes) if the model check errors', async () => {
    svc.listModels.mockRejectedValue(new Error('boom'));
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.modelReady()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="model-required-gate"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-recording-controls')).not.toBeNull();
  });

  it('clears the gate when the window regains focus after a Settings download', async () => {
    // Start with no model → gate up.
    svc.listModels.mockResolvedValue(models(false));
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.modelReady()).toBe(false);
    // The user downloads the model in Settings, then returns → focus re-checks.
    svc.listModels.mockResolvedValue(models(true));
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(component.modelReady()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="model-required-gate"]')).toBeNull();
  });

  it('registers the focus/visibility listeners even if resumeActiveRecording rejects', async () => {
    svc.resumeActiveRecording.mockRejectedValueOnce(new Error('subscribe_transcript failed'));
    await component.ngOnInit();
    // A rejection above must not have prevented the listeners from being wired up.
    svc.listModels.mockClear();
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(svc.listModels).toHaveBeenCalled();
  });

  it('removes the focus/visibility listeners on destroy', async () => {
    await component.ngOnInit();
    await component.ngOnDestroy();
    svc.listModels.mockClear();
    // A focus event after destroy must not trigger another model check.
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(svc.listModels).not.toHaveBeenCalled();
  });

  it('shows the "audio local, send uses network" banner text', () => {
    expect((fixture.nativeElement.textContent ?? '').toLowerCase()).toContain(
      'transcribed locally'
    );
  });

  it('subscribes to a session when one is opened', async () => {
    await component.onOpenSession({ id: 'sess-1' } as TranscriptSession);
    expect(svc.subscribeToTranscript).toHaveBeenCalledWith('sess-1');
  });

  it('shows the "Open Privacy settings" link on a permission error and wires it', async () => {
    component.onError('audio recording permission denied');
    fixture.detectChanges();
    const link = fixture.nativeElement.querySelector('[data-testid="open-mic-settings"]');
    expect(link).not.toBeNull();
    await component.openMicrophoneSettings();
    expect(svc.openMicrophonePrivacyPane).toHaveBeenCalled();
    expect(svc.openAudioCapturePrivacyPane).toHaveBeenCalled();
  });

  it('detaches the live stream on destroy', async () => {
    await component.ngOnDestroy();
    expect(svc.detach).toHaveBeenCalled();
  });

  it('renders no capture-warning banner without a warning', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="capture-warning"]')).toBeNull();
  });

  it('renders the silent-system-audio warning with a settings link', () => {
    captureWarningSig.set('system_audio_silent');
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('[data-testid="capture-warning"]');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('No system audio captured');
    expect(banner.querySelector('[data-testid="open-audio-settings"]')).not.toBeNull();
  });

  it('renders the stalled-microphone warning without a settings link', () => {
    captureWarningSig.set('microphone_stalled');
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('[data-testid="capture-warning"]');
    expect(banner.textContent).toContain('microphone stopped');
    expect(banner.querySelector('[data-testid="open-audio-settings"]')).toBeNull();
  });
});
