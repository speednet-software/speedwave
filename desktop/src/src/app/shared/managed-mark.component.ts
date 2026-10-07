import { ChangeDetectionStrategy, Component } from '@angular/core';

/** The mark of a machine under its organisation's management (inline SVG, `currentColor`). */
@Component({
  selector: 'app-managed-mark',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'img',
    'aria-label': 'Managed by your organisation',
    class: 'inline-block shrink-0',
  },
  template: `
    <svg viewBox="0 0 24 24" class="h-full w-full" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="currentColor"
        d="M12 1.8 20.6 5v6.2c0 5.3-3.6 9.9-8.6 11-5-1.1-8.6-5.7-8.6-11V5L12 1.8Zm0 2.1L5.4 6.4v4.8c0 4.2 2.8 7.9 6.6 8.9 3.8-1 6.6-4.7 6.6-8.9V6.4L12 3.9Z"
      />
    </svg>
  `,
})
export class ManagedMarkComponent {}
