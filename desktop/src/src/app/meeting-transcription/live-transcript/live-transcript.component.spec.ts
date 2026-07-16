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

  it('labels channel-tagged segments and sorts lines chronologically', () => {
    const sys = { ...seg(2, 'ze spotkania'), source: 'system' as const };
    const mic = { ...seg(0, 'moja wypowiedź'), source: 'mic' as const };
    // Mic committed after system (per-lane cycles append out of order).
    fixture.componentRef.setInput('session', session({ live_segments: [sys, mic] }));
    fixture.detectChanges();
    const lines = component.lines();
    expect(lines[0].text).toBe('moja wypowiedź');
    expect(lines[0].speaker).toBe('You');
    expect(lines[1].speaker).toBe('Meeting');
    const chips = fixture.nativeElement.querySelectorAll('[data-testid="line-speaker"]');
    expect(chips.length).toBe(2);
    expect(chips[0].textContent).toContain('You');
  });

  it('sorts a copy, never mutating the session segment array', () => {
    const segs = [seg(2, 'later'), seg(0, 'earlier')];
    fixture.componentRef.setInput('session', session({ live_segments: segs }));
    fixture.detectChanges();
    expect(component.lines().map((l) => l.text)).toEqual(['earlier', 'later']);
    expect(segs.map((s) => s.text)).toEqual(['later', 'earlier']);
  });

  it('keeps append order for segments sharing a start time (stable sort)', () => {
    const first = { ...seg(1, 'system first'), source: 'system' as const };
    const second = { ...seg(1, 'mic second'), source: 'mic' as const };
    fixture.componentRef.setInput('session', session({ live_segments: [first, second] }));
    fixture.detectChanges();
    expect(component.lines().map((l) => l.text)).toEqual(['system first', 'mic second']);
  });

  it('renders untagged segments without a speaker chip', () => {
    fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'hej')] }));
    fixture.detectChanges();
    expect(component.lines()[0].speaker).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="line-speaker"]')).toBeNull();
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
    fixture.componentRef.setInput(
      'session',
      session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
    );
    fixture.detectChanges();
    await component.sendToChat();
    expect(confirmSpy).toHaveBeenCalled();
    expect(svc.sendToChat).toHaveBeenCalledWith('sess-1');
    expect(navSpy).toHaveBeenCalledWith(['/chat']);
  });

  it('does not send or navigate when the confirm is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const navSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.componentRef.setInput(
      'session',
      session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
    );
    fixture.detectChanges();
    await component.sendToChat();
    expect(svc.sendToChat).not.toHaveBeenCalled();
    expect(navSpy).not.toHaveBeenCalled();
  });

  it('stays on the tab (no navigation) if sending fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    svc.sendToChat.mockRejectedValueOnce(new Error('chat busy'));
    const navSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.componentRef.setInput(
      'session',
      session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
    );
    fixture.detectChanges();
    await component.sendToChat();
    expect(navSpy).not.toHaveBeenCalled();
    expect(component.error()).toBe('chat busy');
  });

  it('labels the button "Send to chat" and describes opening the chat', () => {
    fixture.componentRef.setInput(
      'session',
      session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
    );
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain('Send to chat');
    expect((fixture.nativeElement.textContent ?? '').toLowerCase()).toContain('chat');
  });

  describe('auto-scroll', () => {
    /**
     * The scrollable body element, with jsdom-stubbed scroll metrics.
     * @param scrollTop - simulated scroll position (scrollHeight 1000, clientHeight 200)
     */
    function bodyEl(scrollTop: number): HTMLElement {
      const el = fixture.nativeElement.querySelector('[data-testid="transcript-body"]');
      Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
      el.scrollTop = scrollTop;
      return el;
    }
    function scrollSpy() {
      return vi.spyOn(component as unknown as { scrollToBottom(): void }, 'scrollToBottom');
    }

    it('follows new lines while recording', () => {
      const spy = scrollSpy();
      fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'a')] }));
      fixture.detectChanges();
      expect(spy).toHaveBeenCalled();
      spy.mockClear();
      fixture.componentRef.setInput(
        'session',
        session({ live_segments: [seg(0, 'a'), seg(1, 'b')] })
      );
      fixture.detectChanges();
      expect(spy).toHaveBeenCalled();
    });

    it('follows draft updates while recording', () => {
      fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'a')] }));
      fixture.detectChanges();
      const spy = scrollSpy();
      svc.liveDraft.set('tail in progress');
      fixture.detectChanges();
      expect(spy).toHaveBeenCalled();
    });

    it('stops following once the user scrolls up, and re-arms at the bottom', () => {
      fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'a')] }));
      fixture.detectChanges();
      const el = bodyEl(100); // 1000 - 100 - 200 = 700 from the bottom
      el.dispatchEvent(new Event('scroll'));
      const spy = scrollSpy();
      fixture.componentRef.setInput(
        'session',
        session({ live_segments: [seg(0, 'a'), seg(1, 'b')] })
      );
      fixture.detectChanges();
      expect(spy).not.toHaveBeenCalled();

      el.scrollTop = 790; // 1000 - 790 - 200 = 10 → within the 50 px re-arm band
      el.dispatchEvent(new Event('scroll'));
      fixture.componentRef.setInput(
        'session',
        session({ live_segments: [seg(0, 'a'), seg(1, 'b'), seg(2, 'c')] })
      );
      fixture.detectChanges();
      expect(spy).toHaveBeenCalled();
    });

    it('does not auto-scroll a finished session', () => {
      const spy = scrollSpy();
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'a')] })
      );
      fixture.detectChanges();
      expect(spy).not.toHaveBeenCalled();
    });

    it('resets to the top when opening a finished session', () => {
      fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'a')] }));
      fixture.detectChanges();
      const topSpy = vi.spyOn(component as unknown as { scrollToTop(): void }, 'scrollToTop');
      fixture.componentRef.setInput(
        'session',
        session({ id: 'sess-9', status: { state: 'done' }, live_segments: [seg(0, 'x')] })
      );
      fixture.detectChanges();
      expect(topSpy).toHaveBeenCalled();
    });

    it('re-arms the bottom pin when switching to a different session', () => {
      fixture.componentRef.setInput('session', session({ live_segments: [seg(0, 'a')] }));
      fixture.detectChanges();
      const el = bodyEl(100);
      el.dispatchEvent(new Event('scroll')); // user reads older lines
      const spy = scrollSpy();
      fixture.componentRef.setInput(
        'session',
        session({ id: 'sess-2', live_segments: [seg(0, 'x')] })
      );
      fixture.detectChanges();
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('recording gate', () => {
    it('disables the Send to chat button while recording', () => {
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'recording' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]');
      expect(btn.disabled).toBe(true);
    });

    it('sendToChat is a no-op while the session is still recording', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const navSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'recording' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      await component.sendToChat();
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(svc.sendToChat).not.toHaveBeenCalled();
      expect(navSpy).not.toHaveBeenCalled();
    });

    it('enables Send to chat once finalizing completes (status done)', () => {
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]');
      expect(btn.disabled).toBe(false);
    });
  });
});
