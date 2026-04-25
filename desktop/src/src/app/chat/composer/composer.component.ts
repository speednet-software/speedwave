import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ProjectStateService } from '../../services/project-state.service';
import { SlashMenuComponent } from '../slash/slash-menu.component';
import { SlashService, type SlashCommand } from '../slash/slash.service';

/** Regex matching `/query` at the very start of input (optionally preceded by whitespace), capturing the query. */
const SLASH_TRIGGER = /^(\s*)\/([^\s/]*)$/;

/**
 * Stateless composer that wraps a textarea, slash button, slash-menu popover, and a
 * send button. Input is managed by a reactive `FormControl<string>`; Enter
 * submits while Shift+Enter inserts a newline. Typing `/` at the start of the
 * textarea (or clicking the `/` toolbar button) opens the slash-menu popover.
 */
@Component({
  selector: 'app-composer',
  standalone: true,
  imports: [ReactiveFormsModule, SlashMenuComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="mx-auto max-w-3xl relative">
      <div class="rounded border border-line bg-bg-1 focus-within:border-accent">
        <textarea
          #textarea
          data-testid="chat-input"
          rows="2"
          aria-label="Compose message"
          class="w-full resize-none border-0 bg-transparent px-3 py-2.5 text-[14px] leading-relaxed text-ink placeholder-ink-mute focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          [placeholder]="placeholder"
          [formControl]="text"
          (keydown.enter)="onEnter($event)"
          (input)="onInput($event)"
        ></textarea>
        <div
          class="mono flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 text-[11px] text-ink-mute"
        >
          <button
            type="button"
            data-testid="composer-slash"
            class="hover:text-ink"
            (click)="onSlashButtonClick()"
          >
            /<span class="hidden sm:inline"> skill</span>
          </button>
          <div class="ml-auto flex flex-shrink-0 items-center gap-2">
            <span class="hidden sm:inline" data-testid="composer-shortcut">{{
              shortcutLabel
            }}</span>
            <button
              type="button"
              data-testid="chat-send"
              aria-label="Send"
              class="rounded bg-accent px-2.5 py-0.5 font-medium text-on-accent hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              [disabled]="!canSubmit()"
              (click)="submit()"
            >
              send &rarr;
            </button>
          </div>
        </div>
      </div>
      @if (slashOpen()) {
        <app-slash-menu
          [query]="slashQuery()"
          (selected)="applySelection($event)"
          (closed)="closeSlash()"
        />
      }
    </div>
  `,
})
export class ComposerComponent {
  /** Textarea DOM node used to read the caret position and insert text at the cursor. */
  @ViewChild('textarea', { static: true })
  private textareaRef!: ElementRef<HTMLTextAreaElement>;

  private _disabled = false;
  /** Disables input and suppresses submits while the turn is streaming. */
  get disabled(): boolean {
    return this._disabled;
  }
  /** True to disable input and prevent submits, false to enable. */
  @Input() set disabled(value: boolean) {
    this._disabled = value;
    if (value) this.text.disable({ emitEvent: false });
    else this.text.enable({ emitEvent: false });
  }

  /** Placeholder shown in the textarea when it is empty. */
  @Input() placeholder = 'Message Claude...';

  /** Emits the trimmed message text when the user submits via Enter or the send button. */
  @Output() readonly submitted = new EventEmitter<string>();

  /** Emits when the slash popover transitions open/closed (for parent UI coordination). */
  @Output() readonly slashOpenChange = new EventEmitter<boolean>();

  readonly slashService = inject(SlashService);
  private readonly projectState = inject(ProjectStateService);

  /** Reactive control holding the current textarea value. */
  readonly text = new FormControl<string>('', { nonNullable: true });

  /** Whether the slash popover is open. */
  readonly slashOpen = signal<boolean>(false);
  /** Active query used to filter the slash menu (text after `/`). */
  readonly slashQuery = signal<string>('');

  /** Platform-aware submit-shortcut label shown in the toolbar (⌘+↵ on macOS, Ctrl+↵ elsewhere). */
  readonly shortcutLabel = isMacPlatform() ? '⌘+↵' : 'Ctrl+↵';

  /** Bridges `FormControl.valueChanges` (RxJS) into the signal graph for OnPush. */
  readonly textValue = toSignal(this.text.valueChanges, { initialValue: '' });

  constructor() {
    this.projectState.onProjectReady(() => {
      const id = this.projectState.activeProject;
      if (id) void this.slashService.refresh(id);
    });
  }

  /** True when there is text to send and the composer is not disabled. */
  canSubmit(): boolean {
    return !this.disabled && this.textValue().trim().length > 0;
  }

  /** Handles Enter — Shift+Enter inserts newline, Enter alone submits. */
  onEnter(event: Event): void {
    if ((event as KeyboardEvent).shiftKey) return;
    if (this.slashOpen() && this.slashService.commands().length > 0) return;
    event.preventDefault();
    this.submit();
  }

  /** Submits the current textarea value and resets the form. */
  submit(): void {
    if (!this.canSubmit()) return;
    this.submitted.emit(this.textValue().trim());
    this.text.reset('');
    this.closeSlash();
  }

  /** Updates slash-menu visibility when the textarea content changes. */
  onInput(event: Event): void {
    this.updateSlashState(event.target as HTMLTextAreaElement);
  }

  /**
   * Inserts a `/` at the current caret position and opens the slash menu.
   */
  onSlashButtonClick(): void {
    if (this.disabled) return;
    const ta = this.textareaRef.nativeElement;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const insert = before.length === 0 || /\s$/.test(before) ? '/' : ' /';
    this.text.setValue(`${before}${insert}${after}`);
    const newPos = start + insert.length;
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(newPos, newPos);
      this.updateSlashState(ta);
    });
  }

  /**
   * Replaces the `/query` token with the selected command name and closes the popover.
   */
  applySelection(command: SlashCommand): void {
    const ta = this.textareaRef.nativeElement;
    const caret = ta.selectionStart ?? ta.value.length;
    const prefix = ta.value.slice(0, caret);
    const suffix = ta.value.slice(caret);
    const match = SLASH_TRIGGER.exec(prefix);
    if (!match) {
      this.closeSlash();
      return;
    }
    const leading = match[1] ?? '';
    const replacement = `${leading}/${command.name} `;
    this.text.setValue(`${replacement}${suffix}`);
    queueMicrotask(() => {
      const newCaret = replacement.length;
      ta.focus();
      ta.setSelectionRange(newCaret, newCaret);
    });
    this.closeSlash();
  }

  /** Closes the popover and returns focus to the textarea. */
  closeSlash(): void {
    this.setSlashOpen(false);
    this.slashQuery.set('');
  }

  private setSlashOpen(open: boolean): void {
    if (this.slashOpen() === open) return;
    this.slashOpen.set(open);
    this.slashOpenChange.emit(open);
  }

  private updateSlashState(el: HTMLTextAreaElement): void {
    const caret = el.selectionStart ?? el.value.length;
    const prefix = el.value.slice(0, caret);
    const match = SLASH_TRIGGER.exec(prefix);
    if (match) {
      this.slashQuery.set(match[2] ?? '');
      if (!this.slashOpen()) {
        this.setSlashOpen(true);
        const project = this.projectState.activeProject;
        if (project && this.slashService.commands().length === 0) {
          void this.slashService.refresh(project);
        }
      }
    } else if (this.slashOpen()) {
      this.setSlashOpen(false);
      this.slashQuery.set('');
    }
  }
}

/** Detects macOS for platform-aware keyboard hints (browser + jsdom safe). */
function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  type NavigatorWithUA = Navigator & {
    userAgentData?: { platform?: string };
  };
  const nav = navigator as NavigatorWithUA;
  const platform = nav.userAgentData?.platform ?? nav.userAgent ?? '';
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}
