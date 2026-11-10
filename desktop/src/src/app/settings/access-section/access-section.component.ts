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
import { errorText } from '../../shared/error-text';

/** Read-only integrations section. */
@Component({
  selector: 'app-access-section',
  imports: [ToggleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section
      id="section-access"
      class="border-t border-[var(--line)] pt-6"
      data-testid="settings-section-access"
    >
      <h2 class="view-title view-title-section text-[var(--ink)]">Read-only integrations</h2>
      <p
        class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]"
        data-testid="read-only-intro"
      >
        Read-only stops the agent from changing anything in the services Speedwave connects to: it
        cannot send messages, edit issues or push code. It can still read from them.
      </p>

      @let current = view();
      @if (current !== null) {
        <div class="mt-4 flex items-center justify-between gap-3">
          <div>
            <div class="text-[12px] text-[var(--ink)]">All integrations and plugins read-only</div>
            <div class="text-[11px] text-[var(--ink-mute)]" data-testid="read-only-summary">
              Applies to every integration, macOS integration and installed plugin.
            </div>
            @if (current.read_only_locked) {
              <div class="text-[11px] text-[var(--ink-mute)]" data-testid="read-only-locked-note">
                Set by your organization. It cannot be changed here.
              </div>
            }
          </div>
          <app-toggle
            testId="read-only-toggle"
            ariaLabel="All integrations and plugins read-only"
            [checked]="current.read_only"
            [disabled]="current.read_only_locked || busy()"
            (changed)="onToggle($event)"
          />
        </div>
      }

      <details
        class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-3"
        data-testid="read-only-details"
      >
        <summary class="cursor-pointer select-none text-[12px] text-[var(--ink-dim)]">
          What read-only blocks and allows
        </summary>
        <dl
          class="mt-3 space-y-2 text-[11.5px] leading-relaxed text-[var(--ink-dim)]"
          data-testid="read-only-help"
        >
          <div>
            <dt class="text-[var(--ink)]">Blocked</dt>
            <dd>
              Changes in every integration, macOS integration and installed plugin: no messages
              sent, no issues created or edited, nothing deleted, no git push.
            </dd>
          </div>
          <div>
            <dt class="text-[var(--ink)]">Still works</dt>
            <dd>
              Reading from them, and the agent's work in the project: it edits files, runs commands
              and saves downloads and documents into the project folder.
            </dd>
          </div>
          <div>
            <dt class="text-[var(--ink)]">Not covered</dt>
            <dd>
              Internet access from the container, credentials you put into the container by hand.
            </dd>
          </div>
          <div>
            <dt class="text-[var(--ink)]">One integration only</dt>
            <dd>Turn on Always read-only in its panel.</dd>
          </div>
        </dl>
        <p class="mt-3 text-[11px] text-[var(--ink-mute)]">
          Changing the switch restarts the hub and the proxy.
        </p>
      </details>
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

  /** Reloads the view when the project changes. */
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
