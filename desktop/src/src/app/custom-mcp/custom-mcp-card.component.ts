import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { CustomMcpService } from '../services/custom-mcp.service';
import type {
  CustomMcpDeniedHost,
  CustomMcpEgressDenials,
  CustomMcpEntry,
  CustomPiiMode,
  CustomWorkspaceMode,
} from '../models/custom-mcp';
import { eventChecked, eventValue } from '../shared/dom-event';
import { CustomMcpToolsTableComponent } from './custom-mcp-tools-table.component';
import {
  BLOCKED_HOSTS_HELP,
  ENFORCED_LABEL,
  FILE_ACCESS_OPTIONS,
  HOST_WARNING_TEXT,
  ORG_DISABLED_LABEL,
  PII_OPTIONS,
  PROPOSED_BY_REPO_LABEL,
  capText,
  confirmationsFor,
  errorText,
  hostAppNotRunning,
  otherRefusalsText,
  parseDomainTarget,
  reasonText,
  sourceLabel,
  splitDomain,
  statePillClass,
  statusDot,
  workspaceModeAllowed,
} from './custom-mcp-text';

function checkRadio(ev: Event | undefined, value: string): void {
  const group = (ev?.target as HTMLElement | undefined)?.closest('fieldset');
  group?.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((radio) => {
    radio.checked = radio.value === value;
  });
}

const BUTTON =
  'mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-50';

/** Expanded view of one Custom MCP server: tools, consented settings, domains, removal. */
@Component({
  selector: 'app-custom-mcp-card',
  imports: [CustomMcpToolsTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @let e = entry();
    <div class="bg-[var(--bg-1)] p-4" [attr.data-testid]="'custom-mcp-card-' + e.name">
      <div class="flex flex-wrap items-center gap-2">
        <span [style.color]="dot().colour" data-testid="custom-mcp-card-dot">{{
          dot().glyph
        }}</span>
        <span class="mono text-[13px] text-[var(--ink)]">{{ cap(e.name, 40) }}</span>
        <span [class]="'pill ' + pillClass()" data-testid="custom-mcp-card-state">{{
          e.state
        }}</span>
        @if (e.proposed_by_repo) {
          <span class="pill amber" data-testid="custom-mcp-card-proposed">{{ proposedLabel }}</span>
        }
        @if (hostDisabledByOrg()) {
          <span class="pill" data-testid="custom-mcp-card-host-org-disabled">{{
            orgDisabledLabel
          }}</span>
        }
        <span class="mono text-[11px] text-[var(--ink-mute)]">{{ source() }}</span>
        <button
          type="button"
          class="toggle ml-auto"
          [class.on]="e.enabled"
          [disabled]="busy() || hostDisabledByOrg()"
          [attr.aria-pressed]="e.enabled"
          [attr.aria-label]="(e.enabled ? 'Disable ' : 'Enable ') + e.name"
          data-testid="custom-mcp-card-toggle"
          (click)="toggle()"
        ></button>
      </div>
      @if (e.reason) {
        <p class="mt-1 text-[12px] text-[var(--ink-dim)]" data-testid="custom-mcp-card-reason">
          {{ reason() }}
        </p>
      }

      @if (e.host_warning) {
        <div
          class="mt-3 rounded ring-1 ring-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-[var(--amber)]"
          role="note"
          data-testid="custom-mcp-card-host-warning"
        >
          {{ hostWarning }}
        </div>
      }
      @if (e.host_app_available === false) {
        <div
          class="mt-2 flex items-center gap-3 text-[12px] text-[var(--amber)]"
          data-testid="custom-mcp-card-not-running"
        >
          <span>{{ notRunning() }}</span>
          <button
            type="button"
            [class]="buttonClass"
            [disabled]="busy()"
            data-testid="custom-mcp-card-retry"
            (click)="retry()"
          >
            $ retry
          </button>
        </div>
      }
      @for (warning of e.warnings; track $index) {
        <p class="mt-2 text-[12px] text-[var(--amber)]" data-testid="custom-mcp-card-warning">
          {{ cap(warning) }}
        </p>
      }
      @if (error()) {
        <p
          class="mt-2 text-[12px] text-[var(--red)]"
          role="alert"
          data-testid="custom-mcp-card-error"
        >
          {{ error() }}
        </p>
      }

      <div class="mt-4">
        @if (e.tools_available) {
          <app-custom-mcp-tools-table [project]="project()" [name]="e.name" [tools]="e.tools" />
        } @else {
          <p class="text-[12px] text-[var(--ink-mute)]" data-testid="custom-mcp-card-no-tools">
            The tool list is not available yet. Start the project so the server can list its tools.
          </p>
        }
      </div>

      <fieldset class="mt-4" data-testid="custom-mcp-card-pii">
        <legend class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
          Personal data
          @if (e.forced.pii_mode) {
            <span class="pill ml-1" data-testid="custom-mcp-card-pii-forced">{{
              enforcedLabel
            }}</span>
          }
        </legend>
        @for (opt of piiOptions; track opt.value) {
          <label class="mt-1 flex items-start gap-2 text-[12px] text-[var(--ink)]">
            <input
              type="radio"
              class="mt-0.5 accent-[var(--accent)]"
              [name]="'custom-mcp-pii-' + e.name"
              [value]="opt.value"
              [checked]="e.pii_mode === opt.value"
              [disabled]="busy() || e.forced.pii_mode !== null"
              [attr.data-testid]="'custom-mcp-card-pii-' + opt.value"
              (change)="setPiiMode(opt.value, $event)"
            />
            <span>{{ opt.label }}</span>
          </label>
        }
      </fieldset>

      <fieldset class="mt-4" data-testid="custom-mcp-card-files">
        <legend class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
          Project files
          @if (e.forced.workspace_mode_max) {
            <span class="pill ml-1" data-testid="custom-mcp-card-files-forced">{{
              enforcedLabel
            }}</span>
          }
        </legend>
        @for (opt of fileOptions; track opt.value) {
          <label class="mt-1 flex items-center gap-2 text-[12px] text-[var(--ink)]">
            <input
              type="radio"
              class="accent-[var(--accent)]"
              [name]="'custom-mcp-files-' + e.name"
              [value]="opt.value"
              [checked]="selectedWorkspaceMode() === opt.value"
              [disabled]="busy() || !fileModeAllowed(opt.value)"
              [attr.data-testid]="'custom-mcp-card-files-' + opt.value"
              (change)="pickWorkspaceMode(opt.value, $event)"
            />
            <span>{{ opt.label }}</span>
          </label>
        }
        @if (pendingWorkspaceMode(); as pending) {
          @for (text of pendingConfirmations(); track text; let i = $index) {
            <label class="mt-2 flex items-start gap-2 text-[12px] text-[var(--amber)]">
              <input
                type="checkbox"
                class="mt-0.5 accent-[var(--accent)]"
                [checked]="confirmed()[i]"
                [attr.data-testid]="'custom-mcp-card-files-confirm-' + i"
                (change)="confirm(i, eventChecked($event))"
              />
              <span>{{ text }}</span>
            </label>
          }
          <div class="mt-2 flex gap-2">
            <button
              type="button"
              class="mono rounded border border-[var(--accent-dim)] bg-[var(--accent)] px-2 py-0.5 text-[11px] text-[var(--on-accent)] hover:opacity-90 disabled:opacity-50"
              [disabled]="busy() || !allConfirmed()"
              data-testid="custom-mcp-card-files-apply"
              (click)="applyWorkspaceMode(pending)"
            >
              $ apply
            </button>
            <button
              type="button"
              [class]="buttonClass"
              [disabled]="busy()"
              data-testid="custom-mcp-card-files-cancel"
              (click)="cancelWorkspaceMode()"
            >
              cancel
            </button>
          </div>
        }
      </fieldset>

      @if (e.source.kind === 'npm') {
        <section class="mt-4" data-testid="custom-mcp-card-domains">
          <div class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            Internet
            @if (e.forced.allowed_domains) {
              <span class="pill ml-1" data-testid="custom-mcp-card-domains-forced">{{
                enforcedLabel
              }}</span>
            }
          </div>
          @if (e.forced.allowed_domains; as allowed) {
            <p class="mt-1 text-[11px] text-[var(--ink-mute)]">
              Your organization allows only: {{ cap(allowed.join(', ')) }}
            </p>
          }
          @if (e.domains.length === 0 && e.domains_blocked_by_policy.length === 0) {
            <p
              class="mt-1 text-[12px] text-[var(--ink-mute)]"
              data-testid="custom-mcp-card-no-domains"
            >
              This server cannot reach the internet.
            </p>
          }
          <ul class="mt-1 space-y-1">
            @for (domain of e.domains; track domain) {
              <li class="flex items-center gap-2 text-[12px]">
                <span class="mono text-[var(--ink)]">{{ cap(domain, 120) }}</span>
                <button
                  type="button"
                  [class]="buttonClass"
                  [disabled]="busy()"
                  [attr.data-testid]="'custom-mcp-card-domain-remove-' + domain"
                  (click)="removeDomain(domain)"
                >
                  remove
                </button>
              </li>
            }
            @for (domain of e.domains_blocked_by_policy; track domain) {
              <li class="flex items-center gap-2 text-[12px]">
                <span class="mono text-[var(--ink-mute)] line-through">{{ cap(domain, 120) }}</span>
                <span class="pill" [attr.data-testid]="'custom-mcp-card-domain-blocked-' + domain"
                  >Blocked by your organization</span
                >
                <button
                  type="button"
                  [class]="buttonClass"
                  [disabled]="busy()"
                  (click)="removeDomain(domain)"
                >
                  remove
                </button>
              </li>
            }
          </ul>
          <form
            class="mt-2 flex items-center gap-2"
            (submit)="$event.preventDefault(); allowDomain()"
          >
            <input
              type="text"
              class="mono min-w-[12rem] flex-1 rounded border border-[var(--line)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--ink)]"
              placeholder="api.example.com:443"
              autocomplete="off"
              aria-label="Domain to allow"
              [value]="domainInput()"
              data-testid="custom-mcp-card-domain-input"
              (input)="domainInput.set(eventValue($event))"
            />
            <button
              type="submit"
              [class]="buttonClass"
              [disabled]="busy() || domainInput().trim() === ''"
              data-testid="custom-mcp-card-domain-allow"
            >
              $ allow
            </button>
          </form>

          <div class="mt-4" data-testid="custom-mcp-card-blocked">
            <div class="flex items-center gap-2">
              <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
                Blocked connections (since last start)
              </span>
              <button
                type="button"
                [class]="buttonClass"
                [disabled]="denialsLoading()"
                data-testid="custom-mcp-card-blocked-refresh"
                (click)="loadDenials()"
              >
                $ refresh
              </button>
            </div>
            @if (denialsError()) {
              <p
                class="mt-1 text-[12px] text-[var(--red)]"
                role="alert"
                data-testid="custom-mcp-card-blocked-error"
              >
                Could not read the blocked connections: {{ denialsError() }}
              </p>
            } @else if (denials(); as d) {
              @if (!d.container_running) {
                <p
                  class="mt-1 text-[12px] text-[var(--ink-mute)]"
                  data-testid="custom-mcp-card-blocked-not-running"
                >
                  The server is not running, so there are no blocked connections to show.
                </p>
              } @else if (d.hosts.length === 0 && d.other.length === 0) {
                <p
                  class="mt-1 text-[12px] text-[var(--ink-mute)]"
                  data-testid="custom-mcp-card-blocked-empty"
                >
                  No blocked connections since the server last started.
                </p>
                <p
                  class="mt-1 text-[11px] text-[var(--ink-mute)]"
                  data-testid="custom-mcp-card-blocked-proxy-note"
                >
                  Only connections made through the Speedwave egress proxy are listed. A server
                  whose HTTP library ignores proxy settings fails with a DNS error (EAI_AGAIN,
                  ENOTFOUND) and shows nothing here.
                </p>
              } @else {
                @if (d.hosts.length > 0) {
                  <p
                    class="mt-1 text-[11px] text-[var(--ink-mute)]"
                    data-testid="custom-mcp-card-blocked-help"
                  >
                    {{ blockedHelp }}
                  </p>
                  <ul class="mt-1 space-y-1">
                    @for (h of d.hosts; track h.host + ':' + h.port) {
                      <li
                        class="flex items-center gap-2 text-[12px]"
                        data-testid="custom-mcp-card-blocked-host"
                      >
                        <span class="mono break-all text-[var(--ink)]"
                          >{{ h.host }}:{{ h.port }}</span
                        >
                        <span class="mono text-[var(--ink-mute)]">×{{ h.count }}</span>
                        @if (h.allowed_by_policy) {
                          <button
                            type="button"
                            [class]="buttonClass"
                            [disabled]="busy() || denialsLoading()"
                            [attr.aria-label]="'Allow ' + h.host + ':' + h.port"
                            [attr.data-testid]="
                              'custom-mcp-card-blocked-allow-' + h.host + ':' + h.port
                            "
                            (click)="allowBlocked(h)"
                          >
                            $ allow
                          </button>
                        } @else {
                          <span
                            class="pill"
                            [attr.data-testid]="
                              'custom-mcp-card-blocked-org-' + h.host + ':' + h.port
                            "
                            >Blocked by your organization</span
                          >
                        }
                      </li>
                    }
                  </ul>
                }
                @if (d.other.length > 0) {
                  <p
                    class="mt-1 text-[12px] text-[var(--ink-mute)]"
                    data-testid="custom-mcp-card-blocked-other"
                  >
                    Other refused: {{ otherText(d.other) }}
                  </p>
                }
              }
            } @else if (denialsLoading()) {
              <p
                class="mt-1 text-[12px] text-[var(--ink-mute)]"
                data-testid="custom-mcp-card-blocked-loading"
              >
                Reading blocked connections…
              </p>
            }
          </div>
        </section>
      }

      <div
        class="mt-6 rounded border border-red-500/30 bg-red-500/[0.04] p-3"
        data-testid="custom-mcp-card-danger-zone"
      >
        <h3 class="mono mb-2 text-[12px] font-semibold text-red-300">danger zone</h3>
        <p class="mb-2 text-[12px] text-[var(--ink-dim)]">
          Removing revokes your approval and deletes the server's containers, image, credentials and
          settings.
        </p>
        @if (confirmingRemove()) {
          <div class="flex items-center gap-3">
            <span class="mono text-[12px] text-red-300">Are you sure?</span>
            <button
              type="button"
              class="mono rounded border border-red-500/40 bg-red-500/[0.08] px-3 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/[0.12] disabled:opacity-50"
              [disabled]="busy()"
              data-testid="custom-mcp-card-remove-confirm"
              (click)="remove()"
            >
              $ yes, remove
            </button>
            <button
              type="button"
              [class]="buttonClass"
              [disabled]="busy()"
              data-testid="custom-mcp-card-remove-cancel"
              (click)="confirmingRemove.set(false)"
            >
              cancel
            </button>
          </div>
        } @else {
          <button
            type="button"
            class="mono rounded border border-red-500/40 bg-transparent px-3 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/[0.08]"
            data-testid="custom-mcp-card-remove"
            (click)="confirmingRemove.set(true)"
          >
            $ remove server
          </button>
        }
      </div>
    </div>
  `,
})
export class CustomMcpCardComponent {
  /** The project of the server. */
  readonly project = input.required<string>();
  /** The server. */
  readonly entry = input.required<CustomMcpEntry>();

  /** True while a change is saved. */
  readonly busy = signal(false);
  /** The last refused change. */
  readonly error = signal('');
  /** A project files pick waiting for its confirmations. */
  readonly pendingWorkspaceMode = signal<CustomWorkspaceMode | null>(null);
  /** The confirmation checkboxes of the pending pick. */
  readonly confirmed = signal<boolean[]>([]);
  /** The typed domain. */
  readonly domainInput = signal('');
  /** Whether the removal asks for confirmation. */
  readonly confirmingRemove = signal(false);
  /** Connections the egress proxy refused, `null` until read. */
  readonly denials = signal<CustomMcpEgressDenials | null>(null);
  /** True while the refused connections are read. */
  readonly denialsLoading = signal(false);
  /** Why the refused connections could not be read. */
  readonly denialsError = signal('');

  /** The status dot. */
  readonly dot = computed(() => statusDot(this.entry()));
  /** The state pill colour. */
  readonly pillClass = computed(() => statePillClass(this.entry().state));
  /** The source line. */
  readonly source = computed(() => sourceLabel(this.entry().source));
  /** The exclusion reason as text. */
  readonly reason = computed(() => reasonText(this.entry().reason));
  /** The message shown while the host app does not answer. */
  readonly notRunning = computed(() => hostAppNotRunning(this.entry().name));
  /** Whether the organization turned off this host server. */
  readonly hostDisabledByOrg = computed(
    () => this.entry().source.kind === 'host' && this.entry().forced.host_servers_disabled
  );
  /** The project files option shown as picked; back to the saved one on cancel. */
  readonly selectedWorkspaceMode = linkedSignal<CustomWorkspaceMode>(
    () => this.entry().workspace_mode
  );
  /** The confirmations the pending pick needs. */
  readonly pendingConfirmations = computed(() => {
    const pending = this.pendingWorkspaceMode();
    return pending ? confirmationsFor(pending) : [];
  });
  /** Whether every confirmation of the pending pick is given. */
  readonly allConfirmed = computed(() =>
    this.pendingConfirmations().every((_, i) => this.confirmed()[i] === true)
  );

  protected readonly blockedHelp = BLOCKED_HOSTS_HELP;
  protected readonly otherText = otherRefusalsText;
  protected readonly hostWarning = HOST_WARNING_TEXT;
  protected readonly proposedLabel = PROPOSED_BY_REPO_LABEL;
  protected readonly enforcedLabel = ENFORCED_LABEL;
  protected readonly orgDisabledLabel = ORG_DISABLED_LABEL;
  protected readonly piiOptions = PII_OPTIONS;
  protected readonly fileOptions = FILE_ACCESS_OPTIONS;
  protected readonly buttonClass = BUTTON;
  protected readonly cap = capText;
  protected readonly eventValue = eventValue;
  protected readonly eventChecked = eventChecked;

  private readonly customMcp = inject(CustomMcpService);
  private denialsGeneration = 0;
  private readonly denialsKey = computed(() => {
    const e = this.entry();
    return e.source.kind === 'npm' ? `${this.project()}/${e.name}` : null;
  });

  /** Reads the refused connections whenever the card shows another npm server. */
  constructor() {
    effect(() => {
      const key = this.denialsKey();
      untracked(() => {
        this.denialsGeneration++;
        this.denials.set(null);
        this.denialsError.set('');
        this.denialsLoading.set(false);
        if (key !== null) void this.loadDenials();
      });
    });
  }

  /** Reads the connections the server's egress proxy refused since it started. */
  async loadDenials(): Promise<void> {
    const e = this.entry();
    if (e.source.kind !== 'npm') return;
    const gen = ++this.denialsGeneration;
    this.denialsLoading.set(true);
    this.denialsError.set('');
    try {
      const res = await this.customMcp.egressDenials(this.project(), e.name);
      if (gen !== this.denialsGeneration) return;
      if (!res || !Array.isArray(res.hosts) || !Array.isArray(res.other)) {
        throw new Error('unexpected answer from the backend');
      }
      this.denials.set(res);
    } catch (err: unknown) {
      if (gen !== this.denialsGeneration) return;
      this.denials.set(null);
      this.denialsError.set(errorText(err));
    } finally {
      if (gen === this.denialsGeneration) this.denialsLoading.set(false);
    }
  }

  /**
   * Lets the server reach a host its egress proxy refused, then reads the refusals again.
   * @param host - the refused host
   */
  async allowBlocked(host: CustomMcpDeniedHost): Promise<void> {
    if (!host.allowed_by_policy) return;
    const name = this.entry().name;
    const allowed = await this.run(() =>
      this.customMcp.allowDomain(this.project(), name, host.host, host.port)
    );
    if (allowed) await this.loadDenials();
  }

  /**
   * Whether the organization's limit allows a project files option.
   * @param mode - the option
   */
  fileModeAllowed(mode: CustomWorkspaceMode): boolean {
    return workspaceModeAllowed(mode, this.entry().forced.workspace_mode_max);
  }

  /** Turns the server on or off. */
  async toggle(): Promise<void> {
    const e = this.entry();
    await this.run(() => this.customMcp.setEnabled(this.project(), e.name, !e.enabled));
  }

  /**
   * Saves a PII mode; a refused one puts the radio back on the saved mode.
   * @param mode - the picked mode
   * @param ev - the radio change event
   */
  async setPiiMode(mode: CustomPiiMode, ev?: Event): Promise<void> {
    const e = this.entry();
    if (e.forced.pii_mode !== null || mode === e.pii_mode) return;
    const saved = await this.run(() => this.customMcp.setPiiMode(this.project(), e.name, mode));
    if (!saved) checkRadio(ev, e.pii_mode);
  }

  /**
   * Picks a project files option: less access applies at once, more access waits for its
   * confirmations.
   * @param mode - the picked option
   * @param ev - the radio change event
   */
  async pickWorkspaceMode(mode: CustomWorkspaceMode, ev?: Event): Promise<void> {
    this.confirmed.set([]);
    this.selectedWorkspaceMode.set(mode);
    if (mode === this.entry().workspace_mode) {
      this.pendingWorkspaceMode.set(null);
      return;
    }
    if (confirmationsFor(mode).length > 0) {
      this.pendingWorkspaceMode.set(mode);
      return;
    }
    this.pendingWorkspaceMode.set(null);
    const saved = this.entry().workspace_mode;
    if (!(await this.applyWorkspaceMode(mode))) {
      this.selectedWorkspaceMode.set(saved);
      checkRadio(ev, saved);
    }
  }

  /** Drops a project files pick that waits for its confirmations. */
  cancelWorkspaceMode(): void {
    this.pendingWorkspaceMode.set(null);
    this.confirmed.set([]);
    this.selectedWorkspaceMode.set(this.entry().workspace_mode);
  }

  /**
   * Records one confirmation checkbox of the pending pick.
   * @param index - the checkbox
   * @param checked - its state
   */
  confirm(index: number, checked: boolean): void {
    this.confirmed.update((list) => {
      const next = [...list];
      next[index] = checked;
      return next;
    });
  }

  /**
   * Saves a project files option.
   * @param mode - the option
   * @returns whether it was saved
   */
  async applyWorkspaceMode(mode: CustomWorkspaceMode): Promise<boolean> {
    if (!this.allConfirmed() && this.pendingWorkspaceMode() === mode) return false;
    const name = this.entry().name;
    return this.run(async () => {
      await this.customMcp.setFileAccess(this.project(), name, mode);
      this.pendingWorkspaceMode.set(null);
    });
  }

  /** Lets the server reach the typed domain. */
  async allowDomain(): Promise<void> {
    const target = parseDomainTarget(this.domainInput());
    if (!target) {
      this.error.set('Enter a host name such as api.example.com or api.example.com:443.');
      return;
    }
    const name = this.entry().name;
    const allowed = await this.run(async () => {
      await this.customMcp.allowDomain(this.project(), name, target.host, target.port);
      this.domainInput.set('');
    });
    if (allowed) await this.loadDenials();
  }

  /**
   * Stops the server from reaching a domain.
   * @param domain - the stored `host:port`
   */
  async removeDomain(domain: string): Promise<void> {
    const { host, port } = splitDomain(domain);
    const name = this.entry().name;
    const removed = await this.run(() =>
      this.customMcp.removeDomain(this.project(), name, host, port)
    );
    if (removed) await this.loadDenials();
  }

  /** Probes the host app again by reloading the list. */
  async retry(): Promise<void> {
    await this.run(() => this.customMcp.refresh(this.project()));
  }

  /** Revokes the server. */
  async remove(): Promise<void> {
    const name = this.entry().name;
    await this.run(async () => {
      await this.customMcp.remove(this.project(), name);
      this.confirmingRemove.set(false);
    });
  }

  private async run(task: () => Promise<void>): Promise<boolean> {
    this.busy.set(true);
    this.error.set('');
    try {
      await task();
      return true;
    } catch (e: unknown) {
      this.error.set(errorText(e));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
