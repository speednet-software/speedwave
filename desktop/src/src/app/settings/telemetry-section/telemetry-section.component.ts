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
  imports: [],
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
        <p class="mt-2 text-[12px] text-red-300" data-testid="telemetry-error">{{ error() }}</p>
      }

      @if (config(); as c) {
        @if (c.kill_switch) {
          <div
            class="mt-4 flex items-center gap-2 rounded border border-[var(--line)] bg-[var(--bg-1)] px-4 py-3 text-[12px] text-[var(--ink-mute)]"
            data-testid="telemetry-killswitch"
          >
            <span aria-hidden="true">🔒</span>
            Telemetry is managed by your organization and cannot be changed here.
          </div>
        } @else {
          <div class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)]">
            <!-- Enable: label + toggle on one line, like an integration row -->
            <div class="flex items-center justify-between gap-3 px-4 py-3">
              <div class="min-w-0">
                <div class="text-[13px] text-[var(--ink)]">Send telemetry</div>
                <div class="text-[11px] text-[var(--ink-dim)]">
                  @if (c.locks.enabled) {
                    <span class="text-[var(--ink-mute)]">🔒 Managed by your organization</span>
                  } @else {
                    Off means no data leaves this machine.
                  }
                </div>
              </div>
              <label class="relative inline-block h-[24px] w-[44px] shrink-0" data-testid="toggle">
                <input
                  type="checkbox"
                  class="peer sr-only"
                  [checked]="enabled()"
                  [disabled]="c.locks.enabled"
                  (change)="enabled.set(inputChecked($event))"
                  data-testid="telemetry-enabled"
                />
                <span
                  class="absolute inset-0 rounded-full bg-[var(--line-strong)] transition-all duration-300 peer-checked:bg-[var(--accent)] peer-disabled:opacity-40 peer-disabled:cursor-not-allowed before:absolute before:bottom-[3px] before:left-[3px] before:h-[18px] before:w-[18px] before:rounded-full before:bg-white before:transition-all before:duration-300 before:content-[''] peer-checked:before:translate-x-[20px]"
                  [class.cursor-pointer]="!c.locks.enabled"
                ></span>
              </label>
            </div>

            @if (enabled()) {
              <div class="space-y-4 border-t border-[var(--line)] px-4 py-4">
                <!-- Endpoint -->
                <div>
                  <div class="text-[11px] text-[var(--ink-mute)]">
                    Collector endpoint
                    @if (c.locks.endpoint) {
                      <span class="text-[10px]">🔒 managed</span>
                    }
                  </div>
                  <input
                    type="url"
                    class="mono mt-1 w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                    placeholder="https://collector.example.com:4318"
                    [value]="endpoint()"
                    [readonly]="c.locks.endpoint"
                    (input)="endpoint.set(inputValue($event))"
                    data-testid="telemetry-endpoint"
                  />
                  <button
                    type="button"
                    class="mono mt-1 rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
                    [disabled]="!endpoint() || probing()"
                    (click)="testConnection()"
                    data-testid="telemetry-probe"
                  >
                    {{ probing() ? 'testing…' : 'Test connection' }}
                  </button>
                  @if (probeResult()) {
                    <span
                      class="ml-2 text-[11px] text-[var(--ink-mute)]"
                      data-testid="telemetry-probe-result"
                    >
                      {{ probeResult() }}
                    </span>
                  }
                </div>

                <!-- Protocol + exporters -->
                <div class="flex flex-wrap items-center gap-3 text-[11px] text-[var(--ink)]">
                  <label class="flex items-center gap-1">
                    Protocol
                    <select
                      class="rounded border border-[var(--line)] bg-[var(--bg-1)] px-1 py-0.5"
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
                  <label class="flex items-center gap-1">
                    <input
                      type="checkbox"
                      [checked]="exportMetrics()"
                      [disabled]="c.locks.export_metrics"
                      (change)="exportMetrics.set(inputChecked($event))"
                    />
                    Metrics
                  </label>
                  <label class="flex items-center gap-1">
                    <input
                      type="checkbox"
                      [checked]="exportLogs()"
                      [disabled]="c.locks.export_logs"
                      (change)="exportLogs.set(inputChecked($event))"
                    />
                    Logs
                  </label>
                </div>

                <!-- Auth headers (masked secret) -->
                <div>
                  <div class="text-[11px] text-[var(--ink-mute)]">
                    Auth headers
                    @if (c.locks.headers) {
                      <span class="text-[10px]">🔒 managed</span>
                    }
                  </div>
                  <input
                    type="password"
                    autocomplete="off"
                    class="mono mt-1 w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                    [value]="headers()"
                    [readonly]="c.locks.headers"
                    [placeholder]="
                      c.has_headers
                        ? '••••• (saved — type to replace, clear to remove)'
                        : 'Authorization=Bearer …'
                    "
                    (input)="onHeadersInput(inputValue($event))"
                    data-testid="telemetry-headers"
                  />
                </div>

                <!-- Privacy gates -->
                <details class="mt-1">
                  <summary class="cursor-pointer text-[11px] text-[var(--ink-mute)]">
                    Privacy (advanced)
                  </summary>
                  <p class="mt-2 text-[11px] text-red-300" data-testid="telemetry-privacy-warning">
                    Enabling these sends the content of your conversations and code to the
                    collector. Off by default.
                  </p>
                  <div class="mt-2 space-y-1 text-[11px] text-[var(--ink)]">
                    <label class="flex items-center gap-1">
                      <input
                        type="checkbox"
                        [checked]="logUserPrompts()"
                        [disabled]="c.locks.log_user_prompts"
                        (change)="onPrivacyToggle('logUserPrompts', $event)"
                        data-testid="telemetry-log-prompts"
                      />
                      Log user prompts
                    </label>
                    <label class="flex items-center gap-1">
                      <input
                        type="checkbox"
                        [checked]="logAssistantResponses()"
                        [disabled]="c.locks.log_assistant_responses"
                        (change)="onPrivacyToggle('logAssistantResponses', $event)"
                      />
                      Log assistant responses
                    </label>
                    <label class="flex items-center gap-1">
                      <input
                        type="checkbox"
                        [checked]="logToolDetails()"
                        [disabled]="c.locks.log_tool_details"
                        (change)="onPrivacyToggle('logToolDetails', $event)"
                      />
                      Log tool details
                    </label>
                    <label class="flex items-center gap-1">
                      <input
                        type="checkbox"
                        [checked]="logRawApiBodies()"
                        [disabled]="c.locks.log_raw_api_bodies"
                        (change)="onPrivacyToggle('logRawApiBodies', $event)"
                      />
                      Log raw API bodies
                    </label>
                  </div>
                </details>

                <div class="flex justify-end">
                  <button
                    type="button"
                    class="rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-4 py-1.5 text-[12px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
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
    const on = this.inputChecked(ev);
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
    this.protocol.set(this.inputValue(ev) as OtlpProtocol);
  }

  /** Probes the endpoint's reachability from the host and shows the result. */
  async testConnection(): Promise<void> {
    this.probing.set(true);
    this.probeResult.set('');
    this.cdr.markForCheck();
    try {
      const ok = await this.tauri.invoke<boolean>('probe_otlp_endpoint', {
        endpoint: this.endpoint(),
      });
      this.probeResult.set(ok ? 'reachable' : 'unreachable from this host');
    } catch {
      this.probeResult.set('unreachable from this host');
    }
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

  /**
   * The `.value` of an input/select event target (cast kept out of the template).
   * @param ev - the DOM event.
   */
  protected inputValue(ev: Event): string {
    return (ev.target as HTMLInputElement | HTMLSelectElement).value;
  }
  /**
   * The `.checked` of a checkbox event target.
   * @param ev - the DOM event.
   */
  protected inputChecked(ev: Event): boolean {
    return (ev.target as HTMLInputElement).checked;
  }
}
