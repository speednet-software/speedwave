import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ModelPickerService } from '../../services/model-picker.service';
import { ProjectStateService } from '../../services/project-state.service';

/** Renders a `/model`/`/effort` control message as a compact system chip. */
@Component({
  selector: 'app-control-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-1' },
  template: `
    <span
      data-testid="control-chip"
      [attr.data-command]="command()"
      class="mono inline-flex items-center gap-1.5 rounded-full border border-[var(--line-strong)] px-2.5 py-0.5 text-[11.5px] text-[var(--ink-mute)]"
    >
      {{ command() }} -> {{ shownArgument() }}
    </span>
  `,
})
export class ControlChipComponent {
  private readonly labels = inject(ModelPickerService);
  private readonly projectState = inject(ProjectStateService);

  readonly command = input.required<string>();

  readonly argument = input.required<string>();

  protected readonly shownArgument = computed<string>(() =>
    this.command() === 'model'
      ? this.labels.label(this.argument(), this.projectState.activeProject())
      : this.argument()
  );
}
