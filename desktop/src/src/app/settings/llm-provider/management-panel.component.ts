import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { ManagedMarkComponent } from '../../shared/managed-mark.component';
import { ManagementService } from '../../services/management.service';
import { ModelPickerService } from '../../services/model-picker.service';
import {
  complianceLabel,
  complianceTone,
  deploymentLabel,
  riskLabel,
} from '../../models/management';

/** Settings › LLM providers under the organisation's management: what it applies to the project, read-only. */
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

        <dt class="text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">deployment</dt>
        <dd class="text-[var(--ink)]" data-testid="settings-management-deployment">
          {{ deployment() }}
        </dd>

        <dt class="text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">models</dt>
        <dd class="flex flex-wrap items-center gap-2" data-testid="settings-management-models">
          @for (m of models(); track m) {
            <span
              class="rounded border border-[var(--line-strong)] px-1.5 py-0.5 text-[11px] text-[var(--ink)]"
            >
              {{ label(m) }}
              @if (m === applied()?.default_model) {
                <span class="ml-1 text-[9px] uppercase tracking-wide text-[var(--ink-mute)]"
                  >default</span
                >
              }
            </span>
          } @empty {
            <span class="text-[var(--ink-mute)]">—</span>
          }
          @if (applied()?.pinned) {
            <span class="text-[11px] text-[var(--ink-mute)]"
              >pinned by {{ status()?.organization || 'the organisation' }}</span
            >
          }
        </dd>

        <dt class="text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">use case</dt>
        <dd class="text-[var(--ink)]" data-testid="settings-management-use-case">
          {{ applied()?.use_case?.name || 'Not assigned to a use case' }}
        </dd>

        <dt class="text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">compliance</dt>
        <dd
          class="flex items-center gap-1.5 text-[var(--ink)]"
          data-testid="settings-management-compliance"
        >
          <span [style.color]="toneColour()">●</span>{{ compliance() }}
          <span class="text-[var(--ink-mute)]">· risk {{ risk() }}</span>
        </dd>

        <dt class="text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">access</dt>
        <dd [style.color]="applied()?.access === 'SUSPENDED' ? 'var(--red)' : 'var(--ink)'">
          {{
            applied()?.access === 'SUSPENDED'
              ? 'suspended by ' + (status()?.organization || 'the organisation')
              : 'allowed'
          }}
        </dd>

        <dt class="text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">agent</dt>
        <dd class="text-[var(--ink)]">{{ agent() }}</dd>
      </dl>
    </div>
  `,
})
export class ManagementPanelComponent {
  private readonly management = inject(ManagementService);
  private readonly picker = inject(ModelPickerService);

  /** The project whose route is shown (the active one). */
  readonly project = input<string | null>(null);

  protected readonly status = computed(
    () => this.management.statusFor(this.project()) ?? this.management.active()
  );
  protected readonly applied = computed(() => this.status()?.project ?? null);
  protected readonly reachable = computed(() => !!this.status()?.reachable);
  protected readonly models = computed(() => this.applied()?.models ?? []);
  protected readonly deployment = computed(() => deploymentLabel(this.applied()?.deployment));
  protected readonly compliance = computed(() =>
    complianceLabel(this.applied()?.use_case?.compliance)
  );
  protected readonly risk = computed(() =>
    riskLabel(this.applied()?.use_case?.compliance?.riskCategory)
  );
  protected readonly toneColour = computed(() => {
    const tone = complianceTone(this.applied()?.use_case?.compliance);
    return { ok: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)', none: 'var(--ink-mute)' }[
      tone
    ];
  });
  protected readonly agent = computed(() => {
    const s = this.status();
    return s?.package_version ? `${s.provider ?? 'Agent'} ${s.package_version}` : '—';
  });

  protected readonly label = (model: string): string => this.picker.label(model, this.project());

  /** Asks the provider about the project when it changes. */
  constructor() {
    effect(() => {
      const p = this.project();
      if (p) void this.management.refresh(p);
    });
  }
}
