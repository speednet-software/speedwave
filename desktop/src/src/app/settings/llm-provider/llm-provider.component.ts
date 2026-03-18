import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  OnInit,
  Output,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TauriService } from '../../services/tauri.service';

interface LlmConfigResponse {
  provider: string | null;
  model: string | null;
  base_url: string | null;
  api_key_env: string | null;
}

/** Manages LLM provider selection and configuration. */
@Component({
  selector: 'app-llm-provider',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mb-6">
      <h2 class="text-[15px] text-sw-text m-0 mb-3">LLM Provider</h2>
      <div class="bg-sw-bg-dark border border-sw-border rounded-lg p-4">
        <div class="flex justify-between items-center py-2">
          <label class="text-[13px] text-sw-text-muted min-w-[120px]" for="llm-provider"
            >Provider</label
          >
          <select
            id="llm-provider"
            [(ngModel)]="provider"
            (ngModelChange)="onProviderChange()"
            class="flex-1 max-w-[340px] px-2.5 py-1.5 bg-sw-bg-abyss border border-sw-border rounded text-sw-text text-[13px] font-mono outline-none focus:border-sw-accent"
            data-testid="settings-llm-provider"
          >
            <option value="anthropic">Anthropic (default)</option>
            <option value="ollama">Ollama (local)</option>
            <option value="external">External (LiteLLM proxy)</option>
          </select>
        </div>
        <div class="flex justify-between items-center py-2 border-t border-sw-border">
          <label class="text-[13px] text-sw-text-muted min-w-[120px]" for="llm-model">Model</label>
          <input
            id="llm-model"
            type="text"
            [(ngModel)]="model"
            [placeholder]="modelPlaceholder()"
            class="flex-1 max-w-[340px] px-2.5 py-1.5 bg-sw-bg-abyss border border-sw-border rounded text-sw-text text-[13px] font-mono outline-none focus:border-sw-accent"
            data-testid="settings-llm-model"
          />
        </div>
        @if (provider === 'ollama' || provider === 'external') {
          <div class="flex justify-between items-center py-2 border-t border-sw-border">
            <label class="text-[13px] text-sw-text-muted min-w-[120px]" for="llm-base-url"
              >Base URL</label
            >
            <input
              id="llm-base-url"
              type="text"
              [(ngModel)]="baseUrl"
              placeholder="http://host.docker.internal:11434"
              class="flex-1 max-w-[340px] px-2.5 py-1.5 bg-sw-bg-abyss border border-sw-border rounded text-sw-text text-[13px] font-mono outline-none focus:border-sw-accent"
              data-testid="settings-llm-base-url"
            />
          </div>
        }
        @if (provider === 'external') {
          <div class="flex justify-between items-center py-2 border-t border-sw-border">
            <label class="text-[13px] text-sw-text-muted min-w-[120px]" for="llm-api-key-env"
              >API Key env var</label
            >
            <input
              id="llm-api-key-env"
              type="text"
              [(ngModel)]="apiKeyEnv"
              placeholder="OPENAI_API_KEY"
              class="flex-1 max-w-[340px] px-2.5 py-1.5 bg-sw-bg-abyss border border-sw-border rounded text-sw-text text-[13px] font-mono outline-none focus:border-sw-accent"
              data-testid="settings-llm-api-key-env"
            />
          </div>
        }
        <div class="flex items-center gap-3 pt-3 pb-1">
          <button
            class="px-5 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:enabled:bg-sw-accent hover:enabled:text-sw-bg-abyss disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="settings-llm-save"
            (click)="saveConfig()"
            [disabled]="saving"
          >
            {{ saving ? 'Saving...' : 'Save' }}
          </button>
          @if (saved) {
            <span class="text-sw-success text-[13px]" data-testid="settings-llm-saved">Saved!</span>
          }
        </div>
        <p class="text-[11px] text-sw-text-faint mt-2 mb-0">
          Changes take effect on next container restart.
        </p>
      </div>
    </section>
  `,
})
export class LlmProviderComponent implements OnInit {
  provider = 'anthropic';
  model = '';
  baseUrl = '';
  apiKeyEnv = '';
  saving = false;
  saved = false;

  @Output() providerChange = new EventEmitter<string>();
  @Output() errorOccurred = new EventEmitter<string>();

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);

  /** Loads the LLM configuration from the backend on init. */
  ngOnInit(): void {
    this.loadConfig();
  }

  /** Returns a placeholder model name based on the selected LLM provider. */
  modelPlaceholder(): string {
    switch (this.provider) {
      case 'ollama':
        return 'llama3.3';
      case 'external':
        return 'gpt-4o';
      default:
        return 'claude-sonnet-4-6';
    }
  }

  /** Notifies parent when the provider selection changes. */
  onProviderChange(): void {
    this.providerChange.emit(this.provider);
  }

  /** Persists the LLM provider configuration to the backend. */
  async saveConfig(): Promise<void> {
    this.saving = true;
    this.saved = false;
    try {
      await this.tauri.invoke('update_llm_config', {
        provider: this.provider,
        model: this.model || null,
        baseUrl: this.baseUrl || null,
        apiKeyEnv: this.apiKeyEnv || null,
      });
      this.saved = true;
      this.providerChange.emit(this.provider);
      setTimeout(() => {
        this.saved = false;
        this.cdr.markForCheck();
      }, 2000);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.saving = false;
    this.cdr.markForCheck();
  }

  private async loadConfig(): Promise<void> {
    try {
      const config = await this.tauri.invoke<LlmConfigResponse>('get_llm_config');
      this.provider = config.provider || 'anthropic';
      this.model = config.model || '';
      this.baseUrl = config.base_url || '';
      this.apiKeyEnv = config.api_key_env || '';
      this.providerChange.emit(this.provider);
    } catch {
      // Not running inside Tauri or no config yet
    }
    this.cdr.markForCheck();
  }
}
