import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranscriptionSectionComponent } from './transcription-section.component';
import { TranscriptionService } from '../../services/transcription.service';
import type { DownloadProgress, RecommendedModelAck } from '../../models/transcript';

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
    downloadingModelKey: typeof downloadingModelKey;
    downloadProgress: typeof downloadProgress;
  };

  const notDownloaded: RecommendedModelAck = {
    key: 'large-v3',
    display_name: 'Large v3 (multilingual)',
    size_bytes: 3_100_000_000,
    downloaded: false,
    downloading: false,
    accel_label: 'Metal (GPU)',
  };
  const downloaded: RecommendedModelAck = { ...notDownloaded, downloaded: true };

  beforeEach(async () => {
    downloadingModelKey = signal<string | null>(null);
    downloadProgress = signal<DownloadProgress | null>(null);
    svc = {
      recommendedModel: vi.fn(async () => notDownloaded),
      downloadModel: vi.fn(async () => undefined),
      deleteModel: vi.fn(async () => undefined),
      resumeDownloadTracking: vi.fn(async () => undefined),
      clearDownloadTracking: vi.fn(() => undefined),
      downloadingModelKey,
      downloadProgress,
    };
    await TestBed.configureTestingModule({
      imports: [TranscriptionSectionComponent],
      providers: [
        { provide: TranscriptionService, useValue: svc },
        provideRouter([{ path: '**', children: [] }]),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(TranscriptionSectionComponent);
    component = fixture.componentInstance;
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

  it('size() formats GB and MB', () => {
    expect(component.size({ ...notDownloaded, size_bytes: 3_100_000_000 })).toBe('2.9 GB');
    expect(component.size({ ...notDownloaded, size_bytes: 488_000_000 })).toBe('465.4 MB');
  });
});
