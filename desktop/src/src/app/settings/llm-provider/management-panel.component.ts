import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { ManagedMarkComponent } from '../../shared/managed-mark.component';
import { ManagementService } from '../../services/management.service';

/**
 * Settings › LLM providers under the organisation's management: who manages the machine and whether
 * it answers, read-only. What it allows — each project, service, integration, plugin and agent, a
 * use case of its own — is marked beside each of them, never here (ADR-091).
 */
@Component({
  selector: 'app-management-panel',
  imports: [ManagedMarkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div
      class="mt-3 overflow-hidden rounded border border-[var(--line-strong)] bg-[var(--bg-1)]"
      data-testid="settings-management-panel"
    >
      <div class="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
        <app-managed-mark class="h-5 w-5 text-[var(--ink)]" />
        <div class="min-w-0 flex-1">
          <div class="text-[13px] text-[var(--ink)]">{{ status()?.provider || 'Managed' }}</div>
          <div
            class="mono truncate text-[11px] text-[var(--ink-mute)]"
            data-testid="settings-management-org"
          >
            Managed by {{ status()?.organization || 'your organisation' }}
            @if (status()?.host?.name) {
              · {{ status()?.host?.name }}
            }
          </div>
        </div>
        <span
          class="mono flex items-center gap-1.5 text-[11px]"
          [style.color]="reachable() ? 'var(--green)' : 'var(--amber)'"
        >
          <span>●</span>{{ reachable() ? 'connected' : 'not reachable' }}
          @if (reachable() && status()?.latency_ms !== null) {
            <span class="text-[var(--ink-mute)]">· {{ status()?.latency_ms }} ms</span>
          }
        </span>
      </div>
      @if (status()?.error) {
        <div
          class="mono border-b border-[var(--line)] px-4 py-2 text-[11px] text-[var(--amber)]"
          data-testid="settings-management-error"
        >
          {{ status()?.error }}
        </div>
      }
      <dl class="mono grid grid-cols-[120px_1fr] gap-x-4 gap-y-2.5 px-4 py-3 text-[12px]">
        <dt class="text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">gateway</dt>
        <dd class="truncate text-[var(--ink)]">{{ status()?.status_url || '—' }}</dd>

        <dt class="text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">agent</dt>
        <dd class="text-[var(--ink)]">{{ agent() }}</dd>
      </dl>
    </div>
  `,
})
export class ManagementPanelComponent {
  private readonly management = inject(ManagementService);

  /** The active project (the provider is asked through it). */
  readonly project = input<string | null>(null);

  protected readonly status = computed(
    () => this.management.statusFor(this.project()) ?? this.management.active()
  );
  protected readonly reachable = computed(() => !!this.status()?.reachable);
  protected readonly agent = computed(() => {
    const s = this.status();
    return s?.package_version ? `${s.provider ?? 'Agent'} ${s.package_version}` : '—';
  });

  /** Asks the provider when the project changes. */
  constructor() {
    effect(() => {
      const p = this.project();
      if (p) void this.management.refresh(p);
    });
  }
}
