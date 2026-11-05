import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import type { ConnectedPosition } from '@angular/cdk/overlay';
import { IMAGE_MEDIA_TYPES } from '../../models/chat';
import { isSupportedImageType } from '../../services/image-preprocessor.service';
import { IconComponent } from '../../shared/icon.component';

type PickMode = 'files' | 'images';

/** Files one dialog returned to attach, and messages for the user about the ones it refused. */
export interface PickedFiles {
  files: File[];
  notices: string[];
}

const IMAGE_ACCEPT = IMAGE_MEDIA_TYPES.join(',');

const IMAGES_LABEL = 'Attach images…';

/**
 * The composer's "+" (SPEED-74): a menu that opens the system file dialog for any file or for images.
 * The dialog's image filter is only a hint (macOS ignores it), so a non-image picked as an image is refused here.
 */
@Component({
  selector: 'app-attach-menu',
  imports: [CdkMenuTrigger, CdkMenu, CdkMenuItem, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block shrink-0' },
  template: `
    <button
      type="button"
      data-testid="composer-attach"
      class="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--line-strong)] text-[var(--ink-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
      [class.border-[var(--accent)]]="trigger.isOpen()"
      [class.text-[var(--accent)]]="trigger.isOpen()"
      aria-label="Add attachment"
      [disabled]="disabled()"
      [cdkMenuTriggerFor]="menu"
      [cdkMenuPosition]="menuPositions"
      #trigger="cdkMenuTriggerFor"
    >
      <app-icon
        name="plus"
        class="h-4 w-4 transition-transform"
        [class.rotate-45]="trigger.isOpen()"
      />
    </button>
    <input
      #picker
      type="file"
      multiple
      hidden
      data-testid="composer-file-picker"
      (change)="onPicked($event)"
    />
    <ng-template #menu>
      <div
        cdkMenu
        data-testid="composer-attach-menu"
        class="w-64 rounded border border-[var(--line)] bg-[var(--bg-1)] py-1 text-[12px] shadow-lg"
      >
        <button
          type="button"
          cdkMenuItem
          data-testid="composer-attach-files"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--ink)] hover:bg-[var(--accent)]/10 focus:bg-[var(--accent)]/10 focus:outline-none"
          (cdkMenuItemTriggered)="openDialog('files')"
        >
          <app-icon name="document" class="h-4 w-4 text-[var(--ink-mute)]" />
          Attach files…
        </button>
        <button
          type="button"
          cdkMenuItem
          data-testid="composer-attach-images"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--ink)] hover:bg-[var(--accent)]/10 focus:bg-[var(--accent)]/10 focus:outline-none"
          (cdkMenuItemTriggered)="openDialog('images')"
        >
          <app-icon name="image" class="h-4 w-4 text-[var(--ink-mute)]" />
          {{ imagesLabel }}
        </button>
        <p
          class="mono mt-1 border-t border-[var(--line)] px-3 pb-1 pt-1.5 text-[10px] leading-snug text-[var(--ink-mute)]"
        >
          You can also drop files on the message box or paste them.
        </p>
      </div>
    </ng-template>
  `,
})
export class AttachMenuComponent {
  readonly disabled = input(false);

  readonly picked = output<PickedFiles>();

  protected readonly imagesLabel = IMAGES_LABEL;

  protected readonly menuPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -8 },
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 8 },
  ];

  private readonly picker = viewChild.required<ElementRef<HTMLInputElement>>('picker');

  private mode: PickMode = 'files';

  /**
   * Opens the system file dialog; images mode asks it to show only the image types the image pipeline takes.
   * @param mode - The menu item that was chosen.
   */
  protected openDialog(mode: PickMode): void {
    if (this.disabled()) return;
    this.mode = mode;
    const picker = this.picker().nativeElement;
    picker.accept = mode === 'images' ? IMAGE_ACCEPT : '';
    picker.click();
  }

  /**
   * Emits what the dialog returned and clears the input, so the same file can be picked again.
   * @param event - The `change` event of the file input.
   */
  protected onPicked(event: Event): void {
    const picker = event.target as HTMLInputElement;
    const chosen = Array.from(picker.files ?? []);
    picker.value = '';
    if (chosen.length === 0) return;
    if (this.mode === 'files') {
      this.picked.emit({ files: chosen, notices: [] });
      return;
    }
    const files: File[] = [];
    const refused: string[] = [];
    for (const file of chosen) {
      if (isSupportedImageType(file.type)) files.push(file);
      else refused.push(file.name);
    }
    const notices =
      refused.length > 0
        ? [`Only images can be attached with ${IMAGES_LABEL}: ${refused.join(', ')}`]
        : [];
    this.picked.emit({ files, notices });
  }
}
