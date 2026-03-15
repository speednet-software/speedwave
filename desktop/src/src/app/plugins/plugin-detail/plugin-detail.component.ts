import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { PluginStatusEntry, PluginsResponse } from '../../models/plugin';
import { IntegrationsResponse } from '../../models/integration';
import { PluginSettingsFormComponent } from '../plugin-settings-form/plugin-settings-form.component';

/** Detail page for a single plugin with Dashboard and Settings tabs. */
@Component({
  selector: 'app-plugin-detail',
  standalone: true,
  imports: [CommonModule, PluginSettingsFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="detail-page">
      <button class="back-link" (click)="goBack()" data-testid="back-link">
        &larr; Back to Plugins
      </button>

      @if (error) {
        <div class="error-banner" data-testid="detail-error">{{ error }}</div>
      }
      @if (success) {
        <div class="success-banner" data-testid="detail-success">{{ success }}</div>
      }

      @if (!plugin) {
        <p class="not-found" data-testid="plugin-not-found">Plugin not found.</p>
      } @else {
        <div class="detail-header">
          <h1>{{ plugin.name }}</h1>
          <span class="version-badge">v{{ plugin.version }}</span>
          @if (plugin.configured) {
            <span class="badge configured">Configured</span>
          }
        </div>

        <div class="tab-bar" data-testid="tab-bar">
          <button
            [class.active]="activeTab === 'dashboard'"
            (click)="activeTab = 'dashboard'"
            data-testid="tab-dashboard"
          >
            Dashboard
          </button>
          <button
            [class.active]="activeTab === 'settings'"
            (click)="activeTab = 'settings'"
            data-testid="tab-settings"
          >
            Settings
          </button>
        </div>

        <div class="tab-content">
          @if (activeTab === 'dashboard') {
            <div data-testid="dashboard-content">
              <p class="plugin-description">{{ plugin.description }}</p>

              @if (plugin.requires_integrations.length > 0) {
                <div class="integration-requirements" data-testid="integration-requirements">
                  <h3>Required Integrations</h3>
                  @for (integration of plugin.requires_integrations; track integration) {
                    <div
                      class="integration-status"
                      [class.connected]="integrationStatuses.get(integration)"
                      [class.not-configured]="!integrationStatuses.get(integration)"
                      [attr.data-testid]="'integration-status-' + integration"
                    >
                      @if (integrationStatuses.get(integration)) {
                        <span class="check-icon">&#10003;</span>
                        {{ integration | titlecase }} — Connected
                      } @else {
                        <span class="warning-icon">&#9888;</span>
                        {{ integration | titlecase }} — Not configured
                      }
                    </div>
                  }
                  @if (missingIntegrations.length > 0) {
                    <button
                      class="btn-go-integrations"
                      (click)="goToIntegrations()"
                      data-testid="btn-go-integrations"
                    >
                      Go to Integrations
                    </button>
                  }
                </div>
              }

              @if (plugin.requires_integrations.length === 0) {
                <p class="dashboard-placeholder">Plugin dashboard content will appear here.</p>
              }
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
        </div>
      }
    </div>
  `,
  styleUrl: './plugin-detail.component.css',
})
export class PluginDetailComponent implements OnInit, OnDestroy {
  plugin: PluginStatusEntry | null = null;
  settings: Record<string, unknown> = {};
  activeTab: 'dashboard' | 'settings' = 'dashboard';
  error = '';
  success = '';
  integrationStatuses = new Map<string, boolean>();

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private activeProject: string | null = null;
  private unsubProjectReady: (() => void) | null = null;

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
      this.cdr.markForCheck();
    });
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
