import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { formatBytes } from '../../shared/format-bytes';
import { SpinIconComponent } from '../../shared/spin-icon.component';

/** View-model rendered as one pill in the attachment strip. */
export interface AttachmentViewModel {
  id: string;
  filename: string;
  /** Blob URL owned by the composer. */
  previewUrl: string;
  encodedSizeBytes: number;
  preprocessing: boolean;
}

/** Stateless pill-thumbnail row; emits `remove(id)`. */
@Component({
  selector: 'app-attachment-strip',
  imports: [SpinIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (attachments().length > 0) {
      <ul data-testid="composer-attachment-strip" class="mb-2 flex flex-wrap items-center gap-2">
        @for (att of attachments(); track att.id) {
          <li class="relative">
            <img
              [src]="att.previewUrl"
              [alt]="att.filename"
              [title]="att.filename + ' (' + formatBytes(att.encodedSizeBytes) + ')'"
              class="h-14 w-14 rounded border border-[var(--line)] object-cover"
            />
            @if (att.preprocessing) {
              <div
                class="absolute inset-0 flex items-center justify-center rounded bg-black/50"
                role="status"
                [attr.aria-label]="'Preprocessing ' + att.filename"
              >
                <app-spin-icon class="h-4 w-4 text-white" />
              </div>
            }
            <button
              type="button"
              data-testid="composer-attachment-remove"
              class="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full border border-[var(--line)] bg-[var(--bg-1)] text-[10px] leading-none text-[var(--ink-mute)] hover:text-[var(--ink)]"
              [attr.aria-label]="'Remove image ' + att.filename"
              (click)="remove.emit(att.id)"
            >
              ×
            </button>
          </li>
        }
      </ul>
    }
  `,
})
export class AttachmentStripComponent {
  readonly attachments = input.required<ReadonlyArray<AttachmentViewModel>>();
  readonly remove = output<string>();

  /** Pretty-prints a byte count for the thumbnail title (shared helper). */
  readonly formatBytes = formatBytes;
}
