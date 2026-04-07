import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { PluginStatusEntry, PluginsResponse } from '../models/plugin';
import {
  PluginCardComponent,
  SavePluginCredentialsEvent,
} from './plugin-card/plugin-card.component';
import { open } from '@tauri-apps/plugin-dialog';

/** Manages installed plugins: list, install, remove, enable/disable, credentials. */
@Component({
  selector: 'app-plugins',
  standalone: true,
  imports: [CommonModule, PluginCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (installing) {
      <div
        class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-sw-bg-darkest/[0.92]"
        role="alertdialog"
        aria-modal="true"
        aria-label="Installing plugin"
        data-testid="plugins-install-overlay"
      >
        <div
          class="w-8 h-8 border-[3px] border-sw-border-dark border-t-sw-accent rounded-full animate-sw-spin"
        ></div>
        <p class="mt-4 font-mono text-sm text-sw-text">Installing plugin…</p>
      </div>
    }

    <div>
      <h1 class="text-xl text-sw-accent m-0 mb-6">Plugins</h1>

      @if (error) {
        <div
          class="mb-4 px-3 py-2 bg-sw-error-bg border border-sw-accent rounded text-sw-accent text-[13px]"
          data-testid="plugins-error"
        >
          {{ error }}
        </div>
      }
      @if (success) {
        <div
          class="mb-4 px-3 py-2 bg-sw-success-dark border border-sw-success-text rounded text-sw-success-text text-[13px]"
          data-testid="plugins-success"
        >
          {{ success }}
        </div>
      }

      <div class="mb-6">
        <button
          class="px-5 py-2 bg-transparent text-sw-accent border border-dashed border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:enabled:bg-sw-accent hover:enabled:text-sw-bg-darkest disabled:opacity-60 disabled:cursor-not-allowed"
          data-testid="plugins-install"
          (click)="installPlugin()"
          [disabled]="installing"
        >
          @if (installing) {
            <span
              class="inline-block w-3 h-3 border-2 border-sw-accent/30 border-t-sw-accent rounded-full animate-sw-spin"
            ></span>
            Installing...
          } @else {
            + Install Plugin
          }
        </button>
      </div>

      <section class="mb-6" data-testid="plugins-list">
        @if (plugins.length === 0) {
          <p class="text-sw-text-dim text-[13px] py-5 text-center" data-testid="empty-state">
            No plugins installed. Click "Install Plugin" to add one.
          </p>
        }
        @for (plugin of plugins; track plugin.slug) {
          <app-plugin-card
            [plugin]="plugin"
            [expanded]="expandedPlugin === plugin.slug"
            (toggleExpand)="toggleExpand($event)"
            (openPlugin)="navigateToPlugin($event)"
            (togglePlugin)="handleTogglePlugin($event)"
            (saveCredentials)="handleSaveCredentials($event)"
            (deleteCredentials)="handleDeleteCredentials($event)"
            (removePlugin)="handleRemovePlugin($event)"
          />
        }
      </section>
    </div>
  `,
  host: { class: 'block bg-sw-bg-darkest min-h-screen p-6 text-sw-text' },
})
export class PluginsComponent implements OnInit, OnDestroy {
  plugins: PluginStatusEntry[] = [];
  expandedPlugin: string | null = null;
  installing = false;
  error = '';
  success = '';
  activeProject: string | null = null;

  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private unsubProjectReady: (() => void) | null = null;

  /** Loads the active project and plugins on init. */
  async ngOnInit(): Promise<void> {
    await this.loadActiveProject();
    await this.loadPlugins();
    this.unsubProjectReady = this.projectState.onProjectReady(async () => {
      await this.loadActiveProject();
      await this.loadPlugins();
    });
  }

  /** Cleans up project ready listener. */
  ngOnDestroy(): void {
    if (this.unsubProjectReady) {
      this.unsubProjectReady();
      this.unsubProjectReady = null;
    }
  }

  /** Syncs the active project from ProjectStateService. */
  loadActiveProject(): void {
    this.activeProject = this.projectState.activeProject;
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
   * Navigates to the plugin detail page.
   * @param slug - the plugin slug to navigate to
   */
  navigateToPlugin(slug: string): void {
    this.router.navigate(['/plugins', slug]);
  }

  /**
   * Opens a native file dialog to select a plugin ZIP, then installs it.
   */
  async installPlugin(): Promise<void> {
    let selected: string | null;
    try {
      selected = await open({
        multiple: false,
        filters: [{ name: 'Plugin ZIP', extensions: ['zip'] }],
      });
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      this.cdr.markForCheck();
      return;
    }
    if (!selected) return;

    this.installing = true;
    this.error = '';
    this.success = '';
    this.cdr.markForCheck();

    try {
      const msg = await this.tauri.invoke<string>('install_plugin', {
        zipPath: selected,
      });
      this.success = msg;
      this.projectState.requestRestart();
      await this.loadPlugins();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }

    this.installing = false;
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
    const enabled = (event.target as HTMLInputElement).checked;
    const sid = plugin.service_id ?? plugin.slug;
    try {
      await this.tauri.invoke<void>('set_plugin_enabled', {
        project: this.activeProject,
        serviceId: sid,
        enabled,
      });
      plugin.enabled = enabled;
      this.projectState.requestRestart();
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

      await this.loadPlugins();

      const updated = this.plugins.find((p) => p.slug === payload.plugin.slug);
      if (updated && updated.configured && !updated.enabled) {
        const sid = updated.service_id ?? updated.slug;
        await this.tauri.invoke<void>('set_plugin_enabled', {
          project: this.activeProject,
          serviceId: sid,
          enabled: true,
        });
        updated.enabled = true;
      }

      this.projectState.requestRestart();
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
      this.projectState.requestRestart();
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
      this.projectState.requestRestart();
      await this.loadPlugins();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }
}
