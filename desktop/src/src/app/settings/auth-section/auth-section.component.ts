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
import { ProjectStateService } from '../../services/project-state.service';
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
      <section class="mb-6">
        <h2 class="text-[15px] text-sw-text m-0 mb-3">Authentication</h2>
        <div class="bg-sw-bg-dark border border-sw-border rounded-lg p-4">
          <div class="flex justify-between items-center py-2">
            <span class="text-[13px] text-sw-text-muted">Status</span>
            <span
              class="text-[13px]"
              data-testid="auth-status-value"
              [class]="apiKeyConfigured || oauthAuthenticated ? 'text-sw-success' : 'text-sw-text'"
            >
              {{
                apiKeyConfigured
                  ? 'API Key configured'
                  : oauthAuthenticated
                    ? 'OAuth authenticated'
                    : 'Not authenticated'
              }}
            </span>
          </div>
          <div class="flex justify-between items-center py-2 border-t border-sw-border">
            <label class="text-[13px] text-sw-text-muted min-w-[120px]" for="auth-method"
              >Method</label
            >
            <select
              id="auth-method"
              [(ngModel)]="authMethod"
              class="flex-1 max-w-[340px] px-2.5 py-1.5 bg-sw-bg-abyss border border-sw-border rounded text-sw-text text-[13px] font-mono outline-none focus:border-sw-accent"
              data-testid="settings-auth-method"
            >
              <option value="api_key">API Key</option>
              <option value="oauth">Login via claude.ai</option>
            </select>
          </div>
          @if (authMethod === 'api_key') {
            <div class="flex justify-between items-center py-2 border-t border-sw-border">
              <label class="text-[13px] text-sw-text-muted min-w-[120px]" for="api-key-input"
                >API Key</label
              >
              <input
                id="api-key-input"
                type="password"
                [(ngModel)]="apiKeyInput"
                placeholder="sk-ant-..."
                class="flex-1 max-w-[340px] px-2.5 py-1.5 bg-sw-bg-abyss border border-sw-border rounded text-sw-text text-[13px] font-mono outline-none focus:border-sw-accent"
                data-testid="settings-api-key"
              />
            </div>
            <div class="flex items-center gap-3 pt-3 pb-1">
              <button
                class="px-5 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:enabled:bg-sw-accent hover:enabled:text-sw-bg-abyss disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="settings-api-key-save"
                (click)="saveApiKey()"
                [disabled]="apiKeySaving || !apiKeyInput"
              >
                {{ apiKeySaving ? 'Saving...' : 'Save Key' }}
              </button>
              <button
                class="px-4 py-1.5 bg-transparent text-sw-text-muted border border-sw-text-faint rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:enabled:text-sw-text hover:enabled:border-sw-text-muted disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="settings-api-key-remove"
                (click)="deleteApiKey()"
                [disabled]="!apiKeyConfigured"
              >
                Remove Key
              </button>
              @if (apiKeySaved) {
                <span class="text-sw-success text-[13px]">Saved!</span>
              }
            </div>
            <p class="text-[11px] text-sw-text-faint mt-2 mb-0" data-testid="auth-note">
              Restart containers after saving for changes to take effect.
            </p>
          }
          @if (authMethod === 'oauth' && activeProject) {
            <app-auth-terminal [project]="activeProject" (done)="onOAuthDone($event)" />
          }
        </div>
      </section>
    }
    @if (llmProvider === 'ollama') {
      <section class="mb-6">
        <h2 class="text-[15px] text-sw-text m-0 mb-3">Authentication</h2>
        <div class="bg-sw-bg-dark border border-sw-border rounded-lg p-4">
          <p class="text-[11px] text-sw-text-faint mt-2 mb-0" data-testid="auth-note">
            No authentication needed for Ollama.
          </p>
        </div>
      </section>
    }
    @if (llmProvider === 'external') {
      <section class="mb-6">
        <h2 class="text-[15px] text-sw-text m-0 mb-3">Authentication</h2>
        <div class="bg-sw-bg-dark border border-sw-border rounded-lg p-4">
          <p class="text-[11px] text-sw-text-faint mt-2 mb-0" data-testid="auth-note">
            Uses API key env var from LLM Provider settings above.
          </p>
        </div>
      </section>
    }
  `,
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
  private projectState = inject(ProjectStateService);

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
      if (!status.api_key_configured && !status.oauth_authenticated) {
        await this.projectState.retryAuth();
      }
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
      await this.projectState.retryAuth();
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
      await this.projectState.retryAuth();
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
    await this.projectState.retryAuth();
    this.cdr.markForCheck();
  }
}
