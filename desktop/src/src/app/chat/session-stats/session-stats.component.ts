import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import type { SessionStats } from '../../models/chat';

/** Displays session cost and token usage statistics. */
@Component({
  selector: 'app-session-stats',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (stats) {
      <div class="session-stats">
        <span class="stat">Cost: \${{ stats.cost_usd.toFixed(4) }}</span>
        <span class="stat">Total: \${{ stats.total_cost.toFixed(4) }}</span>
        @if (stats.usage) {
          <span class="stat">In: {{ stats.usage.input_tokens }}</span>
          <span class="stat">Out: {{ stats.usage.output_tokens }}</span>
          @if (stats.usage.cache_read_tokens) {
            <span class="stat">Cache read: {{ stats.usage.cache_read_tokens }}</span>
          }
          @if (stats.usage.cache_write_tokens) {
            <span class="stat">Cache write: {{ stats.usage.cache_write_tokens }}</span>
          }
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .session-stats {
      display: flex;
      gap: 16px;
      padding: 8px 16px;
      font-size: 12px;
      color: #6b7280;
      border-top: 1px solid #2d2d44;
    }
    .stat {
      white-space: nowrap;
    }
  `,
})
export class SessionStatsComponent {
  @Input() stats: SessionStats | null = null;
}
