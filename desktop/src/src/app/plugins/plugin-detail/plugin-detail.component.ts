import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Marked } from 'marked';
import { ActivatedRoute, Router } from '@angular/router';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { LoggerService } from '../../services/logger.service';
import {
  PluginStatusEntry,
  PluginsResponse,
  PluginSaveCredentialsEvent,
} from '../../models/plugin';
import {
  IntegrationsResponse,
  OAuthFlowStatus,
  OAuthProgressEvent,
} from '../../models/integration';
import { PluginSettingsFormComponent } from '../plugin-settings-form/plugin-settings-form.component';
import { PluginCredentialsFormComponent } from '../plugin-credentials-form/plugin-credentials-form.component';
import { ProjectPillComponent } from '../../project-switcher/project-pill.component';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { BridgeConnectionComponent } from '../bridge-connection/bridge-connection.component';

/** Tabs available in the plugin-detail view. */
export type PluginDetailTab = 'dashboard' | 'settings' | 'logs';

/** Shown when a mutation is attempted with no active project / loaded plugin. */
const NO_ACTIVE_PROJECT_MSG = 'No active project — open or create a project first.';

/** Scoped `marked` for the Dashboard `instructions` block; forces `<a>` to open in a new tab with `rel="noopener noreferrer"`. */
/**
 * Escape a string for interpolation into an HTML attribute value.
 * @param s the string to escape
 * @returns `s` with `&` → `&amp;` and `"` → `&quot;`
 */
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

const instructionsMarked = new Marked({
  renderer: {
    link({ href, title, text }) {
      const titleAttr = title ? ` title="${escAttr(title)}"` : '';
      return `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
    },
  },
});

/** Detail page for a single plugin with Dashboard / Settings / Logs tabs. */
@Component({
  selector: 'app-plugin-detail',
  imports: [
    CommonModule,
    PluginSettingsFormComponent,
    PluginCredentialsFormComponent,
    ProjectPillComponent,
    TooltipDirective,
    BridgeConnectionComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex h-11 flex-shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--bg-1)] px-4 md:px-6"
      data-testid="detail-header"
    >
      <button
        type="button"
        class="mono flex-shrink-0 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
        appTooltip="Back to plugins"
        placement="bottom"
        data-testid="back-link"
        (click)="goBack()"
      >
        ←<span class="hidden md:inline"> all plugins</span>
      </button>
      <span class="hidden flex-shrink-0 text-[var(--line-strong)] md:inline">·</span>
      <h1 class="view-title view-title-page truncate text-[var(--ink)]" data-testid="detail-title">
        {{ plugin?.name || 'Plugin' }}
      </h1>
      @if (plugin) {
        <span
          class="mono hidden flex-shrink-0 text-[11px] text-[var(--ink-mute)] md:inline"
          data-testid="version-badge"
          >v{{ plugin.version }}</span
        >
        <span class="hidden flex-shrink-0 text-[var(--line-strong)] md:inline">·</span>
        <span class="pill green hidden flex-shrink-0 md:inline-flex" data-testid="signed-badge"
          >✓ ed25519</span
        >
        @if (plugin.configured) {
          <span
            class="pill green hidden flex-shrink-0 md:inline-flex"
            data-testid="configured-badge"
            >configured</span
          >
        }
      }
      <div class="ml-auto flex flex-shrink-0 items-center gap-3">
        @if (plugin) {
          <button
            type="button"
            class="toggle"
            [class.on]="plugin.enabled"
            [attr.aria-pressed]="plugin.enabled"
            [attr.aria-label]="(plugin.enabled ? 'Disable ' : 'Enable ') + plugin.name"
            data-testid="detail-toggle"
            (click)="onMasterToggle()"
          ></button>
          <span class="hidden text-[var(--line-strong)] md:inline">·</span>
        }
        <app-project-pill />
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-4 md:p-6" data-testid="detail-body">
      <div class="mx-auto max-w-3xl">
        @if (error) {
          <div
            class="mb-4 rounded ring-1 ring-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-300"
            data-testid="detail-error"
            role="alert"
          >
            {{ error }}
          </div>
        }
        @if (success) {
          <div
            class="mb-4 rounded ring-1 ring-[rgba(52,211,153,0.4)] bg-[rgba(52,211,153,0.06)] px-3 py-2 text-[12px] text-[var(--green)]"
            data-testid="detail-success"
            role="status"
          >
            {{ success }}
          </div>
        }

        @if (!plugin) {
          <p class="mono text-[12px] text-[var(--ink-mute)]" data-testid="plugin-not-found">
            Plugin not found.
          </p>
        } @else {
          <div
            class="mono mb-4 flex items-center gap-4 overflow-x-auto whitespace-nowrap border-b border-[var(--line)] text-[12px] sm:gap-5"
            role="tablist"
            data-testid="tab-bar"
          >
            <button
              type="button"
              role="tab"
              class="px-1 pb-2"
              [class.border-b-2]="true"
              [style.borderBottomColor]="
                activeTab === 'dashboard' ? 'var(--accent)' : 'transparent'
              "
              [style.color]="activeTab === 'dashboard' ? 'var(--ink)' : 'var(--ink-mute)'"
              [attr.aria-selected]="activeTab === 'dashboard'"
              data-testid="tab-dashboard"
              (click)="selectTab('dashboard')"
            >
              dashboard
            </button>
            <button
              type="button"
              role="tab"
              class="px-1 pb-2"
              [class.border-b-2]="true"
              [style.borderBottomColor]="activeTab === 'settings' ? 'var(--accent)' : 'transparent'"
              [style.color]="activeTab === 'settings' ? 'var(--ink)' : 'var(--ink-mute)'"
              [attr.aria-selected]="activeTab === 'settings'"
              data-testid="tab-settings"
              (click)="selectTab('settings')"
            >
              settings
            </button>
            <button
              type="button"
              role="tab"
              class="px-1 pb-2"
              [class.border-b-2]="true"
              [style.borderBottomColor]="activeTab === 'logs' ? 'var(--accent)' : 'transparent'"
              [style.color]="activeTab === 'logs' ? 'var(--ink)' : 'var(--ink-mute)'"
              [attr.aria-selected]="activeTab === 'logs'"
              data-testid="tab-logs"
              (click)="selectTab('logs')"
            >
              logs
            </button>
          </div>

          @if (activeTab === 'dashboard') {
            <div data-testid="dashboard-content">
              <p
                class="mb-4 text-[13px] leading-relaxed text-[var(--ink-dim)]"
                data-testid="plugin-description"
              >
                {{ plugin.description }}
              </p>

              @if (plugin.instructions && plugin.verification_status === 'verified') {
                <details
                  class="mb-4 rounded border border-[var(--line)] bg-[var(--bg-1)]"
                  data-testid="plugin-instructions-details"
                  [attr.open]="plugin.configured ? null : ''"
                >
                  <summary
                    class="mono flex cursor-pointer items-center gap-2 px-4 py-2.5 text-[10px] uppercase tracking-widest text-[var(--ink-mute)] hover:text-[var(--ink-dim)]"
                    data-testid="plugin-instructions-toggle"
                  >
                    Setup &amp; usage
                  </summary>
                  <div
                    class="prose-sw border-t border-[var(--line)] px-4 py-3 text-[13px] leading-relaxed"
                    data-testid="plugin-instructions"
                    [innerHTML]="renderedInstructions()"
                  ></div>
                </details>
              }
              @if (plugin.verification_status !== 'verified' && plugin.verification_error) {
                <p
                  class="mb-4 rounded border border-red-500/30 bg-red-500/[0.04] px-4 py-3 text-[12px] leading-relaxed text-red-300"
                  data-testid="plugin-verification-error"
                >
                  <strong class="mono mr-1 uppercase tracking-widest text-[10px]"
                    >{{ plugin.verification_status }}:</strong
                  >
                  {{ plugin.verification_error }}
                </p>
              }

              <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div
                  class="rounded border border-[var(--line)] bg-[var(--bg-1)] p-4"
                  data-testid="status-card"
                >
                  <div class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
                    status
                  </div>
                  <div
                    class="mt-1 flex items-center gap-2 text-[15px]"
                    [style.color]="plugin.enabled ? 'var(--green)' : 'var(--ink-mute)'"
                    data-testid="status-line"
                  >
                    <span
                      class="dot"
                      [style.background]="plugin.enabled ? 'var(--green)' : 'var(--ink-mute)'"
                    ></span>
                    {{ plugin.enabled ? 'running' : 'disabled' }}
                  </div>
                  <div
                    class="mono mt-2 text-[11px] text-[var(--ink-mute)]"
                    data-testid="status-detail"
                  >
                    {{ statusDetail() }}
                  </div>
                </div>
              </div>

              @if (plugin.requires_integrations.length > 0) {
                <div class="mt-4" data-testid="integration-requirements">
                  <h3
                    class="mono mb-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  >
                    Required integrations
                  </h3>
                  @for (integration of plugin.requires_integrations; track integration) {
                    <div
                      class="mono mb-2 flex items-center gap-2 rounded border px-3 py-2 text-[12px]"
                      [style.borderColor]="
                        integrationStatuses.get(integration)
                          ? 'rgba(52, 211, 153, 0.4)'
                          : 'rgba(239, 68, 68, 0.4)'
                      "
                      [style.color]="
                        integrationStatuses.get(integration) ? 'var(--green)' : 'var(--accent)'
                      "
                      [attr.data-testid]="'integration-status-' + integration"
                    >
                      @if (integrationStatuses.get(integration)) {
                        <span aria-hidden="true">✓</span>
                        {{ integration }} — Connected
                      } @else {
                        <span aria-hidden="true">!</span>
                        {{ integration }} — Not configured
                      }
                    </div>
                  }
                  @if (missingIntegrations.length > 0) {
                    <button
                      type="button"
                      class="mono mt-2 rounded border border-[var(--accent-dim)] bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)]"
                      data-testid="btn-go-integrations"
                      (click)="goToIntegrations()"
                    >
                      Configure integrations →
                    </button>
                  }
                </div>
              }

              @if (plugin.has_host_bridge) {
                <app-bridge-connection [slug]="plugin.slug" />
              }

              <div
                class="mt-8 rounded border border-red-500/30 bg-red-500/[0.04] p-4"
                data-testid="danger-zone"
              >
                <h3 class="mono mb-2 text-[12px] font-semibold text-red-300">danger zone</h3>
                <p class="mb-3 text-[12px] leading-relaxed text-[var(--ink-dim)]">
                  Uninstalling removes the plugin from
                  <code class="mono">~/.speedwave/plugins/{{ plugin.slug }}/</code>, deletes its
                  per-project credentials, and disables it in your config. Containers will be
                  recreated on the next project restart.
                </p>
                @if (confirmingRemove) {
                  <div class="flex items-center gap-3">
                    <span
                      class="mono text-[12px] text-red-300"
                      data-testid="uninstall-confirm-prompt"
                      >Are you sure?</span
                    >
                    <button
                      type="button"
                      class="mono rounded border border-red-500/40 bg-red-500/[0.08] px-3 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/[0.12] disabled:opacity-50"
                      data-testid="uninstall-confirm-btn"
                      [disabled]="removing"
                      (click)="onConfirmUninstall()"
                    >
                      $ yes, uninstall
                    </button>
                    <button
                      type="button"
                      class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)] disabled:opacity-50"
                      data-testid="uninstall-cancel-btn"
                      [disabled]="removing"
                      (click)="confirmingRemove = false"
                    >
                      cancel
                    </button>
                  </div>
                } @else {
                  <button
                    type="button"
                    class="mono rounded border border-red-500/40 bg-transparent px-3 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/[0.08]"
                    data-testid="uninstall-btn"
                    (click)="confirmingRemove = true"
                  >
                    $ uninstall plugin
                  </button>
                }
              </div>
            </div>
          }

          @if (activeTab === 'settings') {
            <div data-testid="settings-content">
              @if (plugin.auth_fields.length > 0 && plugin.verification_status === 'verified') {
                <section class="mb-8" data-testid="credentials-section">
                  <h3 class="mono mb-3 text-[14px] text-[var(--ink)]">Credentials</h3>
                  <app-plugin-credentials-form
                    [authFields]="plugin.auth_fields"
                    [configuredFields]="plugin.configured_fields"
                    [inFlight]="saving"
                    [providerLabel]="plugin.name"
                    [oauthConfigured]="plugin.configured"
                    [oauthStatus]="oauthStatus"
                    [oauthRedirectUri]="oauthRedirectUri"
                    [oauthStatusMessage]="oauthStatusMessage"
                    (save)="onSaveCredentials($event)"
                    (clear)="confirmingReset = true"
                    (clearField)="onClearField($event)"
                    (authorizeOauth)="handleStartPluginOAuth()"
                    (cancelOauth)="handleCancelPluginOAuth()"
                  />
                  @if (confirmingReset) {
                    <div class="mt-4 flex items-center gap-3">
                      <span class="mono text-[12px] text-red-300" data-testid="reset-confirm-prompt"
                        >Delete all stored credentials? They cannot be recovered.</span
                      >
                      <button
                        type="button"
                        class="mono rounded border border-red-500/40 bg-red-500/[0.08] px-3 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/[0.12] disabled:opacity-50"
                        data-testid="reset-confirm-btn"
                        [disabled]="resetting"
                        (click)="onResetCredentials()"
                      >
                        $ yes, reset
                      </button>
                      <button
                        type="button"
                        class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)] disabled:opacity-50"
                        data-testid="reset-cancel-btn"
                        [disabled]="resetting"
                        (click)="confirmingReset = false"
                      >
                        cancel
                      </button>
                    </div>
                  }
                </section>
              }

              @if (plugin.settings_schema) {
                <section data-testid="schema-settings-section">
                  <h3 class="mono mb-3 text-[14px] text-[var(--ink)]">Settings</h3>
                  <app-plugin-settings-form
                    [schema]="plugin.settings_schema"
                    [values]="settings"
                    (save)="onSaveSettings($event)"
                  />
                </section>
              }

              @if (
                (plugin.auth_fields.length === 0 || plugin.verification_status !== 'verified') &&
                !plugin.settings_schema
              ) {
                <p class="mono text-[12px] text-[var(--ink-mute)]" data-testid="no-settings-msg">
                  This plugin exposes no credentials or settings.
                </p>
              }
            </div>
          }

          @if (activeTab === 'logs') {
            <div data-testid="logs-content">
              <p class="mono text-[12px] text-[var(--ink-mute)]" data-testid="logs-link-hint">
                Per-plugin logs stream from the global Logs view.
                <button
                  type="button"
                  class="mono text-[var(--accent)] hover:underline"
                  data-testid="logs-link"
                  (click)="goToLogs()"
                >
                  Open logs →
                </button>
              </p>
            </div>
          }
        }
      </div>
    </div>
  `,
  host: {
    class: 'flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)]',
  },
})
export class PluginDetailComponent implements OnInit, OnDestroy {
  plugin: PluginStatusEntry | null = null;
  settings: Record<string, unknown> = {};
  activeTab: PluginDetailTab = 'dashboard';
  error = '';
  success = '';
  integrationStatuses = new Map<string, boolean>();

  /** True when the user clicked "uninstall" and we're showing the confirm prompt. */
  confirmingRemove = false;
  /** True while `remove_plugin` is in flight; disables the confirm/cancel buttons. */
  removing = false;

  /** True when the user clicked "Reset all" credentials and we're showing the confirm prompt. */
  confirmingReset = false;
  /** True while `delete_plugin_credentials` is in flight; disables confirm/cancel. */
  resetting = false;

  /** True while any credential/settings mutation is in flight; disables Save. */
  saving = false;

  // -- OAuth (authorization_code) flow state --
  /** Current flow status; null when idle. Passed to the credentials form. */
  oauthStatus: OAuthFlowStatus | null = null;
  oauthStatusMessage = '';
  /** Loopback redirect URI surfaced while awaiting the browser callback. */
  oauthRedirectUri: string | null = null;
  /** Correlates progress events to the in-flight flow. */
  private activeOAuthRequestId: string | null = null;
  /** Latest event per request that arrived before `start_plugin_oauth` returned its request_id. */
  private pendingOAuthEvents = new Map<string, OAuthProgressEvent>();
  private unlistenOAuth: (() => void) | null = null;

  /** Handle for the M9 auto-fade timeout on `success` — cancelled on new mutations. */
  private successFadeTimer: ReturnType<typeof setTimeout> | null = null;

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private log = inject(LoggerService);
  private activeProject: string | null = null;
  private unsubProjectReady: (() => void) | null = null;

  /** Returns integration names that are not yet configured. */
  get missingIntegrations(): string[] {
    if (!this.plugin) return [];
    return this.plugin.requires_integrations.filter((i) => !this.integrationStatuses.get(i));
  }

  /** Memo for {@link renderedInstructions} keyed on the raw Markdown source. */
  private instructionsCache: { src: string; html: string } | null = null;

  /**
   * Renders the manifest's `instructions` Markdown, memoised on the source string.
   * @returns HTML string (sanitised at bind time), or `''`
   */
  renderedInstructions(): string {
    const src = this.plugin?.instructions ?? '';
    if (!src) return '';
    if (this.instructionsCache?.src !== src) {
      const html = instructionsMarked.parse(src, { async: false });
      if (typeof html !== 'string') {
        throw new Error('marked.parse returned a Promise; async option must remain false');
      }
      this.instructionsCache = { src, html };
    }
    return this.instructionsCache.html;
  }

  /** Loads plugin data, settings, and integration status from the backend. */
  async ngOnInit(): Promise<void> {
    const slug = this.route.snapshot.paramMap.get('slug');
    if (!slug) return;

    await this.loadActiveProject();
    if (!this.activeProject) return;

    await this.loadPlugin(slug);
    await this.loadSettings(slug);
    await this.loadIntegrationStatuses();
    this.cdr.markForCheck();

    this.unlistenOAuth = await this.subscribePluginOAuthProgress(slug);

    this.unsubProjectReady = this.projectState.onProjectReady(async () => {
      await this.loadActiveProject();
      const currentSlug = this.route.snapshot.paramMap.get('slug');
      if (!currentSlug || !this.activeProject) {
        this.router.navigate(['/plugins']);
        return;
      }
      await this.loadPlugin(currentSlug);
      await this.loadSettings(currentSlug);
      await this.loadIntegrationStatuses();
      this.cdr.markForCheck();
    });
  }

  /** Cleans up the project ready listener. */
  ngOnDestroy(): void {
    if (this.unsubProjectReady) {
      this.unsubProjectReady();
      this.unsubProjectReady = null;
    }
    if (this.unlistenOAuth) {
      this.unlistenOAuth();
      this.unlistenOAuth = null;
    }
    this.cancelSuccessFade();
  }

  /** Navigates back to the plugins list. */
  goBack(): void {
    this.router.navigate(['/plugins']);
  }

  /** Navigates to the Integrations tab. */
  goToIntegrations(): void {
    this.router.navigate(['/integrations']);
  }

  /** Navigates to the global Logs view. */
  goToLogs(): void {
    this.router.navigate(['/logs']);
  }

  /**
   * Selects a tab.
   * @param tab - the tab to activate
   */
  selectTab(tab: PluginDetailTab): void {
    this.activeTab = tab;
    this.cdr.markForCheck();
  }

  /**
   * Confirms the uninstall and invokes `remove_plugin`. On success, signals
   * the project banner to restart and navigates back to the plugins list —
   * the current page would be a 404 since the plugin no longer exists.
   */
  async onConfirmUninstall(): Promise<void> {
    if (!this.plugin || this.removing) return;
    this.removing = true;
    this.error = '';
    this.success = '';
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('remove_plugin', { slug: this.plugin.slug });
      this.projectState.requestRestart();
      // Navigate before clearing state so the user sees the plugins list
      // refreshed without the removed entry.
      this.router.navigate(['/plugins']);
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      this.removing = false;
      this.confirmingRemove = false;
      this.cdr.markForCheck();
    }
  }

  /** Click handler for the master toggle in the header. */
  async onMasterToggle(): Promise<void> {
    if (!this.plugin || !this.activeProject) return;
    const previous = this.plugin.enabled;
    const next = !previous;
    this.plugin.enabled = next;
    this.cdr.markForCheck();
    const sid = this.plugin.service_id ?? this.plugin.slug;
    try {
      await this.tauri.invoke<void>('set_plugin_enabled', {
        project: this.activeProject,
        serviceId: sid,
        enabled: next,
      });
      this.projectState.requestRestart();
    } catch (e: unknown) {
      this.plugin.enabled = previous;
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  /** Detail line under the status badge. */
  statusDetail(): string {
    if (!this.plugin) return '';
    const sid = this.plugin.service_id ?? this.plugin.slug;
    return `${sid} · v${this.plugin.version}`;
  }

  /**
   * Shared skeleton for credentials/settings mutations; captures slug/project before the first await.
   * @param command - Tauri command name to invoke
   * @param buildPayload - given validated (slug, project), returns the payload
   * @param successMsg - message to show on success
   * @returns true if the invoke succeeded, false otherwise
   */
  private async runPluginMutation(
    command: string,
    buildPayload: (slug: string, project: string) => Record<string, unknown>,
    successMsg: string
  ): Promise<boolean> {
    if (!this.plugin || !this.activeProject) {
      this.error = NO_ACTIVE_PROJECT_MSG;
      this.cdr.markForCheck();
      return false;
    }
    const slug = this.plugin.slug;
    const project = this.activeProject;
    this.error = '';
    this.success = '';
    this.cancelSuccessFade(); // any pending fade from a prior mutation
    this.saving = true;
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke(command, buildPayload(slug, project));
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      this.saving = false;
      this.cdr.markForCheck();
      return false;
    }
    this.success = successMsg;
    this.projectState.requestRestart();
    // Refresh state (e.g. configured badge). `loadPlugin` swallows its error
    // into `this.error`; downgrade to a caveat on the success line + log
    // so a stale view is signalled rather than hidden under the success msg.
    await this.loadPlugin(slug);
    if (this.error) {
      this.log.warn(`plugin reload after mutation failed: ${this.error}`);
      this.error = '';
      this.success = `${successMsg} — but the view could not refresh; reopen the plugin to see the latest state.`;
    }
    this.saving = false;
    this.scheduleSuccessFade();
    this.cdr.markForCheck();
    return true;
  }

  /** Clear an in-flight fade timer (success was overwritten by a new mutation). */
  private cancelSuccessFade(): void {
    if (this.successFadeTimer !== null) {
      clearTimeout(this.successFadeTimer);
      this.successFadeTimer = null;
    }
  }

  /** Auto-fade the green success banner after a short window (M9). */
  private scheduleSuccessFade(): void {
    this.cancelSuccessFade();
    this.successFadeTimer = setTimeout(() => {
      this.success = '';
      this.successFadeTimer = null;
      this.cdr.markForCheck();
    }, 5000);
  }

  /**
   * Saves settings and shows confirmation.
   * @param values - the settings key-value pairs to save
   */
  async onSaveSettings(values: Record<string, unknown>): Promise<void> {
    const ok = await this.runPluginMutation(
      'plugin_save_settings',
      (slug, project) => ({ project, slug, settings: values }),
      'Settings saved'
    );
    if (ok) this.settings = values;
  }

  /**
   * Persists filled credential fields to disk via `save_plugin_credentials`.
   * @param event - filled credentials emitted by PluginCredentialsFormComponent
   */
  async onSaveCredentials(event: PluginSaveCredentialsEvent): Promise<void> {
    const fieldCount = Object.keys(event.credentials).length;
    await this.runPluginMutation(
      'save_plugin_credentials',
      (slug, project) => ({ project, slug, credentials: event.credentials }),
      `Credentials saved (${fieldCount} field${fieldCount === 1 ? '' : 's'})`
    );
  }

  /** Starts the plugin's authorization_code OAuth flow; client credentials must be pre-saved. */
  async handleStartPluginOAuth(): Promise<void> {
    const slug = this.plugin?.service_id ?? this.plugin?.slug;
    if (!slug || !this.activeProject) return;
    this.oauthStatus = 'starting';
    this.oauthStatusMessage = '';
    this.oauthRedirectUri = null;
    this.cdr.markForCheck();
    try {
      const result = await this.tauri.invoke<{ request_id: string }>('start_plugin_oauth', {
        project: this.activeProject,
        slug,
      });
      this.activeOAuthRequestId = result.request_id;
      // Replay any event buffered before the invoke resolved.
      const buffered = this.pendingOAuthEvents.get(result.request_id);
      this.pendingOAuthEvents.clear();
      if (buffered) await this.applyOAuthProgress(buffered, slug);
    } catch (e: unknown) {
      this.oauthStatus = 'error';
      this.oauthStatusMessage = e instanceof Error ? e.message : String(e);
      this.activeOAuthRequestId = null;
      this.cdr.markForCheck();
    }
  }

  /** Cancels an in-flight plugin OAuth flow. */
  async handleCancelPluginOAuth(): Promise<void> {
    try {
      await this.tauri.invoke('cancel_plugin_oauth');
    } catch {
      // Best-effort — the loopback server also times out on its own.
    }
    this.oauthStatus = null;
    this.oauthRedirectUri = null;
    this.activeOAuthRequestId = null;
    this.pendingOAuthEvents.clear();
    this.cdr.markForCheck();
  }

  /**
   * Subscribes to `plugin_oauth_progress`; updates status/redirect and reloads
   * the plugin (configured badge) + requests a restart on success.
   * @param slug - the plugin slug whose flow to track
   */
  private subscribePluginOAuthProgress(slug: string): Promise<() => void> {
    return this.tauri
      .listen<OAuthProgressEvent>('plugin_oauth_progress', async (event) => {
        const payload = (event as { payload: OAuthProgressEvent }).payload;
        if (payload.request_id !== this.activeOAuthRequestId) {
          // Buffer the newest event per request until the request_id is correlated.
          this.pendingOAuthEvents.set(payload.request_id, payload);
          return;
        }
        await this.applyOAuthProgress(payload, slug);
      })
      .catch((e: unknown) => {
        // Without the listener the flow would look hung — leave a breadcrumb.
        this.log.warn(`plugin_oauth_progress listener registration failed: ${String(e)}`);
        return () => {};
      });
  }

  /**
   * Applies one progress event for the active flow — shared by the live
   * listener and the pre-correlation buffer replay.
   * @param payload - the progress event
   * @param slug - the plugin slug whose flow is tracked
   */
  private async applyOAuthProgress(payload: OAuthProgressEvent, slug: string): Promise<void> {
    this.oauthStatus = payload.status;
    // The host sends the redirect URI as the message on awaiting_redirect.
    if (payload.status === 'awaiting_redirect') {
      this.oauthRedirectUri = payload.message;
    } else {
      this.oauthStatusMessage = payload.message;
    }
    if (payload.status === 'success') {
      this.activeOAuthRequestId = null;
      this.oauthRedirectUri = null;
      await this.loadPlugin(slug);
      this.projectState.requestRestart();
    }
    if (['error', 'expired', 'cancelled'].includes(payload.status)) {
      this.activeOAuthRequestId = null;
      this.oauthRedirectUri = null;
    }
    this.cdr.markForCheck();
  }

  /**
   * Clears a single stored credential field via `delete_plugin_credential_field`; not gated by confirm.
   * @param key - the auth_field key to clear
   */
  async onClearField(key: string): Promise<void> {
    await this.runPluginMutation(
      'delete_plugin_credential_field',
      (slug, project) => ({ project, slug, key }),
      `Cleared "${key}"`
    );
  }

  /** Deletes every stored credential for this plugin via `delete_plugin_credentials`; reached only after confirm. */
  async onResetCredentials(): Promise<void> {
    this.resetting = true;
    this.cdr.markForCheck();
    await this.runPluginMutation(
      'delete_plugin_credentials',
      (slug, project) => ({ project, slug }),
      'All credentials cleared'
    );
    this.resetting = false;
    this.confirmingReset = false;
    this.cdr.markForCheck();
  }

  private loadActiveProject(): void {
    this.activeProject = this.projectState.activeProject();
  }

  private async loadPlugin(slug: string): Promise<void> {
    if (!this.activeProject) return;
    try {
      const response = await this.tauri.invoke<PluginsResponse>('get_plugins', {
        project: this.activeProject,
      });
      this.plugin = response.plugins.find((p) => p.slug === slug) ?? null;
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private async loadSettings(slug: string): Promise<void> {
    if (!this.activeProject) return;
    try {
      this.settings = await this.tauri.invoke<Record<string, unknown>>('plugin_load_settings', {
        project: this.activeProject,
        slug,
      });
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private async loadIntegrationStatuses(): Promise<void> {
    if (!this.activeProject || !this.plugin) return;
    if (this.plugin.requires_integrations.length === 0) return;
    try {
      const resp = await this.tauri.invoke<IntegrationsResponse>('get_integrations', {
        project: this.activeProject,
      });
      for (const integration of this.plugin.requires_integrations) {
        const svc = resp.services.find((s) => s.service === integration);
        this.integrationStatuses.set(integration, svc?.configured ?? false);
      }
    } catch (e: unknown) {
      // Non-fatal: badges fall back to "not configured"; log so the error isn't invisible.
      this.log.warn(`loadIntegrationStatuses: get_integrations failed: ${String(e)}`);
    }
  }
}
