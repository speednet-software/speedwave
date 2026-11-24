import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SecretStoreService } from '../../services/secret-store.service';

/** Non-blocking banner for integrations whose saved credentials cannot be read. */
@Component({
  selector: 'app-secret-store-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.notices().length > 0) {
      <div
        class="mono flex items-start justify-between gap-3 border-b border-[var(--amber)]/40 bg-[var(--amber)]/10 px-4 py-1.5 text-[13px] text-[var(--ink)]"
        role="status"
        data-testid="secret-store-notice"
      >
        <ul class="space-y-0.5">
          @for (message of store.notices(); track message) {
            <li data-testid="secret-store-notice-item">{{ message }}</li>
          }
        </ul>
        <button
          type="button"
          class="cursor-pointer rounded border border-[var(--line)] bg-transparent px-2.5 py-0.5 text-xs text-[var(--ink-mute)] hover:text-[var(--ink)]"
          data-testid="secret-store-notice-dismiss"
          (click)="store.dismissNotices()"
        >
          Dismiss
        </button>
      </div>
    }
  `,
})
export class SecretStoreNoticeComponent {
  protected readonly store = inject(SecretStoreService);
}
