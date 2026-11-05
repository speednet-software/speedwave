import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { IconComponent } from '../../shared/icon.component';
import { BetaService } from '../../services/beta.service';
import { RecordingPlaybackService } from '../../services/recording-playback.service';
import { formatClock } from '../recording-format';
import { SpeakerMarkComponent } from '../speaker-mark/speaker-mark.component';
import type { Speaker } from '../speaker-names';

/** Who speaks in the playing span. */
export interface PlaybackSpeaker {
  label: string | null;
  speaker: Pick<Speaker, 'id' | 'color' | 'mark'> | null;
}

/** Recording playback bar. */
@Component({
  selector: 'app-playback-bar',
  imports: [IconComponent, SpeakerMarkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (playback.current(); as now) {
      <div
        role="region"
        aria-label="Recording playback"
        class="flex items-center gap-2 border-t border-[var(--line)] bg-[var(--bg-1)] py-1.5 pl-8 text-[12px]"
        [class.pr-8]="!beta.enabled()"
        [class.pr-16]="beta.enabled()"
        data-testid="playback-bar"
      >
        <button
          type="button"
          class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--ink)] hover:bg-[var(--bg-3)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] disabled:opacity-40"
          data-testid="playback-toggle"
          [disabled]="now.state === 'loading'"
          [attr.aria-label]="now.state === 'playing' ? 'Pause' : 'Play'"
          (click)="toggle()"
        >
          <app-icon [name]="now.state === 'playing' ? 'pause' : 'play'" class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--ink-dim)] hover:bg-[var(--bg-3)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] disabled:opacity-40"
          aria-label="Play again"
          data-testid="playback-replay"
          [disabled]="now.state === 'loading'"
          (click)="replay()"
        >
          <app-icon name="replay" class="h-3.5 w-3.5" />
        </button>
        <span class="flex min-w-0 items-center gap-1.5" data-testid="playback-what">
          @if (who()?.speaker; as sp) {
            <app-speaker-mark [speaker]="sp" />
          }
          @if (who()?.label; as label) {
            <span class="truncate font-medium text-[var(--ink)]">{{ label }}</span>
          }
          <span class="mono shrink-0 tabular-nums text-[var(--ink-mute)]">{{ range() }}</span>
        </span>
        <div
          role="progressbar"
          aria-label="Played"
          class="h-1 min-w-12 flex-1 overflow-hidden rounded bg-[var(--bg-3)]"
          data-testid="playback-progress"
          aria-valuemin="0"
          aria-valuemax="100"
          [attr.aria-valuenow]="percent()"
        >
          <div class="h-full bg-[var(--accent)]" [style.width.%]="percent()"></div>
        </div>
        @if (nameable() && who()?.speaker; as sp) {
          <button
            type="button"
            class="mono shrink-0 rounded border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--ink-dim)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            data-testid="playback-name"
            (click)="name.emit({ id: sp.id, trigger: $any($event.currentTarget) })"
          >
            Name…
          </button>
        }
        <button
          type="button"
          class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--ink-mute)] hover:bg-[var(--bg-3)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
          aria-label="Stop playback"
          data-testid="playback-stop"
          (click)="playback.stop()"
        >
          <app-icon name="x" class="h-3.5 w-3.5" />
        </button>
      </div>
    }
  `,
})
export class PlaybackBarComponent {
  readonly who = input<PlaybackSpeaker | null>(null);
  readonly nameable = input(false);
  readonly name = output<{ id: number; trigger: HTMLElement | null }>();
  readonly failed = output<string>();

  protected readonly playback = inject(RecordingPlaybackService);
  protected readonly beta = inject(BetaService);

  protected readonly range = computed(() => {
    const now = this.playback.current();
    return now ? `${formatClock(now.startSecs * 1000)}–${formatClock(now.endSecs * 1000)}` : '';
  });

  protected readonly percent = computed(() => {
    const duration = this.playback.duration();
    if (duration <= 0) return 0;
    return Math.min(100, Math.round((this.playback.position() / duration) * 100));
  });

  protected async toggle(): Promise<void> {
    const now = this.playback.current();
    if (!now) return;
    try {
      await this.playback.toggle(now);
    } catch (e) {
      this.failed.emit(e instanceof Error ? e.message : String(e));
    }
  }

  protected async replay(): Promise<void> {
    try {
      await this.playback.replay();
    } catch (e) {
      this.failed.emit(e instanceof Error ? e.message : String(e));
    }
  }
}
