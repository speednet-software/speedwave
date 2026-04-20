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
import { ProjectStateService } from '../../services/project-state.service';

interface LlmConfigResponse {
  provider: string | null;
  model: string | null;
  base_url: string | null;
  default_base_url: string | null;
}

/**
 * Discovery state for the LLM model listing. Discriminated union makes the
 * allowed transitions explicit and prevents inconsistent combinations of
 * `discovering + discoveryFailed + discoveredModels` booleans.
 *
 * The `id` on `in-flight` matches the component's monotonic counter — arriving
 * responses whose id is not the latest counter value are discarded as stale
 * (handles rapid blur / provider change races).
 */
type DiscoveryState =
  | { kind: 'idle' }
  | { kind: 'in-flight'; url: string; id: number }
  | { kind: 'ready'; url: string; models: string[] }
  | { kind: 'failed'; url: string; reason: 'offline' | 'unsupported' | 'other' };

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
            class="flex-1 px-2.5 py-1.5 bg-sw-bg-abyss border border-sw-border rounded text-sw-text text-[13px] font-mono outline-none focus:border-sw-accent"
            data-testid="settings-llm-provider"
          >
            <option value="anthropic">Anthropic</option>
            <option value="ollama">Ollama</option>
            <option value="lmstudio">LM Studio</option>
            <option value="llamacpp">llama.cpp</option>
          </select>
        </div>
        @if (provider !== 'anthropic') {
          <div class="flex justify-between items-center py-2 border-t border-sw-border">
            <label class="text-[13px] text-sw-text-muted min-w-[120px]" for="llm-base-url"
              >Base URL</label
            >
            <input
              id="llm-base-url"
              type="text"
              [(ngModel)]="baseUrl"
              [placeholder]="defaultBaseUrl || baseUrlPlaceholder()"
              (blur)="discoverModels(false)"
              class="flex-1 px-2.5 py-1.5 bg-sw-bg-abyss border border-sw-border rounded text-sw-text text-[13px] font-mono outline-none focus:border-sw-accent"
              data-testid="settings-llm-base-url"
            />
          </div>
          <div class="flex justify-between items-center py-2 border-t border-sw-border">
            <label class="text-[13px] text-sw-text-muted min-w-[120px]" for="llm-model"
              >Model</label
            >
            <div class="flex flex-1 gap-2">
              @if (discoveryState.kind === 'ready') {
                <select
                  id="llm-model"
                  [(ngModel)]="model"
                  class="flex-1 px-2.5 py-1.5 bg-sw-bg-abyss border border-sw-border rounded text-sw-text text-[13px] font-mono outline-none focus:border-sw-accent"
                  data-testid="settings-llm-model"
                >
                  @if (model && !discoveryState.models.includes(model)) {
                    <option [value]="model">{{ model }}</option>
                  }
                  @for (m of discoveryState.models; track m) {
                    <option [value]="m">{{ m }}</option>
                  }
                </select>
              } @else {
                <input
                  id="llm-model"
                  type="text"
                  [(ngModel)]="model"
                  [placeholder]="modelPlaceholder()"
                  class="flex-1 px-2.5 py-1.5 bg-sw-bg-abyss border border-sw-border rounded text-sw-text text-[13px] font-mono outline-none focus:border-sw-accent"
                  data-testid="settings-llm-model"
                />
              }
              <button
                type="button"
                data-testid="settings-llm-refresh"
                class="px-3 py-1.5 bg-transparent text-sw-text-muted border border-sw-border rounded text-[12px] font-mono cursor-pointer hover:enabled:text-sw-text hover:enabled:border-sw-accent disabled:opacity-40 disabled:cursor-not-allowed"
                [disabled]="discoveryState.kind === 'in-flight'"
                (click)="discoverModels(true)"
                title="Fetch the list of models from the server"
              >
                @if (discoveryState.kind === 'in-flight') {
                  Discovering...
                } @else {
                  Refresh
                }
              </button>
            </div>
          </div>
          @if (discoveryState.kind === 'failed') {
            <div class="flex justify-end pb-1">
              <span class="text-[11px] text-sw-warning" data-testid="settings-llm-discovery-error">
                {{ discoveryFailureMessage() }}
              </span>
            </div>
          }
          @if (discoveryState.kind === 'in-flight') {
            <div class="flex justify-end pb-1">
              <span class="text-[11px] text-sw-text-muted" data-testid="settings-llm-discovering">
                Probing {{ discoveryState.url }}...
              </span>
            </div>
          }
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
      </div>
    </section>
  `,
})
export class LlmProviderComponent implements OnInit {
  provider = 'anthropic';
  model = '';
  baseUrl = '';
  defaultBaseUrl = '';
  saving = false;
  saved = false;

  /** Current state of the model discovery probe. See `DiscoveryState` docstring. */
  discoveryState: DiscoveryState = { kind: 'idle' };

  /**
   * Monotonic counter incremented on every discovery trigger. An arriving
   * response whose `id` is not equal to the counter is a stale response from
   * a superseded trigger and must be discarded.
   */
  private discoveryCounter = 0;

  /**
   * Tracks the provider value from the previous `onProviderChange` call so we
   * can detect actual changes (ngModelChange can fire without a user edit).
   */
  private lastKnownProvider = 'anthropic';

  /**
   * Session cache of the last URL the user had in the Base URL field per
   * provider. Lets us restore their previous entry when they switch back to
   * a provider instead of overwriting it with the hard-coded default
   * (which is often wrong for the user's specific setup — e.g. llama.cpp
   * default is :8080 but many users run it on a different port).
   * Seeded from the persisted config on init for the config's provider.
   */
  private baseUrlByProvider: Record<string, string> = {};

  /**
   * Cache of the backend-authoritative default base URL per provider.
   * Populated on ngOnInit via `get_default_base_url` for each local provider
   * so that `isDefaultBaseUrl` stays synchronous (no await on the hot path).
   * Backend is SSOT for these values (see `speedwave_runtime::compose::default_base_url`).
   */
  private defaultBaseUrlsByProvider: Record<string, string> = {};

  @Output() providerChange = new EventEmitter<string>();
  @Output() errorOccurred = new EventEmitter<string>();

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);

  /** Loads the LLM configuration from the backend on init. */
  ngOnInit(): void {
    this.loadConfig();
  }

  /** Returns a placeholder model name based on the selected LLM provider. */
  modelPlaceholder(): string {
    switch (this.provider) {
      case 'ollama':
        return 'llama3.3';
      case 'lmstudio':
        return 'qwen2.5-coder';
      case 'llamacpp':
        return 'deepseek-r1';
      default:
        return 'claude-sonnet-4-6';
    }
  }

  /** Returns a fallback base URL placeholder when backend default_base_url is unavailable. */
  baseUrlPlaceholder(): string {
    // Backend is SSOT for known-provider defaults (see default_base_url in
    // compose.rs); this is just a fallback hint if the backend response
    // arrives late.
    return '';
  }

  /**
   * Human-readable explanation of why model discovery failed, shown inline
   * under the Model field so the user understands why the select fell back
   * to a free-text input.
   */
  discoveryFailureMessage(): string {
    if (this.discoveryState.kind !== 'failed') return '';
    const url = this.discoveryState.url;
    const label = this.providerDisplayLabel();
    switch (this.discoveryState.reason) {
      case 'offline':
        return `${label} server not reachable at ${url}. Make sure it's running and the local server is enabled.`;
      case 'unsupported':
        return `${label} does not support model discovery — type the model name manually.`;
      case 'other':
        return `${label} at ${url} returned no models (the server is up but no model is loaded).`;
    }
  }

  /** Returns the UI-friendly label for the current provider. */
  private providerDisplayLabel(): string {
    switch (this.provider) {
      case 'ollama':
        return 'Ollama';
      case 'lmstudio':
        return 'LM Studio';
      case 'llamacpp':
        return 'llama.cpp';
      default:
        return 'Provider';
    }
  }

  /**
   * Handles a change of the provider dropdown.
   *
   * Each provider has a different default port, so baseUrl must be reset on
   * any real change — keeping an Ollama URL around for LM Studio would send
   * probes to the wrong server. After the reset, defaultBaseUrl is shown as
   * the input placeholder and discovery is kicked off against it; if the
   * server isn't running the UI gracefully falls back to the text input.
   *
   * Counter bump invalidates any in-flight probe from the previous provider
   * so its response is discarded on arrival.
   */
  async onProviderChange(): Promise<void> {
    if (this.provider === this.lastKnownProvider) {
      // Guard against redundant ngModelChange fires (HMR reinit, identical
      // selection etc.) — don't wipe state on no-op.
      return;
    }
    // Stash the URL we were just on so the user gets it back if they switch
    // back to this provider during the same session (e.g. they typed :8001
    // for llama.cpp, switched to Ollama to check something, came back — we
    // restore :8001 instead of the hardcoded :8080 default).
    const previousProvider = this.lastKnownProvider;
    if (previousProvider !== 'anthropic' && this.baseUrl) {
      this.baseUrlByProvider[previousProvider] = this.baseUrl;
    }
    this.lastKnownProvider = this.provider;
    this.discoveryCounter++;
    // Clear stale state synchronously so the UI reflects the provider change
    // immediately — even while the async default-URL fetch is in-flight.
    // Model is provider-specific; clearing prevents stale options on the new provider.
    this.model = '';
    this.discoveryState = { kind: 'idle' };
    this.providerChange.emit(this.provider);
    this.cdr.markForCheck();
    // Fetch the backend-authoritative default for the new provider if not yet cached.
    // This keeps compose.rs as the SSOT and avoids duplicating URL strings here.
    // Done AFTER the synchronous state reset above so the UI is consistent.
    if (this.provider !== 'anthropic' && !this.defaultBaseUrlsByProvider[this.provider]) {
      try {
        const freshDefault = await this.tauri.invoke<string | null>('get_default_base_url', {
          provider: this.provider,
        });
        if (freshDefault) {
          this.defaultBaseUrlsByProvider[this.provider] = freshDefault;
        }
      } catch {
        // Not in Tauri or unknown provider — cache stays empty for this provider.
      }
    }
    this.defaultBaseUrl = this.defaultBaseUrlsByProvider[this.provider] ?? '';
    // Restore the cached URL for this provider if we have one; otherwise fall
    // back to the provider's backend-authoritative default. Anthropic has no baseUrl.
    const cached = this.baseUrlByProvider[this.provider];
    this.baseUrl = this.provider === 'anthropic' ? '' : cached || this.defaultBaseUrl;
    // discoverModels self-gates on anthropic and empty URL — no outer guard needed.
    if (this.baseUrl) {
      await this.discoverModels(false);
    }
  }

  /**
   * Probes the local LLM server for the list of available models.
   * Fires only on explicit intent: user blur on baseUrl, Refresh click, or
   * initial load with persisted baseUrl. Provider switches do NOT probe
   * automatically — the new provider's default URL is typically wrong for
   * this user (different port, server not running).
   * @param isRefresh When true, bypass the same-URL dedupe check. Used by the
   *   Refresh button to let the user force a re-probe.
   */
  async discoverModels(isRefresh: boolean): Promise<void> {
    if (this.provider === 'anthropic') return;
    const effectiveUrl = this.baseUrl || this.defaultBaseUrl;
    if (!effectiveUrl) return;

    // Dedupe: skip same-URL non-refresh triggers while a probe is in-flight.
    if (
      !isRefresh &&
      this.discoveryState.kind === 'in-flight' &&
      this.discoveryState.url === effectiveUrl
    ) {
      return;
    }

    const id = ++this.discoveryCounter;
    this.discoveryState = { kind: 'in-flight', url: effectiveUrl, id };
    this.cdr.markForCheck();

    try {
      const models = await this.tauri.invoke<string[]>('discover_llm_models', {
        provider: this.provider,
        baseUrl: effectiveUrl,
      });
      // Stale-discard: drop responses whose id doesn't match the latest trigger.
      if (this.discoveryState.kind !== 'in-flight' || this.discoveryState.id !== id) return;
      // Invariant: do_discover_llm_models maps empty lists to Err("empty"),
      // so a resolved Ok always carries a non-empty array — the success path
      // never observes length === 0.
      this.discoveryState = { kind: 'ready', url: effectiveUrl, models };
      // Auto-select the first discovered model when the current value is
      // blank or not on the list — otherwise the <select> renders with no
      // active <option> and Save would persist an empty model name.
      if (!this.model || !models.includes(this.model)) {
        this.model = models[0];
      }
    } catch (e: unknown) {
      if (this.discoveryState.kind !== 'in-flight' || this.discoveryState.id !== id) return;
      const msg = e instanceof Error ? e.message : String(e);
      let reason: 'offline' | 'unsupported' | 'other' = 'offline';
      if (msg === 'unsupported') {
        reason = 'unsupported';
      } else if (msg === 'empty') {
        reason = 'other';
      }
      this.discoveryState = { kind: 'failed', url: effectiveUrl, reason };
      // No errorOccurred.emit — discovery failure is silent degradation
      // (UI falls back to the free-text input).
    } finally {
      // Always mark for check, even when early-returning via stale-discard.
      this.cdr.markForCheck();
    }
  }

  /** Persists the LLM provider configuration to the backend. */
  async saveConfig(): Promise<void> {
    this.saving = true;
    this.saved = false;
    try {
      // If the user left baseUrl blank for a local provider, fall back to the
      // provider default so compose can inject ANTHROPIC_BASE_URL. Anthropic
      // ignores baseUrl entirely, so null is correct there.
      const effectiveBaseUrl =
        this.provider === 'anthropic' ? null : this.baseUrl || this.defaultBaseUrl || null;
      await this.tauri.invoke('update_llm_config', {
        provider: this.provider,
        model: this.model || null,
        baseUrl: effectiveBaseUrl,
      });
      this.saved = true;
      this.providerChange.emit(this.provider);
      this.projectState.requestRestart();
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

  /**
   * Returns true when `url` exactly matches the backend-authoritative default
   * for `provider`. Uses the `defaultBaseUrlsByProvider` cache (populated on
   * init via `get_default_base_url` — backend is SSOT, see compose.rs).
   * Used by `loadConfig` to distinguish a known-safe default from a
   * user-supplied URL so we never silently probe arbitrary hosts on startup
   * (SSRF mitigation).
   * @param provider The selected provider (e.g. `ollama`, `lmstudio`, `llamacpp`).
   * @param url The base URL to check against the provider's cached default.
   */
  private isDefaultBaseUrl(provider: string, url: string): boolean {
    const def = this.defaultBaseUrlsByProvider[provider];
    return !!def && url === def;
  }

  private async loadConfig(): Promise<void> {
    try {
      const config = await this.tauri.invoke<LlmConfigResponse>('get_llm_config');
      this.provider = config.provider || 'anthropic';
      this.model = config.model || '';
      this.baseUrl = config.base_url || '';
      this.defaultBaseUrl = config.default_base_url || '';
      this.lastKnownProvider = this.provider;
      // Seed the per-provider cache with the backend-authoritative default for
      // the persisted provider so `isDefaultBaseUrl` can compare without a
      // round-trip (backend is SSOT via get_default_base_url / compose.rs).
      if (this.provider !== 'anthropic' && this.defaultBaseUrl) {
        this.defaultBaseUrlsByProvider[this.provider] = this.defaultBaseUrl;
      }
      // Seed the per-provider URL cache with the persisted URL so switching away
      // and back doesn't lose it.
      if (this.provider !== 'anthropic' && this.baseUrl) {
        this.baseUrlByProvider[this.provider] = this.baseUrl;
      }
      this.providerChange.emit(this.provider);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Silently ignore the common "not in Tauri" case (browser dev mode).
      // Log anything else so real backend errors aren't hidden.
      if (!msg.toLowerCase().includes('tauri') && !msg.toLowerCase().includes('invoke')) {
        console.error('loadConfig: unexpected error loading LLM config:', e);
      }
    }
    this.cdr.markForCheck();
    // Auto-probe only when the effective URL is a known-safe default. Any
    // user-supplied URL (even one persisted in config) must NOT be probed
    // silently — a cloned malicious repo could set base_url to an internal
    // RFC1918 host, turning Settings open into an SSRF probe. The user must
    // explicitly click Refresh or blur the Base URL field to trigger a probe
    // against a non-default URL.
    const effectiveUrl = this.baseUrl || this.defaultBaseUrl;
    const isSafeToAutoProbe =
      this.provider !== 'anthropic' &&
      !!effectiveUrl &&
      (this.baseUrl === '' || this.isDefaultBaseUrl(this.provider, this.baseUrl));
    if (isSafeToAutoProbe) {
      await this.discoverModels(false);
    }
  }
}
