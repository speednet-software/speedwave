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
    <section class="section">
      <h2>LLM Provider</h2>
      <div class="info-card">
        <div class="form-row">
          <label class="form-label" for="llm-provider">Provider</label>
          <select
            id="llm-provider"
            [(ngModel)]="provider"
            (ngModelChange)="onProviderChange()"
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
            [(ngModel)]="model"
            [placeholder]="modelPlaceholder()"
            class="form-input"
            data-testid="settings-llm-model"
          />
        </div>
        @if (provider === 'ollama' || provider === 'external') {
          <div class="form-row">
            <label class="form-label" for="llm-base-url">Base URL</label>
            <input
              id="llm-base-url"
              type="text"
              [(ngModel)]="baseUrl"
              placeholder="http://host.docker.internal:11434"
              class="form-input"
              data-testid="settings-llm-base-url"
            />
          </div>
        }
        @if (provider === 'external') {
          <div class="form-row">
            <label class="form-label" for="llm-api-key-env">API Key env var</label>
            <input
              id="llm-api-key-env"
              type="text"
              [(ngModel)]="apiKeyEnv"
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
            (click)="saveConfig()"
            [disabled]="saving"
          >
            {{ saving ? 'Saving...' : 'Save' }}
          </button>
          @if (saved) {
            <span class="save-feedback" data-testid="settings-llm-saved">Saved!</span>
          }
        </div>
        <p class="note">Changes take effect on next container restart.</p>
      </div>
    </section>
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
    `,
  ],
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
