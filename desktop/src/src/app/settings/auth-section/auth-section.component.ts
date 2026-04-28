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
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService, AuthStatusResponse } from '../../services/project-state.service';
import { AuthTerminalComponent } from '../auth-terminal.component';

/** Displays authentication status and controls for API key / OAuth login. */
@Component({
  selector: 'app-auth-section',
  imports: [CommonModule, AuthTerminalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (llmProvider() === 'anthropic') {
      <section id="section-authentication" class="border-t border-[var(--line)] pt-6">
        <h2 class="view-title text-[16px] text-[var(--ink)]">Authentication</h2>

        <!-- Pill replaces the "status" label entirely (mockup-aligned with the
             integrations table convention): green for authenticated states,
             amber when action is needed. -->
        <div class="mt-3 flex items-center">
          @if (apiKeyConfigured) {
            <span class="pill green" data-testid="auth-status-value">api key</span>
          } @else if (oauthAuthenticated) {
            <span class="pill green" data-testid="auth-status-value">oauth</span>
          } @else {
            <span class="pill amber" data-testid="auth-status-value">not configured</span>
          }
        </div>

        <div
          class="mt-3 flex overflow-hidden rounded border border-[var(--line)]"
          role="radiogroup"
          aria-label="Authentication method"
        >
          <button
            type="button"
            role="radio"
            [attr.aria-checked]="authMethod === 'api_key'"
            class="mono flex-1 border-r border-[var(--line)] px-3 py-2 text-[11px] transition-colors"
            [class]="
              authMethod === 'api_key'
                ? 'bg-[var(--bg-2)] text-[var(--ink)]'
                : 'text-[var(--ink-mute)] hover:text-[var(--ink)]'
            "
            data-testid="settings-auth-method-api-key"
            (click)="authMethod = 'api_key'"
          >
            api key
          </button>
          <button
            type="button"
            role="radio"
            [attr.aria-checked]="authMethod === 'oauth'"
            class="mono flex-1 px-3 py-2 text-[11px] transition-colors"
            [class]="
              authMethod === 'oauth'
                ? 'bg-[var(--bg-2)] text-[var(--ink)]'
                : 'text-[var(--ink-mute)] hover:text-[var(--ink)]'
            "
            data-testid="settings-auth-method-oauth"
            (click)="authMethod = 'oauth'"
          >
            oauth (claude.ai)
          </button>
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
              [value]="apiKeyInput"
              (input)="apiKeyInput = $any($event.target).value"
              placeholder="sk-ant-..."
              class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
              data-testid="settings-api-key"
            />
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
