import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TauriService } from '../services/tauri.service';
import { AuthTerminalComponent } from './auth-terminal.component';
import { SystemHealthComponent } from './system-health.component';
import { UpdateInfo, UpdateSettings, ProjectList, ContainerUpdateResult } from '../models/update';

interface LlmConfigResponse {
  provider: string | null;
  model: string | null;
  base_url: string | null;
  api_key_env: string | null;
}

interface AuthStatusResponse {
  api_key_configured: boolean;
  oauth_authenticated: boolean;
}

/** Displays application settings and provides factory reset functionality. */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, AuthTerminalComponent, SystemHealthComponent],
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

      <!-- LLM Provider -->
      <section class="section">
        <h2>LLM Provider</h2>
        <div class="info-card">
          <div class="form-row">
            <label class="form-label" for="llm-provider">Provider</label>
            <select
              id="llm-provider"
              [(ngModel)]="llmProvider"
              class="form-select"
              data-testid="settings-llm-provider"
            >
              <option value="anthropic">Anthropic (default)</option>
              <option value="ollama">Ollama (local)</option>
              <option value="external">External (LiteLLM proxy)</option>
            </select>
          </div>
          <div class="form-row">
            <label class="form-label" for="llm-model">Model</label>
            <input
              id="llm-model"
              type="text"
              [(ngModel)]="llmModel"
              [placeholder]="modelPlaceholder()"
              class="form-input"
              data-testid="settings-llm-model"
            />
          </div>
          @if (llmProvider === 'ollama' || llmProvider === 'external') {
            <div class="form-row">
              <label class="form-label" for="llm-base-url">Base URL</label>
              <input
                id="llm-base-url"
                type="text"
                [(ngModel)]="llmBaseUrl"
                placeholder="http://host.docker.internal:11434"
                class="form-input"
                data-testid="settings-llm-base-url"
              />
            </div>
          }
          @if (llmProvider === 'external') {
            <div class="form-row">
              <label class="form-label" for="llm-api-key-env">API Key env var</label>
              <input
                id="llm-api-key-env"
                type="text"
                [(ngModel)]="llmApiKeyEnv"
                placeholder="OPENAI_API_KEY"
                class="form-input"
                data-testid="settings-llm-api-key-env"
              />
            </div>
          }
          <div class="form-actions">
            <button
              class="btn-save"
              data-testid="settings-llm-save"
              (click)="saveLlmConfig()"
              [disabled]="llmSaving"
            >
              {{ llmSaving ? 'Saving...' : 'Save' }}
            </button>
            @if (llmSaved) {
              <span class="save-feedback" data-testid="settings-llm-saved">Saved!</span>
            }
          </div>
          <p class="note">Changes take effect on next container restart.</p>
        </div>
      </section>

      <!-- Authentication -->
      @if (llmProvider === 'anthropic') {
        <section class="section">
          <h2>Authentication</h2>
          <div class="info-card">
            <div class="info-row">
              <span class="info-label">Status</span>
              <span class="info-value" [class.status-ok]="apiKeyConfigured || oauthAuthenticated">
                {{
                  apiKeyConfigured
                    ? 'API Key configured'
                    : oauthAuthenticated
                      ? 'OAuth authenticated'
                      : 'Not authenticated'
                }}
              </span>
            </div>
            <div class="form-row">
              <label class="form-label" for="auth-method">Method</label>
              <select
                id="auth-method"
                [(ngModel)]="authMethod"
                class="form-select"
                data-testid="settings-auth-method"
              >
                <option value="api_key">API Key</option>
                <option value="oauth">Login via claude.ai</option>
              </select>
            </div>
            @if (authMethod === 'api_key') {
              <div class="form-row">
                <label class="form-label" for="api-key-input">API Key</label>
                <input
                  id="api-key-input"
                  type="password"
                  [(ngModel)]="apiKeyInput"
                  placeholder="sk-ant-..."
                  class="form-input"
                  data-testid="settings-api-key"
                />
              </div>
              <div class="form-actions">
                <button
                  class="btn-save"
                  data-testid="settings-api-key-save"
                  (click)="saveApiKey()"
                  [disabled]="apiKeySaving || !apiKeyInput"
                >
                  {{ apiKeySaving ? 'Saving...' : 'Save Key' }}
                </button>
                <button
                  class="btn-cancel"
                  data-testid="settings-api-key-remove"
                  (click)="deleteApiKey()"
                  [disabled]="!apiKeyConfigured"
                >
                  Remove Key
                </button>
                @if (apiKeySaved) {
                  <span class="save-feedback">Saved!</span>
                }
              </div>
              <p class="note">Restart containers after saving for changes to take effect.</p>
            }
            @if (authMethod === 'oauth') {
              <app-auth-terminal [project]="activeProject!" (done)="onOAuthDone($event)" />
            }
          </div>
        </section>
      }
      @if (llmProvider === 'ollama') {
        <section class="section">
          <h2>Authentication</h2>
          <div class="info-card">
            <p class="note">No authentication needed for Ollama.</p>
          </div>
        </section>
      }
      @if (llmProvider === 'external') {
        <section class="section">
          <h2>Authentication</h2>
          <div class="info-card">
            <p class="note">Uses API key env var from LLM Provider settings above.</p>
          </div>
        </section>
      }

      <!-- Updates -->
      <section class="section">
        <h2>Updates</h2>
        <div class="info-card">
          <div class="info-row">
            <span class="info-label">Current version</span>
            <span class="info-value mono">{{ currentVersion || '—' }}</span>
          </div>
          <div class="form-row">
            <span class="form-label">Auto-check</span>
            <label class="toggle" for="update-auto-check">
              <input
                id="update-auto-check"
                type="checkbox"
                [checked]="updateAutoCheck"
                (change)="toggleAutoCheck()"
              />
              <span class="toggle-label">{{ updateAutoCheck ? 'On' : 'Off' }}</span>
            </label>
          </div>
          @if (updateAutoCheck) {
            <div class="form-row">
              <label class="form-label" for="check-frequency">Frequency</label>
              <select
                id="check-frequency"
                [ngModel]="updateIntervalHours"
                (ngModelChange)="setCheckInterval($event)"
                class="form-select"
              >
                <option [ngValue]="12">Every 12 hours</option>
                <option [ngValue]="24">Every 24 hours</option>
                <option [ngValue]="168">Weekly</option>
              </select>
            </div>
          }
          <div class="form-actions">
            <button
              class="btn-save"
              data-testid="settings-check-update"
              (click)="checkForUpdate()"
              [disabled]="updateChecking || updateInstalling"
            >
              {{ updateChecking ? 'Checking...' : 'Check now' }}
            </button>
            @if (updateResult === 'up-to-date') {
              <span class="save-feedback">Up to date</span>
            }
            @if (updateResult === 'available') {
              <span class="update-available">v{{ updateAvailableVersion }} available</span>
              @if (isLinux) {
                <button
                  class="btn-restart"
                  data-testid="settings-download-update"
                  (click)="openReleasesPage()"
                >
                  Download v{{ updateAvailableVersion }}
                </button>
              } @else {
                <button
                  class="btn-restart"
                  data-testid="settings-install-update"
                  (click)="installUpdate()"
                  [disabled]="updateInstalling"
                >
                  {{ updateInstalling ? 'Installing...' : 'Install & Restart' }}
                </button>
              }
            }
          </div>
          @if (updateInstallError) {
            <p class="error-banner" style="margin-top: 8px">{{ updateInstallError }}</p>
          }
        </div>
      </section>

      <!-- Container Updates -->
      <section class="section">
        <h2>Container Updates</h2>
        <div class="info-card">
          <p class="note" style="margin-top: 0">
            Rebuild container images and recreate containers. User data on host volumes is
            preserved.
          </p>
          <div class="form-actions">
            <button
              class="btn-save"
              data-testid="settings-update-containers"
              (click)="updateContainers()"
              [disabled]="containerUpdating || !activeProject"
            >
              {{ containerUpdating ? 'Updating...' : 'Update containers' }}
            </button>
            <button
              class="btn-cancel"
              data-testid="settings-rollback"
              (click)="rollbackContainers()"
              [disabled]="containerUpdating || !containerUpdateDone || !activeProject"
            >
              Rollback
            </button>
          </div>
          @if (containerUpdateResult) {
            @if (containerUpdateResult.success) {
              <p class="save-feedback" style="margin-top: 8px">
                Updated {{ containerUpdateResult.containers_recreated }} containers ({{
                  containerUpdateResult.images_rebuilt
                }}
                images rebuilt)
              </p>
            } @else {
              <p class="error-banner" style="margin-top: 8px">
                {{ containerUpdateResult.error }}
              </p>
            }
          }
        </div>
      </section>

      <!-- Logging -->
      <section class="section">
        <h2>Logging</h2>
        <div class="info-card">
          <div class="form-row">
            <label class="form-label" for="log-level">Log level</label>
            <select
              id="log-level"
              [ngModel]="logLevel"
              (ngModelChange)="setLogLevel($event)"
              class="form-select"
              data-testid="settings-log-level"
            >
              <option value="error">Error</option>
              <option value="warn">Warn</option>
              <option value="info">Info (default)</option>
              <option value="debug">Debug</option>
              <option value="trace">Trace</option>
            </select>
          </div>
          <p class="note">
            Higher levels (Debug, Trace) produce more output. Verbose library logs (hyper, reqwest)
            are always clamped to Warn.
          </p>
          <div class="form-actions">
            <button
              class="btn-save"
              data-testid="settings-export-diagnostics"
              (click)="exportDiagnostics()"
              [disabled]="diagnosticsExporting || !activeProject"
            >
              {{ diagnosticsExporting ? 'Exporting...' : 'Export Diagnostics' }}
            </button>
            @if (diagnosticsPath) {
              <span class="save-feedback">{{ diagnosticsPath }}</span>
            }
          </div>
          <p class="note">
            Collects app logs, container logs, and system info into a sanitized ZIP (no tokens or
            secrets).
          </p>
        </div>
      </section>

      <!-- System Health -->
      <section class="section">
        <h2>System Health</h2>
        <app-system-health [project]="activeProject" />
      </section>

      <!-- Danger zone -->
      <section class="section danger-zone">
        <h2>Danger Zone</h2>
        <div class="danger-card">
          <div class="danger-info">
            <h3>Factory Reset</h3>
            <p>
              Stops all containers, destroys the VM (macOS), and resets setup state. Tokens in
              ~/.speedwave/tokens/ are preserved. After reset the Setup Wizard will run again.
            </p>
          </div>
          <div class="danger-actions">
            @if (!confirmReset) {
              <button
                class="btn-danger"
                data-testid="settings-reset-btn"
                (click)="confirmReset = true"
                [disabled]="resetting"
              >
                Reset
              </button>
            } @else {
              <div class="confirm-actions">
                <button
                  class="btn-danger"
                  data-testid="settings-confirm-reset"
                  (click)="resetEnvironment()"
                  [disabled]="resetting"
                >
                  {{ resetting ? 'Resetting...' : 'Confirm Reset' }}
                </button>
                <button
                  class="btn-cancel"
                  data-testid="settings-cancel-reset"
                  (click)="confirmReset = false"
                  [disabled]="resetting"
                >
                  Cancel
                </button>
              </div>
            }
          </div>
        </div>
      </section>
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
      .danger-zone h2 {
        color: #e94560;
      }
      .danger-card {
        background: #16213e;
        border: 1px solid #e94560;
        border-radius: 8px;
        padding: 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
      }
      .danger-info {
        flex: 1;
      }
      .danger-info h3 {
        font-size: 14px;
        color: #e0e0e0;
        margin: 0 0 4px 0;
      }
      .danger-info p {
        font-size: 12px;
        color: #888;
        margin: 0;
        line-height: 1.5;
      }
      .danger-actions {
        flex-shrink: 0;
      }
      .confirm-actions {
        display: flex;
        gap: 8px;
      }
      .btn-danger {
        padding: 6px 16px;
        background: transparent;
        color: #e94560;
        border: 1px solid #e94560;
        border-radius: 4px;
        font-size: 13px;
        font-family: monospace;
        cursor: pointer;
        transition: all 0.2s;
        white-space: nowrap;
      }
      .btn-danger:hover:not(:disabled) {
        background: #e94560;
        color: #1a1a2e;
      }
      .btn-danger:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .btn-cancel {
        padding: 6px 16px;
        background: transparent;
        color: #888;
        border: 1px solid #555;
        border-radius: 4px;
        font-size: 13px;
        font-family: monospace;
        cursor: pointer;
        transition: all 0.2s;
      }
      .btn-cancel:hover:not(:disabled) {
        color: #e0e0e0;
        border-color: #888;
      }
      .btn-cancel:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .form-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
      }
      .form-row + .form-row {
        border-top: 1px solid #0f3460;
      }
      .form-label {
        font-size: 13px;
        color: #888;
        min-width: 120px;
      }
      .form-select,
      .form-input {
        flex: 1;
        max-width: 340px;
        padding: 6px 10px;
        background: #1a1a2e;
        border: 1px solid #0f3460;
        border-radius: 4px;
        color: #e0e0e0;
        font-size: 13px;
        font-family: monospace;
      }
      .form-select:focus,
      .form-input:focus {
        outline: none;
        border-color: #e94560;
      }
      .form-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 0 4px 0;
      }
      .btn-save {
        padding: 6px 20px;
        background: transparent;
        color: #e94560;
        border: 1px solid #e94560;
        border-radius: 4px;
        font-size: 13px;
        font-family: monospace;
        cursor: pointer;
        transition: all 0.2s;
      }
      .btn-save:hover:not(:disabled) {
        background: #e94560;
        color: #1a1a2e;
      }
      .btn-save:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .save-feedback {
        color: #4caf50;
        font-size: 13px;
      }
      .note {
        font-size: 11px;
        color: #666;
        margin: 8px 0 0 0;
      }
      .status-ok {
        color: #4caf50;
      }
      .toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }
      .toggle input[type='checkbox'] {
        accent-color: #e94560;
        width: 16px;
        height: 16px;
        cursor: pointer;
      }
      .toggle-label {
        font-size: 13px;
        color: #e0e0e0;
        font-family: monospace;
      }
      .update-available {
        color: #e94560;
        font-size: 13px;
        font-weight: bold;
      }
      .btn-restart {
        padding: 6px 16px;
        background: #e94560;
        color: #1a1a2e;
        border: none;
        border-radius: 4px;
        font-size: 13px;
        font-family: monospace;
        cursor: pointer;
        transition: opacity 0.2s;
      }
      .btn-restart:hover:not(:disabled) {
        opacity: 0.85;
      }
      .btn-restart:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    `,
  ],
})
export class SettingsComponent implements OnInit {
  activeProject: string | null = null;
  projectDir = '';
  error = '';
  confirmReset = false;
  resetting = false;
  llmProvider = 'anthropic';
  llmModel = '';
  llmBaseUrl = '';
  llmApiKeyEnv = '';
  llmSaving = false;
  llmSaved = false;
  authMethod = 'api_key';
  apiKeyInput = '';
  apiKeySaving = false;
  apiKeySaved = false;
  apiKeyConfigured = false;
  oauthAuthenticated = false;
  currentVersion = '';
  updateAutoCheck = true;
  updateIntervalHours = 24;
  updateChecking = false;
  updateResult: 'none' | 'up-to-date' | 'available' = 'none';
  updateAvailableVersion = '';
  updateInstalling = false;
  isLinux = false;
  updateInstallError = '';
  containerUpdating = false;
  containerUpdateDone = false;
  containerUpdateResult: ContainerUpdateResult | null = null;
  logLevel = 'info';
  diagnosticsExporting = false;
  diagnosticsPath = '';

  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);

  /** Loads project information on component initialization. */
  ngOnInit(): void {
    this.loadProjectInfo();
    this.loadLlmConfig();
    this.loadCurrentVersion();
    this.loadUpdateSettings();
    this.loadLogLevel();
    this.detectPlatform();
  }

  private async loadProjectInfo(): Promise<void> {
    try {
      const result = await this.tauri.invoke<ProjectList>('list_projects');
      this.activeProject = result.active_project;
      const entry = result.projects.find((p) => p.name === result.active_project);
      this.projectDir = entry?.dir ?? '';
      if (this.activeProject) {
        this.loadAuthStatus();
      }
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

  /** Loads the current authentication status from the backend. */
  async loadAuthStatus(): Promise<void> {
    if (!this.activeProject) return;
    try {
      const status = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', {
        project: this.activeProject,
      });
      this.apiKeyConfigured = status.api_key_configured;
      this.oauthAuthenticated = status.oauth_authenticated;
    } catch {
      // Auth status check failed — container may not be running
    }
    this.cdr.markForCheck();
  }

  /** Saves the Anthropic API key to the project's secrets directory. */
  async saveApiKey(): Promise<void> {
    if (!this.activeProject || !this.apiKeyInput) return;
    this.apiKeySaving = true;
    this.apiKeySaved = false;
    this.error = '';
    try {
      await this.tauri.invoke('save_api_key', {
        project: this.activeProject,
        apiKey: this.apiKeyInput,
      });
      this.apiKeySaved = true;
      this.apiKeyInput = '';
      await this.loadAuthStatus();
      setTimeout(() => {
        this.apiKeySaved = false;
        this.cdr.markForCheck();
      }, 2000);
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.apiKeySaving = false;
    this.cdr.markForCheck();
  }

  /** Removes the stored API key for the active project. */
  async deleteApiKey(): Promise<void> {
    if (!this.activeProject) return;
    this.error = '';
    try {
      await this.tauri.invoke('delete_api_key', { project: this.activeProject });
      await this.loadAuthStatus();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  /**
   * Handles the completion of the OAuth terminal session.
   * @param _success - whether the auth was successful
   */
  async onOAuthDone(_success: boolean): Promise<void> {
    this.authMethod = 'api_key';
    await this.loadAuthStatus();
    this.cdr.markForCheck();
  }

  private async loadCurrentVersion(): Promise<void> {
    try {
      this.currentVersion = await this.tauri.getVersion();
    } catch {
      // Not running inside Tauri
    }
    this.cdr.markForCheck();
  }

  private async loadUpdateSettings(): Promise<void> {
    try {
      const settings = await this.tauri.invoke<UpdateSettings>('get_update_settings');
      this.updateAutoCheck = settings.auto_check;
      this.updateIntervalHours = settings.check_interval_hours;
    } catch {
      // Not running inside Tauri
    }
    this.cdr.markForCheck();
  }

  private async saveUpdateSettings(): Promise<void> {
    try {
      await this.tauri.invoke('set_update_settings', {
        settings: {
          auto_check: this.updateAutoCheck,
          check_interval_hours: this.updateIntervalHours,
        },
      });
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      this.cdr.markForCheck();
    }
  }

  /** Toggles the auto-check setting and persists it. */
  async toggleAutoCheck(): Promise<void> {
    this.updateAutoCheck = !this.updateAutoCheck;
    await this.saveUpdateSettings();
  }

  /**
   * Updates the check interval and persists it.
   * @param hours - The interval in hours between automatic update checks.
   */
  async setCheckInterval(hours: number): Promise<void> {
    this.updateIntervalHours = hours;
    await this.saveUpdateSettings();
  }

  /** Manually checks for available updates. */
  async checkForUpdate(): Promise<void> {
    this.updateChecking = true;
    this.updateResult = 'none';
    this.error = '';
    this.cdr.markForCheck();
    try {
      const info = await this.tauri.invoke<UpdateInfo | null>('check_for_update');
      if (info) {
        this.updateResult = 'available';
        this.updateAvailableVersion = info.version;
      } else {
        this.updateResult = 'up-to-date';
        setTimeout(() => {
          this.updateResult = 'none';
          this.cdr.markForCheck();
        }, 3000);
      }
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.updateChecking = false;
    this.cdr.markForCheck();
  }

  /** Downloads and installs the available update, then restarts the app. */
  async installUpdate(): Promise<void> {
    if (!this.updateAvailableVersion) return;
    this.updateInstalling = true;
    this.updateInstallError = '';
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('install_update', { expectedVersion: this.updateAvailableVersion });
      await this.tauri.invoke('restart_app', { force: true });
    } catch (e: unknown) {
      this.updateInstallError = e instanceof Error ? e.message : String(e);
    }
    this.updateInstalling = false;
    this.cdr.markForCheck();
  }

  /** Detects the current platform for platform-specific UI. */
  private async detectPlatform(): Promise<void> {
    try {
      const platform = await this.tauri.invoke<string>('get_platform');
      this.isLinux = platform === 'linux';
      this.cdr.markForCheck();
    } catch {
      // Not running inside Tauri
    }
  }

  /** Opens the GitHub Releases page for manual download (Linux .deb). */
  async openReleasesPage(): Promise<void> {
    try {
      await this.tauri.invoke('open_url', {
        url: 'https://github.com/speednet-software/speedwave/releases',
      });
    } catch {
      // Fallback: not running inside Tauri
    }
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

  /**
   * Changes the runtime log level and persists it to config.
   * @param level - The desired log level (error, warn, info, debug, trace).
   */
  async setLogLevel(level: string): Promise<void> {
    this.logLevel = level;
    this.error = '';
    try {
      await this.tauri.invoke('set_log_level', { level });
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cdr.markForCheck();
  }

  /** Exports diagnostic data as a sanitized ZIP archive. */
  async exportDiagnostics(): Promise<void> {
    if (!this.activeProject) return;
    this.diagnosticsExporting = true;
    this.diagnosticsPath = '';
    this.error = '';
    this.cdr.markForCheck();
    try {
      const path = await this.tauri.invoke<string>('export_diagnostics', {
        project: this.activeProject,
      });
      this.diagnosticsPath = path;
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.diagnosticsExporting = false;
    this.cdr.markForCheck();
  }

  /** Performs a factory reset, destroying containers and VM, then navigates to setup. */
  async resetEnvironment(): Promise<void> {
    this.resetting = true;
    this.error = '';
    try {
      await this.tauri.invoke('factory_reset');
      this.router.navigate(['/setup'], { replaceUrl: true });
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.resetting = false;
    this.confirmReset = false;
    this.cdr.markForCheck();
  }
}
