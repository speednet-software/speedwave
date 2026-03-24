import { CanActivateFn } from '@angular/router';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { ProjectStateService } from '../services/project-state.service';

/** Redirects to /settings if Claude authentication has not been completed. */
export const authRequiredGuard: CanActivateFn = () => {
  const router = inject(Router);
  const projectState = inject(ProjectStateService);
  return projectState.status === 'auth_required' ? router.createUrlTree(['/settings']) : true;
};
