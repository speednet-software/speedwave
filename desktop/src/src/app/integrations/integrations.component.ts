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
import {
  IntegrationsResponse,
  IntegrationStatusEntry,
  OsIntegrationStatusEntry,
} from '../models/integration';
import { ProjectList } from '../models/update';
import { ServiceCardComponent, SaveCredentialsEvent } from './service-card/service-card.component';
import { IdeBridgeComponent } from './ide-bridge/ide-bridge.component';

/** Manages MCP service integrations and native OS integration toggles. */
@Component({
  selector: 'app-integrations',
  standalone: true,
  imports: [CommonModule, FormsModule, ServiceCardComponent, IdeBridgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (needsRestart) {
      <div class="restart-banner" data-testid="integrations-restart-banner">
        <div class="restart-info">
          <span>Changes require container restart to take effect</span>
          @if (restarting) {
            <span class="restart-hint">This may take a minute while containers are recreated</span>
          }
        </div>
        <button
          class="restart-btn"
          data-testid="integrations-restart"
          (click)="restartContainers()"
          [disabled]="restarting"
        >
          @if (restarting) {
            <span class="restart-spinner"></span> Restarting...
          } @else {
            Restart Now
          }
        </button>
      </div>
    }

    <div class="integrations-page">
      <h1>Integrations</h1>

      @if (error) {
        <div class="error-banner" data-testid="integrations-error">{{ error }}</div>
      }

      <app-ide-bridge />

      <section class="section" data-testid="integrations-services">
        <h2>Services</h2>
        @for (svc of services; track svc.service) {
          <app-service-card
            [svc]="svc"
            [expanded]="expandedService === svc.service"
            (toggleExpand)="toggleExpand($event)"
            (toggleService)="handleToggleService($event)"
            (saveCredentials)="handleSaveCredentials($event)"
            (deleteCredentials)="deleteCredentials($event)"
          />
        }
      </section>

      @if (osIntegrations.length > 0) {
        <section class="section" data-testid="integrations-os">
          <h2>OS Integrations</h2>
          @for (os of osIntegrations; track os.service) {
            <div class="card os-card">
              <div class="card-header no-expand">
                <div class="card-title">
                  <span class="service-name">{{ os.display_name }}</span>
                </div>
                <div class="card-actions">
                  <label class="toggle">
                    <input
                      type="checkbox"
                      [checked]="os.enabled"
                      (change)="toggleOsService(os, $event)"
                    />
                    <span class="slider"></span>
                  </label>
                </div>
              </div>
              <p class="card-description">{{ os.description }}</p>
            </div>
          }
        </section>
      }
    </div>
  `,
  styleUrl: './integrations.component.css',
})
export class IntegrationsComponent implements OnInit, OnDestroy {
  private static readonly HIDDEN_SERVICES = new Set(['slack', 'sharepoint']);

  /** List of container-based MCP service integrations. */
  services: IntegrationStatusEntry[] = [];
  /** List of native OS integrations (reminders, calendar, mail, notes). */
  osIntegrations: OsIntegrationStatusEntry[] = [];
  /** Currently expanded service card, or null if none. */
  expandedService: string | null = null;
  /** Whether pending changes require a container restart. */
  needsRestart = false;
  /** Whether a container restart is in progress. */
  restarting = false;
  /** Error message to display, empty if none. */
  error = '';
  /** Name of the currently active project. */
  activeProject: string | null = null;

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private unlistenProjectSwitch: (() => void) | null = null;

  /** Loads the active project and integrations on init. */
  async ngOnInit(): Promise<void> {
    await this.loadActiveProject();
    await this.loadIntegrations();
    this.tauri
      .listen<string>('project_switched', async () => {
        await this.loadActiveProject();
        await this.loadIntegrations();
      })
      .then((unlisten) => {
        this.unlistenProjectSwitch = unlisten;
      })
      .catch(() => {
        // Tauri event listener not available outside desktop context
      });
  }

  /** Cleans up Tauri event listener. */
  ngOnDestroy(): void {
    if (this.unlistenProjectSwitch) {
      this.unlistenProjectSwitch();
      this.unlistenProjectSwitch = null;
    }
  }

  /** Resolves the active project from the backend config. */
  async loadActiveProject(): Promise<void> {
    try {
      const result = await this.tauri.invoke<ProjectList>('list_projects');
      this.activeProject = result.active_project;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (typeof window !== 'undefined' && '__TAURI__' in window) {
        this.error = `Failed to load project: ${msg}`;
      }
    }
    this.cdr.markForCheck();
  }

  /** Fetches integration status entries from the backend. */
  async loadIntegrations(): Promise<void> {
    if (!this.activeProject) return;
    try {
      const response = await this.tauri.invoke<IntegrationsResponse>('get_integrations', {
        project: this.activeProject,
      });
      // Slack and SharePoint are not yet publicly available (#91)
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

      this.needsRestart = true;
      await this.loadIntegrations();

      const updated = this.services.find((s) => s.service === payload.svc.service);
      if (updated && updated.configured && !updated.enabled) {
        await this.tauri.invoke('set_integration_enabled', {
          project: this.activeProject,
          service: payload.svc.service,
          enabled: true,
        });
        updated.enabled = true;
      }
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
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
      this.needsRestart = true;
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
      this.needsRestart = true;
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
      this.needsRestart = true;

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

  /** Restarts containers to apply pending integration changes. */
  async restartContainers(): Promise<void> {
    this.restarting = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('restart_integration_containers', { project: this.activeProject });
      this.needsRestart = false;
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.restarting = false;
    this.cdr.markForCheck();
  }
}
