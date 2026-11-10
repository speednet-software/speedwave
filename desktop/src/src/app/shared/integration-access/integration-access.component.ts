import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';

import { TauriService } from '../../services/tauri.service';
import { AccessRestartService } from '../../services/access-restart.service';
import { AccessMode, IntegrationAccessView } from '../../models/access';
import { isGitForge } from '../../models/integration';
import { errorText } from '../error-text';
import { ToggleComponent } from '../toggle.component';

/** Access switch of one integration: always read-only, or follow the project setting. */
@Component({
  selector: 'app-integration-access',
  imports: [ToggleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-testid="integration-access">
      @let current = view();
      @if (current !== null) {
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-[12px] text-[var(--ink)]">Always read-only</div>
            <div class="text-[11px] text-[var(--ink-mute)]" data-testid="integration-access-status">
              @if (current.mode === 'read_only') {
                Currently read-only.
              } @else if (!current.global_read_only) {
                Currently full. Follows the project setting.
              } @else if (current.global_locked) {
                Currently read-only, set by your organization for all integrations.
              } @else {
                Currently read-only, from the project setting in
                <a
                  href="/settings#section-access"
                  class="text-inherit underline decoration-current/40 underline-offset-2 hover:decoration-current focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
                  data-testid="integration-access-settings-link"
                  (click)="openSettings($event)"
                  >Settings</a
                >.
              }
            </div>
          </div>
          <app-toggle
            testId="integration-access-always"
            [ariaLabel]="'Always read-only for ' + (name() || service())"
            [checked]="current.mode === 'read_only'"
            [disabled]="busy()"
            (changed)="onToggle($event)"
          />
        </div>
        <p class="mt-1 text-[11px] text-[var(--ink-mute)]" data-testid="integration-access-help">
          {{ helpText() }}
        </p>
      }
      @if (error()) {
        <p
          class="mt-1 text-[11px] text-red-300"
          role="alert"
          data-testid="integration-access-error"
        >
          {{ error() }}
        </p>
      }
    </div>
  `,
})
export class IntegrationAccessComponent {
  readonly project = input<string | null>(null);
  readonly service = input.required<string>();
  readonly name = input('');

  protected readonly view = signal<IntegrationAccessView | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly helpText = computed(() => {
    const service = this.service();
    if (isGitForge(service)) {
      return 'Read-only blocks the tools that send, create, edit or delete, and git push. Reads, fetch and pull still work.';
    }
    if (service === 'playwright') {
      return 'Read-only blocks opening pages, clicking and typing, so the browser does not work in this mode.';
    }
    return 'Read-only blocks the tools that send, create, edit or delete. Reads still work.';
  });

  private readonly tauri = inject(TauriService);
  private readonly hub = inject(AccessRestartService);
  private readonly router = inject(Router);

  /** Reloads the view when the project or integration changes. */
  constructor() {
    effect(() => {
      const project = this.project();
      const service = this.service();
      untracked(() => {
        this.view.set(null);
        this.error.set('');
        if (project) void this.load(project, service);
      });
    });
  }

  protected openSettings(event: Event): void {
    event.preventDefault();
    void this.router.navigate(['/settings'], { fragment: 'section-access' });
  }

  protected async onToggle(event: Event): Promise<void> {
    const mode: AccessMode = (event.target as HTMLInputElement).checked ? 'read_only' : 'full';
    const project = this.project();
    const current = this.view();
    if (!project || !current || current.mode === mode) return;
    const service = this.service();
    this.view.set({ ...current, mode });
    this.busy.set(true);
    this.error.set('');
    try {
      const next = await this.tauri.invoke<IntegrationAccessView>('set_integration_access_mode', {
        project,
        service,
        mode,
      });
      if (this.project() === project && this.service() === service) this.view.set(next);
      await this.hub.apply(project);
    } catch (e: unknown) {
      this.error.set(errorText(e));
      await this.load(project, service);
    } finally {
      this.busy.set(false);
    }
  }

  private async load(project: string, service: string): Promise<void> {
    try {
      const next = await this.tauri.invoke<IntegrationAccessView>('get_integration_access', {
        project,
        service,
      });
      if (this.project() === project && this.service() === service && next) this.view.set(next);
    } catch (e: unknown) {
      this.error.set(errorText(e));
    }
  }
}
