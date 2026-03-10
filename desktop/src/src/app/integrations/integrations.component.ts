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
import { DetectedIde } from '../models/health';
import { ProjectList } from '../models/update';

/** Manages MCP service integrations and native OS integration toggles. */
@Component({
  selector: 'app-integrations',
  standalone: true,
  imports: [CommonModule, FormsModule],
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

      <section class="section" data-testid="integrations-ide-bridge">
        <h2>IDE Bridge</h2>
        @if (lastEvent) {
          <div class="event-banner" [class.fading]="eventFading">
            {{ lastEvent }}
          </div>
        }
        <div class="card ide-card">
          <div class="card-header no-expand">
            <div class="card-title">
              <span class="service-name">Available IDEs</span>
            </div>
          </div>
          <div class="ide-card-body">
            @if (availableIdes.length === 0) {
              <div class="no-data">
                No IDE detected — open Cursor or VS Code with the Claude Code extension.
              </div>
            } @else {
              <div class="ide-list">
                @for (ide of availableIdes; track ide.ide_name + ':' + ide.port) {
                  <div
                    class="ide-row"
                    [class.selected]="
                      selectedIde?.ide_name === ide.ide_name && selectedIde?.port === ide.port
                    "
                  >
                    <span class="ide-row-name">{{ ide.ide_name }}</span>
                    @if (ide.port !== null) {
                      <span class="port-badge">:{{ ide.port }}</span>
                    }
                    <button
                      class="connect-btn"
                      [class.active]="
                        selectedIde?.ide_name === ide.ide_name && selectedIde?.port === ide.port
                      "
                      [disabled]="ideConnecting"
                      (click)="connectIde(ide)"
                    >
                      {{
                        selectedIde?.ide_name === ide.ide_name && selectedIde?.port === ide.port
                          ? 'Connected'
                          : 'Connect'
                      }}
                    </button>
                  </div>
                }
              </div>
            }
            @if (ideError) {
              <div class="error-banner">{{ ideError }}</div>
            }
          </div>
        </div>
      </section>

      <section class="section" data-testid="integrations-services">
        <h2>Services</h2>
        @for (svc of services; track svc.service) {
          <div class="card" [attr.data-testid]="'integrations-service-' + svc.service">
            <div class="card-header">
              <button class="card-header-btn" type="button" (click)="toggleExpand(svc.service)">
                <span class="service-name">{{ svc.display_name }}</span>
                <span
                  class="badge"
                  [class.configured]="svc.configured"
                  [class.not-configured]="!svc.configured"
                >
                  {{ svc.configured ? 'Configured' : 'Not Configured' }}
                </span>
              </button>
              <div class="card-actions">
                <label
                  class="toggle"
                  [class.disabled]="!svc.configured"
                  [title]="svc.configured ? '' : 'Configure credentials to enable'"
                >
                  <input
                    type="checkbox"
                    [checked]="svc.enabled"
                    [disabled]="!svc.configured"
                    (change)="toggleService(svc, $event)"
                    [attr.data-testid]="'integrations-toggle-' + svc.service"
                  />
                  <span class="slider"></span>
                </label>
              </div>
            </div>
            <p class="card-description">{{ svc.description }}</p>

            @if (expandedService === svc.service) {
              <div class="card-body">
                <form (submit)="saveCredentials(svc, $event)">
                  @for (field of svc.auth_fields; track field.key) {
                    <div class="form-group">
                      <label [for]="svc.service + '-' + field.key">{{ field.label }}</label>
                      <input
                        [id]="svc.service + '-' + field.key"
                        [type]="field.field_type === 'password' ? 'password' : 'text'"
                        [placeholder]="field.placeholder"
                        [value]="getFieldValue(svc, field.key)"
                        (input)="setFieldValue(svc.service, field.key, $event)"
                        class="form-input"
                      />
                    </div>
                  }

                  @if (svc.service === 'redmine') {
                    <div class="mappings-section">
                      <h4>ID Mappings</h4>
                      @for (entry of getMappingEntries(svc); track entry.key) {
                        <div class="mapping-row">
                          <input
                            class="mapping-key"
                            [value]="entry.key"
                            (input)="updateMappingKey(svc.service, entry.key, $event)"
                            placeholder="Key"
                          />
                          <input
                            class="mapping-value"
                            type="number"
                            [value]="entry.value"
                            (input)="updateMappingValue(svc.service, entry.key, $event)"
                            placeholder="ID"
                          />
                          <button
                            type="button"
                            class="remove-mapping-btn"
                            (click)="removeMapping(svc.service, entry.key)"
                          >
                            x
                          </button>
                        </div>
                      }
                      <button
                        type="button"
                        class="add-mapping-btn"
                        (click)="addMapping(svc.service)"
                      >
                        + Add Mapping
                      </button>
                    </div>
                  }

                  <div class="form-actions">
                    <button
                      type="submit"
                      class="btn-save"
                      [attr.data-testid]="'integrations-save-' + svc.service"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      class="btn-cancel"
                      [attr.data-testid]="'integrations-remove-' + svc.service"
                      (click)="deleteCredentials(svc)"
                    >
                      Remove Credentials
                    </button>
                  </div>
                </form>
              </div>
            }
          </div>
        }
      </section>

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
    </div>
  `,
  styleUrl: './integrations.component.css',
})
export class IntegrationsComponent implements OnInit, OnDestroy {
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
  /** Edited credential field values keyed by service then field key. */
  editedValues: Record<string, Record<string, string>> = {};
  /** Edited Redmine mapping values keyed by service then mapping key. */
  editedMappings: Record<string, Record<string, number>> = {};
  /** Name of the currently active project. */
  activeProject: string | null = null;

  /** IDEs detected by the IDE Bridge scanner. */
  availableIdes: DetectedIde[] = [];
  /** Currently connected IDE, or null if none. */
  selectedIde: { ide_name: string; port: number } | null = null;
  /** Whether an IDE connection attempt is in progress. */
  ideConnecting = false;
  /** IDE-specific error message. */
  ideError: string | null = null;
  /** Latest IDE Bridge event description. */
  lastEvent: string | null = null;
  /** Whether the event banner is fading out. */
  eventFading = false;

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private ideIntervalId: ReturnType<typeof setInterval> | null = null;
  private eventTimerId: ReturnType<typeof setTimeout> | null = null;
  private unlistenEvent: (() => void) | null = null;
  private nextMappingId = 0;

  /** Loads the active project, integrations, and starts IDE polling on init. */
  async ngOnInit(): Promise<void> {
    await this.loadActiveProject();
    await this.loadIntegrations();
    await this.loadSelectedIde();
    this.pollIdes();
    this.ideIntervalId = setInterval(() => this.pollIdes(), 5000);
    this.tauri
      .listen<{ kind: string; detail: string }>('ide_bridge_event', (event) => {
        this.lastEvent = `${event.payload.kind}: ${event.payload.detail}`;
        this.eventFading = false;
        this.cdr.markForCheck();
        if (this.eventTimerId !== null) clearTimeout(this.eventTimerId);
        this.eventTimerId = setTimeout(() => {
          this.eventFading = true;
          this.cdr.markForCheck();
          this.eventTimerId = setTimeout(() => {
            this.lastEvent = null;
            this.eventFading = false;
            this.cdr.markForCheck();
            this.eventTimerId = null;
          }, 1000);
        }, 9000);
      })
      .then((unlisten) => {
        this.unlistenEvent = unlisten;
      })
      .catch(() => {
        // Tauri event listener not available outside desktop context
      });
  }

  /** Cleans up IDE polling interval, event fade timer, and Tauri event listener. */
  ngOnDestroy(): void {
    if (this.ideIntervalId !== null) {
      clearInterval(this.ideIntervalId);
      this.ideIntervalId = null;
    }
    if (this.eventTimerId !== null) {
      clearTimeout(this.eventTimerId);
      this.eventTimerId = null;
    }
    if (this.unlistenEvent) {
      this.unlistenEvent();
      this.unlistenEvent = null;
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
      this.services = response.services;
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
   * Returns the current value for a credential field, preferring edited values.
   * @param svc - the integration status entry
   * @param key - the field key to look up
   */
  getFieldValue(svc: IntegrationStatusEntry, key: string): string {
    return this.editedValues[svc.service]?.[key] ?? svc.current_values[key] ?? '';
  }

  /**
   * Stores a field value change in the local edit buffer.
   * @param service - the service identifier
   * @param key - the field key
   * @param event - the DOM input event
   */
  setFieldValue(service: string, key: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (!this.editedValues[service]) this.editedValues[service] = {};
    this.editedValues[service][key] = value;
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
   * Saves credential fields and optional Redmine mappings for a service.
   * @param svc - the integration to save credentials for
   * @param event - the form submit event
   */
  async saveCredentials(svc: IntegrationStatusEntry, event: Event): Promise<void> {
    event.preventDefault();
    const credentials: Record<string, string> = {};

    for (const field of svc.auth_fields) {
      const value = this.editedValues[svc.service]?.[field.key];
      if (value !== undefined && value !== '') {
        credentials[field.key] = value;
      }
    }

    if (Object.keys(credentials).length === 0) return;

    this.error = '';
    try {
      await this.tauri.invoke('save_integration_credentials', {
        project: this.activeProject,
        service: svc.service,
        credentials,
      });

      if (svc.service === 'redmine' && this.editedMappings['redmine']) {
        const mappings: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(this.editedMappings['redmine'])) {
          mappings[k] = v;
        }
        await this.tauri.invoke('save_redmine_mappings', {
          project: this.activeProject,
          mappings,
        });
      }

      this.needsRestart = true;
      await this.loadIntegrations();
      this.editedValues[svc.service] = {};

      const updated = this.services.find((s) => s.service === svc.service);
      if (updated && updated.configured && !updated.enabled) {
        await this.tauri.invoke('set_integration_enabled', {
          project: this.activeProject,
          service: svc.service,
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

  /**
   * Returns the current Redmine mapping entries as key-value pairs.
   * @param svc - the integration with mappings
   */
  getMappingEntries(svc: IntegrationStatusEntry): { key: string; value: number }[] {
    const source =
      this.editedMappings[svc.service] ?? (svc.mappings as Record<string, number>) ?? {};
    return Object.entries(source).map(([key, value]) => ({ key, value: Number(value) }));
  }

  /**
   * Renames a mapping key while preserving its value.
   * @param service - the service identifier
   * @param oldKey - the current key name
   * @param event - the DOM input event with the new key name
   */
  updateMappingKey(service: string, oldKey: string, event: Event): void {
    const newKey = (event.target as HTMLInputElement).value;
    if (!this.editedMappings[service]) {
      this.editedMappings[service] = {
        ...((this.services.find((s) => s.service === service)?.mappings as Record<
          string,
          number
        >) ?? {}),
      };
    }
    const value = this.editedMappings[service][oldKey];
    delete this.editedMappings[service][oldKey];
    this.editedMappings[service][newKey] = value;
  }

  /**
   * Updates the numeric value for a mapping key.
   * @param service - the service identifier
   * @param key - the mapping key to update
   * @param event - the DOM input event with the new value
   */
  updateMappingValue(service: string, key: string, event: Event): void {
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    if (!this.editedMappings[service]) {
      this.editedMappings[service] = {
        ...((this.services.find((s) => s.service === service)?.mappings as Record<
          string,
          number
        >) ?? {}),
      };
    }
    this.editedMappings[service][key] = value;
  }

  /**
   * Adds a new empty mapping entry for the given service.
   * @param service - the service identifier
   */
  addMapping(service: string): void {
    if (!this.editedMappings[service]) {
      this.editedMappings[service] = {
        ...((this.services.find((s) => s.service === service)?.mappings as Record<
          string,
          number
        >) ?? {}),
      };
    }
    this.editedMappings[service][`mapping_${++this.nextMappingId}`] = 0;
  }

  /**
   * Removes a mapping entry by key for the given service.
   * @param service - the service identifier
   * @param key - the mapping key to remove
   */
  removeMapping(service: string, key: string): void {
    if (!this.editedMappings[service]) {
      this.editedMappings[service] = {
        ...((this.services.find((s) => s.service === service)?.mappings as Record<
          string,
          number
        >) ?? {}),
      };
    }
    delete this.editedMappings[service][key];
  }

  private async loadSelectedIde(): Promise<void> {
    try {
      const sel = await this.tauri.invoke<{ ide_name: string; port: number } | null>(
        'get_selected_ide'
      );
      if (sel) this.selectedIde = { ide_name: sel.ide_name, port: sel.port };
    } catch (e: unknown) {
      if (typeof window !== 'undefined' && '__TAURI__' in window) {
        console.warn('loadSelectedIde failed:', e);
      }
    }
    this.cdr.markForCheck();
  }

  private async pollIdes(): Promise<void> {
    try {
      this.availableIdes = await this.tauri.invoke<DetectedIde[]>('list_available_ides');
    } catch (e: unknown) {
      if (typeof window !== 'undefined' && '__TAURI__' in window) {
        console.warn('pollIdes failed:', e);
      }
    }
    this.cdr.markForCheck();
  }

  /**
   * Connects the IDE Bridge to the selected IDE instance.
   * @param ide - The detected IDE to connect to via the bridge.
   */
  async connectIde(ide: DetectedIde): Promise<void> {
    if (ide.port === null) {
      this.ideError = `${ide.ide_name} has no port — cannot connect`;
      this.cdr.markForCheck();
      return;
    }
    this.ideConnecting = true;
    this.ideError = null;
    try {
      await this.tauri.invoke('select_ide', { ideName: ide.ide_name, port: ide.port });
      this.selectedIde = { ide_name: ide.ide_name, port: ide.port };
    } catch (err) {
      this.ideError = `Failed to connect to ${ide.ide_name}: ${err}`;
    } finally {
      this.ideConnecting = false;
      this.cdr.markForCheck();
    }
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
