import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';

/**
 * Project switcher trigger — the small monogram + name pill rendered in the
 * right slot of every view header (chat, settings, logs, plugins, etc.).
 *
 * Single source of truth for the pill so all views look and behave identically.
 * Reads the active project from {@link ProjectStateService} and toggles the
 * dropdown via {@link UiStateService.toggleProjectSwitcher}.
 *
 * Mockup reference: header right-cluster across all views (lines 488-506,
 * 1481-1492, 1636-1660).
 */
@Component({
  selector: 'app-project-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex' },
  template: `
    <button
      type="button"
      data-testid="project-pill"
      class="mono flex items-center gap-1.5 text-[11px] text-[var(--ink)] hover:text-[var(--accent)]"
      title="Switch project"
      aria-label="Switch project"
      (click)="ui.toggleProjectSwitcher()"
    >
      <span
        class="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-[var(--violet)] text-[8px] font-bold text-[#07090f]"
        aria-hidden="true"
        >{{ monogram() }}</span
      >
      <span>{{ projectName() || 'no project' }}</span>
    </button>
  `,
})
export class ProjectPillComponent implements OnInit, OnDestroy {
  readonly ui = inject(UiStateService);
  private readonly projectState = inject(ProjectStateService);

  /** Active project name — kept in a signal so OnPush re-renders on change. */
  protected readonly projectName = signal<string>('');

  /** First two letters of the active project name, lowercased. Falls back to a dot. */
  protected readonly monogram = computed(() => {
    const name = this.projectName().trim();
    if (!name) return '·';
    return name.slice(0, 2).toLowerCase();
  });

  private unsubscribe: (() => void) | null = null;

  /** Subscribes to project state changes so the pill label stays current. */
  ngOnInit(): void {
    this.refresh();
    this.unsubscribe = this.projectState.onChange(() => this.refresh());
  }

  /** Pulls the active project name out of the shared state into a local signal. */
  private refresh(): void {
    const name = this.projectState.activeProject ?? '';
    this.projectName.set(name);
  }

  /** Tears down the project state subscription. */
  ngOnDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
