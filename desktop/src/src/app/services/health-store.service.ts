import { Injectable, signal } from '@angular/core';
import type { HealthReport } from '../models/health';

/**
 * SSOT for the latest health snapshot. Written by the startup health gate
 * (ProjectStateService) and the polling loop (SystemHealthService), so views
 * render real data immediately instead of a "checking…" placeholder.
 */
@Injectable({ providedIn: 'root' })
export class HealthStoreService {
  /** Latest health report; `null` until the first fetch lands. */
  readonly health = signal<HealthReport | null>(null);
}
