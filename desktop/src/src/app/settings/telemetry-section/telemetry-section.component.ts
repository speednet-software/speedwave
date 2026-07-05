import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  inject,
  output,
  signal,
} from '@angular/core';

import { TauriService } from '../../services/tauri.service';
import { ToggleComponent } from '../../shared/toggle.component';
import { eventChecked, eventValue } from '../../shared/dom-event';
import type {
  OtlpProtocol,
  TelemetryConfigResponse,
  TelemetryConfigUpdate,
} from '../../models/telemetry';

/**
 * Settings → Telemetry. Lets a user point Claude Code at their own OTLP collector.
 * MDM-locked fields render read-only ("managed by your organization"); a kill-switch
 * greys the whole section. The headers secret is masked and never leaves the host.
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

      @if (error()) {
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
                    @if (probeResult(); as result) {
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
                    class="mono mb-1 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  >
                    Transport &amp; signals
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
                        <option value="grpc">gRPC</option>
                        <option value="http/protobuf">HTTP protobuf</option>
                        <option value="http/json">HTTP JSON</option>
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

                <!-- Privacy gates -->
                <details class="rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-2">
                  <summary
                    class="mono cursor-pointer text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  >
                    Privacy (advanced)
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

                <div class="flex justify-end border-t border-[var(--line)] pt-4">
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
export class TelemetrySectionComponent implements OnInit {
  /** Forwards errors to the Settings shell banner. */
  readonly errorOccurred = output<string>();

  readonly config = signal<TelemetryConfigResponse | null>(null);
  readonly error = signal('');
  readonly saving = signal(false);
  readonly probing = signal(false);
  /** Empty until a probe runs; then 'reachable' or 'unreachable from this host'. */
  readonly probeResult = signal('');

  // Editable form state (signals — OnPush requires it).
  readonly enabled = signal(false);
  readonly endpoint = signal('');
  readonly protocol = signal<OtlpProtocol>('grpc');
  readonly exportMetrics = signal(true);
  readonly exportLogs = signal(false);
  readonly headers = signal('');
  readonly headersTouched = signal(false);
  readonly logUserPrompts = signal(false);
  readonly logAssistantResponses = signal(false);
  readonly logToolDetails = signal(false);
  readonly logRawApiBodies = signal(false);

  private readonly tauri = inject(TauriService);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Loads the effective telemetry config on first paint. */
  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const c = await this.tauri.invoke<TelemetryConfigResponse>('get_telemetry_config');
      this.config.set(c);
      this.enabled.set(c.enabled);
      this.endpoint.set(c.endpoint ?? '');
      this.protocol.set(c.protocol);
      this.exportMetrics.set(c.export_metrics);
      this.exportLogs.set(c.export_logs);
      this.headers.set('');
      this.headersTouched.set(false);
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
   * A privacy toggle turning ON requires an explicit confirm.
   * @param field - which privacy-gate signal to toggle.
   * @param ev - the checkbox change event.
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
    this.headers.set(value);
    this.headersTouched.set(true);
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
    this.endpoint.set(value);
    this.probeResult.set('');
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

  /** Persists the editable fields (MDM-locked ones are ignored server-side). */
  async save(): Promise<void> {
    this.saving.set(true);
    this.cdr.markForCheck();
    const update: TelemetryConfigUpdate = {
      enabled: this.enabled(),
      endpoint: this.endpoint() || undefined,
      protocol: this.protocol(),
      export_metrics: this.exportMetrics(),
      export_logs: this.exportLogs(),
      log_user_prompts: this.logUserPrompts(),
      log_assistant_responses: this.logAssistantResponses(),
      log_tool_details: this.logToolDetails(),
      log_raw_api_bodies: this.logRawApiBodies(),
    };
    // Tri-state headers: only send when the user edited the field.
    if (this.headersTouched()) {
      update.headers = this.headers() === '' ? null : this.headers();
    }
    try {
      await this.tauri.invoke('update_telemetry_config', { update });
      await this.refresh();
    } catch (e: unknown) {
      this.emitError(e);
    }
    this.saving.set(false);
    this.cdr.markForCheck();
  }

  private emitError(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.error.set(msg);
    this.errorOccurred.emit(msg);
  }

  /** Shared DOM-event readers, exposed for template event bindings. */
  protected readonly eventValue = eventValue;
  protected readonly eventChecked = eventChecked;
}
