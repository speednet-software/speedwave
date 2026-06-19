import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranscriptionSectionComponent } from './transcription-section.component';
import { TranscriptionService } from '../../services/transcription.service';
import type { ModelsAck, TranscriptionConfig } from '../../models/transcript';

describe('TranscriptionSectionComponent', () => {
  let component: TranscriptionSectionComponent;
  let fixture: ComponentFixture<TranscriptionSectionComponent>;
  let svc: {
    getConfig: ReturnType<typeof vi.fn>;
    setConfig: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
  };

  const offConfig: TranscriptionConfig = {
    enabled: false,
    default_language: null,
    default_live_model: null,
    keep_audio_after_finalize: null,
  };
  const models: ModelsAck = {
    whisper: [
      { key: 'small', downloaded: true, size_bytes: 79_000_000, path: '/m/small' },
      { key: 'large-v3', downloaded: false, size_bytes: 2_900_000_000, path: null },
    ],
    total_bytes_used: 79_000_000,
  };

  beforeEach(async () => {
    svc = {
      getConfig: vi.fn(async () => offConfig),
      setConfig: vi.fn(async () => undefined),
      listModels: vi.fn(async () => models),
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

  it('shows the privacy disclaimer text', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    const body: string = fixture.nativeElement.textContent ?? '';
    expect(body).toContain('record system audio');
    expect(body).toContain('runs locally');
    expect(body).toContain('use the');
  });

  it('reads the config; off by default → no extra controls', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.enabled()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="default-language"]')).toBeNull();
  });

  it('toggling on shows the default-language / default-live-model / keep-audio controls', async () => {
    await component.ngOnInit();
    await component.toggle();
    fixture.detectChanges();
    expect(component.enabled()).toBe(true);
    expect(svc.setConfig).toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="default-language"]')).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="default-live-model"]')
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="keep-audio"]')).not.toBeNull();
    // The live-model dropdown is populated from the model list.
    expect(component.liveModelOptions().map((m) => m.key)).toEqual(['small', 'large-v3']);
  });

  it('persists the default language', async () => {
    svc.getConfig.mockResolvedValueOnce({ ...offConfig, enabled: true });
    await component.ngOnInit();
    await component.onLanguage('en');
    expect(component.defaultLanguage()).toBe('en');
    expect(svc.setConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ default_language: 'en' })
    );
  });

  it('persists the default live model ("" → null)', async () => {
    svc.getConfig.mockResolvedValueOnce({ ...offConfig, enabled: true });
    await component.ngOnInit();
    await component.onLiveModel('large-v3');
    expect(svc.setConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ default_live_model: 'large-v3' })
    );
    await component.onLiveModel('');
    expect(svc.setConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ default_live_model: null })
    );
  });

  it('persists the keep-audio toggle', async () => {
    svc.getConfig.mockResolvedValueOnce({ ...offConfig, enabled: true });
    await component.ngOnInit();
    await component.onKeepAudio(false);
    expect(svc.setConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ keep_audio_after_finalize: false })
    );
  });

  it('reflects an existing config (language/model/keep-audio loaded from backend)', async () => {
    svc.getConfig.mockResolvedValueOnce({
      enabled: true,
      default_language: 'en',
      default_live_model: 'small',
      keep_audio_after_finalize: false,
    });
    await component.ngOnInit();
    expect(component.defaultLanguage()).toBe('en');
    expect(component.defaultLiveModel()).toBe('small');
    expect(component.keepAudio()).toBe(false);
  });

  it('falls back to off and emits the error when the backend fails', async () => {
    svc.getConfig.mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.fn();
    component.errorOccurred.subscribe(errSpy);
    await component.ngOnInit();
    expect(component.enabled()).toBe(false);
    expect(errSpy).toHaveBeenCalledWith('boom');
  });

  it('onLanguage ignores invalid values', async () => {
    svc.getConfig.mockResolvedValueOnce({ ...offConfig, enabled: true });
    await component.ngOnInit();
    svc.setConfig.mockClear();
    await component.onLanguage('de');
    expect(component.defaultLanguage()).toBe('pl');
    expect(svc.setConfig).not.toHaveBeenCalled();
  });
});
