import { CanActivateFn } from '@angular/router';
import { inject } from '@angular/core';

import { betaEnabledGuard } from './beta-enabled.guard';
import { TranscriptionService } from '../services/transcription.service';

/**
 * Guards `/meeting-transcription`: beta-gated (ADR-058/056), except while a recording runs.
 * @param route - activated route snapshot, forwarded to the beta guard.
 * @param state - router state snapshot, forwarded to the beta guard.
 * @returns `true`, or the beta guard's verdict (a `/chat` redirect when beta is off).
 */
export const transcriptionRouteGuard: CanActivateFn = (route, state) => {
  if (inject(TranscriptionService).recording()) return true;
  return betaEnabledGuard(route, state);
};
