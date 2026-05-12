import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ModelManagerComponent } from './model-manager.component';
import { TranscriptionService } from '../../services/transcription.service';
import type { ModelsAck, ModelStatusEntry } from '../../models/transcript';

function entry(key: string, downloaded: boolean): ModelStatusEntry {
  return {
    key,
    downloaded,
    size_bytes: downloaded ? 79_000_000 : 79_000_000,
    path: downloaded ? `/m/${key}` : null,
  };
}

describe('ModelManagerComponent', () => {
  let component: ModelManagerComponent;
  let fixture: ComponentFixture<ModelManagerComponent>;
  let svc: {
    listModels: ReturnType<typeof vi.fn>;
    downloadModel: ReturnType<typeof vi.fn>;
    deleteModel: ReturnType<typeof vi.fn>;
  };

  const ack: ModelsAck = {
    whisper: [entry('small', true), entry('large-v3', false)],
    diarization: [entry('pyannote-seg', false)],
    total_bytes_used: 79_000_000,
  };

  beforeEach(async () => {
    svc = {
      listModels: vi.fn(async () => ack),
      downloadModel: vi.fn(async () => ({ done: Promise.resolve(), unlisten: () => undefined })),
      deleteModel: vi.fn(async () => undefined),
    };
    await TestBed.configureTestingModule({
      imports: [ModelManagerComponent],
      providers: [{ provide: TranscriptionService, useValue: svc }],
    }).compileComponents();
    fixture = TestBed.createComponent(ModelManagerComponent);
    component = fixture.componentInstance;
  });

  it('lists whisper + diarization models from the backend', async () => {
    await component.ngOnInit();
    expect(svc.listModels).toHaveBeenCalled();
    expect(component.whisper().map((m) => m.key)).toEqual(['small', 'large-v3']);
    expect(component.diarization().map((m) => m.key)).toEqual(['pyannote-seg']);
  });

  it('renders the "uses network" disclaimer line', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    expect((fixture.nativeElement.textContent ?? '').toLowerCase()).toContain('use the network');
  });

  it('downloads a model then refreshes', async () => {
    await component.ngOnInit();
    await component.download('large-v3');
    expect(svc.downloadModel).toHaveBeenCalledWith('large-v3', expect.any(Function));
    // refresh was called again after the download.
    expect(svc.listModels).toHaveBeenCalledTimes(2);
  });

  it('deletes a model then refreshes', async () => {
    await component.ngOnInit();
    await component.delete('small');
    expect(svc.deleteModel).toHaveBeenCalledWith('small');
    expect(svc.listModels).toHaveBeenCalledTimes(2);
  });

  it('surfaces a backend error and emits it', async () => {
    svc.listModels.mockRejectedValueOnce(new Error('disk full'));
    const errSpy = vi.fn();
    component.errorOccurred.subscribe(errSpy);
    await component.ngOnInit();
    expect(component.error()).toBe('disk full');
    expect(errSpy).toHaveBeenCalledWith('disk full');
  });

  it('isDownloading tracks in-flight downloads', () => {
    expect(component.isDownloading('small')).toBe(false);
  });
});
