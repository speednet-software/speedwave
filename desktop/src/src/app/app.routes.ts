import { Routes } from '@angular/router';
import { setupCompleteGuard } from './guards/setup-complete.guard';
import { setupNotCompleteGuard } from './guards/setup-not-complete.guard';
import { authRequiredGuard } from './guards/auth-required.guard';

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
        canActivate: [authRequiredGuard],
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
        path: 'projects',
        canActivate: [setupCompleteGuard],
        loadComponent: () =>
          import('./projects-view/projects-view.component').then((m) => m.ProjectsViewComponent),
      },
      {
        path: 'skills',
        canActivate: [setupCompleteGuard],
        loadComponent: () =>
          import('./skills-view/skills-view.component').then((m) => m.SkillsViewComponent),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./settings/settings.component').then((m) => m.SettingsComponent),
      },
    ],
  },
];
