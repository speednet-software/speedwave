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
  AudioSource,
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
    speakerAttribution: ReturnType<typeof vi.fn>;
    renameSpeaker: ReturnType<typeof vi.fn>;
    yourName: ReturnType<typeof vi.fn>;
    setYourName: ReturnType<typeof vi.fn>;
    yourNameAsked: ReturnType<typeof vi.fn>;
    markYourNameAsked: ReturnType<typeof vi.fn>;
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
      speakerAttribution: vi.fn(() => false),
      renameSpeaker: vi.fn(async (_id: string, _n: number, name: string) => name.trim() || null),
      yourName: vi.fn(() => ''),
      setYourName: vi.fn((name: string) => name.trim()),
      yourNameAsked: vi.fn(() => false),
      markYourNameAsked: vi.fn(),
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
        status: { state: 'done' },
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
      'Speaker 1',
      'You',
      'Speaker 2',
      'Speaker 1',
      'Meeting',
      'Speaker 6',
    ]);
    expect(lines.map((l) => l.diarized?.id ?? null)).toEqual([1, null, 2, 1, null, 6]);
    expect(lines[0].diarized).toEqual(lines[3].diarized);
    expect(lines[0].diarized?.color).not.toBe(lines[2].diarized?.color);
    expect(lines[5].diarized).toMatchObject({ color: null, mark: '6' });
    expect(lines[1].diarized).toBeNull();
    const chips: HTMLElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="line-speaker"]')
    );
    expect(chips[0].textContent?.trim()).toBe('Speaker 1');
    expect(chips[0].tagName).toBe('BUTTON');
    expect(chips[1].tagName).toBe('SPAN');
    expect(chips[4].tagName).toBe('SPAN');
    expect(chips[0].className).toContain('text-[var(--ink-dim)]');
    const dots: HTMLElement[] = Array.from(
      fixture.nativeElement.querySelectorAll(
        '[data-testid="transcript-body"] [data-testid="speaker-dot"]'
      )
    );
    expect(dots.map((d) => d.style.backgroundColor)).toEqual([
      'var(--teal)',
      'var(--violet)',
      'var(--teal)',
    ]);
    expect(chips[5].querySelector('[data-testid="speaker-circle"]')!.textContent).toBe('6');
  });

  it('labels diarized segments without a channel as Speaker N in their colour', () => {
    const untagged = (start: number, text: string, speaker_id?: number) => ({
      ...seg(start, text),
      speaker_id,
    });
    fixture.componentRef.setInput(
      'session',
      session({
        audio_source: { source: { kind: 'imported_file' }, label: 'Imported file: sync.m4a' },
        final_segments: [
          untagged(0, 'zaczynamy', 1),
          untagged(1, 'pytanie', 2),
          untagged(2, 'mhm'),
        ],
        models_used: { live: null, finalize: 'large-v3', diarization: 'nemotron' },
      })
    );
    fixture.detectChanges();
    const lines = component.lines();
    expect(lines.map((l) => l.speaker)).toEqual(['Speaker 1', 'Speaker 2', null]);
    expect(lines.map((l) => l.diarized?.color ?? null)).toEqual([
      'var(--teal)',
      'var(--violet)',
      null,
    ]);
    const chips: HTMLElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="line-speaker"]')
    );
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['Speaker 1', 'Speaker 2']);
  });

  describe('speaker names', () => {
    const sys = (start: number, text: string, speaker_id?: number) => ({
      ...seg(start, text),
      source: 'system' as const,
      speaker_id,
    });
    const q = (id: string): HTMLElement | null =>
      fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
    const all = (id: string): HTMLElement[] =>
      Array.from(fixture.nativeElement.querySelectorAll(`[data-testid="${id}"]`));
    const field = (): HTMLInputElement => q('speaker-name-input') as HTMLInputElement;
    const type = (value: string): void => {
      field().value = value;
      field().dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };

    function open(named: Record<string, string> = {}, previous: string[] = []): void {
      fixture.componentRef.setInput(
        'session',
        session({
          status: { state: 'done' },
          final_segments: [
            sys(0, 'zaczynamy', 1),
            { ...seg(1, 'cześć'), source: 'mic' as const },
            sys(2, 'pytanie', 2),
            sys(3, 'dalej', 1),
            sys(4, 'odpowiadam', 3),
            sys(5, 'jeszcze', 1),
            sys(6, 'też', 2),
          ],
          models_used: { live: null, finalize: 'large-v3', diarization: 'nemotron' },
          named_speakers: named,
          previous_speaker_names: previous,
        })
      );
      fixture.detectChanges();
    }

    it('shows a legend of the speakers, most lines first, and counts the unnamed', () => {
      open({ '2': 'Paweł' });
      expect(all('speaker-chip').map((c) => c.getAttribute('aria-label'))).toEqual([
        'Name Speaker 1, 3 lines',
        'Rename Paweł, 2 lines',
        'Name Speaker 3, 1 line',
      ]);
      expect(all('speaker-chip')[0].className).toContain('border-dashed');
      expect(all('speaker-chip')[1].className).not.toContain('border-dashed');
      expect(all('speaker-chip')[1].getAttribute('aria-label')).toBe('Rename Paweł, 2 lines');
      expect(q('transcript-meta')!.textContent).toContain('3 speakers · 2 unnamed');
      expect(q('speaker-approximate')).not.toBeNull();
    });

    it('shows no legend for a transcript without speakers', () => {
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      expect(q('speaker-legend')).toBeNull();
      expect(q('transcript-meta')!.textContent).not.toContain('speaker');
    });

    it('labels a named speaker with its name and keeps the pencil out of sight until hover', () => {
      open({ '1': 'Marta' });
      const labels = all('line-speaker');
      expect(labels[0].textContent?.trim()).toBe('Marta');
      expect(labels[0].getAttribute('aria-label')).toBe('Rename Marta, 3 lines');
      expect(labels[0].querySelector('app-icon')!.className).toContain('opacity-0');
      expect(labels[2].getAttribute('aria-label')).toBe('Name Speaker 2, 2 lines');
      expect(labels[2].querySelector('app-icon')!.className).toContain('opacity-60');
      expect(q('transcript-meta')!.textContent).toContain('3 speakers · 2 unnamed');
    });

    it('opens the dialog under the clicked line with the scope of the change', () => {
      open();
      all('line-speaker')[2].click();
      fixture.detectChanges();
      const lineWithDialog = q('speaker-name-dialog')!.closest('[data-testid="transcript-line"]');
      expect(lineWithDialog!.textContent).toContain('pytanie');
      expect(q('speaker-name-dialog')!.getAttribute('aria-label')).toBe('Name for Speaker 2');
      expect(q('speaker-name-note')!.textContent?.trim()).toBe('Renames Speaker 2 on all 2 lines.');
      const highlighted = all('transcript-line').filter((l) =>
        l.className.includes('bg-[var(--bg-1)]')
      );
      expect(highlighted.map((l) => l.textContent)).toEqual([
        expect.stringContaining('pytanie'),
        expect.stringContaining('też'),
      ]);
    });

    it('saves on Enter, closes the dialog and gives the focus back to the label', async () => {
      open();
      const label = all('line-speaker')[2];
      label.click();
      fixture.detectChanges();
      type('Paweł');
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await fixture.whenStable();
      fixture.detectChanges();
      expect(svc.renameSpeaker).toHaveBeenCalledWith('sess-1', 2, 'Paweł');
      expect(q('speaker-name-dialog')).toBeNull();
      expect(document.activeElement).toBe(label);
    });

    it('says that a name another speaker has puts both together', () => {
      open({ '1': 'Marta' });
      all('line-speaker')[2].click();
      fixture.detectChanges();
      type(' marta ');
      expect(q('speaker-name-note')!.textContent?.trim()).toBe(
        'Renames Speaker 2 on all 2 lines. Same name as Speaker 1, so they count as one person, also in exports and chats. Different people? Add a surname or a number.'
      );
      type('Marek');
      expect(q('speaker-name-note')!.textContent?.trim()).toBe('Renames Speaker 2 on all 2 lines.');
    });

    it('says a speaker with one line is renamed on that line', () => {
      open();
      all('line-speaker')[4].click();
      fixture.detectChanges();
      expect(q('speaker-name-note')!.textContent?.trim()).toBe(
        'Renames Speaker 3 on its one line.'
      );
    });

    it('saves nothing on blur, on Cancel, on Esc or on a click outside', async () => {
      open();
      all('line-speaker')[0].click();
      fixture.detectChanges();
      type('Mar');
      field().dispatchEvent(new Event('blur'));
      fixture.detectChanges();
      expect(q('speaker-name-dialog')).not.toBeNull();
      q('speaker-name-cancel')!.click();
      fixture.detectChanges();
      expect(q('speaker-name-dialog')).toBeNull();

      all('line-speaker')[0].click();
      fixture.detectChanges();
      q('speaker-name-dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      fixture.detectChanges();
      expect(q('speaker-name-dialog')).toBeNull();

      all('line-speaker')[0].click();
      fixture.detectChanges();
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      fixture.detectChanges();
      expect(q('speaker-name-dialog')).toBeNull();
      await fixture.whenStable();
      expect(svc.renameSpeaker).not.toHaveBeenCalled();
    });

    it('does not call the backend when the name did not change', async () => {
      open({ '1': 'Marta' });
      all('line-speaker')[0].click();
      fixture.detectChanges();
      expect(field().value).toBe('Marta');
      q('speaker-name-save')!.click();
      await fixture.whenStable();
      expect(svc.renameSpeaker).not.toHaveBeenCalled();
    });

    it('takes a name away when saved empty and shows the number again', async () => {
      open({ '1': 'Marta' });
      all('line-speaker')[0].click();
      fixture.detectChanges();
      expect(q('speaker-name-dialog')!.textContent).toContain('empty goes back to Speaker 1');
      type('');
      q('speaker-name-save')!.click();
      await fixture.whenStable();
      expect(svc.renameSpeaker).toHaveBeenCalledWith('sess-1', 1, '');
    });

    it('reports a backend refusal', async () => {
      svc.renameSpeaker.mockRejectedValueOnce(new Error('this transcript has no Speaker 2'));
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      open();
      all('line-speaker')[2].click();
      fixture.detectChanges();
      type('Paweł');
      q('speaker-name-save')!.click();
      await fixture.whenStable();
      expect(errSpy).toHaveBeenCalledWith('this transcript has no Speaker 2');
    });

    it('opens the same dialog from a legend chip, under the legend', () => {
      open();
      all('speaker-chip')[1].click();
      fixture.detectChanges();
      const dialog = q('speaker-name-dialog')!;
      expect(dialog.closest('[data-testid="transcript-line"]')).toBeNull();
      expect(dialog.closest('[data-testid="transcript-header"]')).not.toBeNull();
      expect(dialog.getAttribute('aria-label')).toBe('Name for Speaker 2');
    });

    it('highlights the lines of a speaker while its chip is hovered, and its chip from a line', () => {
      open();
      all('speaker-chip')[0].dispatchEvent(new Event('mouseenter'));
      fixture.detectChanges();
      const highlighted = all('transcript-line').filter((l) =>
        l.className.includes('bg-[var(--bg-1)]')
      );
      expect(highlighted.length).toBe(3);
      all('speaker-chip')[0].dispatchEvent(new Event('mouseleave'));
      all('line-speaker')[4].dispatchEvent(new Event('mouseenter'));
      fixture.detectChanges();
      expect(all('speaker-chip')[2].className).toContain('border-[var(--accent)]');
    });

    it('treats two labels with one name as one person: together in the legend, numbered, lit up together', () => {
      open({ '1': 'Marta', '3': 'marta' });
      expect(all('speaker-chip').map((c) => c.getAttribute('aria-label'))).toEqual([
        'Rename Marta (Speaker 1), 3 lines',
        'Rename marta (Speaker 3), 1 line',
        'Name Speaker 2, 2 lines',
      ]);
      expect(q('transcript-meta')!.textContent).toContain('2 speakers · 3 labels · 1 unnamed');
      expect(all('line-speaker')[0].textContent).toContain('#1');
      expect(all('line-speaker')[2].textContent).not.toContain('#');
      const dots = all('line-speaker').map(
        (l) =>
          (l.querySelector('[data-testid="speaker-dot"]') as HTMLElement | null)?.style
            .backgroundColor
      );
      expect(dots[0]).toBe('var(--teal)');
      expect(dots[4]).toBe('var(--teal)');
      expect(dots[2]).toBe('var(--violet)');
      all('speaker-chip')[1].dispatchEvent(new Event('mouseenter'));
      fixture.detectChanges();
      const lit = all('transcript-line').filter((l) => l.className.includes('bg-[var(--bg-1)]'));
      expect(
        lit.map((l) => l.textContent?.match(/zaczynamy|dalej|jeszcze|odpowiadam/)?.[0])
      ).toEqual(['zaczynamy', 'dalej', 'odpowiadam', 'jeszcze']);
    });

    it('lights up only the label being named, since its name changes only that label', () => {
      open({ '1': 'Marta', '3': 'Marta' });
      all('line-speaker')[4].click();
      fixture.detectChanges();
      const lit = all('transcript-line').filter((l) => l.className.includes('bg-[var(--bg-1)]'));
      expect(lit.length).toBe(1);
      expect(lit[0].textContent).toContain('odpowiadam');
      expect(q('speaker-name-note')!.textContent).toContain('Renames Marta on its one line.');
    });

    it('offers the names from before the last transcription that no speaker has', () => {
      open({ '1': 'Marta' }, ['marta', 'Paweł', 'Ola']);
      expect(q('speaker-reapply')).not.toBeNull();
      q('speaker-reapply')!.click();
      fixture.detectChanges();
      expect(q('speaker-name-dialog')!.getAttribute('aria-label')).toBe('Name for Speaker 2');
      expect(all('speaker-name-suggestion').map((b) => b.textContent?.trim())).toEqual([
        'Paweł',
        'Ola',
      ]);
      all('speaker-name-suggestion')[0].click();
      fixture.detectChanges();
      expect(field().value).toBe('Paweł');
    });

    it('offers no reapply once every speaker is named', () => {
      open({ '1': 'Marta', '2': 'Paweł', '3': 'Ola' }, ['Kasia']);
      expect(q('speaker-reapply')).toBeNull();
      expect(q('transcript-meta')!.textContent).toContain('3 speakers');
      expect(q('transcript-meta')!.textContent).not.toContain('unnamed');
    });

    it('offers no naming while a transcription runs, and the backend would refuse it anyway', () => {
      open();
      fixture.componentRef.setInput(
        'session',
        session({ ...component.session()!, status: { state: 'finalizing', progress: 0.3 } })
      );
      fixture.detectChanges();
      expect(all('line-speaker').map((l) => l.tagName)).toEqual([
        'SPAN',
        'SPAN',
        'SPAN',
        'SPAN',
        'SPAN',
        'SPAN',
        'SPAN',
      ]);
      expect(all('speaker-chip').every((c) => (c as HTMLButtonElement).disabled)).toBe(true);
      component.openNaming({ id: 1, trigger: null }, 'legend');
      fixture.detectChanges();
      expect(q('speaker-name-dialog')).toBeNull();
    });

    it('highlights the lines of a speaker while its line label has keyboard focus', () => {
      open();
      all('line-speaker')[2].dispatchEvent(new Event('focus'));
      fixture.detectChanges();
      expect(
        all('transcript-line').filter((l) => l.className.includes('bg-[var(--bg-1)]')).length
      ).toBe(2);
      all('line-speaker')[2].dispatchEvent(new Event('blur'));
      fixture.detectChanges();
      expect(
        all('transcript-line').filter((l) => l.className.includes('bg-[var(--bg-1)]')).length
      ).toBe(0);
    });

    it('warns about a merge for a name that differs only in inner spacing', () => {
      open({ '1': 'Marta Nowak' });
      all('line-speaker')[2].click();
      fixture.detectChanges();
      type('marta   nowak');
      expect(q('speaker-name-note')!.textContent).toContain('Same name as Speaker 1');
    });

    it('does not call the backend when the typed name normalises to the stored one', async () => {
      open({ '1': 'Marta Nowak' });
      all('line-speaker')[0].click();
      fixture.detectChanges();
      type('  Marta   Nowak ');
      q('speaker-name-save')!.click();
      await fixture.whenStable();
      expect(svc.renameSpeaker).not.toHaveBeenCalled();
    });

    it('closes the dialog when the transcription starts again', () => {
      open();
      all('line-speaker')[0].click();
      fixture.detectChanges();
      fixture.componentRef.setInput(
        'session',
        session({ ...component.session()!, status: { state: 'finalizing', progress: 0 } })
      );
      fixture.detectChanges();
      expect(q('speaker-name-dialog')).toBeNull();
    });

    it('folds speakers past the fourth into +N and opens them on request', () => {
      fixture.componentRef.setInput(
        'session',
        session({
          status: { state: 'done' },
          final_segments: [1, 2, 3, 4, 5, 6].map((n) => sys(n, `mówca ${n}`, n)),
          models_used: { live: null, finalize: 'large-v3', diarization: 'nemotron' },
          named_speakers: { '5': 'Basia' },
        })
      );
      fixture.detectChanges();
      expect(all('speaker-chip').length).toBe(4);
      expect(q('speaker-more')!.textContent?.replace(/\s+/g, ' ').trim()).toBe('+2 · 1 unnamed');
      q('speaker-more')!.click();
      fixture.detectChanges();
      expect(all('speaker-chip').length).toBe(6);
      const circles = all('speaker-circle').filter((c) =>
        c.closest('[data-testid="speaker-chip"]')
      );
      expect(circles.map((c) => c.textContent)).toEqual(['B', '6']);
      q('speaker-fewer')!.click();
      fixture.detectChanges();
      expect(all('speaker-chip').length).toBe(4);
    });

    it('says Transcribe again detaches the names once a speaker is named', () => {
      open({ '1': 'Marta' });
      component.toggleMenu('more');
      fixture.detectChanges();
      expect(q('retranscribe-item')!.textContent).toContain(
        'Speaker names will be detached and offered again.'
      );
    });
  });

  describe('your name before the first export', () => {
    const q = (id: string): HTMLElement | null =>
      fixture.nativeElement.querySelector(`[data-testid="${id}"]`);

    function withOwnLines(): void {
      fixture.componentRef.setInput(
        'session',
        session({
          status: { state: 'done' },
          final_segments: [{ ...seg(0, 'cześć'), source: 'mic' as const }],
        })
      );
      fixture.detectChanges();
    }

    it('asks once before an export of a transcript with lines of the user', async () => {
      withOwnLines();
      await component.exportMarkdown();
      fixture.detectChanges();
      expect(svc.exportMarkdown).not.toHaveBeenCalled();
      expect(q('speaker-name-dialog')!.getAttribute('aria-label')).toBe('Your name');
      const input = q('speaker-name-input') as HTMLInputElement;
      input.value = 'Kamil';
      q('speaker-name-save')!.click();
      await fixture.whenStable();
      expect(svc.setYourName).toHaveBeenCalledWith('Kamil');
      expect(svc.markYourNameAsked).toHaveBeenCalled();
      expect(svc.exportMarkdown).toHaveBeenCalledWith('sess-1');
      expect(svc.setYourName.mock.invocationCallOrder[0]).toBeLessThan(
        svc.exportMarkdown.mock.invocationCallOrder[0]
      );
      expect(q('speaker-name-dialog')).toBeNull();
    });

    it('keeps You and goes on when the user declines', async () => {
      withOwnLines();
      await component.stageForChat();
      fixture.detectChanges();
      q('speaker-name-cancel')!.click();
      await fixture.whenStable();
      expect(svc.setYourName).not.toHaveBeenCalled();
      expect(svc.markYourNameAsked).toHaveBeenCalled();
      expect(svc.stageForChat).toHaveBeenCalledWith('sess-1', 'new-chat');
    });

    it('says why an attach that became blocked while the question showed did not happen', async () => {
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      withOwnLines();
      await component.stageForChat();
      fixture.detectChanges();
      chat.newChatBlockedReason.set('Close a chat tab first');
      q('speaker-name-cancel')!.click();
      await fixture.whenStable();
      expect(svc.stageForChat).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith('Close a chat tab first');
    });

    it('drops the question and its action when another recording opens', async () => {
      withOwnLines();
      await component.exportMarkdown();
      fixture.detectChanges();
      fixture.componentRef.setInput(
        'session',
        session({
          id: 'sess-2',
          status: { state: 'done' },
          final_segments: [{ ...seg(0, 'inne'), source: 'mic' as const }],
        })
      );
      fixture.detectChanges();
      expect(q('speaker-name-dialog')).toBeNull();
      expect(svc.exportMarkdown).not.toHaveBeenCalled();
    });

    it('does nothing and asks again later when the question is dismissed', async () => {
      withOwnLines();
      await component.copyMarkdown();
      fixture.detectChanges();
      q('speaker-name-dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      fixture.detectChanges();
      expect(q('speaker-name-dialog')).toBeNull();
      expect(svc.markYourNameAsked).not.toHaveBeenCalled();
      expect(svc.getMarkdown).not.toHaveBeenCalled();
    });

    it('does not ask when the name is set, was asked, or the transcript has no lines of the user', async () => {
      withOwnLines();
      svc.yourName.mockReturnValue('Kamil');
      await component.exportMarkdown();
      svc.yourName.mockReturnValue('');
      svc.yourNameAsked.mockReturnValue(true);
      await component.exportMarkdown();
      svc.yourNameAsked.mockReturnValue(false);
      fixture.componentRef.setInput(
        'session',
        session({ status: { state: 'done' }, live_segments: [seg(0, 'hi')] })
      );
      fixture.detectChanges();
      await component.exportMarkdown();
      expect(svc.exportMarkdown).toHaveBeenCalledTimes(3);
      fixture.detectChanges();
      expect(q('speaker-name-dialog')).toBeNull();
    });
  });

  describe('speaker labels on a microphone-only recording', () => {
    const q = (id: string): HTMLElement | null =>
      fixture.nativeElement.querySelector(`[data-testid="${id}"]`);

    function openDone(
      kind: AudioSource['kind'],
      asked: boolean,
      finalize = 'large',
      state: 'done' | 'postponed' = 'done'
    ): void {
      svc.speakerAttribution.mockReturnValue(asked);
      fixture = TestBed.createComponent(LiveTranscriptComponent);
      component = fixture.componentInstance;
      svc.recordings.set([row({ finalize_model: finalize, status: { state } })]);
      const sources: Record<AudioSource['kind'], AudioSource> = {
        microphone: { kind: 'microphone', device: null },
        mixed: { kind: 'mixed', mic: null },
        system_wide: { kind: 'system_wide' },
        imported_file: { kind: 'imported_file' },
      };
      fixture.componentRef.setInput(
        'session',
        session({
          status: { state },
          audio_source: { source: sources[kind], label: 'Source' },
          final_segments: [seg(0, 'hi')],
          models_used: { live: null, finalize },
        })
      );
      fixture.detectChanges();
    }

    it('says why there are no labels when the Settings switch asked for them', () => {
      openDone('microphone', true);
      expect(q('transcript-quality')!.textContent).toContain(
        'Speaker labels are not available for a microphone-only recording.'
      );
    });

    it('says nothing with the switch off or for a recording of the meeting audio', () => {
      openDone('microphone', false);
      expect(q('transcript-quality')).toBeNull();
      openDone('system_wide', true);
      expect(q('transcript-quality')).toBeNull();
      openDone('imported_file', true);
      expect(q('transcript-quality')).toBeNull();
      openDone('mixed', true);
      expect(q('transcript-quality')).toBeNull();
    });

    it('keeps the smaller-model and put-off lines ahead of it', () => {
      openDone('microphone', true, 'small');
      expect(q('transcript-quality')!.textContent).toContain('Made with a smaller model');
      openDone('microphone', true, 'large', 'postponed');
      expect(q('transcript-quality')!.textContent).not.toContain('Speaker labels');
    });
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
    expect(bar.firstElementChild.className).toContain('bg-[var(--amber)]');
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
      expect(el.querySelector('[data-testid="failure-reason"]')!.className).toContain(
        'text-[var(--red)]'
      );
      expect(el.querySelector('[data-testid="transcribe-btn"]')!.className).toContain(
        'text-[var(--on-accent)]'
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

    it('colours the state line with the theme amber and red, never a fixed palette', () => {
      const cls = (state: TranscriptSummary['status'], queued = false): string | undefined => {
        svc.recordings.set([row({ status: state, queued })]);
        fixture.componentRef.setInput('session', session({ status: state }));
        fixture.detectChanges();
        return component.quality()?.cls;
      };
      expect(cls({ state: 'recording' })).toBe('text-[var(--red)]');
      expect(cls({ state: 'paused' })).toBe('text-[var(--amber)]');
      expect(cls({ state: 'finalizing', progress: 0.1 })).toBe('text-[var(--amber)]');
      expect(cls({ state: 'finalizing', progress: 0 }, true)).toBe('text-[var(--amber)]');
      expect(cls({ state: 'failed', reason: 'x' })).toBe('text-[var(--red)]');
      expect(cls({ state: 'postponed' })).toBe('text-[var(--ink-dim)]');
      expect(cls({ state: 'done' })).toBeUndefined();
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
      expect(q('send-to-chat-btn')!.className).toContain('text-[var(--on-accent)]');
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
        '13 min · System · Polish'
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
      expect(el.querySelector('[data-testid="smaller-model-banner"]')!.className).toContain(
        'text-[var(--ink)]'
      );
      expect(el.querySelector('[data-testid="transcript-quality"]')!.className).toContain(
        'text-[var(--amber)]'
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

    it('offers no Continue recording on an imported file, which has nothing to capture', () => {
      fixture.componentRef.setInput(
        'session',
        session({
          status: { state: 'done' },
          audio_source: { source: { kind: 'imported_file' }, label: 'Imported file: sync.m4a' },
          live_segments: [seg(0, 'hi')],
        })
      );
      fixture.detectChanges();
      expect(q('resume-item')).toBeNull();
      expect(q('retranscribe-item')).not.toBeNull();
      expect(q('reveal-btn')).not.toBeNull();
    });

    it('names the language an imported file was transcribed in', () => {
      fixture.componentRef.setInput(
        'session',
        session({
          status: { state: 'done' },
          language: 'en',
          audio_source: { source: { kind: 'imported_file' }, label: 'Imported file: sync.m4a' },
          live_segments: [seg(0, 'hi')],
        })
      );
      fixture.detectChanges();
      const meta = q('transcript-meta')!.textContent!;
      expect(meta).toContain('Imported file: sync.m4a · English');
    });

    it('deletes only after the confirmation', async () => {
      q('delete-item')!.click();
      fixture.detectChanges();
      expect(svc.delete).not.toHaveBeenCalled();
      const confirm = fixture.nativeElement.querySelector('[data-testid="delete-confirm"]');
      expect(confirm.textContent).toContain('This cannot be undone.');
      expect(q('delete-yes')!.className).toContain('text-[var(--red)]');
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
