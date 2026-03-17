import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import type { SessionStats } from '../../models/chat';

/** Displays session cost and token usage statistics. */
@Component({
  selector: 'app-session-stats',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (stats) {
      <div
        data-testid="session-stats"
        class="flex gap-4 px-4 py-2 text-xs text-sw-code-gray border-t border-sw-border-dark"
      >
        <span class="whitespace-nowrap">Cost: \${{ stats.cost_usd.toFixed(4) }}</span>
        <span class="whitespace-nowrap">Total: \${{ stats.total_cost.toFixed(4) }}</span>
        @if (stats.usage) {
          <span class="whitespace-nowrap">In: {{ stats.usage.input_tokens }}</span>
          <span class="whitespace-nowrap">Out: {{ stats.usage.output_tokens }}</span>
          @if (stats.usage.cache_read_tokens) {
            <span class="whitespace-nowrap">Cache read: {{ stats.usage.cache_read_tokens }}</span>
          }
          @if (stats.usage.cache_write_tokens) {
            <span class="whitespace-nowrap">Cache write: {{ stats.usage.cache_write_tokens }}</span>
          }
        }
      </div>
    }
  `,
})
export class SessionStatsComponent {
  @Input() stats: SessionStats | null = null;
}
