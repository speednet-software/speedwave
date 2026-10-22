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
  NEW_CHAT_TAB_LIMIT,
  NEW_CONVERSATION_BUSY,
  NEW_CONVERSATION_STREAMING,
} from '../../services/chat-state.service';
import { Clipboard } from '@angular/cdk/clipboard';
import type {
  DownloadProgress,
  RecommendedModelEntry,
  Segment,
  TranscriptSummary,
} from '../../models/transcript';
import { makeTranscriptSession as session } from '../../testing/transcript-session';

/**
 * The list row of the session under test.
 * @param overrides - fields to replace.
 */
function row(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
  return {
    id: 'sess-1',
    created_at: '2026-05-12T00:00:00Z',
    title: null,
    language: 'pl',
    source_label: 'System',
    status: { state: 'done' },
    duration_secs: 780,
    segment_count: 1,
    preview: null,
    size_bytes: 12 * 1024 * 1024,
    finalize_model: 'large',
    queued: false,
    ...overrides,
  };
}

/**
 * The high-quality model entry.
 * @param downloaded - whether it is on disk.
 */
function best(downloaded = true): RecommendedModelEntry {
  return {
    key: 'large',
    display_name: 'Large',
    size_bytes: 1_600_000_000,
    downloaded,
    downloading: false,
  };
}

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
    postpone: ReturnType<typeof vi.fn>;
    exportMarkdown: ReturnType<typeof vi.fn>;
    revealAudio: ReturnType<typeof vi.fn>;
    getMarkdown: ReturnType<typeof vi.fn>;
    liveDraft: WritableSignal<string>;
    recordings: WritableSignal<TranscriptSummary[]>;
    highQualityModel: WritableSignal<RecommendedModelEntry | null>;
    downloadingModelKey: WritableSignal<string | null>;
    downloadProgress: WritableSignal<DownloadProgress | null>;
    recording: WritableSignal<boolean>;
    pausedRecording: WritableSignal<TranscriptSummary | null>;
    downloadModel: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    resumeRecording: ReturnType<typeof vi.fn>;
    liveTranscriptPreferred: ReturnType<typeof vi.fn>;
  };
  let chat: {
    hasConversation: WritableSignal<boolean>;
    isStreamingFromState: WritableSignal<boolean>;
    newChatBlockedReason: WritableSignal<string>;
  };

  beforeEach(async () => {
    svc = {
      stageForChat: vi.fn(async () => undefined),
      rename: vi.fn(async (_id: string, title: string) => title.trim() || null),
      transcribe: vi.fn(async () => undefined),
      postpone: vi.fn(async () => undefined),
      exportMarkdown: vi.fn(async () => true),
      revealAudio: vi.fn(async () => undefined),
      getMarkdown: vi.fn(async () => '# Meeting transcript'),
      liveDraft: signal(''),
      recordings: signal<TranscriptSummary[]>([]),
      highQualityModel: signal<RecommendedModelEntry | null>(best()),
      downloadingModelKey: signal<string | null>(null),
      downloadProgress: signal<DownloadProgress | null>(null),
      recording: signal(false),
      pausedRecording: signal<TranscriptSummary | null>(null),
      downloadModel: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      resumeRecording: vi.fn(async () => undefined),
      liveTranscriptPreferred: vi.fn(() => false),
    };
    chat = {
      hasConversation: signal(false),
      isStreamingFromState: signal(false),
      newChatBlockedReason: signal(''),
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

  it('labels diarized meeting segments with their speaker in one colour per number', () => {
    const sys = (start: number, text: string, speaker_id?: number) => ({
      ...seg(start, text),
      source: 'system' as const,
      speaker_id,
    });
    fixture.componentRef.setInput(
      'session',
      session({
        final_segments: [
          sys(0, 'zaczynamy', 1),
          { ...seg(1, 'cześć'), source: 'mic' as const },
          sys(2, 'pytanie', 2),
          sys(3, 'dalej', 1),
          sys(4, 'mhm'),
          sys(5, 'szósty', 6),
        ],
        models_used: { live: null, finalize: 'large-v3', diarization: 'nemotron' },
      })
    );
    fixture.detectChanges();
    const lines = component.lines();
    expect(lines.map((l) => l.speaker)).toEqual([
      'Meeting · Speaker 1',
      'You',
      'Meeting · Speaker 2',
      'Meeting · Speaker 1',
      'Meeting',
      'Meeting · Speaker 6',
    ]);
    expect(lines[0].speakerColor).toBe(lines[3].speakerColor);
    expect(lines[0].speakerColor).not.toBe(lines[2].speakerColor);
    expect(lines[5].speakerColor).toBeNull();
    expect(lines[1].speakerColor).toBeNull();
    expect(lines[4].speakerColor).toBeNull();
    const chips: HTMLElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="line-speaker"]')
    );
    expect(chips[0].textContent?.trim()).toBe('Meeting · Speaker 1');
    expect(chips[0].style.color).toBe('var(--teal)');
    expect(chips[1].style.color).toBe('');
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
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
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
    expect(el.querySelector('[data-testid="append-to-chat-btn"]')).toBeNull();
    component.toggleMenu('chat');
    fixture.detectChanges();
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
      chat.newChatBlockedReason.set(NEW_CONVERSATION_STREAMING);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      component.toggleMenu('chat');
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
      chat.newChatBlockedReason.set(NEW_CONVERSATION_BUSY);
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

    it('disables "Attach to new chat" with the tab-limit reason in its tooltip and stages nothing', async () => {
      chat.hasConversation.set(true);
      chat.newChatBlockedReason.set(NEW_CHAT_TAB_LIMIT);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]');
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('aria-label')).toContain(NEW_CHAT_TAB_LIMIT);
      const tooltip = fixture.debugElement
        .query(By.css('[data-testid="send-to-chat-btn"]'))
        .parent?.injector.get(TooltipDirective)
        .label();
      expect(tooltip).toBe(NEW_CHAT_TAB_LIMIT);
      await component.stageForChat();
      expect(svc.stageForChat).not.toHaveBeenCalled();
      expect(component.appendBlockedReason()).toBe('');
    });

    it('disables the append item and says why under it when no chat is open', () => {
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      component.toggleMenu('chat');
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="append-to-chat-btn"]');
      expect(btn.disabled).toBe(true);
      expect(component.appendBlockedReason()).toBe('No open chat to attach to');
      expect(btn.getAttribute('aria-label')).toContain('No open chat to attach to');
      expect(btn.textContent).toContain('No open chat to attach to');
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
      fixture.nativeElement.querySelector('[data-testid="chat-menu-btn"]').click();
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="append-to-chat-btn"]');
      btn.click();
      await fixture.whenStable();
      expect(svc.stageForChat).toHaveBeenCalledWith('sess-1', 'current-chat');
      expect(navSpy).toHaveBeenCalledWith(['/chat']);
      expect(component.openMenu()).toBeNull();
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
    it('keeps the name but hides the actions while recording or paused', () => {
      for (const status of [{ state: 'recording' }, { state: 'paused' }] as const) {
        fixture.componentRef.setInput(
          'session',
          session({ status, live_segments: [seg(0, 'hi')] })
        );
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[data-testid="send-to-chat-btn"]')).toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="more-btn"]')).toBeNull();
        expect(
          fixture.nativeElement.querySelector('[data-testid="transcript-title"]')
        ).not.toBeNull();
        expect(component.sendBlockedReason()).toBe('Stop the recording first');
      }
    });

    it('blocks both chat actions while the transcript is still being made', () => {
      chat.hasConversation.set(true);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.2 }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      expect(component.sendBlockedReason()).toBe('Available when the transcript is ready.');
      expect(component.appendBlockedReason()).toBe('Available when the transcript is ready.');
      expect(
        fixture.nativeElement.querySelector('[data-testid="chat-privacy-note"]').textContent
      ).toContain('Available when the transcript is ready.');
      expect(fixture.nativeElement.querySelector('[data-testid="copy-btn"]').disabled).toBe(true);
      expect(fixture.nativeElement.querySelector('[data-testid="export-btn"]').disabled).toBe(true);
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
      svc.recordings.set([row({ title: 'Retro', duration_secs: 3900 })]);
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

    it('makes the title itself the rename control, with a pencil and an accessible name', () => {
      fixture.componentRef.setInput(
        'session',
        session({ title: 'Retro', status: { state: 'done' } })
      );
      fixture.detectChanges();
      const btn: HTMLButtonElement = fixture.nativeElement.querySelector(
        '[data-testid="rename-btn"]'
      );
      expect(btn.querySelector('[data-testid="transcript-title"]')!.textContent).toContain('Retro');
      expect(btn.querySelector('app-icon')).not.toBeNull();
      expect(btn.getAttribute('aria-label')).toBe('Rename recording: Retro');
      expect(btn.textContent).not.toContain('Rename');
    });

    it('edits in a field with the save and cancel keys spelled out, and returns focus on Escape', async () => {
      fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
      fixture.detectChanges();
      component.startRename();
      fixture.detectChanges();
      await fixture.whenStable();
      const input: HTMLInputElement = fixture.nativeElement.querySelector(
        '[data-testid="title-input"]'
      );
      expect(document.activeElement).toBe(input);
      const hint = fixture.nativeElement.querySelector('#title-input-hint');
      expect(hint.textContent).toContain('Enter to save');
      expect(hint.textContent).toContain('Esc to cancel');
      expect(input.getAttribute('aria-describedby')).toBe('title-input-hint');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      fixture.detectChanges();
      await fixture.whenStable();
      expect(component.renaming()).toBe(false);
      expect(document.activeElement).toBe(
        fixture.nativeElement.querySelector('[data-testid="rename-btn"]')
      );
      expect(svc.rename).not.toHaveBeenCalled();
    });

    it('saves on blur without pulling focus back to the title', async () => {
      fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
      fixture.detectChanges();
      component.startRename();
      fixture.detectChanges();
      await fixture.whenStable();
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      const input: HTMLInputElement = fixture.nativeElement.querySelector(
        '[data-testid="title-input"]'
      );
      input.value = 'Planning';
      outside.focus();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(svc.rename).toHaveBeenCalledWith('sess-1', 'Planning');
      expect(document.activeElement).toBe(outside);
      outside.remove();
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
      expect((el.querySelector('[data-testid="export-btn"]') as HTMLButtonElement).disabled).toBe(
        true
      );
      expect(el.querySelector('[data-testid="transcript-quality"]')!.textContent).toContain(
        'Not transcribed'
      );
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
    it('says it transcribes N min of audio while the model of the pass is not known', () => {
      svc.recordings.set([
        row({
          status: { state: 'finalizing', progress: 0.1 },
          duration_secs: 45 * 60,
          finalize_model: null,
        }),
      ]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.1 } })
      );
      fixture.detectChanges();
      const quality = fixture.nativeElement.querySelector('[data-testid="transcript-quality"]');
      expect(quality.textContent).toContain('Transcribing 45 min of audio');
      expect(quality.textContent).not.toContain('Re-transcribing');
    });

    it('mentions the model of the pass only when it is the smaller one', () => {
      svc.recordings.set([row({ status: { state: 'finalizing', progress: 0.1 } })]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.1 } })
      );
      fixture.detectChanges();
      expect(component.quality()?.text).toBe('Transcribing 13 min of audio');
      svc.recordings.set([
        row({ status: { state: 'finalizing', progress: 0.1 }, finalize_model: 'small' }),
      ]);
      expect(component.quality()?.text).toBe('Transcribing with the smaller model');
    });

    it('says the recording waits its turn while another pass runs', () => {
      svc.recordings.set([row({ status: { state: 'finalizing', progress: 0 }, queued: true })]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0 } })
      );
      expect(component.quality()?.text).toBe('Waiting for another transcription to finish');
    });

    describe('time estimate', () => {
      let now: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        now = vi.spyOn(Date, 'now').mockReturnValue(0);
      });

      afterEach(() => {
        now.mockRestore();
      });

      const report = (atMs: number, progress: number, id = 'sess-1'): string => {
        now.mockReturnValue(atMs);
        fixture.componentRef.setInput(
          'session',
          session({ id, status: { state: 'finalizing', progress } })
        );
        fixture.detectChanges();
        return component.eta();
      };

      it('estimates the decode time left from the pace so far', () => {
        expect(report(0, 0.05)).toBe('');
        expect(report(60_000, 0.15)).toBe('about 5 min left');
        expect(report(240_000, 0.55)).toBe('less than a minute left');
      });

      it('shows no estimate before the decode has run for a few seconds', () => {
        report(0, 0.05);
        expect(report(2_000, 0.3)).toBe('');
      });

      it('shows no estimate before the decode has moved enough to extrapolate', () => {
        report(0, 0.05);
        expect(report(60_000, 0.09)).toBe('');
      });

      it('anchors on the decode start, not on the wait and the model load before it', () => {
        expect(report(0, 0)).toBe('');
        expect(report(50_000, 0.02)).toBe('');
        expect(report(60_000, 0.05)).toBe('');
        expect(report(120_000, 0.15)).toBe('about 5 min left');
      });

      it('shows nothing while the pass is queued or loading its model', () => {
        expect(report(0, 0)).toBe('');
        expect(report(600_000, 0.04)).toBe('');
      });

      it('follows the pace of the last minutes when a lane with more speech decodes slower', () => {
        report(0, 0.05);
        report(60_000, 0.15);
        expect(report(120_000, 0.25)).toBe('about 4 min left');
        report(180_000, 0.3);
        report(240_000, 0.35);
        expect(report(300_000, 0.4)).toBe('about 4 min left');
        report(360_000, 0.45);
        expect(report(420_000, 0.5)).toBe('about 2 min left');
      });

      it('falls back to the pace since the decode start when the last minutes hold one report', () => {
        report(0, 0.05);
        report(30_000, 0.1);
        expect(report(300_000, 0.3)).toBe('about 6 min left');
      });

      it('falls back to the pace since the decode start when the window spans under half a minute', () => {
        report(0, 0.05);
        report(130_000, 0.3);
        report(131_000, 0.32);
        expect(report(132_000, 0.34)).toBe('about 2 min left');
        expect(report(132_000, 0.36)).toBe('about 2 min left');
      });

      it('names the phase after the decode instead of a time', () => {
        report(0, 0.05);
        report(600_000, 0.55);
        expect(report(660_000, 0.6)).toBe('almost done');
        expect(report(661_000, 0.62)).toBe('telling speakers apart');
        expect(report(900_000, 0.85)).toBe('almost done');
        expect(report(901_000, 0.9)).toBe('almost done');
      });

      it('starts over for another recording', () => {
        report(0, 0.05);
        report(60_000, 0.15);
        expect(report(60_000, 0.15, 'sess-2')).toBe('');
        expect(report(120_000, 0.25, 'sess-2')).toBe('about 4 min left');
      });

      it('drops the track once the pass is over', () => {
        report(0, 0.05);
        report(60_000, 0.15);
        now.mockReturnValue(61_000);
        fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
        fixture.detectChanges();
        expect(component.eta()).toBe('');
        expect(report(120_000, 0.05)).toBe('');
      });
    });
  });

  describe('empty states and announcements', () => {
    it('explains every empty transcript body in one line', () => {
      fixture.detectChanges();
      expect(component.emptyText()).toBe('Open a recording, or press Record to start one.');
      fixture.componentRef.setInput('session', session());
      fixture.detectChanges();
      expect(component.emptyText()).toBe('Recording. The transcript appears after you stop.');
      fixture.componentRef.setInput('session', session({ status: { state: 'paused' } }));
      fixture.detectChanges();
      expect(component.emptyText()).toContain('Paused.');
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.2 } })
      );
      fixture.detectChanges();
      expect(component.emptyText()).toContain('You can start another recording meanwhile.');
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

  describe('transcribe later', () => {
    const q = (id: string): HTMLElement | null =>
      fixture.nativeElement.querySelector(`[data-testid="${id}"]`);

    it('offers Later on a running transcription and puts it off', async () => {
      svc.recordings.set([row({ status: { state: 'finalizing', progress: 0.4 } })]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.4 } })
      );
      fixture.detectChanges();
      expect(component.laterTooltip()).toContain('starts it again from the beginning');
      (q('later-btn') as HTMLButtonElement).click();
      await fixture.whenStable();
      expect(svc.postpone).toHaveBeenCalledWith('sess-1');
      expect(component.working()).toBe(false);
    });

    it('says a queued transcription only leaves the queue', () => {
      svc.recordings.set([row({ status: { state: 'finalizing', progress: 0 }, queued: true })]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0 } })
      );
      fixture.detectChanges();
      expect(q('later-btn')).not.toBeNull();
      expect(component.laterTooltip()).toContain('out of the queue');
    });

    it('reports a refused Later to the parent', async () => {
      svc.postpone.mockRejectedValueOnce(
        new Error('only a recording that is being transcribed can be put off')
      );
      const errors: string[] = [];
      component.errorOccurred.subscribe((e) => errors.push(e));
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.4 } })
      );
      fixture.detectChanges();
      await component.postpone();
      expect(errors).toEqual(['only a recording that is being transcribed can be put off']);
      expect(component.working()).toBe(false);
    });

    it('shows no Later once the transcript is done', () => {
      fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
      fixture.detectChanges();
      expect(q('later-btn')).toBeNull();
    });

    it('treats a put-off recording with live text as a smaller-model transcript', async () => {
      svc.recordings.set([row({ status: { state: 'postponed' }, segment_count: 1 })]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'postponed' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      expect(q('transcript-quality')!.textContent).toContain('Made with a smaller model');
      expect(q('transcript-quality')!.textContent).not.toContain('Not transcribed');
      expect(q('smaller-model-banner')!.textContent).toContain('live text from the recording');
      expect(q('transcribe-btn')).toBeNull();
      expect(q('send-to-chat-btn')!.className).not.toContain('bg-[var(--bg-2)]');
      expect((q('copy-btn') as HTMLButtonElement).disabled).toBe(false);
      expect((q('export-btn') as HTMLButtonElement).disabled).toBe(false);
      const banner = q('banner-transcribe') as HTMLButtonElement;
      expect(banner.textContent!.trim()).toBe('Transcribe');
      banner.click();
      await fixture.whenStable();
      expect(svc.transcribe).toHaveBeenCalledWith('sess-1');
      (q('more-btn') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(q('retranscribe-item')).not.toBeNull();
    });

    it('offers the download for live text while the high-quality model is missing', () => {
      svc.highQualityModel.set(best(false));
      svc.recordings.set([row({ status: { state: 'postponed' }, segment_count: 1 })]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'postponed' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      expect(q('banner-transcribe')).toBeNull();
      expect(q('download-best-model')!.textContent).toContain('Download high-quality model');
    });

    it('makes Transcribe the main action of a put-off recording', async () => {
      svc.recordings.set([row({ status: { state: 'postponed' } })]);
      fixture.componentRef.setInput('session', session({ status: { state: 'postponed' } }));
      fixture.detectChanges();
      expect(q('transcript-quality')!.textContent).toContain('Not transcribed yet');
      expect(q('transcript-empty')!.textContent).toContain('put off');
      expect(q('status-announcement')!.textContent).toContain('Transcription put off');
      expect(q('later-btn')).toBeNull();
      expect(q('finalize-bar')).toBeNull();
      expect(q('send-to-chat-btn')!.className).toContain('bg-[var(--bg-2)]');
      (q('transcribe-btn') as HTMLButtonElement).click();
      await fixture.whenStable();
      expect(svc.transcribe).toHaveBeenCalledWith('sess-1');
      (q('more-btn') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(q('delete-item')).not.toBeNull();
      expect(q('retranscribe-item')).toBeNull();
      expect(q('resume-item')).toBeNull();
    });
  });

  describe('transcript quality', () => {
    it('names no model and adds no label for a good transcript', () => {
      svc.recordings.set([row({ finalize_model: 'large' })]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="transcript-meta"]')!.textContent!.trim()).toBe(
        '13 min · System'
      );
      expect(el.querySelector('[data-testid="transcript-quality"]')).toBeNull();
      expect(el.querySelector('[data-testid="smaller-model-banner"]')).toBeNull();
    });

    it('names no model while the transcript is still being made', () => {
      svc.recordings.set([row({ status: { state: 'finalizing', progress: 0.3 } })]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.3 } })
      );
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="transcript-meta"]').textContent
      ).not.toContain('Large');
    });

    it('says nothing about quality for a recording made before the model was recorded', () => {
      svc.recordings.set([row({ finalize_model: null })]);
      fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="transcript-quality"]')).toBeNull();
    });

    it('offers the download when a smaller model made the transcript', async () => {
      svc.highQualityModel.set(best(false));
      svc.recordings.set([row({ finalize_model: 'small' })]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="transcript-quality"]')!.textContent).toContain(
        'Made with a smaller model'
      );
      expect(el.querySelector('[data-testid="smaller-model-banner"]')!.textContent).toContain(
        'high-quality one was not downloaded'
      );
      const btn = el.querySelector('[data-testid="download-best-model"]') as HTMLButtonElement;
      expect(btn.textContent).toContain('Download high-quality model');
      btn.click();
      await fixture.whenStable();
      expect(svc.downloadModel).toHaveBeenCalledWith('large');
    });

    it('shows the download progress on the banner button', () => {
      svc.highQualityModel.set(best(false));
      svc.downloadingModelKey.set('large');
      svc.downloadProgress.set({ model_key: 'large', downloaded_bytes: 42, total_bytes: 100 });
      svc.recordings.set([row({ finalize_model: 'small' })]);
      fixture.componentRef.setInput('session', session({ status: { state: 'done' } }));
      expect(component.downloadLabel()).toBe('Downloading 42%');
      expect(component.downloadBusy()).toBe(true);
    });

    it('offers Transcribe again once the best model is on disk', async () => {
      svc.recordings.set([row({ finalize_model: 'small' })]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      (
        fixture.nativeElement.querySelector(
          '[data-testid="banner-transcribe"]'
        ) as HTMLButtonElement
      ).click();
      await fixture.whenStable();
      expect(svc.transcribe).toHaveBeenCalledWith('sess-1');
    });

    it('reports a failed download', async () => {
      svc.highQualityModel.set(best(false));
      svc.downloadModel.mockRejectedValueOnce(new Error('offline'));
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      await component.downloadBestModel();
      expect(errSpy).toHaveBeenCalledWith('offline');
    });
  });

  describe('more actions menu', () => {
    beforeEach(() => {
      svc.recordings.set([row()]);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      fixture.nativeElement.querySelector('[data-testid="more-btn"]').click();
      fixture.detectChanges();
    });

    const q = (id: string): HTMLButtonElement | null =>
      fixture.nativeElement.querySelector(`[data-testid="${id}"]`);

    it('lists Transcribe again, Show audio file, Continue recording and Delete', () => {
      expect(q('more-btn')!.getAttribute('aria-expanded')).toBe('true');
      expect(q('retranscribe-item')).not.toBeNull();
      expect(q('reveal-btn')).not.toBeNull();
      expect(q('resume-item')).not.toBeNull();
      expect(q('delete-item')!.textContent).toContain('13 min · 12');
    });

    it('warns that speaker numbers can change only when the transcript has speakers', () => {
      expect(q('retranscribe-item')!.textContent).not.toContain('Speaker numbers');
      fixture.componentRef.setInput(
        'session',
        session({
          status: { state: 'done' },
          live_segments: [seg(0, 'hi')],
          models_used: { live: null, finalize: 'large-v3', diarization: 'nemotron' },
        })
      );
      fixture.detectChanges();
      expect(q('retranscribe-item')!.textContent).toContain('Speaker numbers can change.');
    });

    it('runs Transcribe again on a finished recording and closes the menu', async () => {
      q('retranscribe-item')!.click();
      await fixture.whenStable();
      expect(svc.transcribe).toHaveBeenCalledWith('sess-1');
      expect(component.openMenu()).toBeNull();
    });

    it('continues the recording with the live preference', async () => {
      q('resume-item')!.click();
      await fixture.whenStable();
      expect(svc.resumeRecording).toHaveBeenCalledWith('sess-1', false);
    });

    it('offers no Continue recording while another recording captures or waits paused', () => {
      svc.recording.set(true);
      fixture.detectChanges();
      expect(q('resume-item')).toBeNull();
      svc.recording.set(false);
      svc.pausedRecording.set(row({ id: 'other', status: { state: 'paused' } }));
      fixture.detectChanges();
      expect(q('resume-item')).toBeNull();
    });

    it('deletes only after the confirmation', async () => {
      q('delete-item')!.click();
      fixture.detectChanges();
      expect(svc.delete).not.toHaveBeenCalled();
      const confirm = fixture.nativeElement.querySelector('[data-testid="delete-confirm"]');
      expect(confirm.textContent).toContain('This cannot be undone.');
      q('delete-no')!.click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="delete-confirm"]')).toBeNull();

      component.askDelete();
      fixture.detectChanges();
      q('delete-yes')!.click();
      await fixture.whenStable();
      expect(svc.delete).toHaveBeenCalledWith('sess-1');
    });

    it('reports a refused delete and keeps the confirmation', async () => {
      svc.delete.mockRejectedValueOnce(new Error('in use'));
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      component.askDelete();
      await component.remove();
      expect(errSpy).toHaveBeenCalledWith('in use');
      expect(component.confirmingDelete()).toBe(true);
    });

    it('closes on Escape and on a click outside, not on a click inside', () => {
      const inside = q('reveal-btn')!;
      component.onDocumentClick({ target: inside } as unknown as MouseEvent);
      expect(component.openMenu()).toBe('more');
      component.onDocumentClick({ target: document.body } as unknown as MouseEvent);
      expect(component.openMenu()).toBeNull();
      component.toggleMenu('more');
      component.closeMenus();
      expect(component.openMenu()).toBeNull();
    });

    it('drops an open menu and a pending delete when another recording opens', () => {
      component.askDelete();
      fixture.componentRef.setInput(
        'session',
        session({ id: 'sess-2', status: { state: 'done' } })
      );
      fixture.detectChanges();
      expect(component.confirmingDelete()).toBe(false);
      expect(component.openMenu()).toBeNull();
    });

    it('offers no Delete while the recording is being transcribed', () => {
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'finalizing', progress: 0.2 } })
      );
      component.openMenu.set('more');
      fixture.detectChanges();
      expect(q('reveal-btn')).not.toBeNull();
      expect(q('delete-item')).toBeNull();
      expect(q('retranscribe-item')).toBeNull();
    });
  });
});
