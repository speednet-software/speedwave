import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
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
    audio_source: { source: { kind: 'system_wide' }, label: 'System' },
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
    liveDraft: WritableSignal<string>;
  };

  beforeEach(async () => {
    svc = {
      sendToChat: vi.fn(async () => undefined),
      liveDraft: signal(''),
    };
    await TestBed.configureTestingModule({
      imports: [LiveTranscriptComponent],
      providers: [
        { provide: TranscriptionService, useValue: svc },
        provideRouter([{ path: '**', children: [] }]),
      ],
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

  it('renders the service draft as a muted tail line while recording', () => {
    svc.liveDraft.set('jeszcze niezatwierdzony ogon');
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi')] }));
    fixture.detectChanges();
    const draft = fixture.nativeElement.querySelector('[data-testid="live-draft"]');
    expect(draft).not.toBeNull();
    expect(draft.textContent).toContain('jeszcze niezatwierdzony ogon');
  });

  it('hides the draft once the session leaves the recording state', () => {
    svc.liveDraft.set('stale tail');
    fixture.componentRef.setInput(
      'session',
      session({ status: { state: 'finalizing', progress: 0.1 } })
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="live-draft"]')).toBeNull();
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

  it('confirms, sends, then navigates to the chat tab', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const navSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi')] }));
    fixture.detectChanges();
    await component.sendToChat();
    expect(confirmSpy).toHaveBeenCalled();
    expect(svc.sendToChat).toHaveBeenCalledWith('sess-1');
    expect(navSpy).toHaveBeenCalledWith(['/chat']);
  });

  it('does not send or navigate when the confirm is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const navSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi')] }));
    fixture.detectChanges();
    await component.sendToChat();
    expect(svc.sendToChat).not.toHaveBeenCalled();
    expect(navSpy).not.toHaveBeenCalled();
  });

  it('stays on the tab (no navigation) if sending fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    svc.sendToChat.mockRejectedValueOnce(new Error('chat busy'));
    const navSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi')] }));
    fixture.detectChanges();
    await component.sendToChat();
    expect(navSpy).not.toHaveBeenCalled();
    expect(component.error()).toBe('chat busy');
  });

  it('labels the button "Send to chat" and describes opening the chat', () => {
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hi')] }));
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain('Send to chat');
    expect((fixture.nativeElement.textContent ?? '').toLowerCase()).toContain('chat');
  });
});
