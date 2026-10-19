import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SessionListComponent } from './session-list.component';
import { TranscriptionService } from '../../services/transcription.service';
import type { RecommendedModelEntry, TranscriptSummary } from '../../models/transcript';

/**
 * A list row, created today at the given local hour unless overridden.
 * @param id - row id.
 * @param overrides - fields to replace.
 */
function summary(id: string, overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
  const now = new Date();
  return {
    id,
    created_at: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0).toISOString(),
    title: null,
    language: 'pl',
    source_label: 'System',
    status: { state: 'done' },
    duration_secs: 30 * 60,
    segment_count: 12,
    preview: 'Dzień dobry wszystkim',
    size_bytes: 50 * 1024 * 1024,
    finalize_model: 'large',
    queued: false,
    diarization_secs: null,
    ...overrides,
  };
}

/**
 * RFC 3339 of a local time `daysAgo` days before today.
 * @param daysAgo - whole days back.
 * @param hour - local hour.
 */
function daysAgoAt(daysAgo: number, hour: number): string {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - daysAgo,
    hour,
    0
  ).toISOString();
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
    active: WritableSignal<{ id: string } | null>;
    highQualityModel: WritableSignal<RecommendedModelEntry | null>;
  };

  const q = (testId: string): HTMLElement | null => el.querySelector(`[data-testid="${testId}"]`);
  const click = (testId: string, init: MouseEventInit = {}): void => {
    q(testId)!.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
    fixture.detectChanges();
  };

  beforeEach(async () => {
    const active = signal<{ id: string } | null>(null);
    const recordings = signal<TranscriptSummary[]>([
      summary('c', { title: 'Sprint review', created_at: daysAgoAt(0, 11) }),
      summary('b', { created_at: daysAgoAt(0, 9), preview: 'Zostają nasze rozmowy' }),
      summary('a', { created_at: daysAgoAt(1, 12) }),
    ]);
    svc = {
      recordings,
      recordingsError: signal(''),
      watchRecordings: vi.fn(async () => undefined),
      delete: vi.fn(async (id: string) => {
        recordings.update((list) => list.filter((r) => r.id !== id));
      }),
      active,
      highQualityModel: signal<RecommendedModelEntry | null>({
        key: 'large',
        display_name: 'Large',
        size_bytes: 1,
        downloaded: true,
        downloading: false,
      }),
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

  it('groups rows by day under Today and Yesterday, newest first', () => {
    fixture.detectChanges();
    const headings = [...el.querySelectorAll('h3')].map((h) => h.textContent?.trim());
    expect(headings).toEqual(['Today', 'Yesterday']);
    expect(component.groups().map((g) => g.rows.map((r) => r.rec.id))).toEqual([['c', 'b'], ['a']]);
  });

  it('shows name, length and first line, and the start time only under a title', () => {
    fixture.detectChanges();
    const titled = q('open-c')!.textContent!;
    expect(titled).toContain('Sprint review');
    expect(titled).toContain('30 min');
    expect(titled).toContain('11:00');
    expect(q('preview-b')!.textContent).toContain('Zostają nasze rozmowy');
    expect(q('open-b')!.textContent).toContain('Today 09:00');
  });

  it('puts no chip on a good finished transcript and one on every exception', () => {
    svc.recordings.set([
      summary('ok'),
      summary('small', { finalize_model: 'small' }),
      summary('rec', { status: { state: 'recording' } }),
      summary('paused', { status: { state: 'paused' } }),
      summary('busy', { status: { state: 'finalizing', progress: 0.42 } }),
      summary('queued', { status: { state: 'finalizing', progress: 0 }, queued: true }),
      summary('failed', { status: { state: 'failed', reason: 'interrupted' } }),
      summary('later', { status: { state: 'postponed' }, segment_count: 0 }),
      summary('live', { status: { state: 'postponed' } }),
    ]);
    fixture.detectChanges();
    expect(q('status-ok')).toBeNull();
    expect(q('status-small')!.textContent).toBe('Smaller model');
    expect(q('status-rec')!.textContent).toBe('Recording');
    expect(q('status-paused')!.textContent).toBe('Paused');
    expect(q('status-busy')!.textContent).toBe('Transcribing 42%');
    expect(q('status-queued')!.textContent).toBe('Queued');
    expect(q('status-failed')!.textContent).toBe('Not transcribed');
    expect(q('status-later')!.textContent).toBe('Not transcribed yet');
    expect(q('status-live')!.textContent).toBe('Smaller model');
  });

  it('shows no smaller-model chip while the best model is not known', () => {
    svc.highQualityModel.set(null);
    svc.recordings.set([summary('small', { finalize_model: 'small' })]);
    fixture.detectChanges();
    expect(q('status-small')).toBeNull();
  });

  it('shows the count and total size in the header', () => {
    fixture.detectChanges();
    expect(q('recordings-count')!.textContent).toContain('Recordings · 3');
    expect(q('recordings-size')!.textContent).toContain('150');
  });

  it('opens a row on click, also while another recording captures', () => {
    svc.recordings.update((list) => [summary('rec', { status: { state: 'recording' } }), ...list]);
    fixture.detectChanges();
    const spy = vi.fn();
    component.opened.subscribe(spy);
    click('open-a');
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect((q('open-a') as HTMLButtonElement).disabled).toBe(false);
  });

  it('marks the recording open in the pane as current', () => {
    svc.active.set({ id: 'b' });
    fixture.detectChanges();
    expect(q('row-b')!.getAttribute('data-active')).toBe('true');
    expect(q('open-b')!.getAttribute('aria-current')).toBe('true');
    expect(q('row-a')!.getAttribute('data-active')).toBeNull();
  });

  it('filters by name and first line, case-insensitively, and says when nothing matches', () => {
    fixture.detectChanges();
    component.query.set('SPRINT');
    fixture.detectChanges();
    expect(component.visibleRows().map((r) => r.rec.id)).toEqual(['c']);
    component.query.set('rozmowy');
    fixture.detectChanges();
    expect(component.visibleRows().map((r) => r.rec.id)).toEqual(['b']);
    component.query.set('nic takiego');
    fixture.detectChanges();
    expect(q('recordings-no-match')!.textContent).toContain('nic takiego');
  });

  it('shows the three-step instruction for an empty list, without search or Select', () => {
    svc.recordings.set([]);
    fixture.detectChanges();
    expect(q('recordings-empty')).not.toBeNull();
    expect(q('start-select')).toBeNull();
  });

  describe('select mode', () => {
    beforeEach(() => {
      fixture.detectChanges();
      click('start-select');
    });

    it('ticks a row on click instead of opening it', () => {
      const spy = vi.fn();
      component.opened.subscribe(spy);
      click('open-b');
      expect(spy).not.toHaveBeenCalled();
      expect([...component.selected()]).toEqual(['b']);
      expect(q('selected-count')!.textContent).toContain('1 selected');
      click('open-b');
      expect(component.selected().size).toBe(0);
    });

    it('selects all selectable rows, leaves out ongoing ones, and clears', () => {
      svc.recordings.update((list) => [
        summary('busy', { status: { state: 'finalizing', progress: 0.1 } }),
        ...list,
      ]);
      fixture.detectChanges();
      expect(q('select-all')!.textContent).toContain('Select all (3)');
      click('select-all');
      expect([...component.selected()].sort()).toEqual(['a', 'b', 'c']);
      expect((q('open-busy') as HTMLButtonElement).disabled).toBe(true);
      expect(component.allSelected()).toBe(true);
      click('clear-selection');
      expect(component.selected().size).toBe(0);
    });

    it('shows the header box as partly ticked and toggles all from it', () => {
      click('open-a');
      const box = q('select-all-toggle') as HTMLInputElement;
      expect(box.indeterminate).toBe(true);
      expect(box.checked).toBe(false);
      component.toggleAll();
      fixture.detectChanges();
      expect(component.allSelected()).toBe(true);
      component.toggleAll();
      expect(component.selected().size).toBe(0);
    });

    it('selects a range with Shift-click from the last ticked row, in either direction', () => {
      click('open-c');
      click('open-a', { shiftKey: true });
      expect([...component.selected()].sort()).toEqual(['a', 'b', 'c']);
      component.clearSelection();
      click('open-a');
      click('open-c', { shiftKey: true });
      expect([...component.selected()].sort()).toEqual(['a', 'b', 'c']);
    });

    it('skips ongoing rows inside a Shift range', () => {
      svc.recordings.set([
        summary('x'),
        summary('busy', { status: { state: 'recording' } }),
        summary('y'),
      ]);
      fixture.detectChanges();
      click('open-x');
      click('open-y', { shiftKey: true });
      expect([...component.selected()].sort()).toEqual(['x', 'y']);
    });

    it('treats a Shift-click without an earlier tick as a plain tick', () => {
      click('open-b', { shiftKey: true });
      expect([...component.selected()]).toEqual(['b']);
    });

    it('Select all ticks only rows the search shows', () => {
      component.query.set('sprint');
      fixture.detectChanges();
      click('select-all');
      expect([...component.selected()]).toEqual(['c']);
    });

    it('deletes the ticked recordings after one confirmation and leaves select mode', async () => {
      click('open-a');
      click('open-b');
      click('delete-selected');
      expect(q('bulk-delete-confirm')!.textContent).toContain('Delete 2 recordings');
      await component.removeSelected();
      fixture.detectChanges();
      expect(svc.delete).toHaveBeenCalledTimes(2);
      expect(component.selecting()).toBe(false);
      expect(svc.recordings().map((r) => r.id)).toEqual(['c']);
    });

    it('reports how many deletes failed and still runs the rest', async () => {
      svc.delete.mockImplementationOnce(async () => {
        throw new Error('locked');
      });
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      click('open-a');
      click('open-b');
      await component.removeSelected();
      expect(svc.delete).toHaveBeenCalledTimes(2);
      expect(errSpy).toHaveBeenCalledWith('1 of 2 recordings could not be deleted: locked');
    });

    it('Done leaves select mode and drops the selection', () => {
      click('open-a');
      click('cancel-select');
      expect(component.selecting()).toBe(false);
      expect(component.selected().size).toBe(0);
      expect(q('recordings-search')).not.toBeNull();
    });
  });
});
