import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { MeetingTranscriptionComponent } from './meeting-transcription.component';
import { TranscriptionService } from '../services/transcription.service';
import type { TranscriptSession } from '../models/transcript';

describe('MeetingTranscriptionComponent', () => {
  let component: MeetingTranscriptionComponent;
  let fixture: ComponentFixture<MeetingTranscriptionComponent>;
  let svc: {
    active: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    subscribeToTranscript: ReturnType<typeof vi.fn>;
    recommendedModel: ReturnType<typeof vi.fn>;
    // The child components inject TranscriptionService too; stub the rest.
    getCapabilities: ReturnType<typeof vi.fn>;
    listAudioSources: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    openMicrophonePrivacyPane: ReturnType<typeof vi.fn>;
    openAudioCapturePrivacyPane: ReturnType<typeof vi.fn>;
  };
  const activeSig = signal<TranscriptSession | null>(null);

  const recommended = (downloaded: boolean) => ({
    key: 'large-v3',
    display_name: 'Large v3',
    size_bytes: 3_100_000_000,
    downloaded,
    accel_label: 'CPU',
  });

  beforeEach(async () => {
    activeSig.set(null);
    svc = {
      active: vi.fn(() => activeSig()),
      detach: vi.fn(async () => undefined),
      subscribeToTranscript: vi.fn(async () => ({ event_name: 'e', snapshot: {} as never })),
      recommendedModel: vi.fn(async () => recommended(true)),
      getCapabilities: vi.fn(async () => ({
        capabilities: {
          supports_per_process: true,
          supports_system_audio: true,
          supports_microphone: false,
          note: null,
        },
        backends: ['cpu'],
      })),
      listAudioSources: vi.fn(async () => []),
      listModels: vi.fn(async () => ({ whisper: [], total_bytes_used: 0 })),
      list: vi.fn(async () => []),
      openMicrophonePrivacyPane: vi.fn(async () => undefined),
      openAudioCapturePrivacyPane: vi.fn(async () => undefined),
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
    svc.recommendedModel.mockResolvedValueOnce(recommended(false));
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
    svc.recommendedModel.mockRejectedValueOnce(new Error('boom'));
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.modelReady()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="model-required-gate"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-recording-controls')).not.toBeNull();
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
});
