import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Catalog of icon names supported by `<app-icon>`.
 *
 * All glyphs are sourced from the terminal-minimal mockup
 * (`design-proposals/06-terminal-minimal.html`) — the canonical visual
 * reference. Add a new icon by copying the mockup `<path>` markup
 * verbatim into the `@switch` block below and extending this union.
 */
export type IconName =
  | 'menu'
  | 'menu-alt'
  | 'plus'
  | 'x'
  | 'brain'
  | 'book'
  | 'chevron-right'
  | 'chevron-down'
  | 'alert-triangle'
  | 'git-branch'
  | 'message-circle'
  | 'messages-square'
  | 'code'
  | 'cube'
  | 'settings'
  | 'document'
  | 'refresh';

/**
 * Inline SVG icon — glyphs taken verbatim from the terminal-minimal mockup
 * (`design-proposals/06-terminal-minimal.html`). Mockup conventions:
 * - Primary nav / action icons use `stroke-width="1.75"`
 * - Interactive toggles / spinners use `stroke-width="2"`
 *
 * Usage:
 * ```html
 * <app-icon name="menu-alt" class="h-4 w-4 text-[var(--ink-mute)]" />
 * <app-icon name="chevron-right" strokeWidth="2" class="h-3 w-3" />
 * ```
 *
 * The host renders as `inline-flex` and the inner `<svg>` fills it via
 * `h-full w-full`. Tailwind sizing/colour applied to `<app-icon>` style
 * the icon as expected. `strokeWidth` defaults to 1.75 (mockup default).
 */
@Component({
  selector: 'app-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: ':host { display: inline-block; line-height: 0; flex-shrink: 0; }',
  template: `
    <svg
      [attr.stroke-width]="strokeWidth()"
      class="h-full w-full"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      @switch (name()) {
        @case ('menu') {
          <path d="M4 6h16M4 12h16M4 18h7" />
        }
        @case ('menu-alt') {
          <path d="M4 6h16M4 12h10M4 18h16" />
        }
        @case ('plus') {
          <path d="M12 4v16m8-8H4" />
        }
        @case ('x') {
          <path d="M6 18L18 6M6 6l12 12" />
        }
        @case ('book') {
          <path
            d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
          />
        }
        @case ('brain') {
          <path d="M12 18V5" />
          <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
          <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
          <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
          <path d="M18 18a4 4 0 0 0 2-7.464" />
          <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
          <path d="M6 18a4 4 0 0 1-2-7.464" />
          <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
        }
        @case ('chevron-right') {
          <path d="M9 5l7 7-7 7" />
        }
        @case ('chevron-down') {
          <path d="M2 4l3 3 3-3" />
        }
        @case ('alert-triangle') {
          <path
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        }
        @case ('git-branch') {
          <circle cx="6" cy="6" r="2" />
          <circle cx="6" cy="18" r="2" />
          <circle cx="18" cy="8" r="2" />
          <path d="M6 8v8m0-8a6 6 0 0 0 6 6h4" />
        }
        @case ('message-circle') {
          <path
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 0 1-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        }
        @case ('messages-square') {
          <path
            d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"
          />
          <path
            d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"
          />
        }
        @case ('code') {
          <path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        }
        @case ('cube') {
          <path d="M20 7 12 3 4 7m16 0-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        }
        @case ('settings') {
          <path
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
        }
        @case ('document') {
          <path
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z"
          />
        }
        @case ('refresh') {
          <path
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15"
          />
        }
      }
    </svg>
  `,
})
export class IconComponent {
  readonly name = input.required<IconName>();
  readonly strokeWidth = input<number>(1.75);
}
