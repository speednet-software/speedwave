import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
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

/** Manages MCP service integrations and native OS integration toggles. */
@Component({
  selector: 'app-integrations',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ServiceCardComponent,
    RedmineConfigComponent,
    IdeBridgeComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div>
      <h1 class="text-xl text-sw-accent m-0 mb-6">Integrations</h1>

      @if (error) {
        <div
          class="mb-4 px-3 py-2 bg-sw-error-bg border border-sw-accent rounded text-sw-accent text-[13px]"
          data-testid="integrations-error"
        >
          {{ error }}
        </div>
      }

      <app-ide-bridge />

      <section class="mb-6" data-testid="integrations-services">
        <h2 class="text-[15px] text-sw-text m-0 mb-3">Services</h2>
        @for (svc of services; track svc.service) {
          @if (svc.service === 'redmine') {
            <app-redmine-config
              [svc]="svc"
              [expanded]="expandedService === svc.service"
              (toggleExpand)="toggleExpand($event)"
              (toggleService)="handleToggleService($event)"
              (saveCredentials)="handleSaveCredentials($event)"
              (deleteCredentials)="deleteCredentials($event)"
            />
          } @else {
            <app-service-card
              [svc]="svc"
              [expanded]="expandedService === svc.service"
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
        }
      </section>

      @if (osIntegrations.length > 0) {
        <section class="mb-6" data-testid="integrations-os">
          <h2 class="text-[15px] text-sw-text m-0 mb-3">OS Integrations</h2>
          @for (os of osIntegrations; track os.service) {
            <div class="bg-sw-bg-dark border border-sw-border rounded-lg mb-3 overflow-hidden">
              <div class="flex justify-between items-center px-5 py-4 cursor-default">
                <div class="flex items-center gap-3">
                  <span class="font-semibold text-base">{{ os.display_name }}</span>
                </div>
                <div class="flex items-center gap-3">
                  <label class="relative inline-block w-[44px] h-[24px]">
                    <input
                      type="checkbox"
                      class="peer sr-only"
                      [checked]="os.enabled"
                      (change)="toggleOsService(os, $event)"
                    />
                    <span
                      class="absolute inset-0 bg-sw-slider rounded-full cursor-pointer transition-all duration-300 peer-checked:bg-sw-accent before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[3px] before:bottom-[3px] before:bg-white before:rounded-full before:transition-all before:duration-300 peer-checked:before:translate-x-[20px]"
                    ></span>
                  </label>
                </div>
              </div>
              <p class="px-5 pb-3 text-sw-text-faint text-[13px] m-0">{{ os.description }}</p>
            </div>
          }
        </section>
      }
    </div>
  `,
  host: { class: 'block bg-sw-bg-darkest min-h-screen p-6 text-sw-text' },
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
            this.projectState.requestRestart();
            await this.loadIntegrations();
            if (flowProject !== this.activeProject) return;
            await this.autoEnableIfConfigured('sharepoint');
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

      this.projectState.requestRestart();
      await this.loadIntegrations();
      await this.autoEnableIfConfigured(payload.svc.service);
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
    if (!svc.configured) return;
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
