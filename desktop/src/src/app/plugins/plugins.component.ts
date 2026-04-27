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
import { ProjectPillComponent } from '../project-switcher/project-pill.component';
import { SpinIconComponent } from '../shared/spin-icon.component';
import { open } from '@tauri-apps/plugin-dialog';

/** Per-row plugin dot colour cycle. */
const PLUGIN_DOT_COLOURS: readonly string[] = [
  'var(--accent)',
  'var(--violet)',
  'var(--teal)',
  'var(--amber)',
  'var(--green)',
];

/**
 * Returns a deterministic dot colour for a plugin row based on its index.
 * @param index - the row index in the rendered list
 */
function dotColourFor(index: number): string {
  return PLUGIN_DOT_COLOURS[index % PLUGIN_DOT_COLOURS.length];
}

/** Manages installed plugins: list, install, remove, enable/disable, credentials. */
@Component({
  selector: 'app-plugins',
  imports: [CommonModule, ProjectPillComponent, SpinIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (installing) {
      <div
        class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[var(--bg)]/[0.92]"
        role="alertdialog"
        aria-modal="true"
        aria-label="Installing plugin"
        data-testid="plugins-install-overlay"
      >
        <app-spin-icon class="block h-8 w-8 text-[var(--accent)]" />
        <p class="mono mt-4 text-[12px] text-[var(--ink)]">Installing plugin…</p>
      </div>
    }

    <div
      class="flex h-11 flex-shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--bg-1)] px-4 md:px-6"
      data-testid="plugins-header"
    >
      <h1 class="view-title truncate text-[14px] text-[var(--ink)]" data-testid="plugins-title">
        Installed plugins
      </h1>
      <div class="ml-auto flex flex-shrink-0 items-center gap-3">
        <button
          type="button"
          class="mono hidden rounded border border-[var(--accent-dim)] bg-[var(--accent)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 md:inline-flex"
          data-testid="plugins-install"
          [disabled]="installing"
          (click)="installPlugin()"
        >
          $ install plugin
        </button>
        <span class="hidden text-[var(--line-strong)] md:inline">·</span>
        <app-project-pill />
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-4 md:p-6" data-testid="plugins-body">
      <div class="mx-auto max-w-3xl">
        @if (error) {
          <div
            class="mb-4 rounded ring-1 ring-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-300"
            data-testid="plugins-error"
            role="alert"
          >
            {{ error }}
          </div>
        }
        @if (success) {
          <div
            class="mb-4 rounded ring-1 ring-[rgba(52,211,153,0.4)] bg-[rgba(52,211,153,0.06)] px-3 py-2 text-[12px] text-[var(--green)]"
            data-testid="plugins-success"
            role="status"
          >
            {{ success }}
          </div>
        }

        @if (plugins.length === 0) {
          <p
            class="mono py-10 text-center text-[12px] text-[var(--ink-mute)]"
            data-testid="empty-state"
          >
            No plugins installed. Click "$ install plugin" to add one.
          </p>
        } @else {
          <div
            class="overflow-hidden rounded border border-[var(--line)]"
            data-testid="plugins-table-wrapper"
          >
            <table class="w-full text-[13px]" data-testid="plugins-table">
              <caption class="sr-only">
                Installed plugins
              </caption>
              <thead
                class="mono border-b border-[var(--line)] bg-[var(--bg-1)] text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
              >
                <tr>
                  <th class="px-4 py-2 text-left font-normal" scope="col">plugin</th>
                  <th class="px-4 py-2 text-left font-normal" scope="col">type</th>
                  <th class="hidden px-4 py-2 text-left font-normal md:table-cell" scope="col">
                    ver
                  </th>
                  <th class="hidden px-4 py-2 text-left font-normal md:table-cell" scope="col">
                    tools
                  </th>
                  <th class="hidden px-4 py-2 text-left font-normal lg:table-cell" scope="col">
                    signed
                  </th>
                  <th class="px-4 py-2 text-right font-normal" scope="col">on</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--line)]">
                @for (plugin of plugins; track plugin.slug; let idx = $index) {
                  <tr
                    class="hover-bg cursor-pointer"
                    [attr.data-testid]="'plugins-row-' + plugin.slug"
                    (click)="navigateToPlugin(plugin.slug)"
                    (keydown.enter)="navigateToPlugin(plugin.slug)"
                    tabindex="0"
                    role="link"
                    [attr.aria-label]="'Open ' + plugin.name"
                  >
                    <td class="px-4 py-2.5">
                      <div class="flex items-center gap-2">
                        <span [style.color]="dotColour(idx)" aria-hidden="true">●</span>
                        <div>
                          <div class="text-[var(--ink)]" data-testid="plugins-row-name">
                            {{ plugin.name }}
                          </div>
                          <div
                            class="mono text-[10px] text-[var(--ink-mute)]"
                            data-testid="plugins-row-tagline"
                          >
                            {{ plugin.description }}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td class="px-4 py-2.5">
                      @if (plugin.service_id) {
                        <span class="pill teal" data-testid="plugins-row-type">mcp</span>
                      } @else {
                        <span class="pill" data-testid="plugins-row-type">resource</span>
                      }
                    </td>
                    <td
                      class="mono hidden px-4 py-2.5 text-[var(--ink-mute)] md:table-cell"
                      data-testid="plugins-row-ver"
                    >
                      v{{ plugin.version }}
                    </td>
                    <td
                      class="mono hidden px-4 py-2.5 text-[var(--ink-dim)] md:table-cell"
                      data-testid="plugins-row-tools"
                    >
                      {{ toolsLabelFor(plugin) }}
                    </td>
                    <td class="hidden px-4 py-2.5 lg:table-cell">
                      <span class="pill green" data-testid="plugins-row-signed">✓ ed25519</span>
                    </td>
                    <td class="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        class="toggle ml-auto"
                        [class.on]="plugin.enabled"
                        [attr.aria-pressed]="plugin.enabled"
                        [attr.aria-label]="(plugin.enabled ? 'Disable ' : 'Enable ') + plugin.name"
                        [attr.data-testid]="'plugins-row-toggle-' + plugin.slug"
                        (click)="onRowToggle(plugin, $event)"
                      ></button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>
    </div>
  `,
  host: {
    class: 'flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)]',
  },
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
   * Returns the dot colour for a row based on its index.
   * @param idx - the row index
   */
  dotColour(idx: number): string {
    return dotColourFor(idx);
  }

  /**
   * Tools-column label — em-dash for resource plugins (no MCP worker).
   * @param plugin - the plugin status entry
   */
  toolsLabelFor(plugin: PluginStatusEntry): string {
    if (!plugin.service_id) return '—';
    // We don't currently expose tool counts via get_plugins, so render a stable
    // "—" placeholder and let plugin-detail report the real number per worker.
    return '—';
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
   * Click handler for row toggle pill — flips state without navigating.
   * @param plugin - the plugin to toggle
   * @param event - the click event (used to stop propagation)
   */
  async onRowToggle(plugin: PluginStatusEntry, event: Event): Promise<void> {
    event.stopPropagation();
    const previous = plugin.enabled;
    const next = !previous;
    plugin.enabled = next;
    this.cdr.markForCheck();
    const sid = plugin.service_id ?? plugin.slug;
    try {
      await this.tauri.invoke<void>('set_plugin_enabled', {
        project: this.activeProject,
        serviceId: sid,
        enabled: next,
      });
      this.projectState.requestRestart();
    } catch (e: unknown) {
      plugin.enabled = previous;
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  /**
   * Handles the togglePlugin event from a plugin card (legacy entry point).
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
   * Handles the saveCredentials event from a plugin card (legacy entry point).
   * @param payload - the plugin and credentials to save
   * @param payload.plugin Plugin whose credentials are being saved.
   * @param payload.credentials Map of credential field name to user-provided value.
   */
  async handleSaveCredentials(payload: {
    plugin: PluginStatusEntry;
    credentials: Record<string, string>;
  }): Promise<void> {
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
   * Removes all credential files for a plugin (legacy entry point).
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
