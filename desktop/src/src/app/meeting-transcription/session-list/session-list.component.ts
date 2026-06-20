import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
  output,
  signal,
} from '@angular/core';

import { TranscriptionService } from '../../services/transcription.service';
import type { TranscriptSession, TranscriptStatus } from '../../models/transcript';

/**
 * Short human label for a session status.
 * @param s - the session's lifecycle status.
 */
function statusLabel(s: TranscriptStatus): string {
  switch (s.state) {
    case 'recording':
      return 'recording';
    case 'finalizing':
      return `finalizing ${Math.round(s.progress * 100)}%`;
    case 'done':
      return 'done';
    case 'failed':
      return `failed: ${s.reason}`;
  }
}

/**
 * The recordings list (left pane of the Meeting transcription tab): open,
 * status badge, and delete (removes audio + transcript). No auto-cleanup —
 * the user manages it.
 */
@Component({
  selector: 'app-session-list',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-testid="session-list">
      <h2 class="mono mb-2 text-[11px] uppercase tracking-widest text-[var(--ink-mute)]">
        Recordings ({{ sessions().length }})
      </h2>
      @if (error()) {
        <p class="mb-2 text-[12px] text-red-300">{{ error() }}</p>
      }
      @if (sessions().length === 0) {
        <p class="text-[12px] text-[var(--ink-mute)]">No recordings yet.</p>
      }
      <ul class="space-y-2">
        @for (s of sessions(); track s.id) {
          <li
            class="rounded-md border border-[var(--line)] bg-[var(--bg-1)] p-2 text-[12px]"
            [class.ring-1]="s.id === selectedId()"
            [class.ring-[var(--accent)]]="s.id === selectedId()"
          >
            <button
              type="button"
              class="block w-full text-left"
              [attr.data-testid]="'open-' + s.id"
              (click)="open(s)"
            >
              <div class="font-medium text-[var(--ink)]">{{ s.created_at }}</div>
              <div class="text-[10px] text-[var(--ink-mute)]">
                {{ s.language }} · {{ label(s) }} · {{ s.live_segments.length }} segments
              </div>
            </button>
            <div class="mt-1 flex items-center text-[10px]">
              <button
                type="button"
                class="mono ml-auto rounded border border-red-500/40 px-2 py-0.5 text-red-300 hover:bg-red-500/10"
                [attr.data-testid]="'delete-' + s.id"
                (click)="remove(s.id)"
              >
                delete
              </button>
            </div>
          </li>
        }
      </ul>
    </div>
  `,
})
export class SessionListComponent implements OnInit, OnDestroy {
  /** Emits the session the user opened (the parent shows it in the right pane). */
  readonly opened = output<TranscriptSession>();
  /** Forwards errors to the parent banner. */
  readonly errorOccurred = output<string>();

  /** Recorded sessions on disk (newest first). */
  readonly sessions = signal<TranscriptSession[]>([]);
  /** Id of the session currently open in the right pane (for highlight). */
  readonly selectedId = signal<string | null>(null);
  /** Local error string. */
  readonly error = signal('');

  private readonly transcription = inject(TranscriptionService);
  private readonly cdr = inject(ChangeDetectorRef);
  /** Poll timer, active only while a session is still recording/finalizing. */
  private poll: ReturnType<typeof setInterval> | undefined;

  /** Loads the session list on first paint. */
  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  /** Stops the poll timer on teardown. */
  ngOnDestroy(): void {
    this.stopPolling();
  }

  /** Re-reads the session list from disk. */
  async refresh(): Promise<void> {
    try {
      const list = await this.transcription.list();
      // Newest first by created_at (RFC 3339 sorts lexicographically).
      list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      this.sessions.set(list);
      this.error.set('');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    this.cdr.markForCheck();
    // A session left mid-finalize only streams events to the active view, so
    // poll the list until everything settles, then stop.
    const pending = this.sessions().some(
      (s) => s.status.state === 'recording' || s.status.state === 'finalizing'
    );
    if (pending && this.poll === undefined) {
      this.poll = setInterval(() => void this.refresh(), 1500);
    } else if (!pending) {
      this.stopPolling();
    }
  }

  private stopPolling(): void {
    if (this.poll !== undefined) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  /**
   * Marks a session as the open one (for the row highlight).
   * @param id - session id, or `null` to clear.
   */
  markSelected(id: string | null): void {
    this.selectedId.set(id);
    this.cdr.markForCheck();
  }

  /**
   * Opens a session in the right pane.
   * @param s - the session.
   */
  open(s: TranscriptSession): void {
    this.selectedId.set(s.id);
    this.opened.emit(s);
  }

  /**
   * Deletes a session directory (audio + transcript) and refreshes.
   * @param id - the session id.
   */
  async remove(id: string): Promise<void> {
    try {
      await this.transcription.delete(id);
      if (this.selectedId() === id) this.selectedId.set(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.errorOccurred.emit(msg);
    }
    await this.refresh();
  }

  /**
   * Status label for the list row.
   * @param s - the session.
   */
  label(s: TranscriptSession): string {
    return statusLabel(s.status);
  }
}
