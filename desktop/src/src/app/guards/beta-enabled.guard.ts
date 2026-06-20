import { CanActivateFn } from '@angular/router';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { TauriService } from '../services/tauri.service';

/**
 * Guards beta-only routes (e.g. /meeting-transcription, ADR-058/056).
 * Redirects to /chat when beta is off.
 */
export const betaEnabledGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const tauri = inject(TauriService);
  try {
    const enabled = await tauri.invoke<boolean>('get_beta_enabled');
    return enabled ? true : router.createUrlTree(['/chat']);
  } catch {
    // No Tauri host (web tests) — treat as disabled.
    return router.createUrlTree(['/chat']);
  }
};
