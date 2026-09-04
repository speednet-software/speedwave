import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { provideRouter, Router } from '@angular/router';
import { LiveTranscriptComponent } from './live-transcript.component';
import { TranscriptionService } from '../../services/transcription.service';
import {
  ChatStateService,
  NEW_CONVERSATION_BUSY,
  NEW_CONVERSATION_STREAMING,
} from '../../services/chat-state.service';
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
    stageForChat: ReturnType<typeof vi.fn>;
    liveDraft: WritableSignal<string>;
    audioLevels: WritableSignal<number[] | null>;
  };
  let chat: {
    hasConversation: WritableSignal<boolean>;
    isStreamingFromState: WritableSignal<boolean>;
    newConversationBlockedReason: WritableSignal<string>;
  };

  beforeEach(async () => {
    svc = {
      stageForChat: vi.fn(async () => undefined),
      liveDraft: signal(''),
      audioLevels: signal<number[] | null>(null),
    };
    chat = {
      hasConversation: signal(false),
      isStreamingFromState: signal(false),
      newConversationBlockedReason: signal(''),
    };
    await TestBed.configureTestingModule({
      imports: [LiveTranscriptComponent],
      providers: [
        { provide: TranscriptionService, useValue: svc },
        { provide: ChatStateService, useValue: chat },
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

  it('stages the transcript without a confirm dialog, then navigates to the chat tab', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const navSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.componentRef.setInput(
      'session',
      session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
    );
    fixture.detectChanges();
    await component.stageForChat();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(svc.stageForChat).toHaveBeenCalledWith('sess-1', 'new-chat');
    expect(navSpy).toHaveBeenCalledWith(['/chat']);
  });

  it('stays on the tab (no navigation) if staging fails', async () => {
    svc.stageForChat.mockRejectedValueOnce(new Error('chat busy'));
    const navSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.componentRef.setInput(
      'session',
      session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
    );
    fixture.detectChanges();
    await component.stageForChat();
    expect(navSpy).not.toHaveBeenCalled();
    expect(component.error()).toBe('chat busy');
  });

  it('labels the two send targets so neither needs an explanation', () => {
    fixture.componentRef.setInput(
      'session',
      session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
    );
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]');
    expect(btn.textContent).toContain('Send to new chat');
    expect(
      fixture.nativeElement.querySelector('[data-testid="append-to-chat-btn"]').textContent
    ).toContain('Add to current chat');
  });

  describe('append to the current chat', () => {
    it('disables both send buttons while the chat is still replying, and says so', () => {
      chat.hasConversation.set(true);
      chat.isStreamingFromState.set(true);
      chat.newConversationBlockedReason.set(NEW_CONVERSATION_STREAMING);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]').disabled).toBe(
        true
      );
      expect(
        fixture.nativeElement.querySelector('[data-testid="append-to-chat-btn"]').disabled
      ).toBe(true);
      expect(component.sendBlockedReason()).toBe(NEW_CONVERSATION_STREAMING);
      expect(component.appendBlockedReason()).toBe(NEW_CONVERSATION_STREAMING);
    });

    it('disables both buttons on a refusal the chat service owns', () => {
      chat.hasConversation.set(true);
      chat.newConversationBlockedReason.set(NEW_CONVERSATION_BUSY);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      expect(component.sendBlockedReason()).toBe(NEW_CONVERSATION_BUSY);
      expect(fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]').disabled).toBe(
        true
      );
    });

    it('disables the append button and carries the reason as its tooltip when no chat is open', () => {
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="append-to-chat-btn"]');
      expect(btn.disabled).toBe(true);
      expect(component.appendBlockedReason()).toBe('No open chat to add to');
      // A disabled button fires no hover or focus events, so the reason must also
      // reach the accessibility tree, not only the tooltip.
      expect(btn.getAttribute('aria-label')).toContain('No open chat to add to');
      expect(
        fixture.debugElement
          .query(By.css('[data-testid="append-to-chat-btn"]'))
          .parent?.injector.get(TooltipDirective)
          .label()
      ).toBe('No open chat to add to');
      // The new-chat path stays available: it does not need an existing conversation.
      expect(component.sendBlockedReason()).toBe('');
      expect(fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]').disabled).toBe(
        false
      );
    });

    it('stages against the current chat when the append button is used', async () => {
      const navSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      chat.hasConversation.set(true);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="append-to-chat-btn"]');
      btn.click();
      await fixture.whenStable();
      expect(svc.stageForChat).toHaveBeenCalledWith('sess-1', 'current-chat');
      expect(navSpy).toHaveBeenCalledWith(['/chat']);
    });
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
    it('disables the send button while recording', () => {
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'recording' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]');
      expect(btn.disabled).toBe(true);
    });

    it('stageForChat is a no-op while the session is still recording', async () => {
      const navSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'recording' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      await component.stageForChat();
      expect(svc.stageForChat).not.toHaveBeenCalled();
      expect(navSpy).not.toHaveBeenCalled();
    });

    it('enables the send button once finalizing completes (status done)', () => {
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]');
      expect(btn.disabled).toBe(false);
    });
  });
  describe('audio level meter + record-only hint', () => {
    it('renders labeled bars for a paired capture, on a dB scale', () => {
      fixture.componentRef.setInput('session', session());
      svc.audioLevels.set([0.1, 0.001]);
      fixture.detectChanges();
      const meter = fixture.nativeElement.querySelector('[data-testid="audio-level-meter"]');
      expect(meter).not.toBeNull();
      expect(meter.textContent).toContain('Meeting');
      expect(meter.textContent).toContain('You');
      const bars = component.meterBars();
      // -20 dBFS ≈ 67%, -60 dBFS floor = 0% — a linear meter would show 10% and 0.1%.
      expect(bars[0].pct).toBeGreaterThan(60);
      expect(bars[0].pct).toBeLessThan(75);
      expect(bars[1].pct).toBe(0);
    });

    it('labels a mono capture from the session source and shows a flat bar before the first level', () => {
      fixture.componentRef.setInput(
        'session',
        session({ audio_source: { source: { kind: 'microphone', device: null }, label: 'Mic' } })
      );
      svc.audioLevels.set([0.05]);
      fixture.detectChanges();
      expect(component.meterBars()).toEqual([{ label: 'You', pct: expect.any(Number) }]);

      // Recording but no level event yet: a flat 0% bar reads "silent",
      // a missing meter reads "broken" — the meter must not disappear.
      svc.audioLevels.set(null);
      fixture.detectChanges();
      expect(component.meterBars()).toEqual([{ label: 'You', pct: 0 }]);
      expect(
        fixture.nativeElement.querySelector('[data-testid="audio-level-meter"]')
      ).not.toBeNull();

      // Not recording → no meter at all.
      fixture.componentRef.setInput(
        'session',
        session({
          status: { state: 'done' },
          audio_source: { source: { kind: 'microphone', device: null }, label: 'Mic' },
        })
      );
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="audio-level-meter"]')).toBeNull();
    });

    it('shows both channels at 0% for a mixed capture before the first level event', () => {
      fixture.componentRef.setInput(
        'session',
        session({ audio_source: { source: { kind: 'mixed', mic: null }, label: 'Meeting' } })
      );
      svc.audioLevels.set(null);
      fixture.detectChanges();
      expect(component.meterBars()).toEqual([
        { label: 'Meeting', pct: 0 },
        { label: 'You', pct: 0 },
      ]);
    });

    it('shows the record-only hint only while recording without a live model', () => {
      // Default fixture: recording, models_used.live = null → record-only.
      fixture.componentRef.setInput('session', session());
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="record-only-hint"]')
      ).not.toBeNull();
      // A live session (live model recorded) shows no hint.
      fixture.componentRef.setInput(
        'session',
        session({ models_used: { live: 'small', finalize: null } })
      );
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="record-only-hint"]')).toBeNull();
      // Neither does a finished record-only session.
      fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="record-only-hint"]')).toBeNull();
    });
  });
});
