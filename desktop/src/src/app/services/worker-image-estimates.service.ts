import { Injectable, inject } from '@angular/core';
import { TauriService } from './tauri.service';
import { WorkerImageBuildEstimate } from '../models/integration';

/**
 * Frontend cache of `list_worker_image_build_estimates` — image name →
 * first-build estimate (seconds). The list is static within a session, so we
 * fetch once and reuse. Same pattern as `AnthropicModelsService`.
 */
@Injectable({ providedIn: 'root' })
export class WorkerImageEstimatesService {
  private readonly tauri = inject(TauriService);
  private cache: WorkerImageBuildEstimate[] | null = null;
  private inflight: Promise<WorkerImageBuildEstimate[]> | null = null;

  /**
   * Returns the estimate catalog. Fetches from the backend on first call;
   * subsequent calls reuse the cached result. Returns an empty list outside
   * Tauri so consumers can fall back gracefully.
   */
  async list(): Promise<WorkerImageBuildEstimate[]> {
    if (this.cache) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const result = await this.tauri.invoke<WorkerImageBuildEstimate[]>(
          'list_worker_image_build_estimates'
        );
        this.cache = Array.isArray(result) ? result : [];
      } catch {
        this.cache = [];
      } finally {
        this.inflight = null;
      }
      return this.cache ?? [];
    })();
    return this.inflight;
  }

  /**
   * Estimate for an image name (synchronous after first load); 0 if unknown.
   * @param imageName - The image repo name as it appears in IMAGES, e.g.
   *   `speedwave-mcp-playwright`. Matches `worker_image_build_status.image_name`.
   */
  secondsFor(imageName: string): number {
    if (!this.cache) return 0;
    return this.cache.find((e) => e.image_name === imageName)?.estimated_seconds ?? 0;
  }

  /** Test-only hook to reset cached state between specs. */
  resetForTesting(): void {
    this.cache = null;
    this.inflight = null;
  }
}
