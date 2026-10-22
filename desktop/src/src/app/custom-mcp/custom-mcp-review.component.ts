import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { CustomMcpService } from '../services/custom-mcp.service';
import type {
  CustomMcpHostPreview,
  CustomMcpNpmPreview,
  CustomMcpPreview,
  CustomPiiMode,
  CustomWorkspaceMode,
} from '../models/custom-mcp';
import { eventChecked, eventValue } from '../shared/dom-event';
import {
  ENFORCED_LABEL,
  FILE_ACCESS_OPTIONS,
  FILE_READ_CONFIRMATION,
  FILE_WRITE_CONFIRMATION,
  HOST_WARNING_TEXT,
  PII_OPTIONS,
  PROPOSED_BY_REPO_LABEL,
  capText,
  errorText,
  hostAppNotRunning,
  workspaceModeAllowed,
} from './custom-mcp-text';

const SECONDARY_BUTTON =
  'mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-50';

/**
 * Full-screen review of a Custom MCP server before approval: every pinned fact of an npm package
 * or the probe of a host server, the PII and project-file choices, credential values, and the
 * confirmations Approve waits for.
 */
@Component({
  selector: 'app-custom-mcp-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--bg)]/[0.92] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-mcp-review-title"
      data-testid="custom-mcp-review"
    >
      <div
        class="max-h-full w-full max-w-2xl overflow-y-auto rounded border border-[var(--line)] bg-[var(--bg-1)] p-5"
      >
        <h2
          id="custom-mcp-review-title"
          class="mono text-[14px] text-[var(--ink)]"
          data-testid="custom-mcp-review-title"
        >
          Review {{ cap(current().name, 40) }}
          @if (current().proposed_by_repo) {
            <span class="pill amber ml-2" data-testid="custom-mcp-review-proposed">{{
              proposedLabel
            }}</span>
          }
        </h2>

        @if (current().host_warning) {
          <div
            class="mt-3 rounded ring-1 ring-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-[var(--amber)]"
            role="alert"
            data-testid="custom-mcp-review-host-warning"
          >
            {{ hostWarning }}
          </div>
        }

        @if (npm(); as d) {
          <dl
            class="mt-4 grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-[12px]"
            data-testid="custom-mcp-review-npm"
          >
            <dt class="text-[var(--ink-mute)]">package</dt>
            <dd class="mono break-all text-[var(--ink)]" data-testid="custom-mcp-review-package">
              {{ cap(d.package, 120) }}
            </dd>
            <dt class="text-[var(--ink-mute)]">exact version</dt>
            <dd class="mono text-[var(--ink)]" data-testid="custom-mcp-review-version">
              {{ cap(d.version, 60) }}
            </dd>
            <dt class="text-[var(--ink-mute)]">release date</dt>
            <dd class="mono text-[var(--ink)]" data-testid="custom-mcp-review-published">
              {{ cap(d.published_at, 40) }}
            </dd>
            <dt class="text-[var(--ink-mute)]">integrity</dt>
            <dd
              class="mono break-all text-[var(--ink-dim)]"
              data-testid="custom-mcp-review-integrity"
            >
              {{ cap(d.integrity, 120) }}
            </dd>
            <dt class="text-[var(--ink-mute)]">license</dt>
            <dd class="mono text-[var(--ink)]" data-testid="custom-mcp-review-license">
              {{ d.license ? cap(d.license, 60) : 'none declared' }}
            </dd>
            <dt class="text-[var(--ink-mute)]">dependencies</dt>
            <dd class="mono text-[var(--ink)]" data-testid="custom-mcp-review-dependencies">
              {{ d.dependency_count }}
            </dd>
            <dt class="text-[var(--ink-mute)]">publisher</dt>
            <dd class="mono text-[var(--ink)]" data-testid="custom-mcp-review-publisher">
              {{ d.publisher ? cap(d.publisher, 60) : 'unknown' }}
              @if (d.maintainers.length > 0) {
                <span class="text-[var(--ink-mute)]">
                  · maintainers: {{ cap(d.maintainers.join(', '), 120) }}</span
                >
              }
            </dd>
            @if (d.publisher_changed) {
              <dt class="sr-only">publisher change</dt>
              <dd
                class="col-span-2 rounded ring-1 ring-amber-500/40 bg-amber-500/[0.06] px-2 py-1 text-[var(--amber)]"
                role="alert"
                data-testid="custom-mcp-review-publisher-changed"
              >
                Publisher changed since your last approval: version
                {{ cap(d.previous_version, 40) }} was published by
                {{ cap(d.previous_publisher, 60) }}.
              </dd>
            }
            <dt class="text-[var(--ink-mute)]">provenance</dt>
            <dd class="mono text-[var(--ink)]" data-testid="custom-mcp-review-provenance">
              {{ d.provenance ? 'npm provenance attestation' : 'none' }}
            </dd>
            <dt class="text-[var(--ink-mute)]">install scripts</dt>
            <dd class="mono text-[var(--ink)]" data-testid="custom-mcp-review-install-script">
              {{
                d.has_install_script ? 'yes (skipped: the server may not work without them)' : 'no'
              }}
            </dd>
            <dt class="text-[var(--ink-mute)]">resolved before</dt>
            <dd class="mono text-[var(--ink-dim)]">{{ cap(d.before_date, 40) }}</dd>
            <dt class="text-[var(--ink-mute)]">arguments</dt>
            <dd class="mono break-all text-[var(--ink)]" data-testid="custom-mcp-review-args">
              @if (d.args.length === 0) {
                none
              } @else {
                @for (arg of d.args; track $index) {
                  <span class="mr-1 rounded bg-[var(--bg-3)] px-1">{{ cap(arg, 120) }}</span>
                }
                @if (current().proposed_by_repo) {
                  <span class="pill amber ml-1">{{ proposedLabel }}</span>
                }
              }
            </dd>
          </dl>

          @if (d.env_keys.length > 0) {
            <fieldset class="mt-4" data-testid="custom-mcp-review-env">
              <legend class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
                Credentials (optional; stored for this server only)
              </legend>
              @for (key of d.env_keys; track key) {
                <label class="mt-1 flex items-center gap-2 text-[12px]">
                  <span class="mono w-48 truncate text-[var(--ink)]">{{ cap(key, 64) }}</span>
                  <input
                    type="password"
                    autocomplete="off"
                    class="min-w-[8rem] flex-1 rounded border border-[var(--line)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--ink)]"
                    [attr.aria-label]="'Value of ' + key"
                    [attr.data-testid]="'custom-mcp-review-env-' + key"
                    (input)="setEnvValue(key, eventValue($event))"
                  />
                </label>
              }
            </fieldset>
          }
        }

        @if (host(); as h) {
          <dl
            class="mt-4 grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-[12px]"
            data-testid="custom-mcp-review-host"
          >
            <dt class="text-[var(--ink-mute)]">port</dt>
            <dd class="mono text-[var(--ink)]">{{ h.port }}</dd>
            <dt class="text-[var(--ink-mute)]">path</dt>
            <dd class="mono break-all text-[var(--ink)]">{{ cap(h.path, 120) }}</dd>
            <dt class="text-[var(--ink-mute)]">reachable</dt>
            <dd class="mono text-[var(--ink)]" data-testid="custom-mcp-review-reachable">
              {{ h.upstream_reachable ? 'yes' : 'no' }}
            </dd>
          </dl>
          @if (!h.upstream_reachable) {
            <div
              class="mt-2 flex items-center gap-3 text-[12px] text-[var(--amber)]"
              data-testid="custom-mcp-review-not-running"
            >
              <span>{{ notRunning() }}</span>
              <button
                type="button"
                [class]="secondaryButton"
                [disabled]="busy()"
                data-testid="custom-mcp-review-retry"
                (click)="retryProbe()"
              >
                $ retry
              </button>
            </div>
          }
        }

        @for (warning of current().warnings; track $index) {
          <p class="mt-2 text-[12px] text-[var(--amber)]" data-testid="custom-mcp-review-warning">
            {{ cap(warning) }}
          </p>
        }

        <fieldset class="mt-4" data-testid="custom-mcp-review-pii">
          <legend class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            Personal data
            @if (current().forced.pii_mode) {
              <span class="pill ml-1" data-testid="custom-mcp-review-pii-forced">{{
                enforcedLabel
              }}</span>
            }
          </legend>
          @for (opt of piiOptions; track opt.value) {
            <label class="mt-1 flex items-start gap-2 text-[12px] text-[var(--ink)]">
              <input
                type="radio"
                name="custom-mcp-review-pii"
                class="mt-0.5 accent-[var(--accent)]"
                [checked]="piiMode() === opt.value"
                [disabled]="current().forced.pii_mode !== null"
                [attr.data-testid]="'custom-mcp-review-pii-' + opt.value"
                (change)="piiMode.set(opt.value)"
              />
              <span>{{ opt.label }}</span>
            </label>
          }
        </fieldset>

        <fieldset class="mt-4" data-testid="custom-mcp-review-files">
          <legend class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            Project files
            @if (current().forced.workspace_mode_max) {
              <span class="pill ml-1" data-testid="custom-mcp-review-files-forced">{{
                enforcedLabel
              }}</span>
            }
          </legend>
          @for (opt of fileOptions; track opt.value) {
            <label class="mt-1 flex items-center gap-2 text-[12px] text-[var(--ink)]">
              <input
                type="radio"
                name="custom-mcp-review-files"
                class="accent-[var(--accent)]"
                [checked]="workspaceMode() === opt.value"
                [disabled]="!fileModeAllowed(opt.value)"
                [attr.data-testid]="'custom-mcp-review-files-' + opt.value"
                (change)="pickWorkspaceMode(opt.value)"
              />
              <span>{{ opt.label }}</span>
            </label>
          }
          @if (workspaceMode() !== 'none') {
            <label
              class="mt-2 flex items-start gap-2 text-[12px] text-[var(--amber)]"
              data-testid="custom-mcp-review-confirm-read-label"
            >
              <input
                type="checkbox"
                class="mt-0.5 accent-[var(--accent)]"
                [checked]="readConfirmed()"
                data-testid="custom-mcp-review-confirm-read"
                (change)="readConfirmed.set(eventChecked($event))"
              />
              <span>{{ readConfirmation }}</span>
            </label>
          }
          @if (workspaceMode() === 'read_write') {
            <label
              class="mt-1 flex items-start gap-2 text-[12px] text-[var(--amber)]"
              data-testid="custom-mcp-review-confirm-write-label"
            >
              <input
                type="checkbox"
                class="mt-0.5 accent-[var(--accent)]"
                [checked]="writeConfirmed()"
                data-testid="custom-mcp-review-confirm-write"
                (change)="writeConfirmed.set(eventChecked($event))"
              />
              <span>{{ writeConfirmation }}</span>
            </label>
          }
        </fieldset>

        @if (current().host_warning) {
          <label class="mt-4 flex items-start gap-2 text-[12px] text-[var(--amber)]">
            <input
              type="checkbox"
              class="mt-0.5 accent-[var(--accent)]"
              [checked]="hostConfirmed()"
              data-testid="custom-mcp-review-confirm-host"
              (change)="hostConfirmed.set(eventChecked($event))"
            />
            <span>I trust every tool this server offers.</span>
          </label>
        }
        @if (npm()?.publisher_changed) {
          <label class="mt-2 flex items-start gap-2 text-[12px] text-[var(--amber)]">
            <input
              type="checkbox"
              class="mt-0.5 accent-[var(--accent)]"
              [checked]="publisherConfirmed()"
              data-testid="custom-mcp-review-confirm-publisher"
              (change)="publisherConfirmed.set(eventChecked($event))"
            />
            <span>I checked the new publisher.</span>
          </label>
        }

        @if (error()) {
          <p
            class="mt-3 text-[12px] text-[var(--red)]"
            role="alert"
            data-testid="custom-mcp-review-error"
          >
            {{ error() }}
          </p>
        }

        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            [class]="secondaryButton"
            [disabled]="busy()"
            data-testid="custom-mcp-review-cancel"
            (click)="closed.emit()"
          >
            cancel
          </button>
          <button
            type="button"
            class="mono rounded border border-[var(--accent-dim)] bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-50"
            [disabled]="!canApprove()"
            data-testid="custom-mcp-review-approve"
            (click)="approve()"
          >
            $ approve
          </button>
        </div>
      </div>
    </div>
  `,
})
export class CustomMcpReviewComponent {
  /** The project the server is for. */
  readonly project = input.required<string>();
  /** The review `custom_mcp_preview` returned. */
  readonly preview = input.required<CustomMcpPreview>();
  /** Emitted when the user leaves without approving. */
  readonly closed = output<void>();
  /** Emitted after a successful approval. */
  readonly approved = output<string>();

  /** The review shown, replaced when a host probe is retried. */
  readonly current = linkedSignal(() => this.preview());
  /** The PII radio, preset to the organization's choice or tokens. */
  readonly piiMode = linkedSignal<CustomPiiMode>(() => this.current().forced.pii_mode ?? 'tokens');
  /** The project files radio. */
  readonly workspaceMode = signal<CustomWorkspaceMode>('none');
  /** The read confirmation checkbox. */
  readonly readConfirmed = signal(false);
  /** The write confirmation checkbox. */
  readonly writeConfirmed = signal(false);
  /** The host warning confirmation checkbox. */
  readonly hostConfirmed = signal(false);
  /** The publisher change confirmation checkbox. */
  readonly publisherConfirmed = signal(false);
  /** True while a call runs. */
  readonly busy = signal(false);
  /** The last refused call. */
  readonly error = signal('');

  /** The npm facts, `null` for a host server. */
  readonly npm = computed<CustomMcpNpmPreview | null>(() => {
    const d = this.current().details;
    return d.kind === 'npm' ? d : null;
  });
  /** The host probe, `null` for an npm server. */
  readonly host = computed<CustomMcpHostPreview | null>(() => {
    const d = this.current().details;
    return d.kind === 'host' ? d : null;
  });
  /** The message shown while nothing answers on the host port. */
  readonly notRunning = computed(() => hostAppNotRunning(this.current().name));

  /** Whether every confirmation the choices need is given. */
  readonly canApprove = computed<boolean>(() => {
    if (this.busy()) return false;
    const mode = this.workspaceMode();
    if (!workspaceModeAllowed(mode, this.current().forced.workspace_mode_max)) return false;
    if (mode !== 'none' && !this.readConfirmed()) return false;
    if (mode === 'read_write' && !this.writeConfirmed()) return false;
    if (this.current().host_warning && !this.hostConfirmed()) return false;
    if (this.npm()?.publisher_changed && !this.publisherConfirmed()) return false;
    return true;
  });

  protected readonly hostWarning = HOST_WARNING_TEXT;
  protected readonly proposedLabel = PROPOSED_BY_REPO_LABEL;
  protected readonly enforcedLabel = ENFORCED_LABEL;
  protected readonly readConfirmation = FILE_READ_CONFIRMATION;
  protected readonly writeConfirmation = FILE_WRITE_CONFIRMATION;
  protected readonly piiOptions = PII_OPTIONS;
  protected readonly fileOptions = FILE_ACCESS_OPTIONS;
  protected readonly secondaryButton = SECONDARY_BUTTON;
  protected readonly cap = capText;
  protected readonly eventValue = eventValue;
  protected readonly eventChecked = eventChecked;

  private readonly envValues = signal<Record<string, string>>({});
  private readonly customMcp = inject(CustomMcpService);

  /**
   * Whether the organization's limit allows a project files option.
   * @param mode - the option
   */
  fileModeAllowed(mode: CustomWorkspaceMode): boolean {
    return workspaceModeAllowed(mode, this.current().forced.workspace_mode_max);
  }

  /**
   * Picks a project files option; a new pick needs its confirmations again.
   * @param mode - the option
   */
  pickWorkspaceMode(mode: CustomWorkspaceMode): void {
    this.workspaceMode.set(mode);
    this.readConfirmed.set(false);
    this.writeConfirmed.set(false);
  }

  /**
   * Holds a credential value typed for an env key.
   * @param key - the env key
   * @param value - the typed value
   */
  setEnvValue(key: string, value: string): void {
    this.envValues.update((values) => ({ ...values, [key]: value }));
  }

  /** Probes the host server again. */
  async retryProbe(): Promise<void> {
    const h = this.host();
    if (!h) return;
    await this.run(async () => {
      this.current.set(
        await this.customMcp.preview(this.project(), {
          kind: 'host',
          name: this.current().name,
          port: h.port,
          path: h.path,
        })
      );
    });
  }

  /** Approves the review with the user's choices. */
  async approve(): Promise<void> {
    if (!this.canApprove()) return;
    const keys = this.npm()?.env_keys ?? [];
    const envValues: Record<string, string> = {};
    for (const key of keys) {
      const value = this.envValues()[key];
      if (value) envValues[key] = value;
    }
    const name = this.current().name;
    await this.run(async () => {
      await this.customMcp.approve(this.project(), this.current().preview_id, {
        name,
        pii_mode: this.piiMode(),
        workspace_mode: this.workspaceMode(),
        env_values: envValues,
      });
      this.approved.emit(name);
    });
  }

  private async run(task: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await task();
    } catch (e: unknown) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
