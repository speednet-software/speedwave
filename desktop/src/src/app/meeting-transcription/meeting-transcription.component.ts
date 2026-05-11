import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { TranscriptionService } from '../services/transcription.service';
import type { TranscriptSession } from '../models/transcript';

/**
 * Meeting transcription tab — opt-in (the empty-state links to Settings until
 * the user toggles it on). Phase 2 MVP: shell + empty-state + the session list.
 * Recording controls, the live transcript view, and the model manager land as
 * child components in later iterations.
 */
@Component({
  selector: 'app-meeting-transcription',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)]">
      <header class="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
        <div>
          <h1 class="text-lg font-semibold">Meeting transcription</h1>
          <p class="text-sm text-[var(--ink-mute)]">
            Audio is transcribed locally. Model downloads and "Send to Claude" use the network.
          </p>
        </div>
      </header>

      @if (enabled() === false) {
        <div class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p class="max-w-md text-sm text-[var(--ink-mute)]">
            Meeting transcription is off. Enable it in Settings to record audio from this machine,
            transcribe it locally, and optionally send the transcript to Claude.
          </p>
          <button
            type="button"
            class="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg)] hover:opacity-90"
            (click)="goToSettings()"
          >
            Enable in Settings →
          </button>
        </div>
      } @else {
        <div class="flex flex-1 gap-4 overflow-hidden p-6">
          <aside class="w-72 shrink-0 overflow-y-auto border-r border-[var(--line)] pr-4">
            <h2 class="mb-3 text-sm font-semibold uppercase text-[var(--ink-mute)]">
              Sessions ({{ sessions().length }})
            </h2>
            @if (sessions().length === 0) {
              <p class="text-sm text-[var(--ink-mute)]">No recordings yet.</p>
            }
            <ul class="space-y-2">
              @for (s of sessions(); track s.id) {
                <li class="rounded-md border border-[var(--line)] p-3 text-sm">
                  <div class="font-medium">{{ s.created_at }}</div>
                  <div class="text-xs text-[var(--ink-mute)]">
                    {{ s.language }} · {{ statusLabel(s) }} · {{ s.live_segments.length }} segments
                  </div>
                </li>
              }
            </ul>
          </aside>
          <main class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <p class="text-sm text-[var(--ink-mute)]">
              Recording controls and the live transcript view land in the next iteration.
            </p>
            <p class="text-xs text-[var(--ink-mute)]">
              Phase 2 backend (16 Tauri commands) is wired and reachable from this tab's service.
            </p>
          </main>
        </div>
      }
    </section>
  `,
  host: { class: 'flex h-full flex-1' },
})
export class MeetingTranscriptionComponent implements OnInit {
  private readonly transcription = inject(TranscriptionService);
  private readonly router = inject(Router);

  /** `null` while loading, `true`/`false` once the toggle is known. */
  readonly enabled = signal<boolean | null>(null);
  /** Recorded sessions on disk (populated once the toggle is on). */
  readonly sessions = signal<TranscriptSession[]>([]);

  /** Loads the toggle + (if on) the session list. */
  async ngOnInit(): Promise<void> {
    try {
      const on = await this.transcription.isEnabled();
      this.enabled.set(on);
      if (on) {
        this.sessions.set(await this.transcription.list());
      }
    } catch (err) {
      console.warn('meeting-transcription init failed:', err);
      // Fall back to the empty state if we can't reach the backend.
      this.enabled.set(false);
    }
  }

  /** Sends the user to Settings (where Phase 3 puts the toggle). */
  goToSettings(): void {
    void this.router.navigateByUrl('/settings');
  }

  /**
   * Short status label for the session list.
   * @param s - the session to summarise.
   */
  statusLabel(s: TranscriptSession): string {
    return s.status.state;
  }
}
