import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CustomMcpService } from '../services/custom-mcp.service';
import type { CustomMcpPreview } from '../models/custom-mcp';
import { eventChecked, eventValue } from '../shared/dom-event';
import {
  HOST_WARNING_TEXT,
  ORG_DISABLED_LABEL,
  errorText,
  serverNameError,
} from './custom-mcp-text';

/** Lowest port a host server may use. Mirrors Rust `MIN_HOST_PORT`. */
export const MIN_HOST_PORT = 1024;

/**
 * Why a typed port is refused, `null` when it is valid.
 * @param raw - the typed port
 */
export function hostPortError(raw: string): string | null {
  const port = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || port < MIN_HOST_PORT || port > 65535) {
    return `Enter a port between ${MIN_HOST_PORT} and 65535.`;
  }
  return null;
}

/**
 * Why a typed URL path is refused, `null` when it is valid.
 * @param path - the typed path
 */
export function hostPathError(path: string): string | null {
  if (!path.startsWith('/')) return "The path starts with '/'.";
  if (/[?#\s]/.test(path)) return 'The path has no query, fragment or spaces.';
  if (path.length > 256) return 'The path is too long.';
  return null;
}

const FIELD =
  'mono w-full rounded border border-[var(--line)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--ink)]';

/** Form for an HTTP MCP server already running on this computer; submitting starts its review. */
@Component({
  selector: 'app-custom-mcp-host-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <form
      class="rounded border border-[var(--line)] bg-[var(--bg-1)] p-3"
      data-testid="custom-mcp-host-form"
      (submit)="$event.preventDefault(); submit()"
    >
      <div class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
        Server on this computer
        @if (orgDisabled()) {
          <span class="pill ml-1" data-testid="custom-mcp-host-form-org-disabled">{{
            orgDisabledLabel
          }}</span>
        }
      </div>
      <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_7rem_1fr]">
        <label class="text-[11px] text-[var(--ink-mute)]">
          name
          <input
            type="text"
            [class]="field"
            placeholder="figma-desktop"
            autocomplete="off"
            [value]="name()"
            [disabled]="orgDisabled()"
            data-testid="custom-mcp-host-name"
            (input)="name.set(eventValue($event))"
          />
        </label>
        <label class="text-[11px] text-[var(--ink-mute)]">
          port
          <input
            type="text"
            inputmode="numeric"
            [class]="field"
            placeholder="3845"
            autocomplete="off"
            [value]="port()"
            [disabled]="orgDisabled()"
            data-testid="custom-mcp-host-port"
            (input)="port.set(eventValue($event))"
          />
        </label>
        <label class="text-[11px] text-[var(--ink-mute)]">
          path
          <input
            type="text"
            [class]="field"
            placeholder="/mcp"
            autocomplete="off"
            [value]="path()"
            [disabled]="orgDisabled()"
            data-testid="custom-mcp-host-path"
            (input)="path.set(eventValue($event))"
          />
        </label>
      </div>
      @if (touched() && fieldError()) {
        <p class="mt-1 text-[11px] text-[var(--red)]" data-testid="custom-mcp-host-field-error">
          {{ fieldError() }}
        </p>
      }

      <div
        class="mt-3 rounded ring-1 ring-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-[var(--amber)]"
        role="note"
        data-testid="custom-mcp-host-form-warning"
      >
        {{ hostWarning }}
      </div>
      <label class="mt-2 flex items-start gap-2 text-[12px] text-[var(--ink)]">
        <input
          type="checkbox"
          class="mt-0.5 accent-[var(--accent)]"
          [checked]="confirmed()"
          [disabled]="orgDisabled()"
          data-testid="custom-mcp-host-confirm"
          (change)="confirmed.set(eventChecked($event))"
        />
        <span>I understand that Claude can reach every tool this server exposes.</span>
      </label>

      @if (error()) {
        <p
          class="mt-2 text-[12px] text-[var(--red)]"
          role="alert"
          data-testid="custom-mcp-host-error"
        >
          {{ error() }}
        </p>
      }

      <div class="mt-3 flex justify-end gap-2">
        <button
          type="button"
          class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-50"
          [disabled]="busy()"
          data-testid="custom-mcp-host-cancel"
          (click)="cancelled.emit()"
        >
          cancel
        </button>
        <button
          type="submit"
          class="mono rounded border border-[var(--accent-dim)] bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-50"
          [disabled]="!canSubmit()"
          data-testid="custom-mcp-host-submit"
        >
          $ review
        </button>
      </div>
    </form>
  `,
})
export class CustomMcpHostFormComponent {
  /** The project the server is for. */
  readonly project = input.required<string>();
  /** Whether the organization turned host servers off. */
  readonly orgDisabled = input(false);
  /** Emitted with the review to show. */
  readonly previewed = output<CustomMcpPreview>();
  /** Emitted when the user closes the form. */
  readonly cancelled = output<void>();

  /** The typed server name. */
  readonly name = signal('');
  /** The typed port. */
  readonly port = signal('');
  /** The typed path. */
  readonly path = signal('/mcp');
  /** The host warning checkbox. */
  readonly confirmed = signal(false);
  /** True while the review is requested. */
  readonly busy = signal(false);
  /** The refused review. */
  readonly error = signal('');

  /** True once any field was typed in. */
  readonly touched = computed(() => this.name() !== '' || this.port() !== '');
  /** The first field error, `null` when every field is valid. */
  readonly fieldError = computed<string | null>(
    () => serverNameError(this.name()) ?? hostPortError(this.port()) ?? hostPathError(this.path())
  );
  /** Whether the form can be submitted. */
  readonly canSubmit = computed<boolean>(
    () => !this.orgDisabled() && !this.busy() && this.confirmed() && this.fieldError() === null
  );

  protected readonly hostWarning = HOST_WARNING_TEXT;
  protected readonly orgDisabledLabel = ORG_DISABLED_LABEL;
  protected readonly field = FIELD;
  protected readonly eventValue = eventValue;
  protected readonly eventChecked = eventChecked;

  private readonly customMcp = inject(CustomMcpService);

  /** Requests the review of the typed server. */
  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const preview = await this.customMcp.preview(this.project(), {
        kind: 'host',
        name: this.name(),
        port: Number(this.port()),
        path: this.path(),
      });
      this.previewed.emit(preview);
    } catch (e: unknown) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
