import { CanDeactivateFn } from '@angular/router';
import { inject } from '@angular/core';
import { SettingsDirtyService } from '../settings/settings-dirty.service';

/**
 * Blocks leaving /settings while a Save-gated section has unsaved edits (SPEED-637).
 * Prompts save-and-leave / leave-without-saving / stay via SettingsDirtyService.
 */
export const settingsUnsavedChangesGuard: CanDeactivateFn<unknown> = async () => {
  const dirty = inject(SettingsDirtyService);
  if (dirty.consumeSuppression()) return true;
  if (!dirty.hasDirty()) return true;
  const choice = await dirty.confirmLeave();
  if (choice === 'stay') return false;
  if (choice === 'discard') return true;
  return dirty.saveDirtySections();
};
