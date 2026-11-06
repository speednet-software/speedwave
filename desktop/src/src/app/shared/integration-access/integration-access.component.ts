import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

import { TauriService } from '../../services/tauri.service';
import { AccessRestartService } from '../../services/access-restart.service';
import { AccessMode, IntegrationAccessView } from '../../models/access';

/** The Access control of one integration: Full or Read-only. */
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
                [attr.data-testid]="option.testId"
                (click)="select(option.mode)"
              >
                {{ option.label }}
              </button>
            }
          </div>
        }
      </div>
      @if (current !== null && current.global_read_only) {
        <p class="mt-1 text-[11px] text-[var(--ink-mute)]" data-testid="integration-access-reason">
          @if (current.global_locked) {
            Set by your organization. It cannot be changed here.
          } @else {
            Read-only mode is on for the whole project (Settings, Agent access).
          }
        </p>
      }
      @if (!compact()) {
        <p class="mt-1 text-[11px] text-[var(--ink-mute)]" data-testid="integration-access-help">
          Read-only blocks the tools that send, create, edit or delete. Reads still work.
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

  protected readonly options: { mode: AccessMode; label: string; testId: string }[] = [
    { mode: 'full', label: 'Full', testId: 'integration-access-full' },
    { mode: 'read_only', label: 'Read-only', testId: 'integration-access-read-only' },
  ];
  protected readonly view = signal<IntegrationAccessView | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  private readonly tauri = inject(TauriService);
  private readonly hub = inject(AccessRestartService);

  /** Reloads the stored mode whenever the project or the integration changes. */
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

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
