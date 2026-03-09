import { CanActivateFn } from '@angular/router';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { TauriService } from '../services/tauri.service';

/** Redirects to /settings if setup is already complete (prevents re-running wizard). */
export const setupNotCompleteGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const tauri = inject(TauriService);
  try {
    const complete = await tauri.invoke<boolean>('is_setup_complete');
    return complete ? router.createUrlTree(['/settings']) : true;
  } catch {
    return true;
  }
};
