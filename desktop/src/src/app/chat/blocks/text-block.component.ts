import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { marked } from 'marked';

/** Renders markdown-formatted text content as sanitized HTML. */
@Component({
  selector: 'app-text-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `<div class="prose-sw" [innerHTML]="rendered"></div>`,
})
export class TextBlockComponent {
  @Input({ required: true }) content!: string;

  /** Converts the raw markdown content to HTML via the marked library. */
  get rendered(): string {
    return marked.parse(this.content, { async: false }) as string;
  }
}
