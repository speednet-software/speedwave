import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LiveTranscriptComponent } from './live-transcript.component';
import { TranscriptionService } from '../../services/transcription.service';
import type { Segment, TranscriptSession } from '../../models/transcript';

function seg(start: number, text: string, speaker: number | null): Segment {
  return {
    start: { secs: start, nanos: 0 },
    end: { secs: start + 1, nanos: 0 },
    text,
    words: [],
    speaker,
  };
}

function session(over: Partial<TranscriptSession> = {}): TranscriptSession {
  return {
    id: 'sess-1',
    created_at: '2026-05-12T00:00:00Z',
    language: 'pl',
    audio_source: { source: { kind: 'system_wide' }, label: 'System', app_id: null },
    status: { state: 'recording' },
    live_segments: [],
    final_segments: null,
    audio_path: '/t/sess-1/audio.wav',
    speaker_names: {},
    models_used: {
      live: null,
      finalize: null,
      diarization_segmentation: null,
      diarization_embedding: null,
    },
    last_seq: 0,
    ...over,
  } as TranscriptSession;
}

describe('LiveTranscriptComponent', () => {
  let component: LiveTranscriptComponent;
  let fixture: ComponentFixture<LiveTranscriptComponent>;
  let svc: {
    relabelSpeaker: ReturnType<typeof vi.fn>;
    sendToChat: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    svc = {
      relabelSpeaker: vi.fn(async () => undefined),
      sendToChat: vi.fn(async () => undefined),
    };
    await TestBed.configureTestingModule({
      imports: [LiveTranscriptComponent],
      providers: [{ provide: TranscriptionService, useValue: svc }],
    }).compileComponents();
    fixture = TestBed.createComponent(LiveTranscriptComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('groups consecutive same-speaker segments into runs', () => {
    fixture.componentRef.setInput(
      'session',
      session({
        live_segments: [seg(0, 'hi', 0), seg(1, 'there', 0), seg(2, 'hello', 1), seg(3, 'back', 0)],
      })
    );
    fixture.detectChanges();
    const runs = component.runs();
    expect(runs.length).toBe(3);
    expect(runs[0].text).toBe('hi there');
    expect(runs[1].speaker).toBe(1);
    expect(runs[2].text).toBe('back');
  });

  it('prefers final_segments over live_segments', () => {
    fixture.componentRef.setInput(
      'session',
      session({ live_segments: [seg(0, 'live', 0)], final_segments: [seg(0, 'final', 0)] })
    );
    fixture.detectChanges();
    expect(component.runs()[0].text).toBe('final');
  });

  it('renders speaker chips with the user-supplied name', () => {
    fixture.componentRef.setInput(
      'session',
      session({ live_segments: [seg(0, 'hi', 0)], speaker_names: { 0: 'Ola' } })
    );
    fixture.detectChanges();
    const chip = fixture.nativeElement.querySelector('[data-testid="speaker-chip-0"]');
    expect(chip.textContent).toContain('Ola');
    // The "approximate" warning marker is present.
    expect(chip.textContent).toContain('⚠');
  });

  it('shows the finalize progress bar while finalizing', () => {
    fixture.componentRef.setInput(
      'session',
      session({ status: { state: 'finalizing', progress: 0.4 } })
    );
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('[data-testid="finalize-bar"]');
    expect(bar).not.toBeNull();
    expect(bar.textContent).toContain('40%');
  });

  it('renames a speaker via a prompt', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Bartek');
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi', 0)] }));
    fixture.detectChanges();
    await component.rename(0);
    expect(svc.relabelSpeaker).toHaveBeenCalledWith('sess-1', 0, 'Bartek');
  });

  it('does not rename when the prompt is cancelled', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi', 0)] }));
    fixture.detectChanges();
    await component.rename(0);
    expect(svc.relabelSpeaker).not.toHaveBeenCalled();
  });

  it('ignores rename for an unassigned speaker', async () => {
    fixture.componentRef.setInput('session', session());
    await component.rename(null);
    expect(svc.relabelSpeaker).not.toHaveBeenCalled();
  });

  it('confirms before sending to Claude', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi', 0)] }));
    fixture.detectChanges();
    await component.sendToClaude();
    expect(confirmSpy).toHaveBeenCalled();
    expect(svc.sendToChat).toHaveBeenCalledWith('sess-1');
  });

  it('does not send to Claude when the confirm is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi', 0)] }));
    fixture.detectChanges();
    await component.sendToClaude();
    expect(svc.sendToChat).not.toHaveBeenCalled();
  });

  it('shows the "sends to your LLM provider" disclaimer', () => {
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi', 0)] }));
    fixture.detectChanges();
    expect((fixture.nativeElement.textContent ?? '').toLowerCase()).toContain(
      'configured llm provider'
    );
  });
});
