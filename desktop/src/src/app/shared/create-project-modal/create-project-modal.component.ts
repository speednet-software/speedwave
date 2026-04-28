import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { form, FormField, required } from '@angular/forms/signals';
import { open } from '@tauri-apps/plugin-dialog';
import { TauriService } from '../../services/tauri.service';
import { SpinIconComponent } from '../spin-icon.component';

/** Payload emitted when a project is successfully created. */
export interface CreatedProject {
  /** User-confirmed project slug (will be the compose project name). */
  readonly name: string;
  /** Absolute path to the project directory chosen via the OS picker. */
  readonly dir: string;
}

/**
 * Modal dialog for creating a new Speedwave project. Opens the OS folder
 * picker, derives a default project name from the chosen directory's basename
 * (editable), and invokes `create_project` on the Rust backend on submit.
 *
 * Reused by the setup-wizard (where it is non-dismissible — user must create
 * a project to finish setup) and the project-switcher dropdown (dismissible).
 *
 * Uses Angular Signal Forms (`@angular/forms/signals`) for the editable
 * project-name field. Signal Forms are signal-driven and OnPush-safe — they
 * avoid the second change-detection pass that the legacy `NgModel` directive
 * schedules, which Angular 21.2.x crashes on inside embedded views.
 */
@Component({
  selector: 'app-create-project-modal',
  imports: [SpinIconComponent, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div
        class="fixed inset-0 z-[1300] flex items-center justify-center bg-black/75 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Create new project"
        data-testid="create-project-modal"
        (click)="onBackdropClick($event)"
        (keydown.escape)="onEscape()"
        tabindex="-1"
      >
        <div
          class="w-[min(28rem,calc(100vw-2rem))] rounded border border-[var(--line-strong)] bg-[var(--bg-1)] p-5"
          role="document"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <div class="mono text-[11px] uppercase tracking-widest text-[var(--accent)]">
            new project
          </div>
          <h3 class="view-title mt-1 text-[16px] text-[var(--ink)]" data-testid="modal-title">
            Create your project
          </h3>
          <p class="mt-2 text-[13px] leading-relaxed text-[var(--ink-dim)]">
            Pick the folder. We'll register it as your project.
          </p>

          <label
            class="mono mt-4 mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="create-project-dir"
          >
            project directory
          </label>
          <div class="flex items-stretch gap-2">
            <input
              id="create-project-dir"
              type="text"
              [value]="dir()"
              readonly
              placeholder="(none selected)"
              data-testid="create-project-dir"
              class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
            />
            <button
              type="button"
              class="mono shrink-0 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg)]"
              data-testid="create-project-browse"
              [disabled]="busy()"
              (click)="browse()"
            >
              browse…
            </button>
          </div>

          <label
            class="mono mt-3 mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="create-project-name"
          >
            project name
          </label>
          <input
            id="create-project-name"
            type="text"
            [formField]="projectForm.name"
            placeholder="my-project"
            data-testid="create-project-name"
            class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
          />

          @if (error()) {
            <div
              class="mono mt-3 rounded border border-red-500/30 bg-red-500/5 p-2 text-[11.5px] text-red-300"
              data-testid="create-project-error"
              role="alert"
            >
              {{ error() }}
            </div>
          }

          <div class="mt-5 flex items-center justify-end gap-2">
            @if (dismissible()) {
              <button
                type="button"
                class="mono rounded border border-[var(--line)] px-3 py-1 text-[12px] text-[var(--ink-dim)] hover:text-[var(--ink)]"
                data-testid="create-project-cancel"
                [disabled]="busy()"
                (click)="cancel()"
              >
                cancel
              </button>
            }
            <button
              type="button"
              class="mono inline-flex items-center gap-2 rounded bg-[var(--accent)] px-3 py-1 text-[12px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="create-project-submit"
              [disabled]="!canSubmit()"
              (click)="submit()"
            >
              @if (busy()) {
                <app-spin-icon />
                <span>creating…</span>
              } @else {
                <span>$ create project</span>
              }
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class CreateProjectModalComponent {
  /** Whether the modal is visible. */
  readonly open = input.required<boolean>();
  /**
   * Whether the user is allowed to close the modal without creating a project.
   * Setup-wizard sets this to `false` (project creation is mandatory there);
   * the project-switcher sets it to `true`.
   */
  readonly dismissible = input<boolean>(true);
  /**
   * Tauri command to invoke on submit. Defaults to `create_project` (setup
   * pipeline — config-only registration). The project-switcher should pass
   * `add_project` instead, which also boots containers and switches active
   * project as part of the same transaction.
   */
  readonly command = input<'create_project' | 'add_project'>('create_project');

  /** Emitted with the chosen `name` + `dir` after `create_project` succeeds. */
  readonly created = output<CreatedProject>();
  /** Emitted when the user cancels (only when `dismissible()` is `true`). */
  readonly closed = output<void>();

  private readonly tauri = inject(TauriService);
  private readonly cdr = inject(ChangeDetectorRef);

  /**
   * Reactive model backing the Signal Forms tree. `dir` is set programmatically
   * by `browse()`; `name` is auto-filled from the dir basename then editable.
   */
  protected readonly model = signal<CreatedProject>({ name: '', dir: '' });
  /**
   * Signal Forms field tree. The name input binds via `[formField]` — this
   * routes user input directly through the model and tracks dirty state for
   * us, replacing the legacy `[value]+(input)` workaround and the manual
   * `nameTouched` flag.
   */
  protected readonly projectForm = form(this.model, (path) => {
    required(path.name, { message: 'Project name is required' });
  });

  /** Currently chosen directory (full absolute path). */
  protected readonly dir = computed<string>(() => this.model().dir);
  /** Project name — auto-filled from the dir basename, editable by the user. */
  protected readonly name = computed<string>(() => this.model().name);
  /** Whether `create_project` is in flight. */
  protected readonly busy = signal<boolean>(false);
  /** Inline error from the OS picker or `create_project`. */
  protected readonly error = signal<string | null>(null);

  /** Submit button is enabled iff a directory and a non-empty name are present. */
  protected readonly canSubmit = computed(
    () => !this.busy() && this.dir().length > 0 && this.name().trim().length > 0
  );

  /** Opens the OS folder picker and updates dir + auto-fills name when applicable. */
  async browse(): Promise<void> {
    this.error.set(null);
    let selected: string | string[] | null;
    try {
      // E2E test seam: WebDriver cannot drive the OS folder picker, so the
      // suite plants `window.__E2E_DIALOG_PATH__` to short-circuit the
      // native call. `string` resolves the picker, `null` simulates cancel.
      // Anything else (`undefined`, missing) falls through to the real API.
      const e2eOverride = (window as unknown as { __E2E_DIALOG_PATH__?: string | null })
        .__E2E_DIALOG_PATH__;
      selected =
        e2eOverride !== undefined ? e2eOverride : await open({ directory: true, multiple: false });
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
      this.cdr.markForCheck();
      return;
    }
    if (typeof selected !== 'string' || selected.length === 0) {
      return;
    }
    // Auto-fill name only when the user has not yet edited it. Signal Forms
    // marks the `name` field as dirty whenever its value flows through the
    // `[formField]` binding, so `dirty()` is the SSOT for "user touched it".
    const nameDirty = this.projectForm.name().dirty();
    this.model.update((m) => ({
      ...m,
      dir: selected as string,
      name: nameDirty ? m.name : slugify(basename(selected as string)),
    }));
    this.cdr.markForCheck();
  }

  /**
   * Handles manual edits to the project-name input.
   *
   * In production the `[formField]` directive owns the input event and writes
   * directly to the form's control value. This method exists so unit tests can
   * simulate user typing without spinning up a full DOM event — it routes
   * through the same control-value setter, which keeps `dirty()` honest.
   * @param event - Native `input` event (or test stand-in) from the name field.
   */
  onNameInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.projectForm.name().controlValue.set(value);
  }

  /** Invokes `create_project` and emits `created` on success. */
  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.busy.set(true);
    this.error.set(null);
    this.cdr.markForCheck();
    const name = this.name().trim();
    const dir = this.dir();
    try {
      await this.tauri.invoke(this.command(), { name, dir });
      this.reset();
      this.created.emit({ name, dir });
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
      this.cdr.markForCheck();
    }
  }

  /** Cancels (closes) the modal — only honoured when `dismissible()` is true. */
  cancel(): void {
    if (!this.dismissible() || this.busy()) return;
    this.reset();
    this.closed.emit();
  }

  /** Closes on Esc when allowed. */
  protected onEscape(): void {
    this.cancel();
  }

  /**
   * Closes on backdrop click when allowed.
   * @param event - Mouse click event from the backdrop element.
   */
  protected onBackdropClick(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    this.cancel();
  }

  private reset(): void {
    this.model.set({ name: '', dir: '' });
    // Clear the form's dirty/touched flags so the next `browse()` is treated
    // as a fresh selection rather than a continuation of the previous edit.
    this.projectForm().reset();
    this.error.set(null);
  }
}

/**
 * Returns the trailing path segment of an absolute or relative path.
 * @param path - Path whose final segment we want.
 */
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/u, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Converts a directory basename into a Speedwave-friendly project slug:
 * lowercase, alphanumerics + hyphens only, collapsed runs, trimmed edges.
 * @param input - Directory basename to slugify.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}
