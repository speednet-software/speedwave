import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import {
  DeviceCodeInfo,
  IntegrationsResponse,
  IntegrationStatusEntry,
  OAuthProgressEvent,
  OsIntegrationStatusEntry,
} from '../models/integration';
import { ServiceCardComponent, SaveCredentialsEvent } from './service-card/service-card.component';
import { RedmineConfigComponent } from './redmine-config/redmine-config.component';
import { IdeBridgeComponent } from './ide-bridge/ide-bridge.component';
import { ProjectPillComponent } from '../project-switcher/project-pill.component';

/** Per-service dot colour cycle used in the table. */
const SERVICE_DOT_COLOURS: readonly string[] = [
  'var(--accent)',
  'var(--violet)',
  'var(--teal)',
  'var(--amber)',
  'var(--green)',
];

/**
 * Returns the deterministic dot colour for a service row based on its name.
 * Configured + enabled services use the cycle palette; unconfigured stay muted.
 * @param svc - the integration status entry
 * @param index - the row index in the rendered list
 */
function dotColourFor(svc: IntegrationStatusEntry, index: number): string {
  if (!svc.configured && !svc.enabled) return 'var(--ink-mute)';
  return SERVICE_DOT_COLOURS[index % SERVICE_DOT_COLOURS.length];
}

/** Manages MCP service integrations and native OS integration toggles. */
@Component({
  selector: 'app-integrations',
  imports: [
    FormsModule,
    ServiceCardComponent,
    RedmineConfigComponent,
    IdeBridgeComponent,
    ProjectPillComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex h-11 flex-shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--bg-1)] px-4 md:px-6"
      data-testid="integrations-header"
    >
      <h1
        class="view-title truncate text-[14px] text-[var(--ink)]"
        data-testid="integrations-title"
      >
        Service integrations
      </h1>
      <div class="ml-auto flex flex-shrink-0 items-center gap-3">
        <app-project-pill />
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-4 md:p-6" data-testid="integrations-body">
      <div class="mx-auto max-w-3xl">
        @if (error) {
          <div
            class="mb-4 rounded ring-1 ring-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-300 whitespace-pre-line"
            data-testid="integrations-error"
            role="alert"
          >
            {{ error }}
          </div>
        }

        <div
          class="overflow-hidden rounded border border-[var(--line)]"
          data-testid="integrations-table-wrapper"
        >
          <table class="w-full text-[13px]" data-testid="integrations-table">
            <caption class="sr-only">
              Available service integrations
            </caption>
            <thead
              class="mono border-b border-[var(--line)] bg-[var(--bg-1)] text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            >
              <tr>
                <th class="px-4 py-2 text-left font-normal" scope="col">service</th>
                <th class="px-4 py-2 text-left font-normal" scope="col">status</th>
                <th class="hidden px-4 py-2 text-left font-normal md:table-cell" scope="col">
                  ver
                </th>
                <th class="hidden px-4 py-2 text-left font-normal lg:table-cell" scope="col">
                  latency
                </th>
                <th class="hidden px-4 py-2 text-left font-normal lg:table-cell" scope="col">
                  mount
                </th>
                <th class="px-4 py-2 text-right font-normal" scope="col">on</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--line)]">
              @for (svc of services; track svc.service; let idx = $index) {
                <tr
                  class="hover-bg cursor-pointer"
                  [attr.data-testid]="'integrations-row-' + svc.service"
                  (click)="toggleExpand(svc.service)"
                  (keydown.enter)="toggleExpand(svc.service)"
                  tabindex="0"
                  role="button"
                  [attr.aria-expanded]="expandedService === svc.service"
                >
                  <td class="px-4 py-2.5">
                    <div class="flex items-center gap-2">
                      <span
                        [style.color]="dotColour(svc, idx)"
                        [attr.data-testid]="'integrations-dot-' + svc.service"
                      >
                        {{ svc.configured ? '●' : '○' }}
                      </span>
                      <span
                        [style.color]="svc.configured ? 'var(--ink)' : 'var(--ink-dim)'"
                        data-testid="integrations-row-name"
                      >
                        {{ svc.service }}
                      </span>
                    </div>
                  </td>
                  <td class="px-4 py-2.5">
                    @switch (statusOf(svc)) {
                      @case ('running') {
                        <span class="pill green" data-testid="integrations-row-status"
                          >running</span
                        >
                      }
                      @case ('starting') {
                        <span class="pill amber" data-testid="integrations-row-status"
                          >starting</span
                        >
                      }
                      @case ('disabled') {
                        <span class="pill" data-testid="integrations-row-status">disabled</span>
                      }
                      @default {
                        <button
                          type="button"
                          class="pill accent hover:bg-[var(--accent-soft)]"
                          data-testid="integrations-row-configure"
                          (click)="toggleExpand(svc.service); $event.stopPropagation()"
                        >
                          configure →
                        </button>
                      }
                    }
                  </td>
                  <td
                    class="mono hidden px-4 py-2.5 text-[var(--ink-mute)] md:table-cell"
                    data-testid="integrations-row-ver"
                  >
                    {{ versionFor(svc) }}
                  </td>
                  <td
                    class="mono hidden px-4 py-2.5 text-[var(--ink-dim)] lg:table-cell"
                    data-testid="integrations-row-latency"
                  >
                    {{ svc.enabled && svc.configured ? '—' : '—' }}
                  </td>
                  <td
                    class="mono hidden px-4 py-2.5 lg:table-cell"
                    [style.color]="mountFor(svc) === ':rw' ? 'var(--accent)' : 'var(--ink-mute)'"
                    data-testid="integrations-row-mount"
                  >
                    {{ mountFor(svc) }}
                  </td>
                  <td class="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      class="toggle ml-auto"
                      [class.on]="svc.enabled"
                      [attr.aria-pressed]="svc.enabled"
                      [attr.aria-label]="(svc.enabled ? 'Disable ' : 'Enable ') + svc.service"
                      [attr.data-testid]="'integrations-row-toggle-' + svc.service"
                      (click)="onRowToggle(svc, $event)"
                    ></button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if (expandedService) {
          @for (svc of services; track svc.service) {
            @if (svc.service === expandedService) {
              <div
                class="mt-6 overflow-hidden rounded ring-1 ring-[var(--accent-dim)]"
                [attr.data-testid]="'integrations-expanded-' + svc.service"
              >
                @if (svc.service === 'redmine') {
                  <app-redmine-config
                    [svc]="svc"
                    [expanded]="true"
                    (toggleExpand)="toggleExpand($event)"
                    (toggleService)="handleToggleService($event)"
                    (saveCredentials)="handleSaveCredentials($event)"
                    (deleteCredentials)="deleteCredentials($event)"
                  />
                } @else {
                  <app-service-card
                    [svc]="svc"
                    [expanded]="true"
                    [oauthStatus]="svc.service === 'sharepoint' ? oauthStatus : null"
                    [deviceCodeInfo]="svc.service === 'sharepoint' ? deviceCodeInfo : null"
                    [oauthStatusMessage]="svc.service === 'sharepoint' ? oauthStatusMessage : ''"
                    (toggleExpand)="toggleExpand($event)"
                    (toggleService)="handleToggleService($event)"
                    (saveCredentials)="handleSaveCredentials($event)"
                    (deleteCredentials)="deleteCredentials($event)"
                    (startOAuth)="handleStartOAuth($event)"
                    (cancelOAuth)="handleCancelOAuth()"
                    (openVerificationUrl)="handleOpenVerificationUrl($event)"
                  />
                }
              </div>
            }
          }
        }

        <div class="mt-6" data-testid="integrations-ide-bridge-slot">
          <app-ide-bridge />
        </div>

        @if (osIntegrations.length > 0) {
          <section class="mt-6" data-testid="integrations-os">
            <div class="overflow-hidden rounded border border-[var(--line)]">
              <div
                class="mono border-b border-[var(--line)] bg-[var(--bg-1)] px-4 py-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
              >
                os integrations
              </div>
              <div class="divide-y divide-[var(--line)]">
                @for (os of osIntegrations; track os.service) {
                  <div class="flex items-center gap-3 px-4 py-2.5">
                    <span class="mono text-[13px] text-[var(--ink)]">{{ os.display_name }}</span>
                    <span class="mono text-[11px] text-[var(--ink-mute)]">{{
                      os.description
                    }}</span>
                    <button
                      type="button"
                      class="toggle ml-auto"
                      [class.on]="os.enabled"
                      [attr.aria-pressed]="os.enabled"
                      [attr.aria-label]="(os.enabled ? 'Disable ' : 'Enable ') + os.service"
                      [attr.data-testid]="'integrations-os-toggle-' + os.service"
                      (click)="onOsToggleClick(os, $event)"
                    ></button>
                  </div>
                }
              </div>
            </div>
          </section>
        }
      </div>
    </div>
  `,
  host: {
    class: 'flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)]',
  },
})
export class IntegrationsComponent implements OnInit, OnDestroy {
  private static readonly HIDDEN_SERVICES = new Set(['slack']);

  /** List of container-based MCP service integrations. */
  services: IntegrationStatusEntry[] = [];
  /** List of native OS integrations (reminders, calendar, mail, notes). */
  osIntegrations: OsIntegrationStatusEntry[] = [];
  /** Currently expanded service card, or null if none. */
  expandedService: string | null = null;
  /** Error message to display, empty if none. */
  error = '';
  /** Name of the currently active project. */
  activeProject: string | null = null;

  /** OAuth state */
  oauthStatus: string | null = null;
  deviceCodeInfo: DeviceCodeInfo | null = null;
  oauthStatusMessage = '';
  activeOAuthRequestId: string | null = null;
  private oauthProjectAtStart: string | null = null;
  private oauthStartNonce = 0;
  private unlistenOAuth: (() => void) | null = null;

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private unsubProjectReady: (() => void) | null = null;

  /** Loads the active project and integrations on init. */
  async ngOnInit(): Promise<void> {
    await this.loadActiveProject();
    await this.loadIntegrations();
    this.unsubProjectReady = this.projectState.onProjectReady(async () => {
      if (this.activeOAuthRequestId || this.oauthStatus === 'starting') {
        await this.handleCancelOAuth();
      }
      await this.loadActiveProject();
      await this.loadIntegrations();
    });

    this.tauri
      .listen<OAuthProgressEvent>('sharepoint_oauth_progress', async (event) => {
        try {
          const payload = (event as { payload: OAuthProgressEvent }).payload;
          if (payload.request_id !== this.activeOAuthRequestId) return;

          this.oauthStatus = payload.status;
          this.oauthStatusMessage = payload.message;
          if (payload.status === 'success') {
            const flowProject = this.oauthProjectAtStart;
            this.deviceCodeInfo = null;
            this.activeOAuthRequestId = null;
            this.oauthProjectAtStart = null;
            if (flowProject !== this.activeProject) return;
            await this.loadIntegrations();
            if (flowProject !== this.activeProject) return;
            await this.autoEnableIfConfigured('sharepoint');
            this.projectState.requestRestart();
          }
          if (['error', 'expired', 'cancelled'].includes(payload.status)) {
            this.deviceCodeInfo = null;
            this.activeOAuthRequestId = null;
          }
        } catch (e: unknown) {
          this.error = e instanceof Error ? e.message : String(e);
        }
        this.cdr.markForCheck();
      })
      .then((unlisten) => {
        this.unlistenOAuth = unlisten;
      })
      .catch(() => {});
  }

  /** Cleans up event listeners. */
  ngOnDestroy(): void {
    if (this.unsubProjectReady) {
      this.unsubProjectReady();
      this.unsubProjectReady = null;
    }
    if (this.unlistenOAuth) {
      this.unlistenOAuth();
      this.unlistenOAuth = null;
    }
  }

  /** Syncs the active project from ProjectStateService. */
  loadActiveProject(): void {
    this.activeProject = this.projectState.activeProject;
    this.cdr.markForCheck();
  }

  /** Fetches integration status entries from the backend. */
  async loadIntegrations(): Promise<void> {
    if (!this.activeProject) return;
    try {
      const response = await this.tauri.invoke<IntegrationsResponse>('get_integrations', {
        project: this.activeProject,
      });
      // Slack is not yet publicly available (#91)
      this.services = response.services.filter(
        (s) => !IntegrationsComponent.HIDDEN_SERVICES.has(s.service)
      );
      this.osIntegrations = response.os;
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  /**
   * Expands or collapses the credential form for a service card.
   * @param service - the service identifier to toggle
   */
  toggleExpand(service: string): void {
    this.expandedService = this.expandedService === service ? null : service;
    this.cdr.markForCheck();
  }

  /**
   * Returns the table dot colour for a service row.
   * @param svc - the integration status entry
   * @param idx - the row index in the rendered list
   */
  dotColour(svc: IntegrationStatusEntry, idx: number): string {
    return dotColourFor(svc, idx);
  }

  /**
   * Returns the status pill semantic for a row.
   * @param svc Integration status entry to classify.
   */
  statusOf(svc: IntegrationStatusEntry): 'running' | 'starting' | 'disabled' | 'configure' {
    if (!svc.configured) return 'configure';
    if (!svc.enabled) return 'disabled';
    return 'running';
  }

  /**
   * Placeholder version label until the runtime exposes one — keeps layout stable.
   * @param svc Integration status entry whose version label is requested.
   */
  versionFor(svc: IntegrationStatusEntry): string {
    return svc.configured ? 'configured' : '—';
  }

  /**
   * SharePoint mounts /tokens read-write for OAuth refresh; everything else is read-only.
   * @param svc - the integration status entry
   */
  mountFor(svc: IntegrationStatusEntry): string {
    if (!svc.configured) return '—';
    return svc.service === 'sharepoint' ? ':rw' : ':ro';
  }

  /**
   * Handles a click on a row toggle — flips the enabled flag without expanding.
   * @param svc - the integration to toggle
   * @param event - the click event (used to stop propagation)
   */
  async onRowToggle(svc: IntegrationStatusEntry, event: Event): Promise<void> {
    event.stopPropagation();
    const previous = svc.enabled;
    const next = !previous;
    svc.enabled = next;
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('set_integration_enabled', {
        project: this.activeProject,
        service: svc.service,
        enabled: next,
      });
      this.projectState.requestRestart();
    } catch (e: unknown) {
      svc.enabled = previous;
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  /**
   * Handles the toggleService event from a service card.
   * @param payload - the service and checkbox event to process
   * @param payload.svc - the integration to toggle
   * @param payload.event - the checkbox change event
   */
  async handleToggleService(payload: { svc: IntegrationStatusEntry; event: Event }): Promise<void> {
    await this.toggleService(payload.svc, payload.event);
  }

  /**
   * Handles the saveCredentials event from a service card.
   * @param payload - the service, credentials, and optional mappings to save
   */
  async handleSaveCredentials(payload: SaveCredentialsEvent): Promise<void> {
    this.error = '';
    try {
      await this.tauri.invoke('save_integration_credentials', {
        project: this.activeProject,
        service: payload.svc.service,
        credentials: payload.credentials,
      });

      if (payload.mappings) {
        const mappings: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(payload.mappings)) {
          mappings[k] = v;
        }
        await this.tauri.invoke('save_redmine_mappings', {
          project: this.activeProject,
          mappings,
        });
      }

      await this.loadIntegrations();
      await this.autoEnableIfConfigured(payload.svc.service);
      this.projectState.requestRestart();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  /**
   * Auto-enables a service if it became configured but is not yet enabled.
   * Shared by handleSaveCredentials and OAuth success handler.
   * @param service - the service identifier to check and auto-enable
   */
  private async autoEnableIfConfigured(service: string): Promise<void> {
    const updated = this.services.find((s) => s.service === service);
    if (updated && updated.configured && !updated.enabled) {
      await this.tauri.invoke('set_integration_enabled', {
        project: this.activeProject,
        service,
        enabled: true,
      });
      updated.enabled = true;
      this.cdr.markForCheck();
    }
  }

  /**
   * Handles the startOAuth event from a service card.
   * @param payload - the service and non-oauth credentials
   * @param payload.svc - the integration to start OAuth for
   * @param payload.credentials - non-oauth field values from the form
   */
  async handleStartOAuth(payload: {
    svc: IntegrationStatusEntry;
    credentials: Record<string, string>;
  }): Promise<void> {
    if (this.oauthStatus === 'starting' || this.oauthStatus === 'polling') return;

    const myNonce = ++this.oauthStartNonce;
    this.oauthProjectAtStart = this.activeProject;
    this.oauthStatus = 'starting';
    this.oauthStatusMessage = '';
    this.error = '';
    this.cdr.markForCheck();

    // Save non-oauth fields first
    const nonOAuthCreds = { ...payload.credentials };
    if (Object.keys(nonOAuthCreds).length > 0) {
      try {
        await this.tauri.invoke('save_integration_credentials', {
          project: this.activeProject,
          service: payload.svc.service,
          credentials: nonOAuthCreds,
        });
      } catch (e: unknown) {
        if (myNonce !== this.oauthStartNonce) return;
        this.oauthStatus = null;
        this.error = e instanceof Error ? e.message : String(e);
        this.cdr.markForCheck();
        return;
      }
    }

    const clientId = payload.credentials['client_id'] ?? '';
    const tenantId = payload.credentials['tenant_id'] ?? '';
    if (!clientId || !tenantId) {
      if (myNonce !== this.oauthStartNonce) return;
      this.oauthStatus = null;
      this.error = 'Client ID and Tenant ID are required to start OAuth';
      this.cdr.markForCheck();
      return;
    }

    try {
      const result = await this.tauri.invoke<DeviceCodeInfo>('start_sharepoint_oauth', {
        project: this.activeProject,
        clientId,
        tenantId,
      });
      if (myNonce !== this.oauthStartNonce) return;
      this.deviceCodeInfo = result;
      this.activeOAuthRequestId = result.request_id;
      this.oauthStatus = 'polling';
    } catch (e: unknown) {
      if (myNonce !== this.oauthStartNonce) return;
      this.oauthStatus = null;
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  /** Cancels any active or starting OAuth flow. */
  async handleCancelOAuth(): Promise<void> {
    ++this.oauthStartNonce;
    try {
      await this.tauri.invoke('cancel_sharepoint_oauth');
    } catch {
      // Best-effort cancel
    }
    this.activeOAuthRequestId = null;
    this.oauthProjectAtStart = null;
    this.deviceCodeInfo = null;
    this.oauthStatus = null;
    this.oauthStatusMessage = '';
    this.cdr.markForCheck();
  }

  /**
   * Opens the verification URL in the default browser.
   * @param url - the Microsoft verification URL
   */
  async handleOpenVerificationUrl(url: string): Promise<void> {
    try {
      await this.tauri.invoke('open_url', { url });
    } catch {
      // Best-effort open
    }
  }

  /**
   * Toggles a container-based service on or off.
   * @param svc - the integration to toggle
   * @param event - the checkbox change event
   */
  async toggleService(svc: IntegrationStatusEntry, event: Event): Promise<void> {
    const enabled = (event.target as HTMLInputElement).checked;
    try {
      await this.tauri.invoke('set_integration_enabled', {
        project: this.activeProject,
        service: svc.service,
        enabled,
      });
      svc.enabled = enabled;
      this.projectState.requestRestart();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      (event.target as HTMLInputElement).checked = !enabled;
    }
    this.cdr.markForCheck();
  }

  /**
   * Click handler for OS integration toggle pill — flips state and persists.
   * @param os - the OS integration to toggle
   * @param event - the click event
   */
  async onOsToggleClick(os: OsIntegrationStatusEntry, event: Event): Promise<void> {
    event.stopPropagation();
    const previous = os.enabled;
    const next = !previous;
    os.enabled = next;
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('set_os_integration_enabled', {
        project: this.activeProject,
        service: os.service,
        enabled: next,
      });
      this.projectState.requestRestart();
    } catch (e: unknown) {
      os.enabled = previous;
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  /**
   * Toggles a native OS integration on or off.
   * @param os - the OS integration to toggle
   * @param event - the checkbox change event
   */
  async toggleOsService(os: OsIntegrationStatusEntry, event: Event): Promise<void> {
    const enabled = (event.target as HTMLInputElement).checked;
    try {
      await this.tauri.invoke('set_os_integration_enabled', {
        project: this.activeProject,
        service: os.service,
        enabled,
      });
      os.enabled = enabled;
      this.projectState.requestRestart();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      (event.target as HTMLInputElement).checked = !enabled;
    }
    this.cdr.markForCheck();
  }

  /**
   * Removes all credential files for a service.
   * @param svc - the integration to delete credentials for
   */
  async deleteCredentials(svc: IntegrationStatusEntry): Promise<void> {
    this.error = '';
    try {
      await this.tauri.invoke('delete_integration_credentials', {
        project: this.activeProject,
        service: svc.service,
      });
      this.projectState.requestRestart();

      const updated = this.services.find((s) => s.service === svc.service);
      if (updated) {
        updated.configured = false;
        if (updated.enabled) {
          await this.tauri.invoke('set_integration_enabled', {
            project: this.activeProject,
            service: svc.service,
            enabled: false,
          });
          updated.enabled = false;
        }
      }

      await this.loadIntegrations();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }
}
