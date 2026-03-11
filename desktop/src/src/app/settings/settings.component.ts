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
import { Router } from '@angular/router';
import { TauriService } from '../services/tauri.service';
import { AuthSectionComponent } from './auth-section/auth-section.component';
import { LlmProviderComponent } from './llm-provider/llm-provider.component';
import { SystemHealthComponent } from './system-health.component';
import { AdvancedSectionComponent } from './advanced-section/advanced-section.component';
import { UpdateSectionComponent } from './update-section/update-section.component';
import { ProjectList, ContainerUpdateResult } from '../models/update';

interface LlmConfigResponse {
  provider: string | null;
  model: string | null;
  base_url: string | null;
  api_key_env: string | null;
}

/** Displays application settings and provides factory reset functionality. */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AuthSectionComponent,
    LlmProviderComponent,
    SystemHealthComponent,
    AdvancedSectionComponent,
    UpdateSectionComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="settings-container">
      <h1>Settings</h1>

      @if (error) {
        <div class="error-banner" data-testid="settings-error">{{ error }}</div>
      }

      <!-- Active project info -->
      <section class="section">
        <h2>Project</h2>
        <div class="info-card">
          <div class="info-row">
            <span class="info-label">Active project</span>
            <span class="info-value" data-testid="settings-active-project">{{
              activeProject || 'None'
            }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Directory</span>
            <span class="info-value mono">{{ projectDir || '—' }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Data directory</span>
            <span class="info-value mono">~/.speedwave/</span>
          </div>
        </div>
      </section>

      <!-- LLM Provider (temporarily hidden) -->
      @if (showAdvancedSections) {
        <app-llm-provider
          (providerChange)="llmProvider = $event"
          (errorOccurred)="error = $event"
        />
      }

      <!-- Authentication -->
      <app-auth-section
        [activeProject]="activeProject"
        [llmProvider]="llmProvider"
        (errorOccurred)="error = $event"
      />

      <!-- Updates -->
      <app-update-section
        [activeProject]="activeProject"
        [showAdvancedSections]="showAdvancedSections"
        (errorOccurred)="error = $event"
      />

      <!-- System Health -->
      @if (activeProject) {
        <section class="section">
          <h2>System Health</h2>
          <app-system-health [project]="activeProject" />
        </section>
      }

      <!-- Logging & Danger Zone -->
      <app-advanced-section
        [activeProject]="activeProject"
        [logLevel]="logLevel"
        (errorOccurred)="error = $event"
        (resetCompleted)="onResetCompleted()"
      />
    </div>
  `,
  styles: [
    `
      .settings-container {
        max-width: 700px;
        margin: 32px auto;
        padding: 24px;
      }
      h1 {
        font-size: 20px;
        color: #e94560;
        margin: 0 0 24px 0;
      }
      h2 {
        font-size: 15px;
        color: #e0e0e0;
        margin: 0 0 12px 0;
      }
      .error-banner {
        margin-bottom: 16px;
        padding: 8px 12px;
        background: #3d0000;
        border: 1px solid #e94560;
        border-radius: 4px;
        color: #e94560;
        font-size: 13px;
      }
      .section {
        margin-bottom: 24px;
      }
      .info-card {
        background: #16213e;
        border: 1px solid #0f3460;
        border-radius: 8px;
        padding: 16px;
      }
      .info-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
      }
      .info-row + .info-row {
        border-top: 1px solid #0f3460;
      }
      .info-label {
        font-size: 13px;
        color: #888;
      }
      .info-value {
        font-size: 13px;
        color: #e0e0e0;
      }
      .info-value.mono {
        font-family: monospace;
        color: #aaa;
      }
    `,
  ],
})
export class SettingsComponent implements OnInit, OnDestroy {
  /** When false, hides LLM Provider and Container Updates sections (temporary). */
  showAdvancedSections = false;
  activeProject: string | null = null;
  projectDir = '';
  error = '';
  llmProvider = 'anthropic';
  llmModel = '';
  llmBaseUrl = '';
  llmApiKeyEnv = '';
  llmSaving = false;
  llmSaved = false;
  logLevel = 'info';
  containerUpdating = false;
  containerUpdateDone = false;
  containerUpdateResult: ContainerUpdateResult | null = null;

  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private unlistenProjectSwitch: (() => void) | null = null;

  /** Loads project information on component initialization. */
  ngOnInit(): void {
    this.loadProjectInfo();
    this.loadLlmConfig();
    this.loadLogLevel();

    this.tauri
      .listen<string>('project_switched', () => {
        this.loadProjectInfo();
      })
      .then((unlisten) => {
        this.unlistenProjectSwitch = unlisten;
      })
      .catch(() => {
        // Tauri event listener not available outside desktop context
      });
  }

  /** Unsubscribes from the project_switched event listener. */
  ngOnDestroy(): void {
    if (this.unlistenProjectSwitch) {
      this.unlistenProjectSwitch();
      this.unlistenProjectSwitch = null;
    }
  }

  /** Handles factory reset completion by navigating to setup. */
  onResetCompleted(): void {
    this.router.navigate(['/setup'], { replaceUrl: true });
  }

  private async loadProjectInfo(): Promise<void> {
    try {
      const result = await this.tauri.invoke<ProjectList>('list_projects');
      this.activeProject = result.active_project;
      const entry = result.projects.find((p) => p.name === result.active_project);
      this.projectDir = entry?.dir ?? '';
    } catch {
      // Not running inside Tauri
    }
    this.cdr.markForCheck();
  }

  private async loadLlmConfig(): Promise<void> {
    try {
      const config = await this.tauri.invoke<LlmConfigResponse>('get_llm_config');
      this.llmProvider = config.provider || 'anthropic';
      this.llmModel = config.model || '';
      this.llmBaseUrl = config.base_url || '';
      this.llmApiKeyEnv = config.api_key_env || '';
    } catch {
      // Not running inside Tauri or no config yet
    }
    this.cdr.markForCheck();
  }

  /** Returns a placeholder model name based on the selected LLM provider. */
  modelPlaceholder(): string {
    switch (this.llmProvider) {
      case 'ollama':
        return 'llama3.3';
      case 'external':
        return 'gpt-4o';
      default:
        return 'claude-sonnet-4-6';
    }
  }

  /** Persists the LLM provider configuration to the backend. */
  async saveLlmConfig(): Promise<void> {
    this.llmSaving = true;
    this.llmSaved = false;
    this.error = '';
    try {
      await this.tauri.invoke('update_llm_config', {
        provider: this.llmProvider,
        model: this.llmModel || null,
        baseUrl: this.llmBaseUrl || null,
        apiKeyEnv: this.llmApiKeyEnv || null,
      });
      this.llmSaved = true;
      setTimeout(() => {
        this.llmSaved = false;
        this.cdr.markForCheck();
      }, 2000);
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.llmSaving = false;
    this.cdr.markForCheck();
  }

  /** Rebuilds images and recreates containers for the active project. */
  async updateContainers(): Promise<void> {
    if (!this.activeProject) return;
    this.containerUpdating = true;
    this.containerUpdateResult = null;
    this.error = '';
    this.cdr.markForCheck();
    try {
      const result = await this.tauri.invoke<ContainerUpdateResult>('update_containers', {
        project: this.activeProject,
      });
      this.containerUpdateResult = result;
      this.containerUpdateDone = result.success;
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.containerUpdating = false;
    this.cdr.markForCheck();
  }

  /** Rolls back containers to the pre-update snapshot. */
  async rollbackContainers(): Promise<void> {
    if (!this.activeProject) return;
    this.containerUpdating = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('rollback_containers', { project: this.activeProject });
      this.containerUpdateResult = null;
      this.containerUpdateDone = false;
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.containerUpdating = false;
    this.cdr.markForCheck();
  }

  private async loadLogLevel(): Promise<void> {
    try {
      const level = await this.tauri.invoke<string>('get_log_level');
      this.logLevel = level.toLowerCase();
    } catch {
      // Not running inside Tauri
    }
    this.cdr.markForCheck();
  }
}
