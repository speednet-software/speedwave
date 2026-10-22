import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { CustomMcpService } from '../services/custom-mcp.service';
import type {
  CustomMcpTool,
  CustomMcpToolDecision,
  CustomMcpToolDecisionState,
} from '../models/custom-mcp';
import { CHANGED_TOOL_TEXT, READ_ONLY_PRESET_NOTE, capText, errorText } from './custom-mcp-text';

/** A bulk choice over a server's tools. */
export type ToolPreset = 'all' | 'read_only' | 'manual';

/**
 * A decision for `tool`, pinned to the definition hash the user saw.
 * @param tool - the listed tool
 * @param state - the decision
 */
export function decisionFor(
  tool: CustomMcpTool,
  state: CustomMcpToolDecisionState
): CustomMcpToolDecision {
  return { upstream_name: tool.upstream_name, state, definition_hash: tool.definition_hash };
}

/**
 * The decisions a preset records: only tools whose state it changes, never a `changed` tool,
 * which only an explicit review re-allows.
 * @param preset - the bulk choice
 * @param tools - the listed tools
 */
export function presetDecisions(
  preset: ToolPreset,
  tools: readonly CustomMcpTool[]
): CustomMcpToolDecision[] {
  if (preset === 'manual') return [];
  return tools
    .filter((t) => t.state !== 'changed')
    .map((t) => {
      const target: CustomMcpToolDecisionState =
        preset === 'all' || t.read_only_hint === true ? 'allowed' : 'blocked';
      return { tool: t, target };
    })
    .filter(({ tool, target }) => tool.state !== target)
    .map(({ tool, target }) => decisionFor(tool, target));
}

const BUTTON =
  'mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-50';

/** Allow/block table of a Custom MCP server's tools, with bulk presets. */
@Component({
  selector: 'app-custom-mcp-tools-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="flex flex-wrap items-center gap-2" data-testid="custom-mcp-tools-presets">
      <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">Tools</span>
      <button
        type="button"
        [class]="presetClass('all')"
        [disabled]="busy()"
        [attr.aria-pressed]="preset() === 'all'"
        data-testid="custom-mcp-preset-all"
        (click)="applyPreset('all')"
      >
        all
      </button>
      <button
        type="button"
        [class]="presetClass('read_only')"
        [disabled]="busy()"
        [attr.aria-pressed]="preset() === 'read_only'"
        data-testid="custom-mcp-preset-read-only"
        (click)="applyPreset('read_only')"
      >
        read-only (unverified)
      </button>
      <button
        type="button"
        [class]="presetClass('manual')"
        [disabled]="busy()"
        [attr.aria-pressed]="preset() === 'manual'"
        data-testid="custom-mcp-preset-manual"
        (click)="applyPreset('manual')"
      >
        manual
      </button>
    </div>
    @if (preset() === 'read_only') {
      <p class="mt-1 text-[11px] text-[var(--ink-mute)]" data-testid="custom-mcp-preset-note">
        {{ readOnlyNote }}
      </p>
    }
    @if (tableError()) {
      <p
        class="mt-2 text-[12px] text-[var(--red)]"
        role="alert"
        data-testid="custom-mcp-tools-error"
      >
        {{ tableError() }}
      </p>
    }

    @if (tools().length === 0) {
      <p class="mt-2 text-[12px] text-[var(--ink-mute)]" data-testid="custom-mcp-tools-empty">
        This server lists no tools.
      </p>
    } @else {
      <div class="mt-2 overflow-hidden rounded border border-[var(--line)]">
        <table class="w-full text-[12px]" data-testid="custom-mcp-tools-table">
          <caption class="sr-only">
            Tools of this server
          </caption>
          <thead
            class="mono border-b border-[var(--line)] bg-[var(--bg-1)] text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
          >
            <tr>
              <th class="px-3 py-1.5 text-left font-normal" scope="col">tool</th>
              <th class="hidden px-3 py-1.5 text-left font-normal md:table-cell" scope="col">
                description
              </th>
              <th class="px-3 py-1.5 text-left font-normal" scope="col">hint</th>
              <th class="px-3 py-1.5 text-left font-normal" scope="col">state</th>
              <th class="px-3 py-1.5 text-right font-normal" scope="col">action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--line)]">
            @for (tool of tools(); track tool.upstream_name) {
              <tr [attr.data-testid]="'custom-mcp-tool-' + tool.upstream_name">
                <td class="mono px-3 py-1.5 text-[var(--ink)]">{{ cap(tool.exposed_name, 64) }}</td>
                <td class="hidden px-3 py-1.5 text-[var(--ink-dim)] md:table-cell">
                  {{ cap(tool.description_preview, 160) }}
                </td>
                <td class="mono px-3 py-1.5 text-[var(--ink-mute)]">
                  {{ tool.read_only_hint === true ? 'read-only' : '—' }}
                </td>
                <td class="px-3 py-1.5">
                  <span
                    class="pill"
                    [class.green]="tool.state === 'allowed'"
                    [class.amber]="tool.state === 'pending' || tool.state === 'changed'"
                    [attr.data-testid]="'custom-mcp-tool-state-' + tool.upstream_name"
                    >{{ tool.state }}</span
                  >
                </td>
                <td class="px-3 py-1.5 text-right">
                  <div class="flex flex-wrap justify-end gap-1">
                    @if (tool.state === 'changed' && reviewing() !== tool.upstream_name) {
                      <button
                        type="button"
                        [class]="buttonClass"
                        [disabled]="busy()"
                        [attr.data-testid]="'custom-mcp-tool-review-' + tool.upstream_name"
                        (click)="reviewing.set(tool.upstream_name)"
                      >
                        review
                      </button>
                    } @else {
                      @if (tool.state !== 'allowed') {
                        <button
                          type="button"
                          [class]="buttonClass"
                          [disabled]="busy()"
                          [attr.data-testid]="'custom-mcp-tool-allow-' + tool.upstream_name"
                          (click)="decide(tool, 'allowed')"
                        >
                          allow
                        </button>
                      }
                      @if (tool.state !== 'blocked') {
                        <button
                          type="button"
                          [class]="buttonClass"
                          [disabled]="busy()"
                          [attr.data-testid]="'custom-mcp-tool-block-' + tool.upstream_name"
                          (click)="decide(tool, 'blocked')"
                        >
                          {{ tool.state === 'changed' ? 'keep blocked' : 'block' }}
                        </button>
                      }
                    }
                  </div>
                </td>
              </tr>
              @if (tool.state === 'changed') {
                <tr [attr.data-testid]="'custom-mcp-tool-changed-' + tool.upstream_name">
                  <td colspan="5" class="px-3 pb-2 text-[11px] text-[var(--amber)]">
                    {{ changedText }}
                    @if (reviewing() === tool.upstream_name) {
                      <span class="mt-1 block text-[var(--ink-dim)]">
                        New description: {{ cap(tool.description_preview, 200) }}
                      </span>
                    }
                  </td>
                </tr>
              }
              @if (rowErrors()[tool.upstream_name]; as rowError) {
                <tr>
                  <td
                    colspan="5"
                    class="px-3 pb-2 text-[11px] text-[var(--red)]"
                    role="alert"
                    [attr.data-testid]="'custom-mcp-tool-error-' + tool.upstream_name"
                  >
                    {{ rowError }}
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class CustomMcpToolsTableComponent {
  /** The project of the server. */
  readonly project = input.required<string>();
  /** The server name. */
  readonly name = input.required<string>();
  /** The tools the hub last listed. */
  readonly tools = input.required<CustomMcpTool[]>();

  /** The last preset the user picked. */
  readonly preset = signal<ToolPreset>('manual');
  /** True while a decision is being saved. */
  readonly busy = signal(false);
  /** The `changed` tool whose new definition the user is reviewing. */
  readonly reviewing = signal<string | null>(null);
  /** A failed decision, by upstream tool name. */
  readonly rowErrors = signal<Record<string, string>>({});
  /** A failed preset. */
  readonly tableError = signal('');

  protected readonly changedText = CHANGED_TOOL_TEXT;
  protected readonly readOnlyNote = READ_ONLY_PRESET_NOTE;
  protected readonly buttonClass = BUTTON;
  protected readonly cap = capText;

  private readonly customMcp = inject(CustomMcpService);

  /**
   * Button classes of a preset, filled when it is the current one.
   * @param preset - the preset
   */
  presetClass(preset: ToolPreset): string {
    return this.preset() === preset
      ? 'mono rounded border border-[var(--accent-dim)] bg-[var(--accent)] px-2 py-0.5 text-[11px] text-[var(--on-accent)] disabled:opacity-50'
      : BUTTON;
  }

  /**
   * Records the decisions of a preset.
   * @param preset - the preset the user picked
   */
  async applyPreset(preset: ToolPreset): Promise<void> {
    this.preset.set(preset);
    this.tableError.set('');
    const decisions = presetDecisions(preset, this.tools());
    if (decisions.length === 0) return;
    try {
      await this.save(decisions);
    } catch (e: unknown) {
      this.tableError.set(errorText(e));
    }
  }

  /**
   * Records one tool decision; a refused one shows on its row.
   * @param tool - the tool
   * @param state - the decision
   */
  async decide(tool: CustomMcpTool, state: CustomMcpToolDecisionState): Promise<void> {
    const key = tool.upstream_name;
    this.rowErrors.update(({ [key]: _dropped, ...rest }) => rest);
    try {
      await this.save([decisionFor(tool, state)]);
      if (this.reviewing() === key) this.reviewing.set(null);
    } catch (e: unknown) {
      this.rowErrors.update((errors) => ({ ...errors, [key]: errorText(e) }));
    }
  }

  private async save(decisions: CustomMcpToolDecision[]): Promise<void> {
    this.busy.set(true);
    try {
      await this.customMcp.setTools(this.project(), this.name(), decisions);
    } catch (e: unknown) {
      void this.customMcp.refresh(this.project());
      throw e;
    } finally {
      this.busy.set(false);
    }
  }
}
