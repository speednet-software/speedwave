import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  inject,
} from '@angular/core';
import type { ToolUseBlock, NormalizedToolInput } from '../../models/chat';
import { ToolNormalizerService } from '../../services/tool-normalizer.service';

/** Renders a tool invocation block with collapsible input/result details. */
@Component({
  selector: 'app-tool-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  template: `
    <div class="bg-sw-bg-dark border border-sw-border rounded-md">
      <div
        class="flex items-center px-3 py-2 cursor-pointer gap-2"
        role="button"
        tabindex="0"
        (click)="toggleCollapsed()"
        (keydown.enter)="toggleCollapsed()"
      >
        <span
          data-testid="tool-status"
          [class]="
            tool.status === 'running'
              ? 'text-sw-warning'
              : tool.status === 'done'
                ? 'text-sw-success-light'
                : 'text-sw-error-light'
          "
        >
          @switch (tool.status) {
            @case ('running') {
              &#x25CB;
            }
            @case ('done') {
              &#x2713;
            }
            @case ('error') {
              &#x2717;
            }
          }
        </span>
        <span data-testid="tool-name" class="font-bold text-sw-accent text-[13px]">{{
          tool.tool_name
        }}</span>
        <span
          data-testid="tool-summary"
          class="text-sw-text-muted text-xs overflow-hidden text-ellipsis whitespace-nowrap flex-1"
          >{{ headerSummary }}</span
        >
      </div>
      @if (!isCollapsed()) {
        <div data-testid="tool-body" class="px-3 pb-3">
          @switch (normalized.kind) {
            @case ('bash') {
              <div
                data-testid="terminal-output"
                class="bg-sw-bg-input text-sw-code-lime font-mono p-3 rounded overflow-x-auto"
              >
                <pre class="m-0 bg-transparent p-0">$ {{ asBash(normalized).command }}</pre>
              </div>
            }
            @case ('read') {
              <div data-testid="file-path" class="text-sw-code-blue text-xs mb-1 font-mono">
                {{ asRead(normalized).file_path }}
              </div>
            }
            @case ('write') {
              <div data-testid="file-path" class="text-sw-code-blue text-xs mb-1 font-mono">
                {{ asWrite(normalized).file_path }}
              </div>
              <pre
                data-testid="code-block"
                class="bg-sw-bg-abyss text-sw-text p-3 rounded overflow-x-auto text-[13px] my-1"
                >{{ asWrite(normalized).content }}</pre
              >
            }
            @case ('edit') {
              <div data-testid="file-path" class="text-sw-code-blue text-xs mb-1 font-mono">
                {{ asEdit(normalized).file_path }}
              </div>
              <div
                class="bg-sw-bg-abyss p-3 rounded overflow-x-auto text-[13px] my-1 font-mono whitespace-pre-wrap"
              >
                @for (
                  line of diffLines(asEdit(normalized).old_string, asEdit(normalized).new_string);
                  track $index
                ) {
                  <div
                    [class]="
                      line.startsWith('+')
                        ? 'bg-[rgba(34,197,94,0.15)] text-sw-code-green'
                        : line.startsWith('-')
                          ? 'bg-[rgba(239,68,68,0.15)] text-sw-code-red'
                          : 'text-sw-text'
                    "
                    [attr.data-testid]="
                      line.startsWith('+')
                        ? 'diff-add'
                        : line.startsWith('-')
                          ? 'diff-remove'
                          : 'diff-ctx'
                    "
                  >
                    {{ line }}
                  </div>
                }
              </div>
            }
            @case ('glob') {
              <div class="text-sw-text-lavender text-[13px]">
                Pattern:
                <code class="bg-sw-bg-abyss px-1.5 py-0.5 rounded-sm">{{
                  asGlob(normalized).pattern
                }}</code>
              </div>
            }
            @case ('grep') {
              <div class="text-sw-text-lavender text-[13px]">
                Pattern:
                <code class="bg-sw-bg-abyss px-1.5 py-0.5 rounded-sm">{{
                  asGrep(normalized).pattern
                }}</code>
              </div>
            }
            @case ('web_search') {
              <div class="text-sw-text-lavender text-[13px]">
                Query: {{ asWebSearch(normalized).query }}
              </div>
            }
            @case ('web_fetch') {
              <div class="text-sw-text-lavender text-[13px]">
                URL: {{ asWebFetch(normalized).url }}
              </div>
            }
            @case ('agent') {
              <div class="text-sw-text-lavender text-[13px]">
                {{ asAgent(normalized).description }}
              </div>
            }
            @case ('todo_write') {
              <div class="flex flex-col gap-1">
                @for (todo of asTodoWrite(normalized).todos; track todo.id) {
                  <div class="text-sw-text text-[13px]">
                    <span class="font-mono mr-1">{{
                      todo.status === 'completed' ? '[x]' : '[ ]'
                    }}</span>
                    {{ todo.title }}
                  </div>
                }
              </div>
            }
            @default {
              <pre
                data-testid="code-block"
                class="bg-sw-bg-abyss text-sw-text p-3 rounded overflow-x-auto text-[13px] my-1"
                >{{ asGeneric(normalized).raw_json }}</pre
              >
            }
          }
          @if (tool.status !== 'running') {
            <div
              data-testid="tool-result"
              class="mt-2 border-t border-sw-border pt-2"
              [attr.data-error]="tool.result_is_error ? 'true' : null"
              [class.text-sw-error-light]="tool.result_is_error"
            >
              <div
                data-testid="result-label"
                [class]="
                  tool.result_is_error
                    ? 'text-sw-error-light text-[11px] uppercase mb-1'
                    : 'text-sw-code-gray text-[11px] uppercase mb-1'
                "
              >
                {{ tool.result_is_error ? 'Error' : 'Result' }}
              </div>
              <pre
                data-testid="result-content"
                class="bg-sw-bg-abyss text-sw-text p-2 rounded overflow-x-auto text-xs max-h-[300px] overflow-y-auto m-0"
                >{{ tool.result }}</pre
              >
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class ToolBlockComponent {
  @Input({ required: true }) tool!: ToolUseBlock;

  private normalizer = inject(ToolNormalizerService);
  private cdr = inject(ChangeDetectorRef);

  /** Collapsed state keyed by tool_id (avoids mutating @Input). */
  private collapsedTools = new Set<string>();

  /** Cached normalized result and the input_json it was computed from. */
  private cachedInputJson = '';
  private cachedNormalized: NormalizedToolInput | null = null;

  /** Returns the normalized tool input, caching the result until input_json changes. */
  get normalized(): NormalizedToolInput {
    if (this.cachedInputJson !== this.tool.input_json || !this.cachedNormalized) {
      this.cachedInputJson = this.tool.input_json;
      this.cachedNormalized = this.normalizer.normalize(this.tool.tool_name, this.tool.input_json);
    }
    return this.cachedNormalized;
  }

  /** Returns whether this tool block is collapsed. */
  isCollapsed(): boolean {
    return this.collapsedTools.has(this.tool.tool_id);
  }

  /** Toggles collapsed state for this tool block. */
  toggleCollapsed(): void {
    if (this.collapsedTools.has(this.tool.tool_id)) {
      this.collapsedTools.delete(this.tool.tool_id);
    } else {
      this.collapsedTools.add(this.tool.tool_id);
    }
    this.cdr.markForCheck();
  }

  /** Returns a one-line summary for the collapsed tool header. */
  get headerSummary(): string {
    const n = this.normalized;
    switch (n.kind) {
      case 'bash':
        return n.command.length > 60 ? n.command.slice(0, 60) + '...' : n.command;
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
        return `${n.todos.length} items`;
      case 'generic':
        return '';
    }
  }

  /**
   * Produces a simple side-by-side diff view showing removed and added lines.
   * This is a line-level display (all old lines as removals, all new lines as additions),
   * not a true LCS-based diff algorithm.
   * @param oldStr - The original text content.
   * @param newStr - The replacement text content.
   */
  diffLines(oldStr: string, newStr: string): string[] {
    const lines: string[] = [];
    for (const line of oldStr.split('\n')) {
      lines.push(`- ${line}`);
    }
    for (const line of newStr.split('\n')) {
      lines.push(`+ ${line}`);
    }
    return lines;
  }

  /**
   * Narrows to bash.
   * @param n - The normalized input.
   */
  asBash(n: NormalizedToolInput) {
    return n as Extract<NormalizedToolInput, { kind: 'bash' }>;
  }
  /**
   * Narrows to read.
   * @param n - The normalized input.
   */
  asRead(n: NormalizedToolInput) {
    return n as Extract<NormalizedToolInput, { kind: 'read' }>;
  }
  /**
   * Narrows to write.
   * @param n - The normalized input.
   */
  asWrite(n: NormalizedToolInput) {
    return n as Extract<NormalizedToolInput, { kind: 'write' }>;
  }
  /**
   * Narrows to edit.
   * @param n - The normalized input.
   */
  asEdit(n: NormalizedToolInput) {
    return n as Extract<NormalizedToolInput, { kind: 'edit' }>;
  }
  /**
   * Narrows to glob.
   * @param n - The normalized input.
   */
  asGlob(n: NormalizedToolInput) {
    return n as Extract<NormalizedToolInput, { kind: 'glob' }>;
  }
  /**
   * Narrows to grep.
   * @param n - The normalized input.
   */
  asGrep(n: NormalizedToolInput) {
    return n as Extract<NormalizedToolInput, { kind: 'grep' }>;
  }
  /**
   * Narrows to web_search.
   * @param n - The normalized input.
   */
  asWebSearch(n: NormalizedToolInput) {
    return n as Extract<NormalizedToolInput, { kind: 'web_search' }>;
  }
  /**
   * Narrows to web_fetch.
   * @param n - The normalized input.
   */
  asWebFetch(n: NormalizedToolInput) {
    return n as Extract<NormalizedToolInput, { kind: 'web_fetch' }>;
  }
  /**
   * Narrows to agent.
   * @param n - The normalized input.
   */
  asAgent(n: NormalizedToolInput) {
    return n as Extract<NormalizedToolInput, { kind: 'agent' }>;
  }
  /**
   * Narrows to todo_write.
   * @param n - The normalized input.
   */
  asTodoWrite(n: NormalizedToolInput) {
    return n as Extract<NormalizedToolInput, { kind: 'todo_write' }>;
  }
  /**
   * Narrows to generic.
   * @param n - The normalized input.
   */
  asGeneric(n: NormalizedToolInput) {
    return n as Extract<NormalizedToolInput, { kind: 'generic' }>;
  }
}
