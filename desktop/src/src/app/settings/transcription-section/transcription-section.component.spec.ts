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
} from '../../models/transcript';

describe('TranscriptionSectionComponent', () => {
  let component: TranscriptionSectionComponent;
  let fixture: ComponentFixture<TranscriptionSectionComponent>;
  let downloadingModelKey: ReturnType<typeof signal<string | null>>;
  let downloadProgress: ReturnType<typeof signal<DownloadProgress | null>>;
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
    downloadingModelKey: typeof downloadingModelKey;
    downloadProgress: typeof downloadProgress;
  };
  let platform: string;

  const notDownloaded: RecommendedModelAck = {
    key: 'large-v3',
    display_name: 'Large v3 (multilingual)',
    size_bytes: 3_100_000_000,
    downloaded: false,
    downloading: false,
    accel_label: 'Metal (GPU)',
    finalize: null,
  };
  const downloaded: RecommendedModelAck = { ...notDownloaded, downloaded: true };

  beforeEach(async () => {
    downloadingModelKey = signal<string | null>(null);
    downloadProgress = signal<DownloadProgress | null>(null);
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
      downloadingModelKey,
      downloadProgress,
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
        key: 'small',
        display_name: 'Small (multilingual)',
        size_bytes: 487_601_967,
        accel_label: 'CPU',
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
      // The live row is still the one the original test ids point at.
      expect(
        fixture.nativeElement.querySelector('[data-testid="model-state"]').textContent
      ).toContain('Not downloaded');
      expect(fixture.nativeElement.querySelector('[data-testid="download-model"]')).not.toBeNull();
      // The offline model is already on disk, so its row offers removal, not download.
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
      svc.recommendedModel.mockResolvedValue({ ...notDownloaded, key: 'small', finalize });
      downloadingModelKey.set('large-v3-turbo');
      downloadProgress.set({
        model_key: 'large-v3-turbo',
        downloaded_bytes: 50,
        total_bytes: 100,
      });
      await component.ngOnInit();
      fixture.detectChanges();

      expect(component.downloadLabel({ ...notDownloaded, key: 'small' })).toBe('download model');
      expect(component.downloadLabel(finalize)).toBe('downloading 50%');
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
      expect(state.textContent).toContain('Granted');
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
    expect(body).toContain('record system audio');
    expect(body).toContain('locally');
    expect(body).toContain('network');
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
    expect(component.model()?.downloaded).toBe(true);
    expect(component.busy()).toBe(false);
  });

  it('remove() invokes deleteModel then re-reads state', async () => {
    svc.recommendedModel.mockResolvedValueOnce(downloaded);
    await component.ngOnInit();
    svc.recommendedModel.mockResolvedValueOnce(notDownloaded);
    await component.remove('large-v3');
    expect(svc.deleteModel).toHaveBeenCalledWith('large-v3');
    expect(component.model()?.downloaded).toBe(false);
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
    // Regression: navigating away and back must not re-offer the download
    // button while the backend is still writing the model.
    downloadingModelKey.set('large-v3');
    downloadProgress.set({ model_key: 'large-v3', downloaded_bytes: 50, total_bytes: 100 });
    await component.ngOnInit();
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="download-model"]');
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('downloading 50%');
  });

  it('progress label falls back to an indeterminate form without total_bytes', () => {
    downloadingModelKey.set('large-v3');
    downloadProgress.set({ model_key: 'large-v3', downloaded_bytes: 50, total_bytes: null });
    expect(component.progressLabel()).toBe('downloading…');
  });

  it('resumes progress tracking when the backend reports an untracked download', async () => {
    svc.recommendedModel.mockResolvedValueOnce({ ...notDownloaded, downloading: true });
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
    // Both start before either finishes — proves they ran in parallel, not
    // one-after-another. (Index-based: framework CD may re-run the hook.)
    expect(order.indexOf('get_platform:start')).toBeGreaterThan(-1);
    expect(order.indexOf('get_platform:start')).toBeLessThan(order.indexOf('recommendedModel:end'));
    expect(order.indexOf('recommendedModel:start')).toBeLessThan(
      order.indexOf('recommendedModel:end')
    );
  });

  it('size() formats GB and MB', () => {
    expect(component.size({ ...notDownloaded, size_bytes: 3_100_000_000 })).toBe('2.9 GB');
    expect(component.size({ ...notDownloaded, size_bytes: 488_000_000 })).toBe('465.4 MB');
  });
});
