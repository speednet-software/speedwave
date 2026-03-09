import { CanActivateFn } from '@angular/router';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { TauriService } from '../services/tauri.service';

/** Redirects to /setup if the initial setup wizard has not been completed. */
export const setupCompleteGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const tauri = inject(TauriService);
  try {
    const complete = await tauri.invoke<boolean>('is_setup_complete');
    return complete ? true : router.createUrlTree(['/setup']);
  } catch {
    return true;
  }
};
