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
import { swatchFor } from './project-swatch';

/** Header pill showing the active project; opens the project switcher on click. */
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
        class="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-[8px] font-bold text-[#07090f]"
        [style.background]="swatch()"
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

  /** Active project name. */
  protected readonly projectName = signal<string>('');

  /** Position of the active project in the list — drives the swatch. -1 when no project. */
  protected readonly activeIndex = signal<number>(-1);

  /** First two letters of the active project name, lowercased. Falls back to a dot. */
  protected readonly monogram = computed(() => {
    const name = this.projectName().trim();
    if (!name) return '·';
    return name.slice(0, 2).toLowerCase();
  });

  /** Swatch color matching the same project's row in the switcher dropdown. */
  protected readonly swatch = computed(() => swatchFor(this.activeIndex()));

  private unsubscribe: (() => void) | null = null;

  /** Subscribes to project state changes. */
  ngOnInit(): void {
    this.refresh();
    this.unsubscribe = this.projectState.onChange(() => this.refresh());
  }

  private refresh(): void {
    const name = this.projectState.activeProject() ?? '';
    this.projectName.set(name);
    this.activeIndex.set(this.projectState.projects.findIndex((p) => p.name === name));
  }

  /** Tears down the project state subscription. */
  ngOnDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
