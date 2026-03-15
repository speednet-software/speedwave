import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TauriService } from '../../services/tauri.service';
import { AuthTerminalComponent } from '../auth-terminal.component';

interface AuthStatusResponse {
  api_key_configured: boolean;
  oauth_authenticated: boolean;
}

/** Displays authentication status and controls for API key / OAuth login. */
@Component({
  selector: 'app-auth-section',
  standalone: true,
  imports: [CommonModule, FormsModule, AuthTerminalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
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
          @if (authMethod === 'oauth' && activeProject) {
            <app-auth-terminal [project]="activeProject" (done)="onOAuthDone($event)" />
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
  `,
  styles: [
    `
      .section {
        margin-bottom: 24px;
      }
      h2 {
        font-size: 15px;
        color: #e0e0e0;
        margin: 0 0 12px 0;
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
      .status-ok {
        color: #4caf50;
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
      .save-feedback {
        color: #4caf50;
        font-size: 13px;
      }
      .note {
        font-size: 11px;
        color: #666;
        margin: 8px 0 0 0;
      }
    `,
  ],
})
export class AuthSectionComponent implements OnChanges {
  @Input() activeProject: string | null = null;
  @Input() llmProvider = 'anthropic';

  @Output() errorOccurred = new EventEmitter<string>();

  authMethod = 'api_key';
  apiKeyInput = '';
  apiKeySaving = false;
  apiKeySaved = false;
  apiKeyConfigured = false;
  oauthAuthenticated = false;

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);

  /**
   * Reloads auth status when the active project changes.
   * @param changes - the changed input properties
   */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['activeProject'] && this.activeProject) {
      this.loadAuthStatus();
    }
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
      // Auth status check failed -- container may not be running
    }
    this.cdr.markForCheck();
  }

  /** Saves the Anthropic API key to the project's secrets directory. */
  async saveApiKey(): Promise<void> {
    if (!this.activeProject || !this.apiKeyInput) return;
    this.apiKeySaving = true;
    this.apiKeySaved = false;
    this.errorOccurred.emit('');
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
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.apiKeySaving = false;
    this.cdr.markForCheck();
  }

  /** Removes the stored API key for the active project. */
  async deleteApiKey(): Promise<void> {
    if (!this.activeProject) return;
    this.errorOccurred.emit('');
    try {
      await this.tauri.invoke('delete_api_key', { project: this.activeProject });
      await this.loadAuthStatus();
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
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
}
