import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  WritableSignal,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';

import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { ToggleComponent } from '../../shared/toggle.component';
import { eventChecked, eventValue } from '../../shared/dom-event';
import type {
  OtlpProtocol,
  TelemetryConfigResponse,
  TelemetryConfigUpdate,
} from '../../models/telemetry';

/**
 * A form field that is either untouched (keep the saved/managed value) or
 * touched with an explicit value, incl. `null` to clear it. Bundles the
 * value + touched signal pair every MDM-lockable tri-state field needs.
 */
class TriStateField<T> {
  readonly value: WritableSignal<T>;
  readonly touched = signal(false);

  constructor(initial: T) {
    this.value = signal(initial);
  }

  /**
   * Records an edit: sets the value and marks the field touched.
   * @param value The edited value.
   */
  set(value: T): void {
    this.value.set(value);
    this.touched.set(true);
  }

  /**
   * Reloads the field from a fresh server value and clears touched.
   * @param value The freshly loaded server value.
   */
  reset(value: T): void {
    this.value.set(value);
    this.touched.set(false);
  }

  /**
   * Writes the value onto `update[key]` when touched and unlocked; a locked
   * field is omitted so the server never sees a change attempt for it.
   * @param update The outgoing update payload to write into.
   * @param key The payload key this field maps to.
   * @param locked Whether MDM locks this field.
   */
  applyTo<K extends string, U extends Partial<Record<K, T>>>(
    update: U,
    key: K,
    locked: boolean
  ): void {
    this.applyMappedTo(update, key, locked, (v) => v);
  }

  /**
   * Like {@link applyTo}, but maps the value first — e.g. an emptied string
   * to `null` (clear) before it reaches the wire type.
   * @param update The outgoing update payload to write into.
   * @param key The payload key this field maps to.
   * @param locked Whether MDM locks this field.
   * @param transform Maps the edited value to its wire type.
   */
  applyMappedTo<K extends string, W, U extends Partial<Record<K, W>>>(
    update: U,
    key: K,
    locked: boolean,
    transform: (value: T) => W
  ): void {
    if (this.touched() && !locked) {
      update[key] = transform(this.value()) as U[K];
    }
  }
}

/**
 * Settings → Telemetry: point Claude Code at your own OTLP collector. MDM-locked fields render
 * read-only; the headers secret never leaves the host.
 */
@Component({
  selector: 'app-telemetry-section',
  imports: [ToggleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section
      id="section-telemetry"
      class="border-t border-[var(--line)] pt-6"
      data-testid="settings-section-telemetry"
    >
      <h2 class="view-title view-title-section text-[var(--ink)]">Telemetry</h2>
      <p class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        Send Speedwave usage telemetry to your own OpenTelemetry (OTLP) collector.
      </p>

      @if (error() && !saveError()) {
        <p class="mt-2 text-[12px] text-[var(--red)]" data-testid="telemetry-error">
          {{ error() }}
        </p>
      }

      @if (config(); as c) {
        @if (c.kill_switch) {
          <div
            class="mono mt-4 flex items-center gap-2 rounded border border-[var(--line)] bg-[var(--bg-1)] px-4 py-3 text-[11px] text-[var(--ink-mute)]"
            data-testid="telemetry-killswitch"
          >
            <span aria-hidden="true">🔒</span>
            Managed by your organization — telemetry cannot be changed here.
          </div>
        } @else {
          @if (c.any_locked) {
            <div
              class="mono mt-4 flex items-center gap-2 rounded border border-[var(--line)] bg-[var(--bg-2)] px-4 py-2 text-[11px] text-[var(--ink-mute)]"
              data-testid="telemetry-managed-banner"
            >
              <span aria-hidden="true">🔒</span>
              Some settings are managed by your organization.
            </div>
          }
          <div class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)]">
            <!-- Enable: label + toggle on one line, like an integration row -->
            <div class="flex items-center justify-between gap-3 px-4 py-3">
              <div class="min-w-0">
                <div class="text-[13px] text-[var(--ink)]">Send telemetry</div>
                <div class="mt-0.5 text-[11px] text-[var(--ink-dim)]">
                  @if (c.locks.enabled) {
                    <span class="mono text-[var(--ink-mute)]">🔒 Managed by your organization</span>
                  } @else {
                    Off means no data leaves this machine.
                  }
                </div>
              </div>
              <app-toggle
                [checked]="enabled()"
                [disabled]="c.locks.enabled"
                testId="telemetry-enabled"
                ariaLabel="Send telemetry"
                (changed)="enabled.set(eventChecked($event))"
              />
            </div>

            @if (enabled()) {
              <div class="space-y-5 border-t border-[var(--line)] px-4 py-4">
                <!-- Endpoint -->
                <div>
                  <label
                    class="mono mb-1 flex items-center gap-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                    for="telemetry-endpoint"
                  >
                    Collector endpoint
                    @if (c.locks.endpoint) {
                      <span class="normal-case tracking-normal">🔒 managed</span>
                    }
                  </label>
                  <input
                    id="telemetry-endpoint"
                    type="url"
                    class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)] read-only:opacity-60"
                    placeholder="https://collector.example.com:4318"
                    [value]="endpoint()"
                    [readonly]="c.locks.endpoint"
                    (input)="onEndpointInput(eventValue($event))"
                    data-testid="telemetry-endpoint"
                  />
                  <div class="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:cursor-not-allowed disabled:opacity-40"
                      [disabled]="!endpoint() || probing()"
                      (click)="testConnection()"
                      data-testid="telemetry-probe"
                    >
                      {{ probing() ? 'testing…' : 'Test connection' }}
                    </button>
                    @if (probing()) {
                      <span
                        class="mono text-[11px] text-[var(--ink-mute)]"
                        data-testid="telemetry-probing"
                      >
                        Probing {{ endpoint() }}…
                      </span>
                    }
                    @if (!probing() && probeResult(); as result) {
                      <span
                        class="mono text-[11px]"
                        [class]="
                          result === 'reachable' ? 'text-[var(--green)]' : 'text-[var(--red)]'
                        "
                        data-testid="telemetry-probe-result"
                      >
                        {{ result }}
                      </span>
                    }
                  </div>
                </div>

                <!-- Protocol + exporters -->
                <div>
                  <div
                    class="mono mb-1 flex items-center gap-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  >
                    Transport &amp; signals
                    @if (transportManaged()) {
                      <span
                        class="normal-case tracking-normal"
                        data-testid="telemetry-transport-managed"
                        >🔒 managed</span
                      >
                    }
                  </div>
                  <div class="flex flex-wrap items-center gap-4 text-[11px] text-[var(--ink)]">
                    <label class="mono flex items-center gap-1.5">
                      Protocol
                      <select
                        class="mono min-w-[9rem] rounded border border-[var(--line)] bg-[var(--bg-1)] px-1.5 py-1 text-[11px] disabled:opacity-60"
                        [value]="protocol()"
                        [disabled]="c.locks.protocol"
                        (change)="setProtocol($event)"
                        data-testid="telemetry-protocol"
                      >
                        @for (o of protocolOptions; track o.value) {
                          <!-- Select on the option, not [value] on select: @for options mount after the select's bindings flush. -->
                          <option [value]="o.value" [selected]="o.value === protocol()">
                            {{ o.label }}
                          </option>
                        }
                      </select>
                    </label>
                    <label class="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        class="accent-[var(--accent)]"
                        [checked]="exportMetrics()"
                        [disabled]="c.locks.export_metrics"
                        (change)="exportMetrics.set(eventChecked($event))"
                      />
                      Metrics
                    </label>
                    <label class="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        class="accent-[var(--accent)]"
                        [checked]="exportLogs()"
                        [disabled]="c.locks.export_logs"
                        (change)="exportLogs.set(eventChecked($event))"
                      />
                      Logs
                    </label>
                  </div>
                </div>

                <!-- Auth headers (masked secret) -->
                <div>
                  <label
                    class="mono mb-1 flex items-center gap-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                    for="telemetry-headers"
                  >
                    Auth headers
                    @if (c.locks.headers) {
                      <span class="normal-case tracking-normal">🔒 managed</span>
                    }
                  </label>
                  <input
                    id="telemetry-headers"
                    type="password"
                    autocomplete="off"
                    class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)] read-only:opacity-60"
                    [value]="headers()"
                    [readonly]="c.locks.headers"
                    [placeholder]="
                      c.has_headers
                        ? '••••• (saved — type to replace, clear to remove)'
                        : 'Authorization=Bearer …'
                    "
                    (input)="onHeadersInput(eventValue($event))"
                    data-testid="telemetry-headers"
                  />
                </div>

                <!-- Advanced tuning: resource attributes, account uuid, export intervals -->
                <details class="rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-2">
                  <summary
                    class="mono cursor-pointer text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  >
                    Advanced (resource attributes, intervals)
                    @if (advancedManaged()) {
                      <span
                        class="normal-case tracking-normal"
                        data-testid="telemetry-advanced-managed"
                        >🔒 managed</span
                      >
                    }
                  </summary>
                  <div class="mt-2 space-y-3">
                    <div>
                      <label
                        class="mono mb-1 flex items-center gap-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                        for="telemetry-resource-attributes"
                      >
                        Resource attributes
                        @if (c.locks.resource_attributes) {
                          <span class="normal-case tracking-normal">🔒 managed</span>
                        }
                      </label>
                      <input
                        id="telemetry-resource-attributes"
                        type="text"
                        class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)] read-only:opacity-60"
                        placeholder="team=platform,env=prod"
                        [value]="resourceAttributes()"
                        [readonly]="c.locks.resource_attributes"
                        (input)="onResourceAttributesInput(eventValue($event))"
                        data-testid="telemetry-resource-attributes"
                      />
                    </div>
                    <label class="flex items-center gap-1.5 text-[11px] text-[var(--ink)]">
                      <input
                        type="checkbox"
                        class="accent-[var(--accent)]"
                        [checked]="includeAccountUuid()"
                        [disabled]="c.locks.include_account_uuid"
                        (change)="includeAccountUuid.set(eventChecked($event))"
                        data-testid="telemetry-include-account-uuid"
                      />
                      Include account UUID
                      @if (c.locks.include_account_uuid) {
                        <span class="mono text-[var(--ink-mute)]">🔒 managed</span>
                      }
                    </label>
                    <div class="flex flex-wrap gap-4">
                      <div>
                        <label
                          class="mono mb-1 flex items-center gap-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                          for="telemetry-metric-interval"
                        >
                          Metric interval (ms)
                          @if (c.locks.metric_export_interval_ms) {
                            <span class="normal-case tracking-normal">🔒</span>
                          }
                        </label>
                        <input
                          id="telemetry-metric-interval"
                          type="number"
                          min="1"
                          class="mono w-32 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)] read-only:opacity-60"
                          placeholder="60000"
                          [value]="metricExportIntervalMs() ?? ''"
                          [readonly]="c.locks.metric_export_interval_ms"
                          (input)="onMetricIntervalInput(eventValue($event))"
                          data-testid="telemetry-metric-interval"
                        />
                      </div>
                      <div>
                        <label
                          class="mono mb-1 flex items-center gap-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                          for="telemetry-logs-interval"
                        >
                          Logs interval (ms)
                          @if (c.locks.logs_export_interval_ms) {
                            <span class="normal-case tracking-normal">🔒</span>
                          }
                        </label>
                        <input
                          id="telemetry-logs-interval"
                          type="number"
                          min="1"
                          class="mono w-32 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)] read-only:opacity-60"
                          placeholder="5000"
                          [value]="logsExportIntervalMs() ?? ''"
                          [readonly]="c.locks.logs_export_interval_ms"
                          (input)="onLogsIntervalInput(eventValue($event))"
                          data-testid="telemetry-logs-interval"
                        />
                      </div>
                    </div>
                  </div>
                </details>

                <!-- Privacy gates -->
                <details class="rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-2">
                  <summary
                    class="mono cursor-pointer text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  >
                    Privacy (advanced)
                    @if (privacyManaged()) {
                      <span
                        class="normal-case tracking-normal"
                        data-testid="telemetry-privacy-managed"
                        >🔒 managed</span
                      >
                    }
                  </summary>
                  <p
                    class="mt-2 text-[11px] leading-relaxed text-[var(--red)]"
                    data-testid="telemetry-privacy-warning"
                  >
                    Enabling these sends the content of your conversations and code to the
                    collector. Off by default.
                  </p>
                  <div class="mt-2 space-y-1.5 text-[11px] text-[var(--ink)]">
                    <label class="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        class="accent-[var(--accent)]"
                        [checked]="logUserPrompts()"
                        [disabled]="c.locks.log_user_prompts"
                        (change)="onPrivacyToggle('logUserPrompts', $event)"
                        data-testid="telemetry-log-prompts"
                      />
                      Log user prompts
                    </label>
                    <label class="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        class="accent-[var(--accent)]"
                        [checked]="logAssistantResponses()"
                        [disabled]="c.locks.log_assistant_responses"
                        (change)="onPrivacyToggle('logAssistantResponses', $event)"
                      />
                      Log assistant responses
                    </label>
                    <label class="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        class="accent-[var(--accent)]"
                        [checked]="logToolDetails()"
                        [disabled]="c.locks.log_tool_details"
                        (change)="onPrivacyToggle('logToolDetails', $event)"
                      />
                      Log tool details
                    </label>
                    <label class="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        class="accent-[var(--accent)]"
                        [checked]="logRawApiBodies()"
                        [disabled]="c.locks.log_raw_api_bodies"
                        (change)="onPrivacyToggle('logRawApiBodies', $event)"
                      />
                      Log raw API bodies
                    </label>
                  </div>
                </details>

                <div class="flex items-center justify-end gap-3 border-t border-[var(--line)] pt-4">
                  @if (saveError()) {
                    <span
                      class="mono text-[11px] text-[var(--red)]"
                      data-testid="telemetry-save-error"
                    >
                      {{ saveError() }}
                    </span>
                  }
                  @if (saved()) {
                    <span
                      class="mono text-[11px] text-[var(--green)]"
                      data-testid="telemetry-saved"
                    >
                      Saved — restart to apply
                    </span>
                  }
                  <button
                    type="button"
                    class="mono rounded bg-[var(--accent)] px-4 py-1.5 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    [disabled]="saving()"
                    (click)="save()"
                    data-testid="telemetry-save"
                  >
                    {{ saving() ? 'Saving…' : 'Save' }}
                  </button>
                </div>
              </div>
            }
          </div>
        }
      }
    </section>
  `,
})
export class TelemetrySectionComponent implements OnInit, OnDestroy {
  /** Forwards errors to the Settings shell banner. */
  readonly errorOccurred = output<string>();

  readonly config = signal<TelemetryConfigResponse | null>(null);
  readonly error = signal('');
  /** Save-specific error, shown by the Save button (not the top load banner). */
  readonly saveError = signal('');

  // Section-level managed indicators: true when any field in the section is
  // MDM-locked, so the header shows 🔒 even for fields without a per-field badge.
  readonly transportManaged = computed(() => {
    const l = this.config()?.locks;
    return !!l && (l.protocol || l.export_metrics || l.export_logs);
  });
  readonly advancedManaged = computed(() => {
    const l = this.config()?.locks;
    return (
      !!l &&
      (l.resource_attributes ||
        l.include_account_uuid ||
        l.metric_export_interval_ms ||
        l.logs_export_interval_ms)
    );
  });
  readonly privacyManaged = computed(() => {
    const l = this.config()?.locks;
    return (
      !!l &&
      (l.log_user_prompts ||
        l.log_assistant_responses ||
        l.log_tool_details ||
        l.log_raw_api_bodies)
    );
  });
  readonly saving = signal(false);
  /** Transient success flag; true for ~2s after a save persists. */
  readonly saved = signal(false);
  readonly probing = signal(false);
  /** Empty until a probe runs; then 'reachable' or 'unreachable from this host'. */
  readonly probeResult = signal('');

  // Editable form state (signals — OnPush requires it).
  readonly enabled = signal(false);
  readonly protocol = signal<OtlpProtocol>('grpc');
  readonly exportMetrics = signal(true);
  readonly exportLogs = signal(false);
  readonly includeAccountUuid = signal(true);
  readonly logUserPrompts = signal(false);
  readonly logAssistantResponses = signal(false);
  readonly logToolDetails = signal(false);
  readonly logRawApiBodies = signal(false);

  // MDM-lockable tri-state fields: untouched = keep saved/managed value,
  // touched = send the edited value (incl. null to clear).
  private readonly endpointField = new TriStateField('');
  private readonly headersField = new TriStateField('');
  private readonly resourceAttributesField = new TriStateField('');
  private readonly metricIntervalField = new TriStateField<number | null>(null);
  private readonly logsIntervalField = new TriStateField<number | null>(null);

  readonly endpoint = this.endpointField.value;
  readonly endpointTouched = this.endpointField.touched;
  readonly headers = this.headersField.value;
  readonly headersTouched = this.headersField.touched;
  readonly resourceAttributes = this.resourceAttributesField.value;
  readonly resourceAttributesTouched = this.resourceAttributesField.touched;
  readonly metricExportIntervalMs = this.metricIntervalField.value;
  readonly metricIntervalTouched = this.metricIntervalField.touched;
  readonly logsExportIntervalMs = this.logsIntervalField.value;
  readonly logsIntervalTouched = this.logsIntervalField.touched;

  private readonly tauri = inject(TauriService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly projectState = inject(ProjectStateService);
  private savedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Loads the effective telemetry config on first paint. */
  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const c = await this.tauri.invoke<TelemetryConfigResponse>('get_telemetry_config');
      this.config.set(c);
      this.enabled.set(c.enabled);
      this.endpointField.reset(c.endpoint ?? '');
      this.protocol.set(c.protocol);
      this.exportMetrics.set(c.export_metrics);
      this.exportLogs.set(c.export_logs);
      this.headersField.reset('');
      this.resourceAttributesField.reset(c.resource_attributes ?? '');
      this.includeAccountUuid.set(c.include_account_uuid);
      this.metricIntervalField.reset(c.metric_export_interval_ms);
      this.logsIntervalField.reset(c.logs_export_interval_ms);
      this.logUserPrompts.set(c.log_user_prompts);
      this.logAssistantResponses.set(c.log_assistant_responses);
      this.logToolDetails.set(c.log_tool_details);
      this.logRawApiBodies.set(c.log_raw_api_bodies);
      this.error.set('');
    } catch (e: unknown) {
      this.emitError(e);
    }
    this.cdr.markForCheck();
  }

  /**
   * A privacy toggle turning ON requires an explicit confirm; `field` selects which gate signal.
   * @param field - the privacy gate signal to toggle
   * @param ev - the change event from the toggle input
   */
  onPrivacyToggle(
    field: 'logUserPrompts' | 'logAssistantResponses' | 'logToolDetails' | 'logRawApiBodies',
    ev: Event
  ): void {
    const on = eventChecked(ev);
    if (
      on &&
      !confirm('This sends the content of your conversations and code to the collector. Continue?')
    ) {
      (ev.target as HTMLInputElement).checked = false;
      return;
    }
    this[field].set(on);
  }

  /**
   * Records a headers edit (marks the field touched for the tri-state save).
   * @param value - the raw input value.
   */
  onHeadersInput(value: string): void {
    this.headersField.set(value);
  }

  /**
   * Sets the protocol from a `<select>` change (cast lives here, not the template).
   * @param ev - the select change event.
   */
  setProtocol(ev: Event): void {
    this.protocol.set(eventValue(ev) as OtlpProtocol);
  }

  /**
   * Updates the endpoint and drops any prior probe verdict (it applied to the old value).
   * @param value - the raw input value.
   */
  onEndpointInput(value: string): void {
    this.endpointField.set(value);
    this.probeResult.set('');
  }

  /**
   * Records a resource-attributes edit (marks touched for the tri-state save).
   * @param value - the raw input value.
   */
  onResourceAttributesInput(value: string): void {
    this.resourceAttributesField.set(value);
  }

  /**
   * Parses an export-interval input into a positive number or null (blank/invalid).
   * @param value - the raw input value.
   */
  protected parseInterval(value: string): number | null {
    const n = Number(value);
    return value.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }

  /**
   * Records a metric-interval edit (marks touched for the tri-state save).
   * @param value - the raw input value.
   */
  onMetricIntervalInput(value: string): void {
    this.metricIntervalField.set(this.parseInterval(value));
  }

  /**
   * Records a logs-interval edit (marks touched for the tri-state save).
   * @param value - the raw input value.
   */
  onLogsIntervalInput(value: string): void {
    this.logsIntervalField.set(this.parseInterval(value));
  }

  /** Probes the endpoint's reachability from the host and shows the result. */
  async testConnection(): Promise<void> {
    this.probing.set(true);
    this.probeResult.set('');
    this.cdr.markForCheck();
    let ok: boolean;
    try {
      ok = await this.tauri.invoke<boolean>('probe_otlp_endpoint', {
        endpoint: this.endpoint(),
      });
    } catch {
      ok = false;
    }
    this.probeResult.set(ok ? 'reachable' : 'unreachable from this host');
    this.probing.set(false);
    this.cdr.markForCheck();
  }

  /**
   * Persists the editable fields. Locked fields are omitted entirely (never
   * just server-ignored) so a save with one locked field never blocks an
   * unrelated unlocked edit.
   */
  async save(): Promise<void> {
    this.saving.set(true);
    this.saved.set(false);
    this.cdr.markForCheck();
    const locks = this.config()?.locks;
    const update: TelemetryConfigUpdate = {};
    if (!locks?.enabled) {
      update.enabled = this.enabled();
    }
    if (!locks?.protocol) {
      update.protocol = this.protocol();
    }
    if (!locks?.export_metrics) {
      update.export_metrics = this.exportMetrics();
    }
    if (!locks?.export_logs) {
      update.export_logs = this.exportLogs();
    }
    if (!locks?.include_account_uuid) {
      update.include_account_uuid = this.includeAccountUuid();
    }
    if (!locks?.log_user_prompts) {
      update.log_user_prompts = this.logUserPrompts();
    }
    if (!locks?.log_assistant_responses) {
      update.log_assistant_responses = this.logAssistantResponses();
    }
    if (!locks?.log_tool_details) {
      update.log_tool_details = this.logToolDetails();
    }
    if (!locks?.log_raw_api_bodies) {
      update.log_raw_api_bodies = this.logRawApiBodies();
    }
    // Tri-state (headers / endpoint / resource_attributes / intervals): send only
    // when edited; an emptied string field becomes null (clear), otherwise the value.
    const emptyToNull = (v: string): string | null => (v === '' ? null : v);
    this.headersField.applyMappedTo(update, 'headers', !!locks?.headers, emptyToNull);
    this.endpointField.applyMappedTo(update, 'endpoint', !!locks?.endpoint, emptyToNull);
    this.resourceAttributesField.applyMappedTo(
      update,
      'resource_attributes',
      !!locks?.resource_attributes,
      emptyToNull
    );
    this.metricIntervalField.applyTo(
      update,
      'metric_export_interval_ms',
      !!locks?.metric_export_interval_ms
    );
    this.logsIntervalField.applyTo(
      update,
      'logs_export_interval_ms',
      !!locks?.logs_export_interval_ms
    );
    this.saveError.set('');
    try {
      await this.tauri.invoke('update_telemetry_config', { update });
      await this.refresh();
      // refresh() swallows its own errors into error(), so gate success feedback
      // on it being clear — never show "Saved" next to an error.
      if (this.error()) {
        this.saveError.set(this.error());
      } else {
        // OTEL_* env is baked into the claude container at create time, so a saved
        // change only takes effect after a restart (as with an LLM claude-env change).
        this.projectState.requestRestart();
        this.saved.set(true);
        if (this.savedTimer !== null) {
          clearTimeout(this.savedTimer);
        }
        this.savedTimer = setTimeout(() => {
          this.saved.set(false);
          this.savedTimer = null;
          this.cdr.markForCheck();
        }, 2000);
      }
    } catch (e: unknown) {
      this.emitError(e);
      this.saveError.set(this.error());
    }
    this.saving.set(false);
    this.cdr.markForCheck();
  }

  /** Cancels a pending "saved" flag reset so it never fires post-destroy. */
  ngOnDestroy(): void {
    if (this.savedTimer !== null) {
      clearTimeout(this.savedTimer);
      this.savedTimer = null;
    }
  }

  private emitError(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.error.set(msg);
    this.errorOccurred.emit(msg);
  }

  /** The OTLP protocol choices, driven into the `<select>` (SSOT for the wire union). */
  protected readonly protocolOptions: { value: OtlpProtocol; label: string }[] = [
    { value: 'grpc', label: 'gRPC' },
    { value: 'http/protobuf', label: 'HTTP protobuf' },
    { value: 'http/json', label: 'HTTP JSON' },
  ];

  /** Shared DOM-event readers, exposed for template event bindings. */
  protected readonly eventValue = eventValue;
  protected readonly eventChecked = eventChecked;
}
