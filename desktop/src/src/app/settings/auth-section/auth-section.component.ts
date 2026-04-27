import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService, AuthStatusResponse } from '../../services/project-state.service';
import { AuthTerminalComponent } from '../auth-terminal.component';

/** Displays authentication status and controls for API key / OAuth login. */
@Component({
  selector: 'app-auth-section',
  imports: [CommonModule, FormsModule, AuthTerminalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (llmProvider() === 'anthropic') {
      <section id="section-authentication" class="border-t border-[var(--line)] pt-6">
        <h2 class="view-title text-[16px] text-[var(--ink)]">Authentication</h2>

        <div class="mt-3 flex items-center justify-between">
          <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            >status</span
          >
          <span
            class="mono text-[11px]"
            data-testid="auth-status-value"
            [class]="
              apiKeyConfigured || oauthAuthenticated
                ? 'text-[var(--green)]'
                : 'text-[var(--ink-dim)]'
            "
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

        <div class="mt-3">
          <label
            class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="auth-method"
            >method</label
          >
          <select
            id="auth-method"
            [(ngModel)]="authMethod"
            class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
            data-testid="settings-auth-method"
          >
            <option value="api_key">api key</option>
            <option value="oauth">oauth (claude.ai)</option>
          </select>
        </div>

        @if (authMethod === 'api_key') {
          <div class="mt-3">
            <label
              class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
              for="api-key-input"
              >anthropic_api_key</label
            >
            <input
              id="api-key-input"
              type="password"
              [(ngModel)]="apiKeyInput"
              placeholder="sk-ant-..."
              class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
              data-testid="settings-api-key"
            />
            <p class="mono mt-1 text-[10px] text-[var(--ink-mute)]">
              stored in keychain &middot; never logged
            </p>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="mono rounded bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="settings-api-key-save"
              (click)="saveApiKey()"
              [disabled]="apiKeySaving || !apiKeyInput"
            >
              {{ apiKeySaving ? 'saving...' : 'save key' }}
            </button>
            <button
              type="button"
              class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="settings-api-key-remove"
              (click)="deleteApiKey()"
              [disabled]="!apiKeyConfigured"
            >
              remove key
            </button>
            @if (apiKeySaved) {
              <span class="mono text-[11px] text-[var(--green)]">saved!</span>
            }
          </div>
          <p class="mono mt-2 text-[10px] text-[var(--ink-mute)]" data-testid="auth-note">
            Restart containers after saving for changes to take effect.
          </p>
        }
        @if (authMethod === 'oauth' && activeProject(); as project) {
          <app-auth-terminal [project]="project" (done)="onOAuthDone($event)" />
        }
      </section>
    }
    @if (isLocalProvider()) {
      <section id="section-authentication" class="border-t border-[var(--line)] pt-6">
        <h2 class="view-title text-[16px] text-[var(--ink)]">Authentication</h2>
        <p class="mono mt-3 text-[11px] text-[var(--ink-mute)]" data-testid="auth-note">
          No authentication needed for local model providers.
        </p>
      </section>
    }
  `,
})
export class AuthSectionComponent {
  readonly activeProject = input<string | null>(null);
  readonly llmProvider = input('anthropic');

  readonly errorOccurred = output<string>();

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
   * Reloads auth status whenever the active project input changes.
   */
  constructor() {
    // Reload auth status when the active project changes.
    effect(() => {
      if (this.activeProject()) {
        this.loadAuthStatus();
      }
    });
  }

  /** Returns true if the selected provider is a local model (no Anthropic auth needed). */
  isLocalProvider(): boolean {
    return ['ollama', 'lmstudio', 'llamacpp', 'custom'].includes(this.llmProvider());
  }

  /** Loads the current authentication status from the backend. */
  async loadAuthStatus(): Promise<void> {
    const project = this.activeProject();
    if (!project) return;
    try {
      const status = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', {
        project,
      });
      this.apiKeyConfigured = status.api_key_configured;
      this.oauthAuthenticated = status.oauth_authenticated;
      this.projectState.applyAuthStatus(status);
    } catch {
      // Auth status check failed -- container may not be running
    }
    this.cdr.markForCheck();
  }

  /** Saves the Anthropic API key to the project's secrets directory. */
  async saveApiKey(): Promise<void> {
    const project = this.activeProject();
    if (!project || !this.apiKeyInput) return;
    this.apiKeySaving = true;
    this.apiKeySaved = false;
    this.errorOccurred.emit('');
    try {
      await this.tauri.invoke('save_api_key', {
        project,
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
    const project = this.activeProject();
    if (!project) return;
    this.errorOccurred.emit('');
    try {
      await this.tauri.invoke('delete_api_key', { project });
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
