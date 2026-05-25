import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { PluginBridgeService } from '../../services/plugin-bridge.service';

/** Bridge connection card for any plugin whose manifest declares host_bridge. */
@Component({
  selector: 'app-bridge-connection',
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="mt-6 rounded border border-[var(--line)] bg-[var(--bg-1)] p-4"
      data-testid="bridge-connection"
    >
      <div
        class="mono mb-3 flex items-center gap-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
      >
        Bridge connection
        <span class="dot" [style.background]="dotColor()" data-testid="bridge-status-dot"></span>
        <span data-testid="bridge-status-label">{{ statusLabel() }}</span>
      </div>

      @if (error()) {
        <p class="mono mb-2 text-[12px] text-red-300" data-testid="bridge-error">
          {{ error() }}
        </p>
      } @else {
        <p class="mb-2 text-[12px] leading-relaxed text-[var(--ink-dim)]">
          Paste these into your companion app (e.g. the Figma Desktop plugin). The worker container
          uses an internal address; this URL is for external clients on the same host.
        </p>

        <label
          for="bridge-url-input"
          class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
        >
          Connect URL
        </label>
        <div class="mb-3 flex items-center gap-2">
          <input
            id="bridge-url-input"
            readonly
            class="mono flex-1 rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
            [value]="url() ?? ''"
            data-testid="bridge-url-input"
          />
          <button
            type="button"
            class="mono rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
            data-testid="bridge-url-copy"
            (click)="copy('url')"
          >
            {{ copiedField() === 'url' ? 'copied' : 'copy' }}
          </button>
        </div>

        <label
          for="bridge-token-input"
          class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
        >
          Token
        </label>
        <div class="flex items-center gap-2">
          <input
            id="bridge-token-input"
            readonly
            class="mono flex-1 rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
            [type]="tokenRevealed() ? 'text' : 'password'"
            [value]="token() ?? ''"
            data-testid="bridge-token-input"
          />
          <button
            type="button"
            class="mono rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
            data-testid="bridge-token-reveal"
            (click)="toggleReveal()"
          >
            {{ tokenRevealed() ? 'hide' : 'reveal' }}
          </button>
          <button
            type="button"
            class="mono rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
            data-testid="bridge-token-copy"
            (click)="copy('token')"
          >
            {{ copiedField() === 'token' ? 'copied' : 'copy' }}
          </button>
        </div>
      }
    </section>
  `,
})
export class BridgeConnectionComponent implements OnInit {
  readonly slug = input.required<string>();

  private readonly bridgeService = inject(PluginBridgeService);

  readonly url = signal<string | null>(null);
  readonly token = signal<string | null>(null);
  readonly tokenRevealed = signal(false);
  readonly copiedField = signal<'url' | 'token' | null>(null);
  readonly error = signal<string | null>(null);

  readonly status = computed(() => this.bridgeService.status(this.slug())());

  readonly dotColor = computed(() => {
    const s = this.status();
    if (s?.running && s.paired) return 'var(--green)';
    if (s?.running && s.partner_connected) return 'var(--accent)';
    return 'var(--ink-mute)';
  });

  readonly statusLabel = computed(() => {
    const s = this.status();
    if (s?.running && s.paired) return 'connected';
    if (s?.running && s.partner_connected) return 'companion connected, waiting for worker call';
    return 'waiting for connection';
  });

  /** Loads the initial snapshot and credentials for the bound slug. */
  async ngOnInit(): Promise<void> {
    try {
      await this.bridgeService.refresh(this.slug());
      const creds = await this.bridgeService.credentials(this.slug());
      this.url.set(creds.url);
      this.token.set(creds.token);
      this.error.set(null);
    } catch (err) {
      console.error('BridgeConnectionComponent: load failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.error.set(`Bridge unavailable: ${msg}`);
    }
  }

  /**
   * Copies the bridge URL or token to the clipboard and flashes "copied".
   * @param field - Which field to copy.
   */
  async copy(field: 'url' | 'token'): Promise<void> {
    const value = field === 'url' ? this.url() : this.token();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      this.copiedField.set(field);
      setTimeout(() => {
        if (this.copiedField() === field) this.copiedField.set(null);
      }, 1500);
    } catch (err) {
      console.warn('BridgeConnectionComponent: clipboard write failed', err);
      this.error.set('Could not copy to clipboard');
    }
  }

  /** Toggles between masked password and revealed plaintext for the bridge token. */
  toggleReveal(): void {
    this.tokenRevealed.update((v) => !v);
  }
}
