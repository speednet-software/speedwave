import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The Auditor mark (monochrome tulip) — inline SVG with fill="currentColor", like the Speedwave
 * logo (CSS mask: url() breaks under tauri://localhost). Shown wherever Auditor controls something.
 */
@Component({
  selector: 'app-auditor-mark',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'img', 'aria-label': 'Auditor', class: 'inline-block shrink-0' },
  template: `
    <svg viewBox="0 0 24 24" class="h-full w-full" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="currentColor"
        fill-rule="evenodd"
        d="M22.35 4.35 L22.05 4.24 L21.80 4.24 L21.48 4.35 L15.00 8.42 L14.22 9.00 L13.61 9.62 L13.15 10.20 L12.75 10.85 L12.40 11.61 L12.18 12.29 L11.99 13.24 L11.93 14.10 L11.93 23.32 L12.06 23.64 L12.29 23.87 L12.53 23.97 L12.75 23.98 L12.93 23.95 L13.13 23.86 L20.38 19.32 L20.90 18.92 L21.28 18.56 L21.63 18.15 L22.04 17.51 L22.39 16.75 L22.59 16.11 L22.75 15.35 L22.83 14.56 L22.83 5.08 L22.78 4.87 L22.64 4.60ZM1.69 3.43 L1.52 3.54 L1.31 3.78 L1.20 4.02 L1.15 4.32 L1.17 14.43 L1.23 15.06 L1.44 16.07 L1.60 16.56 L1.79 17.02 L2.15 17.69 L2.56 18.24 L2.93 18.62 L3.50 19.08 L10.65 23.49 L10.20 22.85 L8.89 20.66 L7.21 17.80 L6.17 15.92 L5.39 14.32 L5.09 13.50 L4.95 12.96 L4.79 11.88 L4.78 11.00 L4.84 10.28 L5.03 9.35 L5.35 8.43 L5.70 7.70 L6.08 7.07 L6.74 6.14 L2.53 3.51 L2.29 3.40 L2.15 3.37 L1.90 3.37ZM12.91 0.00 L12.67 0.00 L12.50 0.05 L12.29 0.16 L12.09 0.36 L6.80 7.91 L6.41 8.64 L6.23 9.07 L5.98 9.89 L5.85 10.66 L5.84 11.72 L5.93 12.53 L6.11 13.23 L6.44 14.10 L7.31 15.77 L7.88 16.80 L9.57 19.74 L10.88 21.96 L10.88 13.68 L10.96 12.96 L11.06 12.40 L11.36 11.36 L11.64 10.66 L12.12 9.81 L12.56 9.19 L12.94 8.75 L13.31 8.38 L13.94 7.85 L14.74 7.28 L15.65 6.74 L16.60 6.23 L13.61 0.49 L13.51 0.35 L13.34 0.17 L13.15 0.06Z"
      />
    </svg>
  `,
})
export class AuditorMarkComponent {}
