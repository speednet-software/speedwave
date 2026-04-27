import { Routes } from '@angular/router';
import { setupCompleteGuard } from './guards/setup-complete.guard';
import { setupNotCompleteGuard } from './guards/setup-not-complete.guard';

export const routes: Routes = [
  {
    path: 'setup',
    canActivate: [setupNotCompleteGuard],
    loadComponent: () =>
      import('./setup/setup-wizard.component').then((m) => m.SetupWizardComponent),
  },
  {
    path: '',
    canActivate: [setupCompleteGuard],
    loadComponent: () => import('./shell/shell.component').then((m) => m.ShellComponent),
    children: [
      { path: '', redirectTo: 'chat', pathMatch: 'full' },
      {
        path: 'chat',
        // No authRequiredGuard — the chat view itself surfaces an inline
        // "auth required" block (mockup-aligned) so the user can still see
        // where they are and one-click jump to Settings.
        loadComponent: () => import('./chat/chat.component').then((m) => m.ChatComponent),
      },
      {
        path: 'integrations',
        loadComponent: () =>
          import('./integrations/integrations.component').then((m) => m.IntegrationsComponent),
      },
      {
        path: 'plugins',
        loadComponent: () => import('./plugins/plugins.component').then((m) => m.PluginsComponent),
      },
      {
        path: 'plugins/:slug',
        loadComponent: () =>
          import('./plugins/plugin-detail/plugin-detail.component').then(
            (m) => m.PluginDetailComponent
          ),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./settings/settings.component').then((m) => m.SettingsComponent),
      },
      {
        path: 'system',
        loadComponent: () =>
          import('./system-view/system-view.component').then((m) => m.SystemViewComponent),
      },
      {
        path: 'logs',
        loadComponent: () =>
          import('./logs-view/logs-view.component').then((m) => m.LogsViewComponent),
      },
    ],
  },
];
