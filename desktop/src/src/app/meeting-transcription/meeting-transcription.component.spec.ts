import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { computed, signal, type Signal } from '@angular/core';
import { MeetingTranscriptionComponent } from './meeting-transcription.component';
import { RecordingControlsComponent } from './recording-controls/recording-controls.component';
import { TranscriptionService } from '../services/transcription.service';
import { makeTranscriptSession } from '../testing/transcript-session';
import type {
  AudioSource,
  CaptureWarning,
  DownloadProgress,
  Language,
  RecommendedModelAck,
  RecommendedModelEntry,
  TranscriptSession,
  TranscriptStatus,
  TranscriptSummary,
} from '../models/transcript';
import { isSessionOngoing } from '../models/transcript';

describe('MeetingTranscriptionComponent', () => {
  let component: MeetingTranscriptionComponent;
  let fixture: ComponentFixture<MeetingTranscriptionComponent>;
  let svc: {
    active: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    subscribeToTranscript: ReturnType<typeof vi.fn>;
    resumeActiveRecording: ReturnType<typeof vi.fn>;
    recommendedModel: ReturnType<typeof vi.fn>;
    listAudioSources: ReturnType<typeof vi.fn>;
    liveTranscriptPreferred: ReturnType<typeof vi.fn>;
    modelReady: typeof modelReadySig;
    recommended: Signal<RecommendedModelAck | null>;
    refreshModelReady: ReturnType<typeof vi.fn>;
    refreshModelState: ReturnType<typeof vi.fn>;
    watchRecordings: ReturnType<typeof vi.fn>;
    recordings: Signal<TranscriptSummary[]>;
    recordingsError: Signal<string>;
    recordingStartedAt: Signal<number | null>;
    audioLevels: Signal<number[] | null>;
    liveDraft: Signal<string>;
    openMicrophonePrivacyPane: ReturnType<typeof vi.fn>;
    openAudioCapturePrivacyPane: ReturnType<typeof vi.fn>;
    captureWarnings: typeof captureWarningsSig;
    recordingSessionId: typeof recordingSessionIdSig;
    recording: Signal<boolean>;
    liveStreamNeeded: Signal<boolean>;
    recordingSource: typeof recordingSourceSig;
    recordingLanguage: typeof recordingLanguageSig;
    recordingLive: typeof recordingLiveSig;
    captureOpen: Signal<boolean>;
    pausedRecording: typeof pausedRecordingSig;
    transcribing: Signal<TranscriptSummary[]>;
    highQualityModel: typeof highQualityModelSig;
    downloadingModelKey: typeof downloadingModelKeySig;
    downloadProgress: typeof downloadProgressSig;
    downloadModel: ReturnType<typeof vi.fn>;
    recordingChoice: ReturnType<typeof vi.fn>;
    setRecordingChoice: ReturnType<typeof vi.fn>;
  };
  const modelReadySig = signal<boolean | null>(null);
  const pausedRecordingSig = signal<TranscriptSummary | null>(null);
  const highQualityModelSig = signal<RecommendedModelEntry | null>(null);
  const downloadingModelKeySig = signal<string | null>(null);
  const downloadProgressSig = signal<DownloadProgress | null>(null);
  const activeSig = signal<TranscriptSession | null>(null);
  const captureWarningsSig = signal<readonly CaptureWarning[]>([]);
  const recordingSessionIdSig = signal<string | null>(null);
  const recordingSourceSig = signal<AudioSource | null>(null);
  const recordingLanguageSig = signal<Language | null>(null);
  const recordingLiveSig = signal<boolean | null>(null);

  const session = (status: TranscriptStatus) => makeTranscriptSession({ status });

  const recommended = (downloaded: boolean) => ({
    key: 'large-v3',
    display_name: 'Large v3',
    size_bytes: 3_100_000_000,
    downloaded,
    accel_label: 'CPU',
  });

  beforeEach(async () => {
    modelReadySig.set(true);
    activeSig.set(null);
    captureWarningsSig.set([]);
    recordingSessionIdSig.set(null);
    recordingSourceSig.set(null);
    recordingLanguageSig.set(null);
    recordingLiveSig.set(null);
    pausedRecordingSig.set(null);
    downloadingModelKeySig.set(null);
    downloadProgressSig.set(null);
    highQualityModelSig.set({
      key: 'large-v3',
      display_name: 'Large v3',
      size_bytes: 1_600_000_000,
      downloaded: true,
      downloading: false,
    });
    svc = {
      active: vi.fn(() => activeSig()),
      detach: vi.fn(async () => undefined),
      subscribeToTranscript: vi.fn(async () => ({ event_name: 'e', snapshot: {} as never })),
      resumeActiveRecording: vi.fn(async () => undefined),
      recommendedModel: vi.fn(async () => recommended(true)),
      listAudioSources: vi.fn(async () => []),
      liveTranscriptPreferred: vi.fn(() => false),
      modelReady: modelReadySig,
      recommended: signal<RecommendedModelAck | null>(null),
      refreshModelReady: vi.fn(async () => undefined),
      refreshModelState: vi.fn(async () => undefined),
      watchRecordings: vi.fn(async () => undefined),
      recordings: signal<TranscriptSummary[]>([]),
      recordingsError: signal(''),
      recordingStartedAt: signal<number | null>(null),
      audioLevels: signal<number[] | null>(null),
      liveDraft: signal(''),
      openMicrophonePrivacyPane: vi.fn(async () => undefined),
      openAudioCapturePrivacyPane: vi.fn(async () => undefined),
      captureWarnings: captureWarningsSig,
      recordingSessionId: recordingSessionIdSig,
      recording: computed(() => recordingSessionIdSig() !== null),
      liveStreamNeeded: computed(() => {
        const status = activeSig()?.status;
        return status !== undefined && isSessionOngoing(status);
      }),
      recordingSource: recordingSourceSig,
      recordingLanguage: recordingLanguageSig,
      recordingLive: recordingLiveSig,
      captureOpen: computed(
        () => recordingSessionIdSig() !== null || pausedRecordingSig() !== null
      ),
      pausedRecording: pausedRecordingSig,
      transcribing: signal<TranscriptSummary[]>([]),
      highQualityModel: highQualityModelSig,
      downloadingModelKey: downloadingModelKeySig,
      downloadProgress: downloadProgressSig,
      downloadModel: vi.fn(async () => {
        modelReadySig.set(true);
      }),
      recordingChoice: vi.fn(() => null),
      setRecordingChoice: vi.fn(),
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
    expect(fixture.nativeElement.querySelector('app-model-manager')).toBeNull();
  });

  it('shows the model-required gate (and hides the panes) when no model is downloaded', async () => {
    modelReadySig.set(false);
    await component.ngOnInit();
    fixture.detectChanges();
    const gate = fixture.nativeElement.querySelector('[data-testid="model-required-gate"]');
    expect(gate).not.toBeNull();
    expect(gate.textContent).toContain('One download before your first recording');
    expect(
      fixture.nativeElement.querySelector('[data-testid="gate-download"]').textContent
    ).toContain('Download (1.5 GB)');
    const link = fixture.nativeElement.querySelector('[data-testid="download-model-link"]');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toContain('/settings');
    expect(fixture.nativeElement.querySelector('app-recording-controls')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="quality-disclaimer"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('header')).toBeNull();
  });

  it('shows the panes while the model state is still unknown', async () => {
    modelReadySig.set(null);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="model-required-gate"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-recording-controls')).not.toBeNull();
  });

  it('reads the model state through the service on init', async () => {
    await component.ngOnInit();
    expect(svc.refreshModelState).toHaveBeenCalled();
  });

  it('clears the gate when the window regains focus after a Settings download', async () => {
    modelReadySig.set(false);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="model-required-gate"]')
    ).not.toBeNull();
    svc.refreshModelReady.mockImplementationOnce(async () => {
      modelReadySig.set(true);
    });
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(svc.refreshModelReady).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.querySelector('[data-testid="model-required-gate"]')).toBeNull();
  });

  it('skips the re-check when the document goes hidden', async () => {
    await component.ngOnInit();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(svc.refreshModelReady).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(svc.refreshModelReady).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it('registers the focus/visibility listeners even if resumeActiveRecording rejects', async () => {
    svc.resumeActiveRecording.mockRejectedValueOnce(new Error('subscribe_transcript failed'));
    await component.ngOnInit();
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(svc.refreshModelReady).toHaveBeenCalled();
  });

  it('removes the focus/visibility listeners on destroy', async () => {
    await component.ngOnInit();
    await component.ngOnDestroy();
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(svc.refreshModelReady).not.toHaveBeenCalled();
  });

  it('says in one line that everything stays local until a transcript is sent', () => {
    const header = (fixture.nativeElement.querySelector('header')?.textContent ?? '').toLowerCase();
    expect(header).toContain('on this machine');
    expect(header).toContain('nothing leaves your computer');
  });

  it('keeps the details in a collapsed "How it works" panel', () => {
    const details: HTMLDetailsElement = fixture.nativeElement.querySelector(
      '[data-testid="how-it-works"]'
    );
    expect(details.open).toBe(false);
    const text = details.textContent ?? '';
    expect(text).toContain('Pause turns the microphone off');
    expect(text).toContain('still being transcribed');
    expect(details.querySelector('[data-testid="quality-disclaimer"]')).not.toBeNull();
  });

  it('explains Import audio, its formats and its language under "How it works"', () => {
    const item: HTMLElement = fixture.nativeElement.querySelector(
      '[data-testid="import-how-it-works"]'
    );
    expect(item.textContent).toContain('Import audio');
    expect(item.textContent).toContain('WAV, MP3, M4A, MP4, FLAC or OGG');
    expect(item.textContent).toContain('language chosen next to Record');
  });

  it('opens an imported recording as soon as the controls report it', async () => {
    component.onError('old error');
    const controls = fixture.debugElement.query(By.directive(RecordingControlsComponent));
    (controls.componentInstance as RecordingControlsComponent).imported.emit('imp-1');
    await fixture.whenStable();
    expect(svc.subscribeToTranscript).toHaveBeenCalledWith('imp-1');
    expect(component.error()).toBe('');
  });

  it('keeps the open recording and shows the reason when an import fails', async () => {
    activeSig.set(makeTranscriptSession({ id: 'sess-open' }));
    const controls = fixture.debugElement.query(By.directive(RecordingControlsComponent));
    (controls.componentInstance as RecordingControlsComponent).errorOccurred.emit(
      'Could not import "call.wma": this file type is not supported'
    );
    fixture.detectChanges();
    expect(svc.subscribeToTranscript).not.toHaveBeenCalled();
    expect(component.active()?.id).toBe('sess-open');
    const banner: HTMLElement | null = fixture.nativeElement.querySelector(
      '[data-testid="meeting-transcription-error"]'
    );
    expect(banner?.textContent).toContain('Could not import "call.wma"');
  });

  it('starts following the recordings list through the list component', () => {
    expect(svc.watchRecordings).toHaveBeenCalled();
  });

  it('clears the banner when a recording starts or stops', () => {
    component.onError('boom');
    component.onStarted();
    expect(component.error()).toBe('');
    component.onError('boom');
    component.onStopped();
    expect(component.error()).toBe('');
  });

  it('puts Record in the header and swaps it for the recording bar while one captures or is paused', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('header app-recording-controls')).not.toBeNull();
    expect(el.querySelector('app-recording-bar')).toBeNull();
    recordingSessionIdSig.set('sess-1');
    fixture.detectChanges();
    expect(el.querySelector('app-recording-controls')).toBeNull();
    expect(el.querySelector('app-recording-bar')).not.toBeNull();
    recordingSessionIdSig.set(null);
    pausedRecordingSig.set({ id: 'sess-1', status: { state: 'paused' } } as TranscriptSummary);
    fixture.detectChanges();
    expect(el.querySelector('app-recording-bar')).not.toBeNull();
  });

  it('links to the transcription settings from the header', () => {
    const link = fixture.nativeElement.querySelector('[data-testid="transcription-settings-link"]');
    expect(link.getAttribute('href')).toContain('/settings');
  });

  it('opens the recording the bar names, and not again when it is already open', async () => {
    await component.onOpenById('sess-2');
    expect(svc.subscribeToTranscript).toHaveBeenCalledWith('sess-2');
    activeSig.set(makeTranscriptSession({ id: 'sess-2' }));
    svc.subscribeToTranscript.mockClear();
    await component.onOpenById('sess-2');
    expect(svc.subscribeToTranscript).not.toHaveBeenCalled();
  });

  describe('first-run gate', () => {
    beforeEach(async () => {
      modelReadySig.set(false);
      highQualityModelSig.set({
        key: 'large-v3',
        display_name: 'Large v3',
        size_bytes: 1_600_000_000,
        downloaded: false,
        downloading: false,
      });
      await component.ngOnInit();
      fixture.detectChanges();
    });

    it('downloads the high-quality model in place and lifts the gate', async () => {
      fixture.nativeElement.querySelector('[data-testid="gate-download"]').click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(svc.downloadModel).toHaveBeenCalledWith('large-v3');
      expect(fixture.nativeElement.querySelector('[data-testid="model-required-gate"]')).toBeNull();
    });

    it('lifts the gate when a download another instance started finishes after this mount', async () => {
      downloadingModelKeySig.set('large-v3');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="gate-progress"]')).not.toBeNull();
      downloadingModelKeySig.set(null);
      modelReadySig.set(true);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="model-required-gate"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="gate-download"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('app-recording-controls')).not.toBeNull();
    });

    it('shows the progress while the download runs', () => {
      downloadingModelKeySig.set('large-v3');
      downloadProgressSig.set({
        model_key: 'large-v3',
        downloaded_bytes: 672_000_000,
        total_bytes: 1_600_000_000,
      });
      fixture.detectChanges();
      const progress = fixture.nativeElement.querySelector('[data-testid="gate-progress"]');
      expect(progress.textContent).toContain('Downloading 42%');
      expect(progress.textContent).toContain('of 1.5 GB');
      expect(fixture.nativeElement.querySelector('[data-testid="gate-download"]')).toBeNull();
    });

    it('keeps the gate and says why when the download fails', async () => {
      svc.downloadModel.mockRejectedValueOnce(new Error('network down'));
      await component.downloadFromGate();
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="model-required-gate"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="gate-error"]').textContent
      ).toContain('network down');
      expect(fixture.nativeElement.querySelector('[data-testid="gate-error"]').className).toContain(
        'text-[var(--red)]'
      );
      expect(
        fixture.nativeElement.querySelector('[data-testid="gate-download"]').className
      ).toContain('text-[var(--on-accent)]');
    });
  });

  it('subscribes to a session when one is opened', async () => {
    await component.onOpenSession({ id: 'sess-1' } as TranscriptSummary);
    expect(svc.subscribeToTranscript).toHaveBeenCalledWith('sess-1');
  });

  it('shows the "Open Privacy settings" link on a permission error and wires it', async () => {
    component.onError('audio recording permission denied');
    fixture.detectChanges();
    const link = fixture.nativeElement.querySelector('[data-testid="open-mic-settings"]');
    expect(link).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="meeting-transcription-error"]').className
    ).toContain('text-[var(--red)]');
    await component.openMicrophoneSettings();
    expect(svc.openMicrophonePrivacyPane).toHaveBeenCalled();
    expect(svc.openAudioCapturePrivacyPane).toHaveBeenCalled();
  });

  it('detaches the live stream on destroy', async () => {
    await component.ngOnDestroy();
    expect(svc.detach).toHaveBeenCalled();
  });

  it('keeps the live stream attached on destroy while the open recording captures', async () => {
    recordingSessionIdSig.set('sess-1');
    activeSig.set(session({ state: 'recording' }));
    await component.ngOnDestroy();
    expect(svc.detach).not.toHaveBeenCalled();
  });

  it('detaches the open finished recording on destroy even while another one captures', async () => {
    recordingSessionIdSig.set('another');
    activeSig.set(session({ state: 'done' }));
    await component.ngOnDestroy();
    expect(svc.detach).toHaveBeenCalled();
  });

  it('keeps the live stream attached on destroy while the offline pass runs', async () => {
    activeSig.set(session({ state: 'finalizing', progress: 0.47 }));
    await component.ngOnDestroy();
    expect(svc.detach).not.toHaveBeenCalled();
  });

  it('keeps the live stream attached on destroy right after Stop, before finalizing arrives', async () => {
    activeSig.set(session({ state: 'recording' }));
    await component.ngOnDestroy();
    expect(svc.detach).not.toHaveBeenCalled();
  });

  it('detaches the live stream on destroy once the session is done', async () => {
    activeSig.set(session({ state: 'done' }));
    await component.ngOnDestroy();
    expect(svc.detach).toHaveBeenCalled();
  });

  it('detaches the live stream on destroy once the session failed', async () => {
    activeSig.set(session({ state: 'failed', reason: 'decoder crashed' }));
    await component.ngOnDestroy();
    expect(svc.detach).toHaveBeenCalled();
  });

  it('renders no capture-warning banner without a warning', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="capture-warning"]')).toBeNull();
  });

  it('renders the silent-system-audio warning with a settings link', () => {
    captureWarningsSig.set(['system_audio_silent']);
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('[data-testid="capture-warning"]');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('No system audio captured');
    expect(banner.className).toContain('text-[var(--ink)]');
    expect(banner.className).toContain('ring-[var(--amber)]/40');
    expect(banner.querySelector('[data-testid="open-audio-settings"]')).not.toBeNull();
  });

  it('renders the stalled-microphone warning without a settings link', () => {
    captureWarningsSig.set(['microphone_stalled']);
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('[data-testid="capture-warning"]');
    expect(banner.textContent).toContain('microphone stopped');
    expect(banner.querySelector('[data-testid="open-audio-settings"]')).toBeNull();
  });

  it('renders the speaker-attribution warning as a complete transcript without labels', () => {
    captureWarningsSig.set(['speaker_attribution_failed']);
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('[data-testid="capture-warning"]');
    expect(banner.textContent).toContain('Speakers could not be told apart for this recording');
    expect(banner.textContent).toContain('complete without speaker labels');
    expect(banner.querySelector('[data-testid="open-audio-settings"]')).toBeNull();
  });

  it('renders the missing speaker model warning with the way to fix it', () => {
    captureWarningsSig.set(['speaker_model_missing']);
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('[data-testid="capture-warning"]');
    expect(banner.textContent).toContain('model is not downloaded yet');
    expect(banner.textContent).toContain('Download it in Settings and transcribe again');
    expect(banner.querySelector('[data-testid="open-audio-settings"]')).toBeNull();
  });

  it('renders the dropped-audio warning without blaming the transcriber', () => {
    captureWarningsSig.set(['audio_dropped']);
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('[data-testid="capture-warning"]');
    expect(banner.textContent).toContain('audio was dropped');
    expect(banner.textContent).not.toContain('transcriber');
  });

  it('renders one banner per raised warning, with the same copy as a lone one', () => {
    captureWarningsSig.set(['microphone_stalled', 'audio_dropped']);
    fixture.detectChanges();
    const banners = fixture.nativeElement.querySelectorAll('[data-testid="capture-warning"]');
    expect(banners.length).toBe(2);
    expect(banners[0].textContent).toContain('microphone stopped');
    expect(banners[1].textContent).toContain('audio was dropped');
  });

  it('gives the settings link only to the silent-system-audio row', () => {
    captureWarningsSig.set(['system_audio_silent', 'microphone_stalled']);
    fixture.detectChanges();
    const banners = fixture.nativeElement.querySelectorAll('[data-testid="capture-warning"]');
    expect(banners.length).toBe(2);
    expect(banners[0].querySelector('[data-testid="open-audio-settings"]')).not.toBeNull();
    expect(banners[1].querySelector('[data-testid="open-audio-settings"]')).toBeNull();
  });
});
