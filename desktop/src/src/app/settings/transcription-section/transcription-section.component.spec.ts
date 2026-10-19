import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranscriptionSectionComponent } from './transcription-section.component';
import { TauriService } from '../../services/tauri.service';
import { TranscriptionService } from '../../services/transcription.service';
import type {
  DownloadProgress,
  MicPermissionStatus,
  RecommendedModelAck,
  RecommendedModelEntry,
  TranscriptSummary,
} from '../../models/transcript';

describe('TranscriptionSectionComponent', () => {
  let component: TranscriptionSectionComponent;
  let fixture: ComponentFixture<TranscriptionSectionComponent>;
  let downloadingModelKey: ReturnType<typeof signal<string | null>>;
  let downloadProgress: ReturnType<typeof signal<DownloadProgress | null>>;
  let recordings: ReturnType<typeof signal<TranscriptSummary[]>>;
  let svc: {
    recommendedModel: ReturnType<typeof vi.fn>;
    downloadModel: ReturnType<typeof vi.fn>;
    deleteModel: ReturnType<typeof vi.fn>;
    resumeDownloadTracking: ReturnType<typeof vi.fn>;
    clearDownloadTracking: ReturnType<typeof vi.fn>;
    microphonePermissionStatus: ReturnType<typeof vi.fn>;
    requestMicrophonePermission: ReturnType<typeof vi.fn>;
    openMicrophonePrivacyPane: ReturnType<typeof vi.fn>;
    openAudioCapturePrivacyPane: ReturnType<typeof vi.fn>;
    liveTranscriptPreferred: ReturnType<typeof vi.fn>;
    setLiveTranscriptPreferred: ReturnType<typeof vi.fn>;
    downloadingModelKey: typeof downloadingModelKey;
    downloadProgress: typeof downloadProgress;
    refreshRecordings: ReturnType<typeof vi.fn>;
    speakerAttribution: ReturnType<typeof vi.fn>;
    setSpeakerAttribution: ReturnType<typeof vi.fn>;
    recordings: typeof recordings;
  };
  let platform: string;

  const liveEntry: RecommendedModelEntry = {
    key: 'large-v3',
    display_name: 'Large v3 (multilingual)',
    size_bytes: 3_100_000_000,
    downloaded: false,
    downloading: false,
  };
  const diarizationEntry: RecommendedModelEntry = {
    key: 'nemotron-3-diarization-q8_0',
    display_name: 'Nemotron-3 Diarization',
    size_bytes: 107_012_128,
    downloaded: false,
    downloading: false,
  };
  const notDownloaded: RecommendedModelAck = {
    live: liveEntry,
    accel_label: 'Metal (GPU)',
    finalize: null,
    diarization: diarizationEntry,
    gpu_class: 'discrete',
  };
  const downloaded: RecommendedModelAck = {
    ...notDownloaded,
    live: { ...liveEntry, downloaded: true },
  };

  beforeEach(async () => {
    downloadingModelKey = signal<string | null>(null);
    downloadProgress = signal<DownloadProgress | null>(null);
    recordings = signal<TranscriptSummary[]>([]);
    platform = 'macos';
    svc = {
      recommendedModel: vi.fn(async () => notDownloaded),
      downloadModel: vi.fn(async () => undefined),
      deleteModel: vi.fn(async () => undefined),
      resumeDownloadTracking: vi.fn(async () => undefined),
      clearDownloadTracking: vi.fn(() => undefined),
      microphonePermissionStatus: vi.fn(async (): Promise<MicPermissionStatus> => 'granted'),
      requestMicrophonePermission: vi.fn(async () => 'granted'),
      openMicrophonePrivacyPane: vi.fn(async () => undefined),
      openAudioCapturePrivacyPane: vi.fn(async () => undefined),
      liveTranscriptPreferred: vi.fn(() => false),
      setLiveTranscriptPreferred: vi.fn(),
      downloadingModelKey,
      downloadProgress,
      refreshRecordings: vi.fn(async () => undefined),
      speakerAttribution: vi.fn(() => false),
      setSpeakerAttribution: vi.fn(),
      recordings,
    };
    await TestBed.configureTestingModule({
      imports: [TranscriptionSectionComponent],
      providers: [
        { provide: TranscriptionService, useValue: svc },
        {
          provide: TauriService,
          useValue: {
            invoke: vi.fn(async (cmd: string) => (cmd === 'get_platform' ? platform : undefined)),
          },
        },
        provideRouter([{ path: '**', children: [] }]),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(TranscriptionSectionComponent);
    component = fixture.componentInstance;
  });

  describe('live text toggle', () => {
    it('is off by default, names its cost, and persists a change', async () => {
      await component.ngOnInit();
      fixture.detectChanges();
      const box: HTMLInputElement = fixture.nativeElement.querySelector(
        '[data-testid="live-transcript-toggle"]'
      );
      expect(box.checked).toBe(false);
      expect(fixture.nativeElement.textContent).toContain('Uses more CPU and battery');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(svc.setLiveTranscriptPreferred).toHaveBeenCalledWith(true);
      expect(component.liveTranscript()).toBe(true);
    });

    it('shows a stored opt-in as on', async () => {
      svc.liveTranscriptPreferred.mockReturnValue(true);
      fixture = TestBed.createComponent(TranscriptionSectionComponent);
      component = fixture.componentInstance;
      expect(component.liveTranscript()).toBe(true);
    });
  });

  describe('model rows', () => {
    it('renders a single row when one model serves both passes', async () => {
      await component.ngOnInit();
      fixture.detectChanges();
      expect(component.modelRows().length).toBe(1);
      expect(
        fixture.nativeElement.querySelector('[data-testid="model-state-finalize"]')
      ).toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="model-state"]').textContent
      ).toContain('best quality for your hardware');
    });

    it('renders live and final rows when the host needs two different models', async () => {
      svc.recommendedModel.mockResolvedValue({
        ...notDownloaded,
        live: {
          ...liveEntry,
          key: 'small',
          display_name: 'Small (multilingual)',
          size_bytes: 487_601_967,
        },
        accel_label: 'CPU',
        diarization: diarizationEntry,
        gpu_class: 'none',
        finalize: {
          key: 'large-v3-turbo',
          display_name: 'Large v3 Turbo',
          size_bytes: 1_624_555_275,
          downloaded: true,
          downloading: false,
        },
      });
      await component.ngOnInit();
      fixture.detectChanges();

      expect(component.modelRows().map((r) => r.entry.key)).toEqual(['small', 'large-v3-turbo']);
      expect(
        fixture.nativeElement.querySelector('[data-testid="model-state"]').textContent
      ).toContain('Not downloaded');
      expect(fixture.nativeElement.querySelector('[data-testid="download-model"]')).not.toBeNull();
      const finalizeState = fixture.nativeElement.querySelector(
        '[data-testid="model-state-finalize"]'
      );
      expect(finalizeState.textContent).toContain('Large v3 Turbo');
      expect(finalizeState.textContent).toContain('runs after you stop recording');
      expect(
        fixture.nativeElement.querySelector('[data-testid="remove-model-finalize"]')
      ).not.toBeNull();
    });

    it('shows progress only on the model actually downloading', async () => {
      const finalize = {
        key: 'large-v3-turbo',
        display_name: 'Large v3 Turbo',
        size_bytes: 1_624_555_275,
        downloaded: false,
        downloading: true,
      };
      svc.recommendedModel.mockResolvedValue({
        ...notDownloaded,
        live: { ...liveEntry, key: 'small' },
        finalize,
      });
      downloadingModelKey.set('large-v3-turbo');
      downloadProgress.set({
        model_key: 'large-v3-turbo',
        downloaded_bytes: 50,
        total_bytes: 100,
      });
      await component.ngOnInit();
      fixture.detectChanges();

      expect(component.downloadLabel({ ...liveEntry, key: 'small' })).toBe('Download (2.9 GB)');
      expect(component.downloadLabel(finalize)).toBe('Downloading 50%');
    });
  });
  describe('permissions block', () => {
    it('shows a granted mic state on macOS', async () => {
      await component.ngOnInit();
      fixture.detectChanges();
      const block = fixture.nativeElement.querySelector(
        '[data-testid="transcription-permissions"]'
      );
      expect(block).not.toBeNull();
      const state = fixture.nativeElement.querySelector('[data-testid="mic-permission-state"]');
      expect(state.textContent).toContain('Allowed');
      expect(
        fixture.nativeElement.querySelector('[data-testid="request-mic-permission"]')
      ).toBeNull();
    });

    it('is absent on Windows', async () => {
      platform = 'windows';
      await component.ngOnInit();
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="transcription-permissions"]')
      ).toBeNull();
      expect(svc.microphonePermissionStatus).not.toHaveBeenCalled();
    });

    it('undetermined → request access shows the prompt and re-reads the state', async () => {
      svc.microphonePermissionStatus
        .mockResolvedValueOnce('undetermined')
        .mockResolvedValueOnce('granted');
      await component.ngOnInit();
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="request-mic-permission"]');
      expect(btn).not.toBeNull();
      await component.requestMic();
      fixture.detectChanges();
      expect(svc.requestMicrophonePermission).toHaveBeenCalledTimes(1);
      expect(component.micStatus()).toBe('granted');
      expect(
        fixture.nativeElement.querySelector('[data-testid="request-mic-permission"]')
      ).toBeNull();
    });

    it('denied → offers the Microphone privacy pane deep-link', async () => {
      svc.microphonePermissionStatus.mockResolvedValue('denied');
      await component.ngOnInit();
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="open-mic-privacy"]');
      expect(btn).not.toBeNull();
      await component.openMicPane();
      expect(svc.openMicrophonePrivacyPane).toHaveBeenCalledTimes(1);
    });

    it('always offers the System Audio Recording pane deep-link on macOS', async () => {
      await component.ngOnInit();
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="open-audio-privacy"]');
      expect(btn).not.toBeNull();
      await component.openAudioPane();
      expect(svc.openAudioCapturePrivacyPane).toHaveBeenCalledTimes(1);
    });
  });

  it('shows the privacy/disclaimer text', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    const body: string = fixture.nativeElement.textContent ?? '';
    expect(body).toContain('records system audio');
    expect(body).toContain('on this machine');
    expect(body).toContain('Audio never leaves your computer.');
  });

  it('shows the acceleration label from the backend', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    const accel = fixture.nativeElement.querySelector('[data-testid="accel-label"]');
    expect(accel.textContent).toContain('Metal (GPU)');
  });

  it('not-downloaded → shows size + a download button, no remove button', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="download-model"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="remove-model"]')).toBeNull();
    const state = fixture.nativeElement.querySelector('[data-testid="model-state"]');
    expect(state.textContent).toContain('2.9 GB');
    expect(state.textContent).toContain('best quality for your hardware');
  });

  it('downloaded → shows a remove button, no download button', async () => {
    svc.recommendedModel.mockResolvedValueOnce(downloaded);
    await component.ngOnInit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="remove-model"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="download-model"]')).toBeNull();
    const state = fixture.nativeElement.querySelector('[data-testid="model-state"]');
    expect(state.textContent).toContain('Downloaded');
  });

  it('download() invokes downloadModel then re-reads state', async () => {
    await component.ngOnInit();
    svc.recommendedModel.mockResolvedValueOnce(downloaded);
    await component.download('large-v3');
    expect(svc.downloadModel).toHaveBeenCalledWith('large-v3');
    expect(component.model()?.live.downloaded).toBe(true);
    expect(component.busy()).toBe(false);
  });

  it('remove() invokes deleteModel then re-reads state', async () => {
    svc.recommendedModel.mockResolvedValueOnce(downloaded);
    await component.ngOnInit();
    svc.recommendedModel.mockResolvedValueOnce(notDownloaded);
    await component.remove('large-v3');
    expect(svc.deleteModel).toHaveBeenCalledWith('large-v3');
    expect(component.model()?.live.downloaded).toBe(false);
  });

  it('reports a download error and clears busy', async () => {
    await component.ngOnInit();
    svc.downloadModel.mockRejectedValueOnce(new Error('disk full'));
    const errSpy = vi.fn();
    component.errorOccurred.subscribe(errSpy);
    await component.download('large-v3');
    expect(errSpy).toHaveBeenCalledWith('disk full');
    expect(component.busy()).toBe(false);
  });

  it('emits the error when the recommended-model lookup fails', async () => {
    svc.recommendedModel.mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.fn();
    component.errorOccurred.subscribe(errSpy);
    await component.ngOnInit();
    expect(errSpy).toHaveBeenCalledWith('boom');
    expect(component.model()).toBeNull();
  });

  it('a fresh instance reflects a download already in flight in the service', async () => {
    downloadingModelKey.set('large-v3');
    downloadProgress.set({ model_key: 'large-v3', downloaded_bytes: 50, total_bytes: 100 });
    await component.ngOnInit();
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="download-model"]');
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('Downloading 50%');
  });

  it('progress label falls back to an indeterminate form without total_bytes', () => {
    downloadingModelKey.set('large-v3');
    downloadProgress.set({ model_key: 'large-v3', downloaded_bytes: 50, total_bytes: null });
    expect(component.progressLabel()).toBe('Downloading…');
  });

  it('resumes progress tracking when the backend reports an untracked download', async () => {
    svc.recommendedModel.mockResolvedValueOnce({
      ...notDownloaded,
      live: { ...liveEntry, downloading: true },
    });
    await component.ngOnInit();
    expect(svc.resumeDownloadTracking).toHaveBeenCalledWith('large-v3');
  });

  it('clears stale tracking when the backend no longer reports a download', async () => {
    downloadingModelKey.set('large-v3');
    svc.recommendedModel.mockResolvedValueOnce(downloaded);
    await component.ngOnInit();
    expect(svc.clearDownloadTracking).toHaveBeenCalled();
  });

  it('ngOnInit runs refresh() and refreshPermissions() concurrently, not sequentially', async () => {
    const order: string[] = [];
    svc.recommendedModel.mockImplementationOnce(async () => {
      order.push('recommendedModel:start');
      await new Promise((r) => setTimeout(r, 0));
      order.push('recommendedModel:end');
      return notDownloaded;
    });
    const tauri = TestBed.inject(TauriService);
    vi.spyOn(tauri, 'invoke').mockImplementation(async (cmd: string) => {
      if (cmd === 'get_platform') {
        order.push('get_platform:start');
        await new Promise((r) => setTimeout(r, 0));
        order.push('get_platform:end');
        return platform;
      }
      return undefined;
    });
    await component.ngOnInit();
    expect(order.indexOf('get_platform:start')).toBeGreaterThan(-1);
    expect(order.indexOf('get_platform:start')).toBeLessThan(order.indexOf('recommendedModel:end'));
    expect(order.indexOf('recommendedModel:start')).toBeLessThan(
      order.indexOf('recommendedModel:end')
    );
  });

  it('size() formats GB and MB', () => {
    expect(component.size({ ...liveEntry, size_bytes: 3_100_000_000 })).toBe('2.9 GB');
    expect(component.size({ ...liveEntry, size_bytes: 488_000_000 })).toBe('465.4 MB');
  });

  describe('status line', () => {
    const small: RecommendedModelEntry = {
      key: 'small',
      display_name: 'Small',
      size_bytes: 487_601_967,
      downloaded: true,
      downloading: false,
    };
    const large: RecommendedModelEntry = {
      key: 'large-v3',
      display_name: 'Large v3',
      size_bytes: 1_624_555_275,
      downloaded: true,
      downloading: false,
    };
    const status = (): string =>
      fixture.nativeElement.querySelector('[data-testid="transcription-status"]')?.textContent ??
      '';

    it('says ready when the high-quality model is on disk, with no download button', async () => {
      svc.recommendedModel.mockResolvedValue({
        live: small,
        finalize: large,
        accel_label: 'CPU',
        diarization: diarizationEntry,
        gpu_class: 'none',
      });
      await component.ngOnInit();
      fixture.detectChanges();
      expect(status()).toContain('Ready to record');
      expect(status()).toContain('runs on this machine');
      expect(fixture.nativeElement.querySelector('[data-testid="download-best-model"]')).toBeNull();
    });

    it('says ready with the smaller model and offers the high-quality one', async () => {
      svc.recommendedModel.mockResolvedValue({
        live: small,
        finalize: { ...large, downloaded: false },
        accel_label: 'CPU',
        diarization: diarizationEntry,
        gpu_class: 'none',
      });
      await component.ngOnInit();
      fixture.detectChanges();
      expect(status()).toContain('Ready to record, with the smaller model');
      const btn = fixture.nativeElement.querySelector('[data-testid="download-best-model"]');
      btn.click();
      await fixture.whenStable();
      expect(svc.downloadModel).toHaveBeenCalledWith('large-v3');
    });

    it('says not ready and names the one download when nothing is on disk', async () => {
      await component.ngOnInit();
      fixture.detectChanges();
      expect(status()).toContain('Not ready to record');
      expect(status()).toContain('one download (2.9 GB)');
    });

    it('keeps model names and removal inside the collapsed Technical details', async () => {
      svc.recommendedModel.mockResolvedValue(downloaded);
      await component.ngOnInit();
      fixture.detectChanges();
      const details: HTMLDetailsElement = fixture.nativeElement.querySelector(
        '[data-testid="transcription-technical"]'
      );
      expect(details.open).toBe(false);
      expect(details.querySelector('[data-testid="remove-model"]')).not.toBeNull();
      expect(details.querySelector('[data-testid="accel-label"]')).not.toBeNull();
    });
  });

  describe('live text model', () => {
    const small: RecommendedModelEntry = {
      key: 'small',
      display_name: 'Small',
      size_bytes: 487_601_967,
      downloaded: false,
      downloading: false,
    };
    const large: RecommendedModelEntry = {
      key: 'large-v3',
      display_name: 'Large v3',
      size_bytes: 1_624_555_275,
      downloaded: true,
      downloading: false,
    };

    it('names the extra download live text needs when it is a separate model', async () => {
      svc.recommendedModel.mockResolvedValue({
        live: small,
        finalize: large,
        accel_label: 'CPU',
        diarization: diarizationEntry,
        gpu_class: 'none',
      });
      await component.ngOnInit();
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('needs an extra download (465.0 MB)');
      expect(fixture.nativeElement.querySelector('[data-testid="download-live-model"]')).toBeNull();
    });

    it('offers that download once live text is turned on', async () => {
      svc.recommendedModel.mockResolvedValue({
        live: small,
        finalize: large,
        accel_label: 'CPU',
        diarization: diarizationEntry,
        gpu_class: 'none',
      });
      await component.ngOnInit();
      component.liveTranscript.set(true);
      fixture.detectChanges();
      fixture.nativeElement.querySelector('[data-testid="download-live-model"]').click();
      await fixture.whenStable();
      expect(svc.downloadModel).toHaveBeenCalledWith('small');
    });

    it('asks for no extra download when one model serves both passes', async () => {
      await component.ngOnInit();
      component.liveTranscript.set(true);
      fixture.detectChanges();
      expect(component.liveModel()).toBeNull();
      const liveCard = fixture.nativeElement
        .querySelector('[data-testid="live-transcript-toggle"]')
        .closest('.rounded');
      expect(liveCard.textContent).not.toContain('extra download');
    });
  });

  describe('speaker attribution', () => {
    const q = (id: string): HTMLElement | null =>
      fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
    const toggle = (): HTMLInputElement =>
      fixture.nativeElement.querySelector('[data-testid="speaker-attribution-toggle"]');
    const withDiarization = (
      entry: Partial<RecommendedModelEntry>,
      gpu_class: RecommendedModelAck['gpu_class'] = 'discrete'
    ): RecommendedModelAck => ({
      ...notDownloaded,
      diarization: { ...diarizationEntry, ...entry },
      gpu_class,
    });
    const row = (overrides: Partial<TranscriptSummary>): TranscriptSummary => ({
      id: 'r',
      created_at: '2026-10-19T08:00:00Z',
      title: null,
      language: 'pl',
      source_label: 'System',
      status: { state: 'done' },
      duration_secs: 47 * 60,
      segment_count: 3,
      preview: null,
      size_bytes: 1,
      finalize_model: 'large-v3',
      queued: false,
      diarization_secs: null,
      ...overrides,
    });

    it('sits under While recording, off by default, and saves the choice', async () => {
      await component.ngOnInit();
      fixture.detectChanges();
      const card = q('speaker-attribution');
      expect(card?.textContent).toContain('After you stop');
      expect(card?.textContent).toContain('Tell speakers apart in the meeting audio');
      expect(card?.textContent).toContain('Your microphone stays labelled You');
      expect(component.speakerAttribution()).toBe(false);
      const input = toggle();
      input.checked = true;
      input.dispatchEvent(new Event('change'));
      expect(svc.setSpeakerAttribution).toHaveBeenCalledWith(true);
      expect(component.speakerAttribution()).toBe(true);
    });

    it('reads the stored choice on first paint', async () => {
      svc.speakerAttribution.mockReturnValue(true);
      fixture = TestBed.createComponent(TranscriptionSectionComponent);
      component = fixture.componentInstance;
      await component.ngOnInit();
      expect(component.speakerAttribution()).toBe(true);
    });

    it('asks for the one download only once the mode is on and the model is missing', async () => {
      await component.ngOnInit();
      fixture.detectChanges();
      expect(q('download-diarization-model')).toBeNull();
      component.speakerAttribution.set(true);
      fixture.detectChanges();
      expect(q('speaker-attribution')?.textContent).toContain('Needs one download (102.1 MB)');
      q('download-diarization-model')?.click();
      await fixture.whenStable();
      expect(svc.downloadModel).toHaveBeenCalledWith('nemotron-3-diarization-q8_0');
    });

    it('shows the progress of its own download and disables the button', async () => {
      svc.recommendedModel.mockResolvedValue(withDiarization({ downloading: true }));
      downloadingModelKey.set('nemotron-3-diarization-q8_0');
      downloadProgress.set({
        model_key: 'nemotron-3-diarization-q8_0',
        downloaded_bytes: 53_506_064,
        total_bytes: 107_012_128,
      });
      component.speakerAttribution.set(true);
      await component.ngOnInit();
      fixture.detectChanges();
      const btn = q('download-diarization-model') as HTMLButtonElement;
      expect(btn.textContent).toContain('Downloading 50%');
      expect(btn.disabled).toBe(true);
    });

    it('drops the download row once the model is on disk and offers Remove in Technical details', async () => {
      svc.recommendedModel.mockResolvedValue(withDiarization({ downloaded: true }));
      component.speakerAttribution.set(true);
      await component.ngOnInit();
      fixture.detectChanges();
      expect(q('download-diarization-model')).toBeNull();
      const remove = q('remove-model-diarization');
      expect(remove).not.toBeNull();
      remove?.click();
      await fixture.whenStable();
      expect(svc.deleteModel).toHaveBeenCalledWith('nemotron-3-diarization-q8_0');
    });

    it('keeps the speaker model out of Technical details until it is downloaded', async () => {
      await component.ngOnInit();
      fixture.detectChanges();
      expect(q('model-state-diarization')).toBeNull();
    });

    it('surfaces a failed download as an error and keeps the switch on', async () => {
      svc.downloadModel.mockRejectedValue(new Error('network down'));
      component.speakerAttribution.set(true);
      await component.ngOnInit();
      fixture.detectChanges();
      q('download-diarization-model')?.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(q('transcription-error')?.textContent).toContain('network down');
      expect(component.speakerAttribution()).toBe(true);
    });

    it('gives the measured cost on a Mac whatever the GPU class reports', async () => {
      for (const gpu of ['discrete', 'integrated', 'none'] as const) {
        svc.recommendedModel.mockResolvedValue(withDiarization({}, gpu));
        await component.ngOnInit();
        fixture.detectChanges();
        const hw = q('speaker-hardware');
        expect(hw?.textContent).toContain('adds under a minute per hour of recording');
        expect(hw?.className.includes('text-amber-300')).toBe(false);
      }
    });

    it('says what it costs on each Windows GPU class without a number, warning only without acceleration', async () => {
      platform = 'windows';
      const cases: [RecommendedModelAck['gpu_class'], string, boolean][] = [
        ['discrete', 'Uses your graphics chip: adds some time after each recording.', false],
        [
          'integrated',
          'Uses your integrated graphics: adds some time after each recording.',
          false,
        ],
        ['none', 'no graphics acceleration', true],
      ];
      for (const [gpu, text, warn] of cases) {
        svc.recommendedModel.mockResolvedValue(withDiarization({}, gpu));
        await component.ngOnInit();
        fixture.detectChanges();
        const hw = q('speaker-hardware');
        expect(hw?.textContent).toContain(text);
        expect(hw?.textContent).not.toMatch(/\d/);
        expect(hw?.className.includes('text-amber-300')).toBe(warn);
      }
    });

    it('shows the measured time of the newest diarized recording, and nothing without one', async () => {
      await component.ngOnInit();
      fixture.detectChanges();
      expect(q('speaker-last-run')).toBeNull();
      recordings.set([
        row({ id: 'old', created_at: '2026-10-01T08:00:00Z', diarization_secs: 600 }),
        row({ id: 'new', diarization_secs: 125 }),
        row({ id: 'plain', created_at: '2026-10-20T08:00:00Z' }),
      ]);
      fixture.detectChanges();
      expect(q('speaker-last-run')?.textContent).toContain(
        'Last recording: speakers took 2 min for 47 min of audio.'
      );
    });

    it('lists the gains and the limits under What to expect, collapsed', async () => {
      await component.ngOnInit();
      fixture.detectChanges();
      const details = q('speaker-what-to-expect') as HTMLDetailsElement;
      expect(details.open).toBe(false);
      expect(details.textContent).toContain('can say who said what');
      expect(details.textContent).not.toContain('attributed to the right person');
      expect(details.textContent).toContain(
        'One person can get two labels, and one label can cover two people.'
      );
      expect(details.textContent).toContain('Up to 8 people in the meeting audio');
      expect(details.textContent).toContain('can number the speakers differently');
      expect(q('speaker-extra-cost')?.textContent).toContain(
        'Takes extra time after each recording and one extra download (102.1 MB).'
      );
    });
  });

  it('leaves the recordings and their disk use to the recordings view', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    expect(svc.refreshRecordings).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="transcription-storage"]')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Recordings use');
  });
});
