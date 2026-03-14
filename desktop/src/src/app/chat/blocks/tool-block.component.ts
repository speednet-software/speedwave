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
  template: `
    <div class="tool-block">
      <div
        class="tool-header"
        role="button"
        tabindex="0"
        (click)="toggleCollapsed()"
        (keydown.enter)="toggleCollapsed()"
      >
        <span class="tool-status" [class]="'tool-status-' + tool.status">
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
        <span class="tool-name">{{ tool.tool_name }}</span>
        <span class="tool-summary">{{ headerSummary }}</span>
      </div>
      @if (!isCollapsed()) {
        <div class="tool-body">
          @switch (normalized.kind) {
            @case ('bash') {
              <div class="terminal-output">
                <pre>$ {{ asBash(normalized).command }}</pre>
              </div>
            }
            @case ('read') {
              <div class="file-path">{{ asRead(normalized).file_path }}</div>
            }
            @case ('write') {
              <div class="file-path">{{ asWrite(normalized).file_path }}</div>
              <pre class="code-block">{{ asWrite(normalized).content }}</pre>
            }
            @case ('edit') {
              <div class="file-path">{{ asEdit(normalized).file_path }}</div>
              <div class="diff-block">
                @for (
                  line of diffLines(asEdit(normalized).old_string, asEdit(normalized).new_string);
                  track $index
                ) {
                  <div
                    [class]="
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
              <div class="tool-detail">
                Pattern: <code>{{ asGlob(normalized).pattern }}</code>
              </div>
            }
            @case ('grep') {
              <div class="tool-detail">
                Pattern: <code>{{ asGrep(normalized).pattern }}</code>
              </div>
            }
            @case ('web_search') {
              <div class="tool-detail">Query: {{ asWebSearch(normalized).query }}</div>
            }
            @case ('web_fetch') {
              <div class="tool-detail">URL: {{ asWebFetch(normalized).url }}</div>
            }
            @case ('agent') {
              <div class="tool-detail">{{ asAgent(normalized).description }}</div>
            }
            @case ('todo_write') {
              <div class="todo-list">
                @for (todo of asTodoWrite(normalized).todos; track todo.id) {
                  <div class="todo-item">
                    <span class="todo-status">{{
                      todo.status === 'completed' ? '[x]' : '[ ]'
                    }}</span>
                    {{ todo.title }}
                  </div>
                }
              </div>
            }
            @default {
              <pre class="code-block">{{ asGeneric(normalized).raw_json }}</pre>
            }
          }
          @if (tool.result) {
            <div class="tool-result" [class.tool-result-error]="tool.result_is_error">
              <div class="result-label">{{ tool.result_is_error ? 'Error' : 'Result' }}</div>
              <pre class="result-content">{{ tool.result }}</pre>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      margin: 8px 0;
    }
    .tool-block {
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 6px;
    }
    .tool-header {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      cursor: pointer;
      gap: 8px;
    }
    .tool-name {
      font-weight: bold;
      color: #e94560;
      font-size: 13px;
    }
    .tool-summary {
      color: #888;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .tool-status-running {
      color: #fbbf24;
    }
    .tool-status-done {
      color: #34d399;
    }
    .tool-status-error {
      color: #f87171;
    }
    .tool-body {
      padding: 0 12px 12px;
    }
    .file-path {
      color: #93c5fd;
      font-size: 12px;
      margin-bottom: 4px;
      font-family: monospace;
    }
    .code-block {
      background: #0d1b2a;
      color: #e0e0e0;
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 13px;
      margin: 4px 0;
    }
    .diff-block {
      background: #0d1b2a;
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 13px;
      margin: 4px 0;
      font-family: monospace;
      white-space: pre-wrap;
    }
    .diff-add {
      background: rgba(34, 197, 94, 0.15);
      color: #86efac;
    }
    .diff-remove {
      background: rgba(239, 68, 68, 0.15);
      color: #fca5a5;
    }
    .diff-ctx {
      color: #e0e0e0;
    }
    .terminal-output {
      background: #0d0d0d;
      color: #a3e635;
      font-family: monospace;
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
    }
    .terminal-output pre {
      margin: 0;
      background: none;
      padding: 0;
    }
    .tool-detail {
      color: #a0a0c0;
      font-size: 13px;
    }
    .tool-detail code {
      background: #0d1b2a;
      padding: 2px 6px;
      border-radius: 3px;
    }
    .todo-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .todo-item {
      color: #e0e0e0;
      font-size: 13px;
    }
    .todo-status {
      font-family: monospace;
      margin-right: 4px;
    }
    .tool-result {
      margin-top: 8px;
      border-top: 1px solid #0f3460;
      padding-top: 8px;
    }
    .tool-result-error .result-label {
      color: #f87171;
    }
    .result-label {
      color: #6b7280;
      font-size: 11px;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .result-content {
      background: #0d1b2a;
      color: #e0e0e0;
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 12px;
      max-height: 300px;
      overflow-y: auto;
      margin: 0;
    }
  `,
})
export class ToolBlockComponent {
  @Input({ required: true }) tool!: ToolUseBlock;

  private normalizer = inject(ToolNormalizerService);
  private cdr = inject(ChangeDetectorRef);

  /** Local collapsed state keyed by tool_id (avoids mutating @Input). */
  private static collapsedTools = new Set<string>();

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
    return ToolBlockComponent.collapsedTools.has(this.tool.tool_id);
  }

  /** Toggles collapsed state for this tool block. */
  toggleCollapsed(): void {
    if (ToolBlockComponent.collapsedTools.has(this.tool.tool_id)) {
      ToolBlockComponent.collapsedTools.delete(this.tool.tool_id);
    } else {
      ToolBlockComponent.collapsedTools.add(this.tool.tool_id);
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
