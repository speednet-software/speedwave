import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { AttachmentKind } from '../../models/chat';
import { formatBytes } from '../../shared/format-bytes';
import { IconComponent } from '../../shared/icon.component';
import { SpinIconComponent } from '../../shared/spin-icon.component';

/** View-model rendered as one pill in the attachment strip. */
export interface AttachmentViewModel {
  id: string;
  filename: string;
  kind: AttachmentKind;
  previewUrl: string;
  sizeBytes: number;
  staging: boolean;
}

/** Stateless pill row: thumbnails for images, name-and-size pills for other files; emits `remove(id)`. */
@Component({
  selector: 'app-attachment-strip',
  imports: [IconComponent, SpinIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (attachments().length > 0) {
      <ul data-testid="composer-attachment-strip" class="mb-2 flex flex-wrap items-center gap-2">
        @for (att of attachments(); track att.id) {
          <li class="relative">
            @if (att.kind === 'image') {
              <img
                [src]="att.previewUrl"
                [alt]="att.filename"
                [title]="att.filename + ' (' + formatBytes(att.sizeBytes) + ')'"
                class="h-14 w-14 rounded border border-[var(--line)] object-cover"
              />
            } @else {
              <div
                data-testid="composer-attachment-file"
                class="mono flex h-14 max-w-[14rem] items-center gap-1.5 rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 text-[11px] text-[var(--ink-dim)]"
                [title]="att.filename + ' (' + formatBytes(att.sizeBytes) + ')'"
              >
                <app-icon name="document" class="h-4 w-4 text-[var(--ink-mute)]" />
                <span class="min-w-0 truncate text-[var(--ink)]">{{ att.filename }}</span>
                <span class="shrink-0 text-[var(--ink-mute)]">{{
                  formatBytes(att.sizeBytes)
                }}</span>
              </div>
            }
            @if (att.staging) {
              <div
                class="absolute inset-0 flex items-center justify-center rounded bg-black/50"
                role="status"
                [attr.aria-label]="'Preparing ' + att.filename"
              >
                <app-spin-icon class="h-4 w-4 text-white" />
              </div>
            }
            <button
              type="button"
              data-testid="composer-attachment-remove"
              class="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full border border-[var(--line)] bg-[var(--bg-1)] text-[10px] leading-none text-[var(--ink-mute)] hover:text-[var(--ink)]"
              [attr.aria-label]="'Remove ' + att.kind + ' ' + att.filename"
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

  readonly formatBytes = formatBytes;
}
