import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computed, signal, type Signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SessionListComponent } from './session-list.component';
import { TranscriptionService } from '../../services/transcription.service';
import type { TranscriptSummary } from '../../models/transcript';

function summary(id: string, overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
  return {
    id,
    created_at: '2026-05-12T07:28:04Z',
    title: null,
    language: 'pl',
    source_label: 'System',
    status: { state: 'done' },
    duration_secs: 30 * 60,
    segment_count: 12,
    preview: 'Dzień dobry wszystkim',
    size_bytes: 50 * 1024 * 1024,
    ...overrides,
  };
}

describe('SessionListComponent', () => {
  let component: SessionListComponent;
  let fixture: ComponentFixture<SessionListComponent>;
  let el: HTMLElement;
  let svc: {
    recordings: WritableSignal<TranscriptSummary[]>;
    recordingsError: WritableSignal<string>;
    watchRecordings: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    transcribe: ReturnType<typeof vi.fn>;
    resumeRecording: ReturnType<typeof vi.fn>;
    liveTranscriptPreferred: ReturnType<typeof vi.fn>;
    recordingSessionId: WritableSignal<string | null>;
    recording: Signal<boolean>;
  };

  const q = (testId: string): HTMLElement | null => el.querySelector(`[data-testid="${testId}"]`);

  beforeEach(async () => {
    const recordingSessionId = signal<string | null>(null);
    const recordings = signal<TranscriptSummary[]>([
      summary('b', { title: 'Sprint review', created_at: '2026-05-12T09:00:00Z' }),
      summary('a'),
    ]);
    svc = {
      recordings,
      recordingsError: signal(''),
      watchRecordings: vi.fn(async () => undefined),
      delete: vi.fn(async (id: string) => {
        recordings.update((list) => list.filter((r) => r.id !== id));
      }),
      transcribe: vi.fn(async () => undefined),
      resumeRecording: vi.fn(async () => undefined),
      liveTranscriptPreferred: vi.fn(() => false),
      recordingSessionId,
      recording: computed(() => recordingSessionId() !== null),
    };
    await TestBed.configureTestingModule({
      imports: [SessionListComponent],
      providers: [{ provide: TranscriptionService, useValue: svc }],
    }).compileComponents();
    fixture = TestBed.createComponent(SessionListComponent);
    component = fixture.componentInstance;
    el = fixture.nativeElement;
  });

  it('starts watching the backend list on init and reports a read failure to the parent', async () => {
    svc.recordingsError.set('boom');
    const errSpy = vi.fn();
    component.errorOccurred.subscribe(errSpy);
    await component.ngOnInit();
    expect(svc.watchRecordings).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('boom');
  });

  it('renders a card per recording: name, length, status and the first line', () => {
    fixture.detectChanges();
    const row = q('open-b')!;
    expect(row.textContent).toContain('Sprint review');
    expect(row.textContent).toContain('30 min');
    expect(row.textContent).toContain('Dzień dobry wszystkim');
    expect(q('status-b')!.textContent).toContain('ready');
    expect(row.textContent).not.toContain('2026-05-12T');
    expect(row.textContent).not.toContain('segments');
  });

  it('names an untitled recording by its local start time, not the UTC string', () => {
    fixture.detectChanges();
    const text = q('open-a')!.textContent!;
    expect(text).not.toContain('2026-05-12T07:28:04Z');
    expect(text).toMatch(/\d{2}:\d{2}/);
  });

  it('shows the total size on disk', () => {
    fixture.detectChanges();
    expect(q('recordings-size')!.textContent).toContain('100.0 MB');
  });

  it('turns the empty state into the three steps', () => {
    svc.recordings.set([]);
    fixture.detectChanges();
    const empty = q('recordings-empty')!.textContent!;
    expect(empty).toContain('Start recording');
    expect(empty).toContain('Stop when the meeting ends');
    expect(empty).toContain('Summarize it in chat');
  });

  it('emits the opened recording and highlights it', () => {
    const spy = vi.fn();
    component.opened.subscribe(spy);
    const rec = svc.recordings()[0];
    component.open(rec);
    expect(spy).toHaveBeenCalledWith(rec);
    expect(component.selectedId()).toBe('b');
  });

  it('marks the open recording with the accent edge and aria-current, and only that one', () => {
    component.markSelected('b');
    fixture.detectChanges();
    const open = q('row-b')!;
    expect(open.getAttribute('data-active')).toBe('true');
    expect(open.className).toContain('border-l-[var(--accent)]');
    expect(open.className).not.toContain('ring-');
    expect(q('open-b')!.getAttribute('aria-current')).toBe('true');
    const other = q('row-a')!;
    expect(other.getAttribute('data-active')).toBeNull();
    expect(other.className).not.toContain('border-l-[var(--accent)]');
    expect(q('open-a')!.getAttribute('aria-current')).toBeNull();
  });

  it('locks the other rows while a recording runs, with the reason', () => {
    svc.recordingSessionId.set('b');
    fixture.detectChanges();
    expect((q('open-a') as HTMLButtonElement).disabled).toBe(true);
    expect((q('open-b') as HTMLButtonElement).disabled).toBe(false);
    const spy = vi.fn();
    component.opened.subscribe(spy);
    component.open(svc.recordings()[1]);
    expect(spy).not.toHaveBeenCalled();
  });

  describe('delete', () => {
    it('asks first, naming the recording with its length and size', () => {
      fixture.detectChanges();
      q('delete-b')!.click();
      fixture.detectChanges();
      expect(svc.delete).not.toHaveBeenCalled();
      const confirm = q('delete-confirm-b')!;
      expect(confirm.getAttribute('role')).toBe('alertdialog');
      expect(confirm.textContent).toContain('Sprint review');
      expect(confirm.textContent).toContain('30 min');
      expect(confirm.textContent).toContain('50.0 MB');
      expect(confirm.textContent).toContain('cannot be undone');
    });

    it('deletes on confirm and clears the highlight of the deleted row', async () => {
      component.markSelected('b');
      component.pendingDeleteId.set('b');
      fixture.detectChanges();
      q('delete-yes-b')!.click();
      await fixture.whenStable();
      expect(svc.delete).toHaveBeenCalledWith('b');
      expect(component.selectedId()).toBeNull();
      expect(component.pendingDeleteId()).toBeNull();
    });

    it('cancel keeps the recording', () => {
      component.pendingDeleteId.set('b');
      fixture.detectChanges();
      q('delete-no-b')!.click();
      fixture.detectChanges();
      expect(svc.delete).not.toHaveBeenCalled();
      expect(q('delete-confirm-b')).toBeNull();
    });

    it('reports a refused delete to the parent', async () => {
      svc.delete.mockRejectedValueOnce(new Error('stop the recording before deleting it'));
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      await component.remove('b');
      expect(errSpy).toHaveBeenCalledWith('stop the recording before deleting it');
      expect(component.busy()).toBe(false);
    });

    it('offers no delete for a recording that is still capturing or transcribing', () => {
      svc.recordings.set([
        summary('r', { status: { state: 'recording' } }),
        summary('f', { status: { state: 'finalizing', progress: 0.3 } }),
      ]);
      fixture.detectChanges();
      expect(q('delete-r')).toBeNull();
      expect(q('delete-f')).toBeNull();
      expect(q('status-f')!.textContent).toContain('transcribing 30%');
    });
  });

  describe('bulk delete', () => {
    it('deletes the ticked recordings after one confirmation that names the total size', async () => {
      fixture.detectChanges();
      q('start-select')!.click();
      fixture.detectChanges();
      (q('select-a') as HTMLInputElement).click();
      (q('select-b') as HTMLInputElement).click();
      fixture.detectChanges();
      expect(q('delete-selected')!.textContent).toContain('100.0 MB');
      q('delete-selected')!.click();
      fixture.detectChanges();
      expect(q('bulk-delete-confirm')!.textContent).toContain('cannot be undone');
      q('bulk-delete-yes')!.click();
      await fixture.whenStable();
      expect(svc.delete).toHaveBeenCalledTimes(2);
      expect(component.selecting()).toBe(false);
      expect(component.selected().size).toBe(0);
    });

    it('keeps going past a failure and reports how many could not be deleted', async () => {
      svc.delete.mockRejectedValueOnce(new Error('locked'));
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      component.selecting.set(true);
      component.toggleSelected('a');
      component.toggleSelected('b');
      await component.removeSelected();
      expect(svc.delete).toHaveBeenCalledTimes(2);
      expect(errSpy).toHaveBeenCalledWith('1 of 2 recordings could not be deleted: locked');
    });

    it('cannot tick a recording that is still capturing', () => {
      svc.recordings.set([summary('r', { status: { state: 'recording' } })]);
      component.selecting.set(true);
      fixture.detectChanges();
      expect((q('select-r') as HTMLInputElement).disabled).toBe(true);
    });

    it('toggleSelected unticks a ticked recording', () => {
      component.toggleSelected('a');
      component.toggleSelected('a');
      expect(component.selected().has('a')).toBe(false);
    });
  });

  describe('continue and transcribe', () => {
    it('continues a finished recording with the live preference and selects it', async () => {
      const spy = vi.fn();
      component.opened.subscribe(spy);
      await component.resume(svc.recordings()[0]);
      expect(svc.resumeRecording).toHaveBeenCalledWith('b', false);
      expect(component.selectedId()).toBe('b');
      expect(spy).not.toHaveBeenCalled();
    });

    it('reports a failed continue without selecting the recording', async () => {
      svc.resumeRecording.mockRejectedValueOnce(new Error('capture busy'));
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      await component.resume(svc.recordings()[0]);
      expect(errSpy).toHaveBeenCalledWith('capture busy');
      expect(component.selectedId()).toBeNull();
    });

    it('labels Continue recording on finished rows only, and only while nothing records', () => {
      fixture.detectChanges();
      expect(q('resume-b')!.textContent).toContain('Continue recording');
      svc.recordingSessionId.set('b');
      fixture.detectChanges();
      expect(q('resume-b')).toBeNull();
    });

    it('offers Transcribe on a failed recording, with the reason on the status chip', () => {
      svc.recordings.set([
        summary('x', { status: { state: 'failed', reason: 'interrupted: Speedwave closed' } }),
      ]);
      fixture.detectChanges();
      expect(q('transcribe-x')).not.toBeNull();
      expect(q('resume-x')).toBeNull();
      expect(q('status-x')!.textContent).toContain('failed');
      expect(q('status-x')!.textContent).not.toContain('interrupted');
    });

    it('transcribes a failed recording and opens it so the progress shows', async () => {
      const failed = summary('x', { status: { state: 'failed', reason: 'r' } });
      const spy = vi.fn();
      component.opened.subscribe(spy);
      await component.transcribe(failed);
      expect(svc.transcribe).toHaveBeenCalledWith('x');
      expect(spy).toHaveBeenCalledWith(failed);
      expect(component.busy()).toBe(false);
    });

    it('reports a refused transcribe', async () => {
      svc.transcribe.mockRejectedValueOnce(new Error('no Whisper model'));
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      await component.transcribe(summary('x', { status: { state: 'failed', reason: 'r' } }));
      expect(errSpy).toHaveBeenCalledWith('no Whisper model');
    });
  });
});
