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
import { Clipboard } from '@angular/cdk/clipboard';
import type { Segment, TranscriptSummary } from '../../models/transcript';
import { makeTranscriptSession as session } from '../../testing/transcript-session';

function seg(start: number, text: string): Segment {
  return {
    start: { secs: start, nanos: 0 },
    end: { secs: start + 1, nanos: 0 },
    text,
    words: [],
  };
}

describe('LiveTranscriptComponent', () => {
  let component: LiveTranscriptComponent;
  let fixture: ComponentFixture<LiveTranscriptComponent>;
  let svc: {
    stageForChat: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    transcribe: ReturnType<typeof vi.fn>;
    exportMarkdown: ReturnType<typeof vi.fn>;
    revealAudio: ReturnType<typeof vi.fn>;
    getMarkdown: ReturnType<typeof vi.fn>;
    liveDraft: WritableSignal<string>;
    recordings: WritableSignal<TranscriptSummary[]>;
  };
  let chat: {
    hasConversation: WritableSignal<boolean>;
    isStreamingFromState: WritableSignal<boolean>;
    newConversationBlockedReason: WritableSignal<string>;
  };

  beforeEach(async () => {
    svc = {
      stageForChat: vi.fn(async () => undefined),
      rename: vi.fn(async (_id: string, title: string) => title.trim() || null),
      transcribe: vi.fn(async () => undefined),
      exportMarkdown: vi.fn(async () => true),
      revealAudio: vi.fn(async () => undefined),
      getMarkdown: vi.fn(async () => '# Meeting transcript'),
      liveDraft: signal(''),
      recordings: signal<TranscriptSummary[]>([]),
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

  it('stays on the tab (no navigation) if staging fails, and reports why', async () => {
    svc.stageForChat.mockRejectedValueOnce(new Error('chat busy'));
    const navSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const errSpy = vi.fn();
    component.errorOccurred.subscribe(errSpy);
    fixture.componentRef.setInput(
      'session',
      session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
    );
    fixture.detectChanges();
    await component.stageForChat();
    expect(navSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('chat busy');
    expect(component.sending()).toBe(false);
  });

  it('labels the chat actions by what they do and says nothing is sent yet', () => {
    fixture.componentRef.setInput(
      'session',
      session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
    );
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="send-to-chat-btn"]')!.textContent).toContain(
      'Attach to new chat'
    );
    expect(el.querySelector('[data-testid="append-to-chat-btn"]')!.textContent).toContain(
      'Attach to current chat'
    );
    expect(el.querySelector('[data-testid="chat-privacy-note"]')!.textContent).toContain(
      'Nothing is sent until you press Send.'
    );
    expect(el.textContent).not.toContain('Send to new chat');
    const tooltip = fixture.debugElement
      .query(By.css('[data-testid="send-to-chat-btn"]'))
      .parent?.injector.get(TooltipDirective)
      .label();
    expect(tooltip).toContain('Nothing is sent until you press Send.');
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
      expect(component.appendBlockedReason()).toBe('No open chat to attach to');
      expect(btn.getAttribute('aria-label')).toContain('No open chat to attach to');
      expect(
        fixture.debugElement
          .query(By.css('[data-testid="append-to-chat-btn"]'))
          .parent?.injector.get(TooltipDirective)
          .label()
      ).toBe('No open chat to attach to');
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
      const el = bodyEl(100);
      el.dispatchEvent(new Event('scroll'));
      const spy = scrollSpy();
      fixture.componentRef.setInput(
        'session',
        session({ live_segments: [seg(0, 'a'), seg(1, 'b')] })
      );
      fixture.detectChanges();
      expect(spy).not.toHaveBeenCalled();

      el.scrollTop = 790;
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
      el.dispatchEvent(new Event('scroll'));
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
    it('hides the chat actions and the header while recording', () => {
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'recording' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="transcript-header"]')).toBeNull();
      expect(component.sendBlockedReason()).toBe('Stop the recording first');
    });

    it('blocks both chat actions while the transcript is still being made', () => {
      chat.hasConversation.set(true);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.2 }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      expect(component.sendBlockedReason()).toBe('Wait until the transcript is ready');
      expect(component.appendBlockedReason()).toBe('Wait until the transcript is ready');
    });

    it('blocks both chat actions for a recording with no transcript text', () => {
      chat.hasConversation.set(true);
      fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
      fixture.detectChanges();
      expect(component.sendBlockedReason()).toBe('This recording has no transcript yet');
      expect(component.appendBlockedReason()).toBe('This recording has no transcript yet');
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
  describe('header', () => {
    it('names the recording by its title and lists its length and source', () => {
      svc.recordings.set([
        {
          id: 'sess-1',
          created_at: '2026-05-12T00:00:00Z',
          title: 'Retro',
          language: 'pl',
          source_label: 'System',
          status: { state: 'done' },
          duration_secs: 3900,
          segment_count: 1,
          preview: null,
          size_bytes: 1,
        },
      ]);
      fixture.componentRef.setInput(
        'session',
        session({ title: 'Retro', status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="transcript-title"]')!.textContent).toContain('Retro');
      const meta = el.querySelector('[data-testid="transcript-meta"]')!.textContent!;
      expect(meta).toContain('1 h 05 min');
      expect(meta).toContain('System');
    });

    it('falls back to the local start time, never the raw UTC string', () => {
      fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
      fixture.detectChanges();
      const title = fixture.nativeElement.querySelector('[data-testid="transcript-title"]');
      expect(title.textContent).not.toContain('T00:00:00Z');
    });

    it('renames on Enter and keeps the old name on Escape', async () => {
      fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
      fixture.detectChanges();
      fixture.nativeElement.querySelector('[data-testid="rename-btn"]').click();
      fixture.detectChanges();
      const input: HTMLInputElement = fixture.nativeElement.querySelector(
        '[data-testid="title-input"]'
      );
      input.value = 'Planning';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await fixture.whenStable();
      expect(svc.rename).toHaveBeenCalledWith('sess-1', 'Planning');
      expect(component.renaming()).toBe(false);

      component.startRename();
      fixture.detectChanges();
      fixture.nativeElement
        .querySelector('[data-testid="title-input"]')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      fixture.detectChanges();
      expect(component.renaming()).toBe(false);
      expect(svc.rename).toHaveBeenCalledTimes(1);
    });

    it('skips the backend when the title did not change, and reports a refused rename', async () => {
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      fixture.componentRef.setInput(
        'session',
        session({ title: 'Same', status: { state: 'done' } })
      );
      component.renaming.set(true);
      await component.saveTitle('Same ');
      expect(svc.rename).not.toHaveBeenCalled();

      svc.rename.mockRejectedValueOnce(new Error('disk full'));
      component.renaming.set(true);
      await component.saveTitle('New');
      expect(errSpy).toHaveBeenCalledWith('disk full');
    });

    it('offers Transcribe and the failure reason for a failed recording', async () => {
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'failed', reason: 'interrupted: Speedwave closed' } })
      );
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="failure-reason"]')!.textContent).toContain(
        'interrupted: Speedwave closed'
      );
      expect(el.querySelector('[data-testid="export-btn"]')).toBeNull();
      (el.querySelector('[data-testid="transcribe-btn"]') as HTMLButtonElement).click();
      await fixture.whenStable();
      expect(svc.transcribe).toHaveBeenCalledWith('sess-1');
      expect(component.working()).toBe(false);
    });

    it('reports a refused transcribe', async () => {
      svc.transcribe.mockRejectedValueOnce(new Error('no Whisper model'));
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'failed', reason: 'x' } })
      );
      await component.transcribe();
      expect(errSpy).toHaveBeenCalledWith('no Whisper model');
    });

    it('exports, copies and reveals a finished transcript', async () => {
      const copy = vi.spyOn(TestBed.inject(Clipboard), 'copy').mockReturnValue(true);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      await component.exportMarkdown();
      expect(svc.exportMarkdown).toHaveBeenCalledWith('sess-1');
      await component.copyMarkdown();
      expect(copy).toHaveBeenCalledWith('# Meeting transcript');
      expect(component.copied()).toBe(true);
      await component.revealAudio();
      expect(svc.revealAudio).toHaveBeenCalledWith('sess-1');
    });

    it('reports a clipboard that refuses the copy', async () => {
      vi.spyOn(TestBed.inject(Clipboard), 'copy').mockReturnValue(false);
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
      await component.copyMarkdown();
      expect(errSpy).toHaveBeenCalledWith('could not copy the transcript to the clipboard');
      expect(component.copied()).toBe(false);
    });
  });

  describe('transcription progress', () => {
    it('says it transcribes N min of audio for a recording made without live text', () => {
      svc.recordings.set([
        {
          id: 'sess-1',
          created_at: '2026-05-12T00:00:00Z',
          title: null,
          language: 'pl',
          source_label: 'System',
          status: { state: 'finalizing', progress: 0.1 },
          duration_secs: 45 * 60,
          segment_count: 0,
          preview: null,
          size_bytes: 1,
        },
      ]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.1 } })
      );
      fixture.detectChanges();
      const bar = fixture.nativeElement.querySelector('[data-testid="finalize-bar"]');
      expect(bar.textContent).toContain('Transcribing 45 min of audio');
      expect(bar.textContent).not.toContain('Re-transcribing');
    });

    it('says it re-transcribes when live text was shown', () => {
      fixture.componentRef.setInput(
        'session',
        session({
          status: { state: 'finalizing', progress: 0.1 },
          models_used: { live: 'small', finalize: null },
        })
      );
      fixture.detectChanges();
      expect(component.finalizeLabel()).toBe('Re-transcribing with the higher-quality model');
    });

    it('estimates the time left from the pace so far', () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(0);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.05 } })
      );
      fixture.detectChanges();
      expect(component.eta()).toBe('');

      now.mockReturnValue(60_000);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.15 } })
      );
      fixture.detectChanges();
      expect(component.eta()).toBe('about 5 min left');

      now.mockReturnValue(240_000);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.55 } })
      );
      fixture.detectChanges();
      expect(component.eta()).toBe('less than a minute left');
      now.mockRestore();
    });

    it('shows no estimate before the pass has moved enough to extrapolate', () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(0);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.05 } })
      );
      fixture.detectChanges();
      now.mockReturnValue(2_000);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.3 } })
      );
      fixture.detectChanges();
      expect(component.eta()).toBe('');
      now.mockRestore();
    });
  });

  describe('empty states and announcements', () => {
    it('explains every empty transcript body in one line', () => {
      fixture.detectChanges();
      expect(component.emptyText()).toBe('Open a recording, or start a new one.');
      fixture.componentRef.setInput('session', session());
      fixture.detectChanges();
      expect(component.emptyText()).toBe('');
      fixture.componentRef.setInput(
        'session',
        session({ models_used: { live: 'small', finalize: null } })
      );
      fixture.detectChanges();
      expect(component.emptyText()).toBe('Listening…');
      fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
      fixture.detectChanges();
      expect(component.emptyText()).toBe('No speech was recognized in this recording.');
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'failed', reason: 'x' } })
      );
      fixture.detectChanges();
      expect(component.emptyText()).toContain('Transcribe runs it again');
    });

    it('announces state changes to screen readers through a polite live region', () => {
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.5 } })
      );
      fixture.detectChanges();
      const region = fixture.nativeElement.querySelector('[data-testid="status-announcement"]');
      expect(region.getAttribute('aria-live')).toBe('polite');
      expect(region.textContent).toContain('Transcribing');
      fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
      fixture.detectChanges();
      expect(region.textContent).toContain('Transcript ready');
    });
  });
});
