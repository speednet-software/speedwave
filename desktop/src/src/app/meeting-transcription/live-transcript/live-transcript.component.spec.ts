import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LiveTranscriptComponent } from './live-transcript.component';
import { TranscriptionService } from '../../services/transcription.service';
import type { Segment, TranscriptSession } from '../../models/transcript';

function seg(start: number, text: string): Segment {
  return {
    start: { secs: start, nanos: 0 },
    end: { secs: start + 1, nanos: 0 },
    text,
    words: [],
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
    models_used: {
      live: null,
      finalize: null,
    },
    last_seq: 0,
    ...over,
  } as TranscriptSession;
}

describe('LiveTranscriptComponent', () => {
  let component: LiveTranscriptComponent;
  let fixture: ComponentFixture<LiveTranscriptComponent>;
  let svc: {
    sendToChat: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    svc = {
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

  it('renders each segment as a timestamped line', () => {
    fixture.componentRef.setInput(
      'session',
      session({ live_segments: [seg(0, 'hi'), seg(1, 'there')] })
    );
    fixture.detectChanges();
    const lines = component.lines();
    expect(lines.length).toBe(2);
    expect(lines[0].text).toBe('hi');
    expect(lines[0].startLabel).toBe('00:00');
    expect(lines[1].text).toBe('there');
  });

  it('prefers final_segments over live_segments', () => {
    fixture.componentRef.setInput(
      'session',
      session({ live_segments: [seg(0, 'live')], final_segments: [seg(0, 'final')] })
    );
    fixture.detectChanges();
    expect(component.lines()[0].text).toBe('final');
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

  it('confirms before sending to Claude', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi')] }));
    fixture.detectChanges();
    await component.sendToClaude();
    expect(confirmSpy).toHaveBeenCalled();
    expect(svc.sendToChat).toHaveBeenCalledWith('sess-1');
  });

  it('does not send to Claude when the confirm is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi')] }));
    fixture.detectChanges();
    await component.sendToClaude();
    expect(svc.sendToChat).not.toHaveBeenCalled();
  });

  it('shows the "sends to your LLM provider" disclaimer', () => {
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi')] }));
    fixture.detectChanges();
    expect((fixture.nativeElement.textContent ?? '').toLowerCase()).toContain(
      'configured llm provider'
    );
  });
});
