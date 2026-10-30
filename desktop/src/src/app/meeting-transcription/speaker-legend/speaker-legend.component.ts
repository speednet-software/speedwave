import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { IconComponent } from '../../shared/icon.component';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { SpeakerMarkComponent } from '../speaker-mark/speaker-mark.component';
import { linesLabel, speakerActionLabel, type Speaker } from '../speaker-names';

/** Chips shown before the rest fold into "+N". */
const VISIBLE_CHIPS = 4;

/** What the approximate-labels note says in its tooltip. */
const APPROXIMATE_NOTE =
  'Labels are approximate: one person can get two labels and one label can cover two people. ' +
  'Names you give go to the export and to what Claude gets.';

/** A request to name a speaker, with the element focus returns to afterwards. */
export interface NameRequest {
  id: number;
  trigger: HTMLElement | null;
}

/**
 * Speaker chips above the transcript: a chip opens the name dialog, highlights its speaker's
 * lines while hovered or focused, and chips past {@link VISIBLE_CHIPS} fold into "+N".
 */
@Component({
  selector: 'app-speaker-legend',
  imports: [IconComponent, TooltipDirective, SpeakerMarkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="mt-2.5 flex flex-wrap items-center gap-1.5" data-testid="speaker-legend">
      @for (s of shown(); track s.id) {
        <button
          type="button"
          class="inline-flex min-w-0 max-w-[min(16rem,100%)] items-center gap-1.5 rounded-md border bg-[var(--bg-1)] py-1 pl-2 pr-2.5 text-[12px] hover:bg-[var(--bg-2)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] disabled:cursor-default disabled:hover:bg-[var(--bg-1)]"
          data-testid="speaker-chip"
          [class.border-dashed]="!s.name"
          [class.border-[var(--line-strong)]]="!s.name && highlighted() !== s.id"
          [class.border-[var(--line)]]="!!s.name && highlighted() !== s.id"
          [class.border-[var(--accent)]]="highlighted() === s.id"
          [disabled]="!editable()"
          [attr.aria-label]="editable() ? actionLabel(s) : s.label + ', ' + lines(s.lines)"
          (click)="name.emit({ id: s.id, trigger: $any($event.currentTarget) })"
          (mouseenter)="hover.emit(s.id)"
          (mouseleave)="hover.emit(null)"
          (focus)="hover.emit(s.id)"
          (blur)="hover.emit(null)"
        >
          <app-speaker-mark [speaker]="s" />
          <span
            class="truncate"
            [class.font-medium]="!!s.name"
            [class.text-[var(--ink)]]="!!s.name"
            [class.text-[var(--ink-dim)]]="!s.name"
            >{{ s.label }}</span
          >
          <span class="mono shrink-0 text-[10.5px] text-[var(--ink-mute)]">{{
            lines(s.lines)
          }}</span>
          @if (!s.name && editable()) {
            <app-icon name="pencil" class="h-3 w-3 shrink-0 text-[var(--ink-mute)] opacity-60" />
          }
        </button>
      }
      @if (hidden().length > 0 && !expanded()) {
        <button
          type="button"
          class="inline-flex shrink-0 items-center gap-1 rounded-md border bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--ink-dim)] hover:bg-[var(--bg-2)]"
          data-testid="speaker-more"
          [class.border-dashed]="hiddenUnnamed() > 0"
          [class.border-[var(--line-strong)]]="hiddenUnnamed() > 0"
          [class.border-[var(--line)]]="hiddenUnnamed() === 0"
          [attr.aria-label]="'Show ' + hidden().length + ' more speakers'"
          (click)="expanded.set(true)"
        >
          +{{ hidden().length
          }}{{ hiddenUnnamed() > 0 ? ' · ' + hiddenUnnamed() + ' unnamed' : '' }}
          <app-icon name="chevron-down" class="h-3 w-3" />
        </button>
      }
      @if (expanded()) {
        <button
          type="button"
          class="shrink-0 rounded px-1.5 py-1 text-[11.5px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
          data-testid="speaker-fewer"
          (click)="expanded.set(false)"
        >
          Show fewer
        </button>
      }
      @if (canReapply() && editable()) {
        <button
          type="button"
          class="mono shrink-0 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
          data-testid="speaker-reapply"
          (click)="reapply.emit($any($event.currentTarget))"
        >
          Reapply names…
        </button>
      }
      <button
        type="button"
        class="shrink-0 whitespace-nowrap px-1 text-[11.5px] text-[var(--ink-mute)] underline decoration-dotted underline-offset-2 hover:text-[var(--ink-dim)]"
        data-testid="speaker-approximate"
        [appTooltip]="approximateNote"
        [attr.aria-label]="approximateNote"
        placement="bottom"
      >
        Labels are approximate
      </button>
    </div>
  `,
})
export class SpeakerLegendComponent {
  /** The transcript's speakers, those with the most lines first. */
  readonly speakers = input.required<Speaker[]>();
  /** The speaker whose lines are highlighted, if any. */
  readonly highlighted = input<number | null>(null);
  /** Whether the speakers can be named now; while a transcription runs the chips only show. */
  readonly editable = input(true);
  /** Whether names from before the last transcription can be given again. */
  readonly canReapply = input(false);
  /** The user asked to name a speaker. */
  readonly name = output<NameRequest>();
  /** The speaker under the pointer or focus, or null when it left. */
  readonly hover = output<number | null>();
  /** The user asked to give the earlier names again; carries the button. */
  readonly reapply = output<HTMLElement | null>();

  protected readonly approximateNote = APPROXIMATE_NOTE;
  protected readonly expanded = signal(false);
  protected readonly shown = computed(() =>
    this.expanded() ? this.speakers() : this.speakers().slice(0, VISIBLE_CHIPS)
  );
  protected readonly hidden = computed(() => this.speakers().slice(VISIBLE_CHIPS));
  protected readonly hiddenUnnamed = computed(() => this.hidden().filter((s) => !s.name).length);
  protected readonly lines = linesLabel;
  protected readonly actionLabel = speakerActionLabel;
}
