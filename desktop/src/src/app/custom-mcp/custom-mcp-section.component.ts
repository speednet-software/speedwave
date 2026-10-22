import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { CustomMcpService } from '../services/custom-mcp.service';
import { ProjectStateService } from '../services/project-state.service';
import type {
  CustomMcpEntry,
  CustomMcpPreview,
  CustomMcpProposal,
  CustomMcpProposalSource,
} from '../models/custom-mcp';
import { eventValue } from '../shared/dom-event';
import { CustomMcpCardComponent } from './custom-mcp-card.component';
import { CustomMcpHostFormComponent } from './custom-mcp-host-form.component';
import { CustomMcpReviewComponent } from './custom-mcp-review.component';
import {
  ORG_DISABLED_LABEL,
  PROPOSED_BY_REPO_LABEL,
  capText,
  errorText,
  reasonText,
  serverNameError,
  sourceLabel,
  statePillClass,
  statusDot,
} from './custom-mcp-text';

/** Which add-server form is open. */
type AddMode = 'choose' | 'npm' | 'host';

/** One `.mcp.json` proposal with the name the user gives it. */
interface ProposalRow {
  proposal: CustomMcpProposal;
  name: string;
}

const BUTTON =
  'mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2.5 py-0.5 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-50';
const PRIMARY_BUTTON =
  'mono rounded border border-[var(--accent-dim)] bg-[var(--accent)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-50';
const FIELD =
  'mono w-full rounded border border-[var(--line)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--ink)]';
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Splits a typed list of env key names.
 * @param raw - names separated by commas or spaces
 */
export function parseEnvKeys(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter((k) => k !== '');
}

/**
 * One-line description of what a `.mcp.json` entry asks to run.
 * @param source - the proposal source
 */
export function proposalSourceLabel(source: CustomMcpProposalSource): string {
  switch (source.kind) {
    case 'npm':
      return `npm ${capText(source.package, 80)}${source.version ? '@' + capText(source.version, 40) : ''}`;
    case 'remote':
      return `remote ${capText(source.host, 80)}`;
    default:
      return capText(source.command, 80);
  }
}

/**
 * The Custom MCP servers of one project (beta, ADR-100..103): the list, repository proposals,
 * the add-server forms and the review overlay. Rendered per project; every call names it.
 */
@Component({
  selector: 'app-custom-mcp-section',
  imports: [CustomMcpCardComponent, CustomMcpHostFormComponent, CustomMcpReviewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section id="custom-mcp-servers" data-testid="custom-mcp-section">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <h2 class="view-title view-title-section text-[var(--ink)]" data-testid="custom-mcp-title">
          Custom MCP servers
        </h2>
        @if (managedDisabled()) {
          <span class="pill" data-testid="custom-mcp-org-disabled">{{ orgDisabledLabel }}</span>
        } @else {
          <div class="ml-auto flex items-center gap-2">
            <button
              type="button"
              [class]="buttonClass"
              [disabled]="!project() || scanning()"
              data-testid="custom-mcp-scan"
              (click)="scan()"
            >
              $ scan repo
            </button>
            <button
              type="button"
              [class]="primaryButton"
              [disabled]="!project()"
              data-testid="custom-mcp-add"
              (click)="openAdd()"
            >
              $ add server
            </button>
          </div>
        }
      </div>

      @if (managedDisabled()) {
        <p class="text-[12px] text-[var(--ink-mute)]" data-testid="custom-mcp-org-disabled-text">
          Your organization turned off custom MCP servers.
        </p>
      } @else {
        @if (customMcp.error() || error()) {
          <div
            class="mb-3 rounded ring-1 ring-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-300"
            role="alert"
            data-testid="custom-mcp-error"
          >
            {{ error() || customMcp.error() }}
          </div>
        }

        @if (addMode(); as mode) {
          <div class="mb-3" data-testid="custom-mcp-add-panel">
            @if (mode === 'choose') {
              <div
                class="flex flex-wrap items-center gap-2 rounded border border-[var(--line)] bg-[var(--bg-1)] p-3"
              >
                <span class="text-[12px] text-[var(--ink-dim)]">Add a server from</span>
                <button
                  type="button"
                  [class]="buttonClass"
                  data-testid="custom-mcp-add-npm"
                  (click)="addMode.set('npm')"
                >
                  $ npm package
                </button>
                <button
                  type="button"
                  [class]="buttonClass"
                  [disabled]="hostServersDisabled()"
                  data-testid="custom-mcp-add-host"
                  (click)="addMode.set('host')"
                >
                  $ server on this computer
                </button>
                @if (hostServersDisabled()) {
                  <span class="pill" data-testid="custom-mcp-add-host-org-disabled">{{
                    orgDisabledLabel
                  }}</span>
                }
                <button
                  type="button"
                  [class]="buttonClass + ' ml-auto'"
                  data-testid="custom-mcp-add-cancel"
                  (click)="addMode.set(null)"
                >
                  cancel
                </button>
              </div>
            } @else if (mode === 'host') {
              <app-custom-mcp-host-form
                [project]="project()!"
                [orgDisabled]="hostServersDisabled()"
                (previewed)="openReview($event)"
                (cancelled)="addMode.set(null)"
              />
            } @else {
              <form
                class="rounded border border-[var(--line)] bg-[var(--bg-1)] p-3"
                data-testid="custom-mcp-npm-form"
                (submit)="$event.preventDefault(); reviewNpm()"
              >
                <div class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
                  npm package
                </div>
                <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <label class="text-[11px] text-[var(--ink-mute)]">
                    name
                    <input
                      type="text"
                      [class]="field"
                      placeholder="figma"
                      autocomplete="off"
                      [value]="npmName()"
                      data-testid="custom-mcp-npm-name"
                      (input)="npmName.set(eventValue($event))"
                    />
                  </label>
                  <label class="text-[11px] text-[var(--ink-mute)]">
                    package
                    <input
                      type="text"
                      [class]="field"
                      placeholder="figma-developer-mcp"
                      autocomplete="off"
                      [value]="npmPackage()"
                      data-testid="custom-mcp-npm-package"
                      (input)="npmPackage.set(eventValue($event))"
                    />
                  </label>
                  <label class="text-[11px] text-[var(--ink-mute)]">
                    exact version
                    <input
                      type="text"
                      [class]="field"
                      placeholder="0.6.1"
                      autocomplete="off"
                      [value]="npmVersion()"
                      data-testid="custom-mcp-npm-version"
                      (input)="npmVersion.set(eventValue($event))"
                    />
                  </label>
                </div>
                <label class="mt-2 block text-[11px] text-[var(--ink-mute)]">
                  credential names (optional, comma-separated)
                  <input
                    type="text"
                    [class]="field"
                    placeholder="FIGMA_API_KEY"
                    autocomplete="off"
                    [value]="npmEnvKeys()"
                    data-testid="custom-mcp-npm-env"
                    (input)="npmEnvKeys.set(eventValue($event))"
                  />
                </label>
                @if (npmTouched() && npmError()) {
                  <p class="mt-1 text-[11px] text-[var(--red)]" data-testid="custom-mcp-npm-error">
                    {{ npmError() }}
                  </p>
                }
                <div class="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    [class]="buttonClass"
                    [disabled]="previewing()"
                    (click)="addMode.set(null)"
                  >
                    cancel
                  </button>
                  <button
                    type="submit"
                    [class]="primaryButton"
                    [disabled]="previewing() || npmError() !== null"
                    data-testid="custom-mcp-npm-submit"
                  >
                    {{ previewing() ? 'resolving…' : '$ review' }}
                  </button>
                </div>
              </form>
            }
          </div>
        }

        @if (proposals(); as rows) {
          <div
            class="mb-3 rounded border border-[var(--line)] bg-[var(--bg-1)] p-3"
            data-testid="custom-mcp-proposals"
          >
            <div class="flex items-center gap-2">
              <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                >.mcp.json</span
              >
              <span class="pill amber">{{ proposedLabel }}</span>
              <button
                type="button"
                [class]="buttonClass + ' ml-auto'"
                data-testid="custom-mcp-proposals-close"
                (click)="proposals.set(null)"
              >
                close
              </button>
            </div>
            @if (rows.length === 0) {
              <p
                class="mt-2 text-[12px] text-[var(--ink-mute)]"
                data-testid="custom-mcp-proposals-empty"
              >
                This repository proposes no MCP servers.
              </p>
            }
            @for (row of rows; track row.proposal.key; let i = $index) {
              <div
                class="mt-2 flex flex-wrap items-center gap-2 text-[12px]"
                [attr.data-testid]="'custom-mcp-proposal-' + i"
              >
                <span class="mono text-[var(--ink)]">{{ cap(row.proposal.key, 64) }}</span>
                <span class="mono text-[var(--ink-mute)]">{{
                  proposalSource(row.proposal.source)
                }}</span>
                @if (row.proposal.configured_as) {
                  <span class="pill green"
                    >configured as {{ cap(row.proposal.configured_as, 40) }}</span
                  >
                } @else if (row.proposal.builtin_integration) {
                  <span class="pill"
                    >use the built-in
                    {{ cap(row.proposal.builtin_integration, 40) }} integration</span
                  >
                } @else if (row.proposal.status === 'ready') {
                  <input
                    type="text"
                    class="mono w-40 rounded border border-[var(--line)] bg-[var(--bg)] px-2 py-0.5 text-[12px] text-[var(--ink)]"
                    autocomplete="off"
                    [attr.aria-label]="'Name for ' + row.proposal.key"
                    [value]="row.name"
                    [attr.data-testid]="'custom-mcp-proposal-name-' + i"
                    (input)="renameProposal(i, eventValue($event))"
                  />
                  <button
                    type="button"
                    [class]="buttonClass"
                    [disabled]="previewing() || nameError(row.name) !== null"
                    [attr.data-testid]="'custom-mcp-proposal-review-' + i"
                    (click)="reviewProposal(row)"
                  >
                    $ review
                  </button>
                } @else {
                  <span class="pill amber">{{ row.proposal.status }}</span>
                }
                @if (row.proposal.reason) {
                  <span class="w-full text-[11px] text-[var(--ink-mute)]">{{
                    cap(row.proposal.reason)
                  }}</span>
                }
                @if (row.proposal.refused_env_keys.length > 0) {
                  <span class="w-full text-[11px] text-[var(--amber)]"
                    >Refused credential names:
                    {{ cap(row.proposal.refused_env_keys.join(', ')) }}</span
                  >
                }
              </div>
            }
          </div>
        }

        @if (servers().length === 0) {
          <p
            class="mono rounded border border-dashed border-[var(--line)] py-6 text-center text-[12px] text-[var(--ink-mute)]"
            data-testid="custom-mcp-empty"
          >
            No custom MCP servers. Use "$ scan repo" to see the ones this repository proposes, or "$
            add server".
          </p>
        } @else {
          <div class="overflow-hidden rounded border border-[var(--line)]">
            <table class="w-full text-[13px]" data-testid="custom-mcp-table">
              <caption class="sr-only">
                Custom MCP servers
              </caption>
              <thead
                class="mono border-b border-[var(--line)] bg-[var(--bg-1)] text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
              >
                <tr>
                  <th class="px-4 py-2 text-left font-normal" scope="col">server</th>
                  <th class="hidden px-4 py-2 text-left font-normal md:table-cell" scope="col">
                    source
                  </th>
                  <th class="px-4 py-2 text-left font-normal" scope="col">status</th>
                  <th class="px-4 py-2 text-left font-normal" scope="col">tools</th>
                  <th class="hidden px-4 py-2 text-left font-normal md:table-cell" scope="col">
                    pii
                  </th>
                  <th class="px-4 py-2 text-right font-normal" scope="col">on</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--line)]">
                @for (s of servers(); track s.name) {
                  <tr
                    class="hover-bg mono cursor-pointer"
                    tabindex="0"
                    role="button"
                    [attr.aria-expanded]="expanded() === s.name"
                    [attr.data-testid]="'custom-mcp-row-' + s.name"
                    (click)="toggleExpand(s.name)"
                    (keydown.enter)="toggleExpand(s.name)"
                  >
                    <td class="px-4 py-2.5">
                      <span [style.color]="dot(s).colour">{{ dot(s).glyph }}</span>
                      <span class="ml-2 text-[var(--ink)]">{{ cap(s.name, 40) }}</span>
                    </td>
                    <td class="hidden px-4 py-2.5 text-[12px] text-[var(--ink-mute)] md:table-cell">
                      {{ source(s) }}
                    </td>
                    <td class="px-4 py-2.5">
                      <span
                        [class]="'pill ' + pillClass(s)"
                        [attr.title]="reason(s) || null"
                        [attr.data-testid]="'custom-mcp-row-status-' + s.name"
                        >{{ s.state }}</span
                      >
                    </td>
                    <td
                      class="px-4 py-2.5 text-[12px] text-[var(--ink-dim)]"
                      [attr.data-testid]="'custom-mcp-row-tools-' + s.name"
                    >
                      {{ toolCount(s) }}
                    </td>
                    <td class="hidden px-4 py-2.5 text-[12px] text-[var(--ink-dim)] md:table-cell">
                      {{ s.pii_mode }}
                    </td>
                    <td class="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        class="toggle ml-auto"
                        [class.on]="s.enabled"
                        [disabled]="toggling() === s.name"
                        [attr.aria-pressed]="s.enabled"
                        [attr.aria-label]="(s.enabled ? 'Disable ' : 'Enable ') + s.name"
                        [attr.data-testid]="'custom-mcp-row-toggle-' + s.name"
                        (click)="$event.stopPropagation(); toggle(s)"
                        (keydown.enter)="$event.stopPropagation()"
                      ></button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (expandedEntry(); as e) {
            <div
              class="mt-3 overflow-hidden rounded ring-1 ring-[var(--accent-dim)]"
              [attr.data-testid]="'custom-mcp-expanded-' + e.name"
            >
              @if (e.proposed_by_repo) {
                <div
                  class="border-b border-[var(--line)] bg-[var(--bg-1)] px-4 py-1.5 text-[12px] text-[var(--ink-dim)]"
                >
                  ▼ {{ cap(e.name, 40) }} — {{ proposedLabel }}
                </div>
              }
              <app-custom-mcp-card [project]="project()!" [entry]="e" />
            </div>
          }
        }
      }
    </section>

    @if (review(); as preview) {
      <app-custom-mcp-review
        [project]="project()!"
        [preview]="preview"
        (closed)="review.set(null)"
        (approved)="onApproved($event)"
      />
    }
  `,
})
export class CustomMcpSectionComponent implements OnInit, OnDestroy {
  /** The project this section belongs to, `null` before the app knows it. */
  readonly project = input<string | null>(null);

  /** The servers of this project, none while the list belongs to another one. */
  readonly servers = computed<CustomMcpEntry[]>(() =>
    this.customMcp.project() === this.project() ? this.customMcp.entries() : []
  );
  /** Whether the organization turned Custom MCP servers off. */
  readonly managedDisabled = computed(
    () => this.customMcp.project() === this.project() && this.customMcp.managedDisabled()
  );
  /** Whether the organization turned host servers off. */
  readonly hostServersDisabled = computed(() =>
    this.servers().some((s) => s.forced.host_servers_disabled)
  );
  /** The expanded server name. */
  readonly expanded = signal<string | null>(null);
  /** The expanded server. */
  readonly expandedEntry = computed(
    () => this.servers().find((s) => s.name === this.expanded()) ?? null
  );
  /** The open add-server form. */
  readonly addMode = signal<AddMode | null>(null);
  /** The last scan, `null` when none is shown. */
  readonly proposals = signal<ProposalRow[] | null>(null);
  /** The review overlay. */
  readonly review = signal<CustomMcpPreview | null>(null);
  /** True while a scan runs. */
  readonly scanning = signal(false);
  /** True while an npm package is resolved for review. */
  readonly previewing = signal(false);
  /** The server whose toggle is saved. */
  readonly toggling = signal<string | null>(null);
  /** The last refused section-level call. */
  readonly error = signal('');

  /** The typed npm server name. */
  readonly npmName = signal('');
  /** The typed npm package. */
  readonly npmPackage = signal('');
  /** The typed exact version. */
  readonly npmVersion = signal('');
  /** The typed credential names. */
  readonly npmEnvKeys = signal('');
  /** True once the npm form was typed in. */
  readonly npmTouched = computed(() => this.npmName() !== '' || this.npmPackage() !== '');
  /** The first npm form error, `null` when it can be submitted. */
  readonly npmError = computed<string | null>(() => {
    const nameErr = serverNameError(this.npmName());
    if (nameErr) return nameErr;
    if (this.npmPackage().trim() === '') return 'Enter the npm package.';
    if (!EXACT_VERSION.test(this.npmVersion().trim())) {
      return 'Enter an exact version such as 1.2.3.';
    }
    const bad = parseEnvKeys(this.npmEnvKeys()).find((k) => !ENV_KEY.test(k));
    return bad ? `"${capText(bad, 40)}" is not a credential name (A-Z, 0-9, _).` : null;
  });

  protected readonly customMcp = inject(CustomMcpService);
  protected readonly buttonClass = BUTTON;
  protected readonly primaryButton = PRIMARY_BUTTON;
  protected readonly field = FIELD;
  protected readonly proposedLabel = PROPOSED_BY_REPO_LABEL;
  protected readonly orgDisabledLabel = ORG_DISABLED_LABEL;
  protected readonly cap = capText;
  protected readonly eventValue = eventValue;
  protected readonly dot = statusDot;
  protected readonly source = (s: CustomMcpEntry): string => sourceLabel(s.source);
  protected readonly pillClass = (s: CustomMcpEntry): string => statePillClass(s.state);
  protected readonly reason = (s: CustomMcpEntry): string => reasonText(s.reason);
  protected readonly proposalSource = proposalSourceLabel;
  protected readonly nameError = serverNameError;

  private readonly projectState = inject(ProjectStateService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private unsubscribers: (() => void)[] = [];

  /** Opens the add-server form when the command palette asks for it. */
  constructor() {
    effect(() => {
      if (!this.customMcp.addServerRequested()) return;
      untracked(() => {
        if (!this.project() || this.managedDisabled()) return;
        if (!this.customMcp.consumeAddServerRequest()) return;
        this.openAdd();
        this.host.nativeElement.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      });
    });
  }

  /** Loads the servers, and reloads them once containers are ready or restarted. */
  ngOnInit(): void {
    void this.reload();
    this.unsubscribers = [
      this.projectState.onProjectReady(() => void this.reload()),
      this.projectState.onRestartComplete(() => void this.reload()),
    ];
  }

  /** Drops the project listeners. */
  ngOnDestroy(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  /**
   * Allowed over listed tools, `—` while the list is not available.
   * @param s - the server
   */
  toolCount(s: CustomMcpEntry): string {
    if (!s.tools_available) return '—';
    return `${s.tools.filter((t) => t.state === 'allowed').length}/${s.tools.length}`;
  }

  /**
   * Expands a server row, or collapses it when it is open.
   * @param name - the server name
   */
  toggleExpand(name: string): void {
    this.expanded.update((current) => (current === name ? null : name));
  }

  /** Opens the add-server choice. */
  openAdd(): void {
    this.addMode.set('choose');
  }

  /**
   * Turns a server on or off from its row.
   * @param s - the server
   */
  async toggle(s: CustomMcpEntry): Promise<void> {
    const project = this.project();
    if (!project) return;
    this.toggling.set(s.name);
    this.error.set('');
    try {
      await this.customMcp.setEnabled(project, s.name, !s.enabled);
    } catch (e: unknown) {
      this.error.set(errorText(e));
    } finally {
      this.toggling.set(null);
    }
  }

  /** Lists the servers the repository's `.mcp.json` proposes. */
  async scan(): Promise<void> {
    const project = this.project();
    if (!project) return;
    this.scanning.set(true);
    this.error.set('');
    try {
      const found = await this.customMcp.scanRepo(project);
      if (project !== this.project()) return;
      this.proposals.set(found.map((p) => ({ proposal: p, name: p.suggested_name ?? '' })));
    } catch (e: unknown) {
      this.error.set(errorText(e));
    } finally {
      this.scanning.set(false);
    }
  }

  /**
   * Sets the name a proposal will be reviewed under.
   * @param index - the proposal row
   * @param name - the typed name
   */
  renameProposal(index: number, name: string): void {
    this.proposals.update((rows) =>
      rows ? rows.map((r, i) => (i === index ? { ...r, name } : r)) : rows
    );
  }

  /**
   * Starts the review of a ready npm proposal.
   * @param row - the proposal and its name
   */
  async reviewProposal(row: ProposalRow): Promise<void> {
    const source = row.proposal.source;
    if (source.kind !== 'npm' || source.version === null) return;
    await this.startNpmReview({
      name: row.name,
      package: source.package,
      version: source.version,
      args: row.proposal.args,
      env_keys: row.proposal.env_keys,
    });
  }

  /** Starts the review of the typed npm package. */
  async reviewNpm(): Promise<void> {
    if (this.npmError() !== null) return;
    await this.startNpmReview({
      name: this.npmName(),
      package: this.npmPackage().trim(),
      version: this.npmVersion().trim(),
      args: [],
      env_keys: parseEnvKeys(this.npmEnvKeys()),
    });
  }

  /**
   * Shows a review.
   * @param preview - the review to show
   */
  openReview(preview: CustomMcpPreview): void {
    this.review.set(preview);
  }

  /**
   * Closes the review and forms after an approval and expands the new server.
   * @param name - the approved server name
   */
  onApproved(name: string): void {
    this.review.set(null);
    this.addMode.set(null);
    this.proposals.set(null);
    this.expanded.set(name);
  }

  private async startNpmReview(req: {
    name: string;
    package: string;
    version: string;
    args: string[];
    env_keys: string[];
  }): Promise<void> {
    const project = this.project();
    if (!project) return;
    this.previewing.set(true);
    this.error.set('');
    try {
      const preview = await this.customMcp.preview(project, { kind: 'npm', ...req });
      if (project === this.project()) this.review.set(preview);
    } catch (e: unknown) {
      this.error.set(errorText(e));
    } finally {
      this.previewing.set(false);
    }
  }

  private async reload(): Promise<void> {
    const project = this.project();
    if (project) await this.customMcp.refresh(project);
  }
}
