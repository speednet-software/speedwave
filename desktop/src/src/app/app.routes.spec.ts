import { describe, it, expect } from 'vitest';
import { Route } from '@angular/router';

import { routes } from './app.routes';
import { settingsUnsavedChangesGuard } from './guards/settings-unsaved-changes.guard';

describe('app routes', () => {
  function shellChild(path: string): Route | undefined {
    const shell = routes.find((r) => r.path === '');
    return shell?.children?.find((r) => r.path === path);
  }

  it('opens meeting transcription without a guard, whatever the beta toggle', () => {
    const route = shellChild('meeting-transcription');
    expect(route).toBeDefined();
    expect(route?.canActivate).toBeUndefined();
    expect(route?.canMatch).toBeUndefined();
  });

  it('the settings route carries the unsaved-changes deactivation guard', () => {
    expect(shellChild('settings')?.canDeactivate).toEqual([settingsUnsavedChangesGuard]);
  });
});
