import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { marked } from 'marked';

/** Renders markdown-formatted text content as sanitized HTML. */
@Component({
  selector: 'app-text-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="text-block" [innerHTML]="rendered"></div>`,
  styles: `
    :host {
      display: block;
    }
    .text-block :first-child {
      margin-top: 0;
    }
    .text-block :last-child {
      margin-bottom: 0;
    }
    .text-block pre {
      background: #0d1b2a;
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .text-block code {
      background: #0d1b2a;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 13px;
    }
    .text-block pre code {
      background: none;
      padding: 0;
    }
    .text-block p {
      margin: 8px 0;
    }
    .text-block ul,
    .text-block ol {
      margin: 8px 0;
      padding-left: 20px;
    }
  `,
})
export class TextBlockComponent {
  @Input({ required: true }) content!: string;

  /** Converts the raw markdown content to HTML via the marked library. */
  get rendered(): string {
    return marked.parse(this.content, { async: false }) as string;
  }
}
