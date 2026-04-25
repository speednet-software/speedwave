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
  imports: [CommonModule, PluginSettingsFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div>
      <button
        class="bg-transparent border-none text-sw-accent text-[13px] font-mono cursor-pointer p-0 mb-5 inline-block hover:underline"
        (click)="goBack()"
        data-testid="back-link"
      >
        &larr; Back to Plugins
      </button>

      @if (error) {
        <div
          class="mb-4 px-3 py-2 bg-sw-error-bg border border-sw-accent rounded text-sw-accent text-[13px]"
          data-testid="detail-error"
        >
          {{ error }}
        </div>
      }
      @if (success) {
        <div
          class="mb-4 px-3 py-2 bg-sw-success-dark border border-sw-success-text rounded text-sw-success-text text-[13px]"
          data-testid="detail-success"
        >
          {{ success }}
        </div>
      }

      @if (!plugin) {
        <p class="text-sw-text-dim text-[13px]" data-testid="plugin-not-found">Plugin not found.</p>
      } @else {
        <div class="flex items-center gap-3 mb-6">
          <h1 class="text-xl text-sw-accent m-0">{{ plugin.name }}</h1>
          <span class="text-[11px] text-sw-text-dim font-mono" data-testid="version-badge"
            >v{{ plugin.version }}</span
          >
          @if (plugin.configured) {
            <span
              class="text-[11px] px-2 py-0.5 rounded font-medium bg-sw-success-dark text-sw-success-text"
              data-testid="configured-badge"
              >Configured</span
            >
          }
        </div>

        <div class="flex border-b border-sw-border mb-6" data-testid="tab-bar">
          <button
            class="bg-transparent border-none border-b-2 border-b-transparent text-sw-text-dim text-sm font-mono px-5 py-2 cursor-pointer transition-all duration-200 hover:text-sw-text"
            [class.text-sw-accent!]="activeTab === 'dashboard'"
            [class.border-b-sw-accent!]="activeTab === 'dashboard'"
            (click)="activeTab = 'dashboard'"
            data-testid="tab-dashboard"
          >
            Dashboard
          </button>
          <button
            class="bg-transparent border-none border-b-2 border-b-transparent text-sw-text-dim text-sm font-mono px-5 py-2 cursor-pointer transition-all duration-200 hover:text-sw-text"
            [class.text-sw-accent!]="activeTab === 'settings'"
            [class.border-b-sw-accent!]="activeTab === 'settings'"
            (click)="activeTab = 'settings'"
            data-testid="tab-settings"
          >
            Settings
          </button>
        </div>

        <div class="min-h-[200px]">
          @if (activeTab === 'dashboard') {
            <div data-testid="dashboard-content">
              <p class="text-sw-text-muted text-[13px] m-0 mb-4" data-testid="plugin-description">
                {{ plugin.description }}
              </p>

              @if (plugin.requires_integrations.length > 0) {
                <div class="mt-4" data-testid="integration-requirements">
                  <h3 class="text-sm text-sw-text-subtle m-0 mb-3">Required Integrations</h3>
                  @for (integration of plugin.requires_integrations; track integration) {
                    <div
                      class="px-3.5 py-2.5 rounded-md text-[13px] mb-2 border"
                      [class.bg-sw-success-dark]="integrationStatuses.get(integration)"
                      [class.text-sw-success-text]="integrationStatuses.get(integration)"
                      [class.border-sw-success-border]="integrationStatuses.get(integration)"
                      [class.bg-sw-error-bg]="!integrationStatuses.get(integration)"
                      [class.text-sw-accent]="!integrationStatuses.get(integration)"
                      [class.border-sw-accent]="!integrationStatuses.get(integration)"
                      [attr.data-testid]="'integration-status-' + integration"
                    >
                      @if (integrationStatuses.get(integration)) {
                        <span class="mr-1.5 font-bold">&#10003;</span>
                        {{ integration | titlecase }} — Connected
                      } @else {
                        <span class="mr-1.5">&#9888;</span>
                        {{ integration | titlecase }} — Not configured
                      }
                    </div>
                  }
                  @if (missingIntegrations.length > 0) {
                    <button
                      class="mt-3 bg-sw-accent text-white border-none rounded px-5 py-2 text-[13px] font-mono cursor-pointer transition-colors duration-200 hover:bg-sw-accent-hover"
                      (click)="goToIntegrations()"
                      data-testid="btn-go-integrations"
                    >
                      Go to Integrations
                    </button>
                  }
                </div>
              }

              @if (plugin.requires_integrations.length === 0) {
                <p
                  class="text-sw-text-ghost text-[13px] italic"
                  data-testid="dashboard-placeholder"
                >
                  Plugin dashboard content will appear here.
                </p>
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
  host: { class: 'block bg-sw-bg-darkest min-h-screen p-6 text-sw-text' },
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
