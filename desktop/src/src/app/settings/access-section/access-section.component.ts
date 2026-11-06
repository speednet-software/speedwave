import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import { TauriService } from '../../services/tauri.service';
import { AccessRestartService } from '../../services/access-restart.service';
import { ToggleComponent } from '../../shared/toggle.component';
import { AccessSettingsView } from '../../models/access';

/** Settings, Agent access: the project's global read-only mode for integrations. */
@Component({
  selector: 'app-access-section',
  imports: [ToggleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      id="section-access"
      class="border-t border-[var(--line)] pt-6"
      data-testid="settings-section-access"
    >
      <h2 class="view-title view-title-section text-[var(--ink)]">Agent access</h2>
      <p class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        In read-only mode the agent reads from every integration but cannot change anything in it:
        tools that send, create, edit or delete are blocked, and a blocked call returns an
        explanation to the agent.
      </p>

      @let current = view();
      @if (current !== null) {
        <div class="mt-4 flex items-center justify-between gap-3">
          <div>
            <div class="text-[12px] text-[var(--ink)]">Read-only mode</div>
            @if (current.read_only_locked) {
              <div class="text-[11px] text-[var(--ink-mute)]" data-testid="read-only-locked-note">
                Set by your organization. It cannot be changed here.
              </div>
            } @else {
              <div class="text-[11px] text-[var(--ink-mute)]">
                Speedwave restarts the tool hub to apply the change.
              </div>
            }
          </div>
          <app-toggle
            testId="read-only-toggle"
            ariaLabel="Read-only mode"
            [checked]="current.read_only"
            [disabled]="current.read_only_locked || busy()"
            (changed)="onToggle($event)"
          />
        </div>
      }

      <div
        class="mt-4 text-[11px] leading-relaxed text-[var(--ink-mute)]"
        data-testid="read-only-help"
      >
        <p>Read-only mode does not cover:</p>
        <ul class="mt-1 list-disc pl-5">
          <li>Claude Code's own tools: Write, Edit, Bash and WebFetch.</li>
          <li>Internet access from the container, which a separate offline mode will limit.</li>
          <li>Credentials you put into the container by hand.</li>
        </ul>
      </div>
    </section>
  `,
})
export class AccessSectionComponent {
  readonly project = input<string | null>(null);
  readonly errorOccurred = output<string>();

  protected readonly view = signal<AccessSettingsView | null>(null);
  protected readonly busy = signal(false);

  private readonly tauri = inject(TauriService);
  private readonly hub = inject(AccessRestartService);

  /** Reloads the stored mode whenever the project changes. */
  constructor() {
    effect(() => {
      const project = this.project();
      untracked(() => {
        this.view.set(null);
        if (project) void this.load(project);
      });
    });
  }

  protected async onToggle(event: Event): Promise<void> {
    const enabled = (event.target as HTMLInputElement).checked;
    const project = this.project();
    if (!project) return;
    this.view.update((v) => v && { ...v, read_only: enabled });
    this.busy.set(true);
    try {
      const next = await this.tauri.invoke<AccessSettingsView>('set_read_only_mode', {
        project,
        enabled,
      });
      if (this.project() === project) this.view.set(next);
      await this.hub.apply(project);
    } catch (e: unknown) {
      this.errorOccurred.emit(errorText(e));
      await this.load(project);
    } finally {
      this.busy.set(false);
    }
  }

  private async load(project: string): Promise<void> {
    try {
      const next = await this.tauri.invoke<AccessSettingsView>('get_access_settings', { project });
      if (this.project() === project && next) this.view.set(next);
    } catch (e: unknown) {
      this.errorOccurred.emit(errorText(e));
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
