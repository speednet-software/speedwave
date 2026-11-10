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

import { TauriService } from '../../services/tauri.service';
import { AccessRestartService } from '../../services/access-restart.service';
import { AccessMode, IntegrationAccessView } from '../../models/access';
import { isGitForge } from '../../models/integration';
import { errorText } from '../error-text';

/** Access control of one integration. */
@Component({
  selector: 'app-integration-access',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-testid="integration-access">
      @let current = view();
      <div class="flex items-center gap-3">
        <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
          Access
        </span>
        @if (current !== null) {
          <div role="radiogroup" aria-label="Access" class="flex gap-2">
            @for (option of options; track option.mode) {
              <button
                type="button"
                role="radio"
                class="pill"
                [class.accent]="effective(current) === option.mode"
                [attr.aria-checked]="effective(current) === option.mode"
                [disabled]="locked(current)"
                [attr.title]="globalHint(current)"
                [attr.data-testid]="option.testId"
                (click)="select(option.mode)"
              >
                {{ option.label }}
              </button>
            }
          </div>
        }
      </div>
      @if (current !== null && current.global_read_only && explainGlobal()) {
        <p class="mt-1 text-[11px] text-[var(--ink-mute)]" data-testid="integration-access-reason">
          @if (current.global_locked) {
            Set by your organization. It cannot be changed here.
          } @else {
            All integrations and plugins are read-only (Settings, Integration access).
          }
        </p>
      }
      @if (!compact()) {
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
  readonly compact = input(false);
  readonly explainGlobal = input(false);

  protected readonly options: { mode: AccessMode; label: string; testId: string }[] = [
    { mode: 'full', label: 'Full', testId: 'integration-access-full' },
    { mode: 'read_only', label: 'Read-only', testId: 'integration-access-read-only' },
  ];
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

  protected effective(view: IntegrationAccessView): AccessMode {
    return view.global_read_only ? 'read_only' : view.mode;
  }

  protected globalHint(view: IntegrationAccessView): string | null {
    if (!view.global_read_only || this.explainGlobal()) return null;
    return view.global_locked
      ? 'Set for all integrations and plugins by your organization'
      : 'Set for all integrations and plugins in Settings, Integration access';
  }

  protected locked(view: IntegrationAccessView): boolean {
    return view.global_read_only || this.busy();
  }

  protected async select(mode: AccessMode): Promise<void> {
    const project = this.project();
    const current = this.view();
    if (!project || !current || this.effective(current) === mode) return;
    const service = this.service();
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
