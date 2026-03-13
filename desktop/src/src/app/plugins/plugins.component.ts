import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TauriService } from '../services/tauri.service';
import { PluginStatusEntry, PluginsResponse } from '../models/plugin';
import { ProjectList } from '../models/update';
import {
  PluginCardComponent,
  SavePluginCredentialsEvent,
} from './plugin-card/plugin-card.component';

/** Manages installed plugins: list, install, remove, enable/disable, credentials. */
@Component({
  selector: 'app-plugins',
  standalone: true,
  imports: [CommonModule, PluginCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (needsRestart) {
      <div class="restart-banner" data-testid="plugins-restart-banner">
        <div class="restart-info">
          <span>Changes require container restart to take effect</span>
          @if (restarting) {
            <span class="restart-hint">This may take a minute while containers are recreated</span>
          }
        </div>
        <button
          class="restart-btn"
          data-testid="plugins-restart"
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

    <div class="plugins-page">
      <h1>Plugins</h1>

      @if (error) {
        <div class="error-banner" data-testid="plugins-error">{{ error }}</div>
      }
      @if (success) {
        <div class="success-banner" data-testid="plugins-success">{{ success }}</div>
      }

      <div class="install-section">
        <input
          #fileInput
          type="file"
          accept=".zip"
          class="hidden-input"
          (change)="onFileSelected($event)"
          data-testid="plugins-file-input"
        />
        <button
          class="install-btn"
          data-testid="plugins-install"
          (click)="fileInput.click()"
          [disabled]="installing"
        >
          @if (installing) {
            Installing...
          } @else {
            + Install Plugin
          }
        </button>
      </div>

      <section class="section" data-testid="plugins-list">
        @if (plugins.length === 0) {
          <p class="empty-state">No plugins installed. Click "Install Plugin" to add one.</p>
        }
        @for (plugin of plugins; track plugin.slug) {
          <app-plugin-card
            [plugin]="plugin"
            [expanded]="expandedPlugin === plugin.slug"
            (toggleExpand)="toggleExpand($event)"
            (togglePlugin)="handleTogglePlugin($event)"
            (saveCredentials)="handleSaveCredentials($event)"
            (deleteCredentials)="handleDeleteCredentials($event)"
            (removePlugin)="handleRemovePlugin($event)"
          />
        }
      </section>
    </div>
  `,
  styleUrl: './plugins.component.css',
})
export class PluginsComponent implements OnInit, OnDestroy {
  plugins: PluginStatusEntry[] = [];
  expandedPlugin: string | null = null;
  needsRestart = false;
  restarting = false;
  installing = false;
  error = '';
  success = '';
  activeProject: string | null = null;

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private unlistenProjectSwitch: (() => void) | null = null;

  /** Loads the active project and plugins on init. */
  async ngOnInit(): Promise<void> {
    await this.loadActiveProject();
    await this.loadPlugins();
    this.tauri
      .listen<string>('project_switched', async () => {
        await this.loadActiveProject();
        await this.loadPlugins();
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

  /** Fetches installed plugin entries from the backend. */
  async loadPlugins(): Promise<void> {
    if (!this.activeProject) return;
    try {
      const response = await this.tauri.invoke<PluginsResponse>('get_plugins', {
        project: this.activeProject,
      });
      this.plugins = response.plugins;
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  /**
   * Expands or collapses the credential form for a plugin card.
   * @param slug - the plugin slug to toggle
   */
  toggleExpand(slug: string): void {
    this.expandedPlugin = this.expandedPlugin === slug ? null : slug;
  }

  /**
   * Handles the file input change event for plugin ZIP install.
   * @param event - the file input change event
   */
  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.installing = true;
    this.error = '';
    this.success = '';
    this.cdr.markForCheck();

    try {
      // Tauri webview file inputs provide the real path
      const msg = await this.tauri.invoke<string>('install_plugin', {
        zipPath: (file as File & { path?: string }).path ?? file.name,
      });
      this.success = msg;
      this.needsRestart = true;
      await this.loadPlugins();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }

    this.installing = false;
    input.value = '';
    this.cdr.markForCheck();
  }

  /**
   * Handles the togglePlugin event from a plugin card.
   * @param payload - the plugin and checkbox event to process
   * @param payload.plugin - the plugin to toggle
   * @param payload.event - the checkbox change event
   */
  async handleTogglePlugin(payload: { plugin: PluginStatusEntry; event: Event }): Promise<void> {
    const { plugin, event } = payload;
    if (!plugin.configured) return;
    const enabled = (event.target as HTMLInputElement).checked;
    const sid = plugin.service_id ?? plugin.slug;
    try {
      await this.tauri.invoke('set_plugin_enabled', {
        project: this.activeProject,
        serviceId: sid,
        enabled,
      });
      plugin.enabled = enabled;
      this.needsRestart = true;
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      (event.target as HTMLInputElement).checked = !enabled;
    }
    this.cdr.markForCheck();
  }

  /**
   * Handles the saveCredentials event from a plugin card.
   * @param payload - the plugin and credentials to save
   */
  async handleSaveCredentials(payload: SavePluginCredentialsEvent): Promise<void> {
    this.error = '';
    this.success = '';
    try {
      await this.tauri.invoke('save_plugin_credentials', {
        project: this.activeProject,
        slug: payload.plugin.slug,
        credentials: payload.credentials,
      });

      this.needsRestart = true;
      await this.loadPlugins();

      const updated = this.plugins.find((p) => p.slug === payload.plugin.slug);
      if (updated && updated.configured && !updated.enabled && updated.service_id) {
        const sid = updated.service_id ?? updated.slug;
        await this.tauri.invoke('set_plugin_enabled', {
          project: this.activeProject,
          serviceId: sid,
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
   * Removes all credential files for a plugin.
   * @param plugin - the plugin to delete credentials for
   */
  async handleDeleteCredentials(plugin: PluginStatusEntry): Promise<void> {
    this.error = '';
    this.success = '';
    try {
      await this.tauri.invoke('delete_plugin_credentials', {
        project: this.activeProject,
        slug: plugin.slug,
      });
      this.needsRestart = true;
      await this.loadPlugins();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  /**
   * Uninstalls a plugin and reloads the list.
   * @param plugin - the plugin to remove
   */
  async handleRemovePlugin(plugin: PluginStatusEntry): Promise<void> {
    this.error = '';
    this.success = '';
    try {
      await this.tauri.invoke('remove_plugin', { slug: plugin.slug });
      this.success = `Plugin '${plugin.name}' removed`;
      this.needsRestart = true;
      await this.loadPlugins();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  /** Restarts containers to apply pending plugin changes. */
  async restartContainers(): Promise<void> {
    this.restarting = true;
    this.error = '';
    this.success = '';
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('restart_integration_containers', {
        project: this.activeProject,
      });
      this.needsRestart = false;
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.restarting = false;
    this.cdr.markForCheck();
  }
}
