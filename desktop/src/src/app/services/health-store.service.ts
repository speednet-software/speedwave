import { Injectable, signal } from '@angular/core';
import type { HealthReport } from '../models/health';

/** SSOT for the latest health snapshot. */
@Injectable({ providedIn: 'root' })
export class HealthStoreService {
  /** Latest health report; `null` until the first fetch lands. */
  readonly health = signal<HealthReport | null>(null);
}
