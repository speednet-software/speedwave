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
    isEnabled: ReturnType<typeof vi.fn>;
    active: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    subscribeToTranscript: ReturnType<typeof vi.fn>;
    // The child components inject TranscriptionService too; stub the rest.
    getCapabilities: ReturnType<typeof vi.fn>;
    listAudioSources: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    openMicrophonePrivacyPane: ReturnType<typeof vi.fn>;
    openAudioCapturePrivacyPane: ReturnType<typeof vi.fn>;
  };
  const activeSig = signal<TranscriptSession | null>(null);

  function build(enabled: boolean | null): void {
    svc = {
      isEnabled: vi.fn(async () =>
        enabled === null ? Promise.reject(new Error('boom')) : enabled
      ),
      active: vi.fn(() => activeSig()),
      detach: vi.fn(async () => undefined),
      subscribeToTranscript: vi.fn(async () => ({ event_name: 'e', snapshot: {} as never })),
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
  }

  beforeEach(() => {
    activeSig.set(null);
  });

  async function mount(enabled: boolean | null): Promise<void> {
    build(enabled);
    await TestBed.configureTestingModule({
      imports: [MeetingTranscriptionComponent],
      providers: [
        { provide: TranscriptionService, useValue: svc },
        provideRouter([{ path: '**', children: [] }]),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MeetingTranscriptionComponent);
    component = fixture.componentInstance;
    await component.ngOnInit();
    fixture.detectChanges();
  }

  it('shows the empty-state with an "Enable in Settings" link when off', async () => {
    await mount(false);
    expect(
      fixture.nativeElement.querySelector('[data-testid="enable-in-settings"]')
    ).not.toBeNull();
    // The recording panes are not shown.
    expect(fixture.nativeElement.querySelector('app-recording-controls')).toBeNull();
  });

  it('shows the recording panes when enabled', async () => {
    await mount(true);
    expect(fixture.nativeElement.querySelector('app-recording-controls')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-live-transcript')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-session-list')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-model-manager')).not.toBeNull();
  });

  it('falls back to the empty-state if the toggle read fails', async () => {
    await mount(null);
    expect(component.enabled()).toBe(false);
  });

  it('shows the "audio local, downloads/send use network" banner text', async () => {
    await mount(true);
    expect((fixture.nativeElement.textContent ?? '').toLowerCase()).toContain(
      'transcribed locally'
    );
  });

  it('subscribes to a session when one is opened', async () => {
    await mount(true);
    await component.onOpenSession({ id: 'sess-1' } as TranscriptSession);
    expect(svc.subscribeToTranscript).toHaveBeenCalledWith('sess-1');
  });

  it('shows the "Open Privacy settings" link on a permission error and wires it', async () => {
    await mount(true);
    component.onError('audio recording permission denied');
    fixture.detectChanges();
    const link = fixture.nativeElement.querySelector('[data-testid="open-mic-settings"]');
    expect(link).not.toBeNull();
    await component.openMicrophoneSettings();
    expect(svc.openMicrophonePrivacyPane).toHaveBeenCalled();
    expect(svc.openAudioCapturePrivacyPane).toHaveBeenCalled();
  });

  it('detaches the live stream on destroy', async () => {
    await mount(true);
    await component.ngOnDestroy();
    expect(svc.detach).toHaveBeenCalled();
  });

  it('re-checks recording readiness when the model list changes', async () => {
    await mount(true);
    // The model-manager re-loads the list once on init; calling onModelsChanged
    // makes the recording-controls re-read it too — listModels gets called again.
    svc.listModels.mockClear();
    component.onModelsChanged();
    await fixture.whenStable();
    expect(svc.listModels).toHaveBeenCalled();
  });
});
