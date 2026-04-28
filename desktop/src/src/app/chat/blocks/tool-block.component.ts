import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import type { NormalizedToolInput, ToolUseBlock } from '../../models/chat';
import { ToolNormalizerService } from '../../services/tool-normalizer.service';
import { DiffViewComponent } from './diff-view.component';
import { SpinIconComponent } from '../../shared/spin-icon.component';

/**
 * Semantic status → timeline border color class.
 *
 * Mirrors the design-proposals/06-terminal-minimal.html mockup: amber while
 * running, green on success, red-500 on error.
 */
const STATUS_BORDER: Readonly<Record<ToolUseBlock['status'], string>> = Object.freeze({
  running: 'border-[var(--amber)]/50',
  done: 'border-[var(--green)]/50',
  error: 'border-red-500/50',
});

/** Status → text color for the tool-name label in the header. */
const STATUS_INK: Readonly<Record<ToolUseBlock['status'], string>> = Object.freeze({
  running: 'text-[var(--amber)]',
  done: 'text-[var(--green)]',
  error: 'text-red-400',
});

/**
 * Renders a Claude tool invocation as a collapsible timeline event.
 *
 * The header row (status glyph · tool name · inline summary) is always
 * visible; clicking it toggles the body. The body template is chosen by
 * `NormalizedToolInput.kind` — bash, read, edit, write, todo_write, glob,
 * grep, web_search, web_fetch, agent, or a generic JSON fallback. Edit and
 * Write delegate their diff pane to `<app-diff-view>`.
 *
 * Default collapsed state: every tool block starts collapsed regardless of
 * status. The user expands a block by clicking the header — explicit choices
 * override the default and survive status transitions (running → done).
 */
@Component({
  selector: 'app-tool-block',
  imports: [DiffViewComponent, SpinIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  template: `
    <div
      role="region"
      [attr.aria-labelledby]="headerId"
      class="border-l-2 pl-4"
      [class]="borderClass()"
      [class.opacity-70]="isStopped()"
    >
      <button
        type="button"
        [id]="headerId"
        [attr.aria-controls]="bodyId"
        [attr.aria-expanded]="!isCollapsed()"
        class="mono flex w-full items-center gap-2 text-left text-[11px]"
        (click)="toggleCollapsed()"
      >
        <span [class]="statusInkClass()" class="inline-flex items-center gap-1.5">
          @if (tool().status === 'running' && !isStopped()) {
            <app-spin-icon testId="tool-status" />
          } @else {
            <span data-testid="tool-status" aria-hidden="true">{{ statusGlyph() }}</span>
          }
          <span data-testid="tool-name">{{ tool().tool_name }}</span>
        </span>
        @if (headerSummary()) {
          <span data-testid="tool-summary" class="truncate text-[var(--ink-dim)]">
            {{ headerSummary() }}
          </span>
        }
        @if (headerMeta()) {
          <span data-testid="tool-meta" class="ml-auto text-[var(--ink-mute)]">{{
            headerMeta()
          }}</span>
        }
      </button>

      @if (!isCollapsed()) {
        <div [id]="bodyId" data-testid="tool-body" class="mt-2">
          @switch (normalized().kind) {
            @case ('bash') {
              <pre
                data-testid="terminal-output"
                class="mono overflow-x-auto rounded border border-[var(--line)] bg-[var(--bg-1)] p-3 text-[11.5px] leading-[1.6] text-[var(--ink-dim)]"
              >
$ {{ asBash(normalized()).command }}</pre
              >
            }
            @case ('read') {
              <div data-testid="file-path" class="mono text-[11.5px] text-[var(--teal)]">
                {{ asRead(normalized()).file_path }}
              </div>
              @if (
                asRead(normalized()).offset !== undefined ||
                asRead(normalized()).limit !== undefined
              ) {
                <div class="mono mt-1 text-[11px] text-[var(--ink-mute)]">
                  @if (asRead(normalized()).offset !== undefined) {
                    offset {{ asRead(normalized()).offset }}
                  }
                  @if (asRead(normalized()).limit !== undefined) {
                    &nbsp;&middot; limit {{ asRead(normalized()).limit }}
                  }
                </div>
              }
            }
            @case ('edit') {
              <div data-testid="file-path" class="mono mb-2 text-[11.5px] text-[var(--teal)]">
                {{ asEdit(normalized()).file_path }}
              </div>
              <app-diff-view
                [oldString]="asEdit(normalized()).old_string"
                [newString]="asEdit(normalized()).new_string"
              />
            }
            @case ('write') {
              <div data-testid="file-path" class="mono mb-2 text-[11.5px] text-[var(--teal)]">
                {{ asWrite(normalized()).file_path }}
              </div>
              <app-diff-view [oldString]="''" [newString]="asWrite(normalized()).content" />
            }
            @case ('todo_write') {
              <ul
                data-testid="todo-list"
                class="mono list-none space-y-0.5 rounded border border-[var(--line)] bg-[var(--bg-1)] p-3 text-[12px]"
              >
                @for (todo of asTodoWrite(normalized()).todos; track todo.id) {
                  <li [class]="todoColor(todo.status)">
                    {{ todoGlyph(todo.status) }} {{ todo.title }}
                  </li>
                }
              </ul>
            }
            @case ('glob') {
              <div class="mono flex flex-wrap items-center gap-2 text-[11.5px]">
                <span class="text-[var(--ink-mute)]">pattern:</span>
                <span data-testid="pattern" class="text-[var(--teal)]">{{
                  asGlob(normalized()).pattern
                }}</span>
                @if (asGlob(normalized()).path) {
                  <span class="text-[var(--ink-mute)]">&middot; in</span>
                  <span class="text-[var(--teal)]">{{ asGlob(normalized()).path }}</span>
                }
              </div>
            }
            @case ('grep') {
              <div class="mono flex flex-wrap items-center gap-2 text-[11.5px]">
                <span class="text-[var(--ink-mute)]">pattern:</span>
                <span data-testid="pattern" class="text-[var(--teal)]">{{
                  asGrep(normalized()).pattern
                }}</span>
                @if (asGrep(normalized()).path) {
                  <span class="text-[var(--ink-mute)]">&middot; in</span>
                  <span class="text-[var(--teal)]">{{ asGrep(normalized()).path }}</span>
                }
                @if (asGrep(normalized()).include) {
                  <span class="text-[var(--ink-mute)]">&middot; include</span>
                  <span class="text-[var(--teal)]">{{ asGrep(normalized()).include }}</span>
                }
              </div>
            }
            @case ('web_search') {
              <div class="mono flex flex-wrap items-center gap-2 text-[11.5px]">
                <span class="text-[var(--ink-mute)]">query:</span>
                <span data-testid="query" class="text-[var(--teal)]">{{
                  asWebSearch(normalized()).query
                }}</span>
              </div>
            }
            @case ('web_fetch') {
              <div class="mono flex flex-wrap items-center gap-2 text-[11.5px]">
                <span class="text-[var(--ink-mute)]">url:</span>
                <span data-testid="url" class="text-[var(--teal)]">{{
                  asWebFetch(normalized()).url
                }}</span>
              </div>
            }
            @case ('agent') {
              <div data-testid="agent-description" class="mono text-[11.5px] text-[var(--ink-dim)]">
                {{ asAgent(normalized()).description }}
              </div>
            }
            @default {
              <pre
                data-testid="code-block"
                class="mono overflow-x-auto rounded border border-[var(--line)] bg-[var(--bg-1)] p-3 text-[11.5px] leading-[1.5] text-[var(--ink-dim)]"
                >{{ asGeneric(normalized()).raw_json }}</pre
              >
            }
          }
          @if (hasResult()) {
            <div
              data-testid="tool-result"
              class="mt-2"
              [attr.data-error]="resultIsError() ? 'true' : null"
            >
              <div
                data-testid="result-label"
                class="mono mb-1 text-[10px] uppercase tracking-widest"
                [class.text-red-400]="resultIsError()"
                [class.text-[var(--ink-mute)]]="!resultIsError()"
              >
                {{ resultIsError() ? 'Error' : 'Result' }}
              </div>
              <pre
                data-testid="result-content"
                class="mono max-h-[300px] overflow-x-auto overflow-y-auto rounded border p-3 text-[11.5px] leading-[1.6]"
                [class]="resultPaneClass()"
                >{{ resultText() }}</pre
              >
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class ToolBlockComponent {
  readonly tool = input.required<ToolUseBlock>();

  private readonly normalizer = inject(ToolNormalizerService);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Deterministic counter for ARIA id pairing; avoids DOM collisions without Math.random. */
  private static nextInstance = 0;
  private readonly instanceId = ++ToolBlockComponent.nextInstance;
  readonly headerId = `tool-block-header-${this.instanceId}`;
  readonly bodyId = `tool-block-body-${this.instanceId}`;

  /**
   * User-toggle state, keyed by tool_id.
   *
   * Absent entries fall back to the status-derived default (`running` →
   * expanded, everything else → collapsed). Keying by id means the user's
   * explicit choice survives a status transition (running → done) without
   * snapping back to the "done collapses" default; swapping the bound tool
   * instance starts fresh.
   */
  private readonly overrides: Record<string, boolean> = {};

  /** Returns the normalized tool input — recomputes only when input_json changes. */
  readonly normalized = computed<NormalizedToolInput>(() =>
    this.normalizer.normalize(this.tool().tool_name, this.tool().input_json)
  );

  /** Whether this tool's body is currently hidden. */
  isCollapsed(): boolean {
    const t = this.tool();
    const override = this.overrides[t.tool_id];
    if (override !== undefined) {
      return override;
    }
    // All tool blocks default to collapsed regardless of status — the user
    // expands them on demand by clicking the header.
    return true;
  }

  /** Toggles this tool's collapsed state; the override survives status changes. */
  toggleCollapsed(): void {
    const next = !this.isCollapsed();
    this.overrides[this.tool().tool_id] = next;
    this.cdr.markForCheck();
  }

  /** Tailwind border-color class for the timeline left rail, keyed by tool status. */
  readonly borderClass = computed<string>(() => {
    // Stopped tools surface as status="error" but visually use a muted gray rail
    // (matches the "stopped gray" rule in the design-system spec). The host
    // element already carries `border-l-2 pl-4`, so only the color class is
    // returned here.
    if (this.isStopped()) return 'border-[var(--ink-mute)]/50';
    return STATUS_BORDER[this.tool().status];
  });

  /** Tailwind text-color class for the status glyph + tool name in the header. */
  readonly statusInkClass = computed<string>(() => {
    if (this.isStopped()) return 'text-[var(--ink-mute)]';
    return STATUS_INK[this.tool().status];
  });

  /** A tool is "stopped" when its error result mentions a user cancel (opacity cue). */
  readonly isStopped = computed<boolean>(() => {
    const t = this.tool();
    if (t.status !== 'error') {
      return false;
    }
    const marker = t.result.toLowerCase();
    return marker.includes('stopped') || marker.includes('interrupted');
  });

  /**
   * Header glyph for non-running statuses. The running variant is rendered as
   * an inline spin SVG directly in the template (matches the mockup) so this
   * computed never returns a placeholder for it.
   */
  readonly statusGlyph = computed<string>(() => {
    if (this.isStopped()) {
      return '⊘';
    }
    switch (this.tool().status) {
      case 'running':
        return '';
      case 'done':
        return '✓';
      case 'error':
        return '✗';
    }
  });

  /** Returns a one-line human summary shown inline after the tool name. */
  readonly headerSummary = computed<string>(() => {
    const n = this.normalized();
    switch (n.kind) {
      case 'bash':
        return `$ ${n.command}`;
      case 'read':
      case 'write':
      case 'edit':
        return n.file_path;
      case 'glob':
      case 'grep':
        return n.pattern;
      case 'web_search':
        return n.query;
      case 'web_fetch':
        return n.url;
      case 'agent':
        return n.description;
      case 'todo_write':
        return `${n.todos.length} ${n.todos.length === 1 ? 'task' : 'tasks'}`;
      case 'generic':
        return '';
    }
  });

  /** Returns right-aligned metadata shown on the header (running, stopped). */
  readonly headerMeta = computed<string>(() => {
    if (this.tool().status === 'running') {
      return 'running';
    }
    if (this.isStopped()) {
      return 'stopped';
    }
    return '';
  });

  /** True when the tool has finished AND emitted a non-empty result string. */
  readonly hasResult = computed<boolean>(() => {
    const t = this.tool();
    return t.status !== 'running' && t.result.length > 0;
  });

  /** True when the tool ended in error and the runtime flagged the result as an error payload. */
  readonly resultIsError = computed<boolean>(() => {
    const t = this.tool();
    return t.status === 'error' && t.result_is_error === true;
  });

  /** Text shown in the result pane — blank while running so we don't echo a stale value. */
  readonly resultText = computed<string>(() => {
    const t = this.tool();
    return t.status === 'running' ? '' : t.result;
  });

  /** Tailwind classes for the result pane — swap border/bg/text on error without slash-class bindings. */
  readonly resultPaneClass = computed<string>(() =>
    this.resultIsError()
      ? 'border-red-500/20 bg-red-500/5 text-red-300'
      : 'border-[var(--line)] bg-[var(--bg-1)] text-[var(--ink-dim)]'
  );

  /**
   * Glyph for a TodoWrite item's status cell.
   * @param status - The todo item's status string (e.g. "completed", "in_progress").
   */
  todoGlyph(status: string): string {
    switch (status) {
      case 'completed':
        return '✓';
      case 'in_progress':
        return '▸';
      case 'cancelled':
        return '⊘';
      default:
        return '○';
    }
  }

  /**
   * Tailwind color class for a TodoWrite item keyed by status.
   * @param status - The todo item's status string.
   */
  todoColor(status: string): string {
    switch (status) {
      case 'completed':
        return 'text-[var(--green)]';
      case 'in_progress':
        return 'text-[var(--accent)]';
      case 'cancelled':
        return 'text-[var(--ink-mute)] line-through';
      default:
        return 'text-[var(--ink-mute)]';
    }
  }

  /**
   * Narrows the normalized input to the bash variant for template usage.
   * @param n - Normalized input to narrow.
   */
  asBash(n: NormalizedToolInput): Extract<NormalizedToolInput, { kind: 'bash' }> {
    return n as Extract<NormalizedToolInput, { kind: 'bash' }>;
  }

  /**
   * Narrows the normalized input to the read variant for template usage.
   * @param n - Normalized input to narrow.
   */
  asRead(n: NormalizedToolInput): Extract<NormalizedToolInput, { kind: 'read' }> {
    return n as Extract<NormalizedToolInput, { kind: 'read' }>;
  }

  /**
   * Narrows the normalized input to the write variant for template usage.
   * @param n - Normalized input to narrow.
   */
  asWrite(n: NormalizedToolInput): Extract<NormalizedToolInput, { kind: 'write' }> {
    return n as Extract<NormalizedToolInput, { kind: 'write' }>;
  }

  /**
   * Narrows the normalized input to the edit variant for template usage.
   * @param n - Normalized input to narrow.
   */
  asEdit(n: NormalizedToolInput): Extract<NormalizedToolInput, { kind: 'edit' }> {
    return n as Extract<NormalizedToolInput, { kind: 'edit' }>;
  }

  /**
   * Narrows the normalized input to the glob variant for template usage.
   * @param n - Normalized input to narrow.
   */
  asGlob(n: NormalizedToolInput): Extract<NormalizedToolInput, { kind: 'glob' }> {
    return n as Extract<NormalizedToolInput, { kind: 'glob' }>;
  }

  /**
   * Narrows the normalized input to the grep variant for template usage.
   * @param n - Normalized input to narrow.
   */
  asGrep(n: NormalizedToolInput): Extract<NormalizedToolInput, { kind: 'grep' }> {
    return n as Extract<NormalizedToolInput, { kind: 'grep' }>;
  }

  /**
   * Narrows the normalized input to the web_search variant for template usage.
   * @param n - Normalized input to narrow.
   */
  asWebSearch(n: NormalizedToolInput): Extract<NormalizedToolInput, { kind: 'web_search' }> {
    return n as Extract<NormalizedToolInput, { kind: 'web_search' }>;
  }

  /**
   * Narrows the normalized input to the web_fetch variant for template usage.
   * @param n - Normalized input to narrow.
   */
  asWebFetch(n: NormalizedToolInput): Extract<NormalizedToolInput, { kind: 'web_fetch' }> {
    return n as Extract<NormalizedToolInput, { kind: 'web_fetch' }>;
  }

  /**
   * Narrows the normalized input to the agent variant for template usage.
   * @param n - Normalized input to narrow.
   */
  asAgent(n: NormalizedToolInput): Extract<NormalizedToolInput, { kind: 'agent' }> {
    return n as Extract<NormalizedToolInput, { kind: 'agent' }>;
  }

  /**
   * Narrows the normalized input to the todo_write variant for template usage.
   * @param n - Normalized input to narrow.
   */
  asTodoWrite(n: NormalizedToolInput): Extract<NormalizedToolInput, { kind: 'todo_write' }> {
    return n as Extract<NormalizedToolInput, { kind: 'todo_write' }>;
  }

  /**
   * Narrows the normalized input to the generic fallback variant for template usage.
   * @param n - Normalized input to narrow.
   */
  asGeneric(n: NormalizedToolInput): Extract<NormalizedToolInput, { kind: 'generic' }> {
    return n as Extract<NormalizedToolInput, { kind: 'generic' }>;
  }
}
