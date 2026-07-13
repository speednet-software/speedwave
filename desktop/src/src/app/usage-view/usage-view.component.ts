import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ProjectStateService } from '../services/project-state.service';
import { ProjectPillComponent } from '../project-switcher/project-pill.component';
import { LlmUsageComponent } from '../settings/llm-usage/llm-usage.component';

/** LLM usage page (ADR-073) — its own nav-rail entry (chart icon). Hosts the per-day/per-model aggregate from the proxy's usage log for the active project, outside Settings. */
@Component({
  selector: 'app-usage-view',
  imports: [ProjectPillComponent, LlmUsageComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex h-full flex-col bg-[var(--bg)] text-[var(--ink)]',
  },
  template: `
    <!-- Header band — 44px tall, matches the other views -->
    <div
      class="flex h-11 flex-shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--bg-1)] px-4 md:px-6"
    >
      <h1 class="view-title view-title-page truncate text-[var(--ink)]" data-testid="usage-title">
        LLM usage
      </h1>
      <div class="ml-auto flex flex-shrink-0 items-center gap-3">
        <app-project-pill />
      </div>
    </div>

    <!-- Scrollable content -->
    <div class="flex-1 overflow-y-auto p-4 md:p-6">
      <div class="mx-auto max-w-3xl">
        @if (projectState.activeProject(); as project) {
          <p class="mb-3 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
            Requests routed through the project's LLM proxy, aggregated per day and model.
            Subscription traffic shows token counts; API-priced models also show cost.
          </p>
          <app-llm-usage [project]="project" />
        } @else {
          <p class="mono text-[11px] text-[var(--ink-mute)]" data-testid="usage-no-project">
            No active project.
          </p>
        }
      </div>
    </div>
  `,
})
export class UsageViewComponent {
  protected readonly projectState = inject(ProjectStateService);
}
