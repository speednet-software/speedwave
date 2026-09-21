import { describe, it, expect } from 'vitest';
import { routes } from './app.routes';
import { settingsUnsavedChangesGuard } from './guards/settings-unsaved-changes.guard';

describe('app routes', () => {
  it('the settings route carries the unsaved-changes deactivation guard', () => {
    const shell = routes.find((r) => r.path === '');
    const settings = shell?.children?.find((r) => r.path === 'settings');
    expect(settings?.canDeactivate).toEqual([settingsUnsavedChangesGuard]);
  });
});
