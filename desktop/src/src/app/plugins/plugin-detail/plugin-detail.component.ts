import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { PluginBridgeService } from '../../services/plugin-bridge.service';
import { PluginStatusEntry, PluginsResponse } from '../../models/plugin';
import { IntegrationsResponse } from '../../models/integration';
import { PluginSettingsFormComponent } from '../plugin-settings-form/plugin-settings-form.component';
import { ProjectPillComponent } from '../../project-switcher/project-pill.component';
import { TooltipDirective } from '../../shared/tooltip.directive';

/** Tabs available in the plugin-detail view. */
export type PluginDetailTab = 'dashboard' | 'settings' | 'tools' | 'logs';

/** A single tool exposed by a plugin worker (placeholder data until backend exposes). */
interface ExposedTool {
  name: string;
  calls: number;
  errors: number;
}

/** Detail page for a single plugin with Dashboard / Settings / Tools / Logs tabs. */
@Component({
  selector: 'app-plugin-detail',
  imports: [CommonModule, PluginSettingsFormComponent, ProjectPillComponent, TooltipDirective],
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
              [style.borderBottomColor]="activeTab === 'tools' ? 'var(--accent)' : 'transparent'"
              [style.color]="activeTab === 'tools' ? 'var(--ink)' : 'var(--ink-mute)'"
              [attr.aria-selected]="activeTab === 'tools'"
              data-testid="tab-tools"
              (click)="selectTab('tools')"
            >
              tools · {{ exposedTools.length }}
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

                <div
                  class="rounded border border-[var(--line)] bg-[var(--bg-1)] p-4"
                  data-testid="invocations-card"
                >
                  <div class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
                    invocations
                  </div>
                  <div class="mt-1 text-[20px] text-[var(--ink)]" data-testid="invocations-value">
                    {{ totalInvocations() }}
                  </div>
                  <div
                    class="mono mt-1 text-[11px] text-[var(--ink-mute)]"
                    data-testid="invocations-detail"
                  >
                    last 24h · {{ totalErrors() }} errors
                  </div>
                </div>
              </div>

              @if (exposedTools.length > 0) {
                <div
                  class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)]"
                  data-testid="tools-card"
                >
                  <div
                    class="mono border-b border-[var(--line)] px-4 py-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  >
                    exposed tools
                  </div>
                  <div class="divide-y divide-[var(--line)]">
                    @for (tool of exposedTools; track tool.name) {
                      <div
                        class="mono flex items-center gap-3 px-4 py-2 text-[12px]"
                        [attr.data-testid]="'tool-row-' + tool.name"
                      >
                        <span class="text-[var(--accent)]">fn</span>
                        <span class="text-[var(--teal)]">{{ tool.name }}</span>
                        <span class="ml-auto text-[var(--ink-mute)]"
                          >{{ tool.calls }} calls · {{ tool.errors }} err</span
                        >
                      </div>
                    }
                  </div>
                </div>
              }

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
              } @else {
                <p
                  class="mono mt-4 text-[12px] italic text-[var(--ink-mute)]"
                  data-testid="dashboard-placeholder"
                >
                  Plugin dashboard content will appear here.
                </p>
              }

              @if (plugin.has_host_bridge) {
                <section
                  class="mt-6 rounded border border-[var(--line)] bg-[var(--bg-1)] p-4"
                  data-testid="bridge-connection"
                >
                  <div
                    class="mono mb-3 flex items-center gap-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  >
                    Bridge connection
                    <span
                      class="dot"
                      [style.background]="
                        bridgeStatus()?.paired ? 'var(--green)' : 'var(--ink-mute)'
                      "
                      data-testid="bridge-status-dot"
                    ></span>
                    <span data-testid="bridge-status-label">
                      {{ bridgeStatus()?.paired ? 'connected' : 'waiting for client' }}
                    </span>
                  </div>

                  @if (bridgeError()) {
                    <p class="mono mb-2 text-[12px] text-red-300" data-testid="bridge-error">
                      {{ bridgeError() }}
                    </p>
                  } @else {
                    <p class="mb-2 text-[12px] leading-relaxed text-[var(--ink-dim)]">
                      Paste these into your companion app (e.g. the Figma Desktop plugin). The
                      worker container uses an internal address; this URL is for external clients on
                      the same host.
                    </p>

                    <label
                      for="bridge-url-input"
                      class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                    >
                      Connect URL
                    </label>
                    <div class="mb-3 flex items-center gap-2">
                      <input
                        id="bridge-url-input"
                        readonly
                        class="mono flex-1 rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
                        [value]="bridgeUrl() ?? ''"
                        data-testid="bridge-url-input"
                      />
                      <button
                        type="button"
                        class="mono rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                        data-testid="bridge-url-copy"
                        (click)="copyBridgeField('url')"
                      >
                        {{ bridgeCopiedField() === 'url' ? 'copied' : 'copy' }}
                      </button>
                    </div>

                    <label
                      for="bridge-token-input"
                      class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                    >
                      Token
                    </label>
                    <div class="flex items-center gap-2">
                      <input
                        id="bridge-token-input"
                        readonly
                        class="mono flex-1 rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
                        [type]="bridgeTokenRevealed() ? 'text' : 'password'"
                        [value]="bridgeToken() ?? ''"
                        data-testid="bridge-token-input"
                      />
                      <button
                        type="button"
                        class="mono rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                        data-testid="bridge-token-reveal"
                        (click)="toggleBridgeTokenReveal()"
                      >
                        {{ bridgeTokenRevealed() ? 'hide' : 'reveal' }}
                      </button>
                      <button
                        type="button"
                        class="mono rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                        data-testid="bridge-token-copy"
                        (click)="copyBridgeField('token')"
                      >
                        {{ bridgeCopiedField() === 'token' ? 'copied' : 'copy' }}
                      </button>
                    </div>
                  }
                </section>
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
              <app-plugin-settings-form
                [schema]="plugin.settings_schema"
                [values]="settings"
                (save)="onSaveSettings($event)"
              />
            </div>
          }

          @if (activeTab === 'tools') {
            <div data-testid="tools-content">
              @if (exposedTools.length === 0) {
                <p class="mono text-[12px] text-[var(--ink-mute)]" data-testid="tools-empty">
                  This plugin does not expose tools.
                </p>
              } @else {
                <div class="rounded border border-[var(--line)] bg-[var(--bg-1)]">
                  <div class="divide-y divide-[var(--line)]">
                    @for (tool of exposedTools; track tool.name) {
                      <div
                        class="mono flex items-center gap-3 px-4 py-2 text-[12px]"
                        [attr.data-testid]="'tools-tab-row-' + tool.name"
                      >
                        <span class="text-[var(--accent)]">fn</span>
                        <span class="text-[var(--teal)]">{{ tool.name }}</span>
                        <span class="ml-auto text-[var(--ink-mute)]"
                          >{{ tool.calls }} calls · {{ tool.errors }} err</span
                        >
                      </div>
                    }
                  </div>
                </div>
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
  /** Exposed tools — currently always empty until the backend reports them. */
  exposedTools: ExposedTool[] = [];

  /** True when the user clicked "uninstall" and we're showing the confirm prompt. */
  confirmingRemove = false;
  /** True while `remove_plugin` is in flight; disables the confirm/cancel buttons. */
  removing = false;

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private bridgeService = inject(PluginBridgeService);
  private activeProject: string | null = null;
  private unsubProjectReady: (() => void) | null = null;

  bridgeToken = signal<string | null>(null);
  bridgeUrl = signal<string | null>(null);
  bridgeTokenRevealed = signal(false);
  bridgeCopiedField = signal<'url' | 'token' | null>(null);
  bridgeError = signal<string | null>(null);
  bridgeStatus = signal<import('../../models/plugin').PluginBridgeStatus | null>(null);

  /** Returns integration names that are not yet configured. */
  get missingIntegrations(): string[] {
    if (!this.plugin) return [];
    return this.plugin.requires_integrations.filter((i) => !this.integrationStatuses.get(i));
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
    await this.loadBridge(slug);
    this.cdr.markForCheck();

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
      await this.loadBridge(currentSlug);
      this.cdr.markForCheck();
    });
  }

  private async loadBridge(slug: string): Promise<void> {
    if (!this.plugin?.has_host_bridge) {
      this.bridgeStatus.set(null);
      return;
    }
    try {
      await this.bridgeService.refresh(slug);
      this.bridgeStatus = this.bridgeService.status(slug) as typeof this.bridgeStatus;
      const creds = await this.bridgeService.credentials(slug);
      this.bridgeUrl.set(creds.url);
      this.bridgeToken.set(creds.token);
      this.bridgeError.set(null);
    } catch (err) {
      this.bridgeError.set(String(err));
    }
  }

  /**
   * Copies the bridge URL or token to the clipboard and flashes "copied".
   * @param field - Which field to copy.
   */
  async copyBridgeField(field: 'url' | 'token'): Promise<void> {
    const value = field === 'url' ? this.bridgeUrl() : this.bridgeToken();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      this.bridgeCopiedField.set(field);
      setTimeout(() => {
        if (this.bridgeCopiedField() === field) this.bridgeCopiedField.set(null);
      }, 1500);
    } catch {
      // Clipboard API not available — silently ignore.
    }
  }

  /** Toggles between masked password and revealed plaintext for the bridge token. */
  toggleBridgeTokenReveal(): void {
    this.bridgeTokenRevealed.update((v) => !v);
  }

  /** Cleans up the project ready listener. */
  ngOnDestroy(): void {
    if (this.unsubProjectReady) {
      this.unsubProjectReady();
      this.unsubProjectReady = null;
    }
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

  /** Total invocations across all exposed tools. */
  totalInvocations(): number {
    return this.exposedTools.reduce((sum, t) => sum + t.calls, 0);
  }

  /** Total errors across all exposed tools. */
  totalErrors(): number {
    return this.exposedTools.reduce((sum, t) => sum + t.errors, 0);
  }

  /**
   * Saves settings and shows confirmation.
   * @param values - the settings key-value pairs to save
   */
  async onSaveSettings(values: Record<string, unknown>): Promise<void> {
    if (!this.plugin || !this.activeProject) return;
    this.error = '';
    this.success = '';
    try {
      await this.tauri.invoke('plugin_save_settings', {
        project: this.activeProject,
        slug: this.plugin.slug,
        settings: values,
      });
      this.settings = values;
      this.success = 'Settings saved';
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  private loadActiveProject(): void {
    this.activeProject = this.projectState.activeProject;
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
    } catch {
      /* non-critical — UI will default to not configured */
    }
  }
}
