import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { Router } from '@angular/router';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { AuthSectionComponent } from './auth-section/auth-section.component';
import { LlmProviderComponent } from './llm-provider/llm-provider.component';
import { SystemHealthComponent } from './system-health.component';
import { AdvancedSectionComponent } from './advanced-section/advanced-section.component';
import { UpdateSectionComponent } from './update-section/update-section.component';
import { ProjectList } from '../models/update';

/** Displays application settings and provides factory reset functionality. */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    LlmProviderComponent,
    AuthSectionComponent,
    SystemHealthComponent,
    AdvancedSectionComponent,
    UpdateSectionComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block min-h-screen bg-[var(--bg)] text-[var(--ink)] p-4 md:p-6',
  },
  template: `
    <div class="mx-auto max-w-3xl space-y-8">
      <h1 class="mono text-[14px] text-[var(--ink)] m-0" data-testid="settings-title">Settings</h1>

      @if (error) {
        <div
          class="rounded ring-1 ring-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-300"
          data-testid="settings-error"
          role="alert"
        >
          {{ error }}
        </div>
      }

      <!-- Active project info -->
      <section data-testid="settings-section-project">
        <h2
          class="mono mb-3 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
          data-testid="settings-section-project-heading"
        >
          project
        </h2>
        <div class="overflow-hidden rounded ring-1 ring-[var(--line)] bg-[var(--bg-1)]">
          <div class="divide-y divide-[var(--line)]">
            <div class="flex items-center justify-between gap-3 px-4 py-3">
              <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                >active project</span
              >
              <span
                class="mono text-[12px] text-[var(--ink)]"
                data-testid="settings-active-project"
                >{{ activeProject || 'None' }}</span
              >
            </div>
            <div class="flex items-center justify-between gap-3 px-4 py-3">
              <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                >directory</span
              >
              <span class="mono truncate text-[12px] text-[var(--ink-dim)]">{{
                projectDir || '—'
              }}</span>
            </div>
            <div class="flex items-center justify-between gap-3 px-4 py-3">
              <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                >data directory</span
              >
              <span class="mono text-[12px] text-[var(--ink-dim)]">~/.speedwave/</span>
            </div>
          </div>
        </div>
      </section>

      <!-- LLM Provider -->
      <app-llm-provider (providerChange)="llmProvider = $event" (errorOccurred)="error = $event" />

      <!-- Authentication -->
      <app-auth-section
        [activeProject]="activeProject"
        [llmProvider]="llmProvider"
        (errorOccurred)="error = $event"
      />

      <!-- Updates -->
      <app-update-section [activeProject]="activeProject" (errorOccurred)="error = $event" />

      <!-- System Health -->
      @if (activeProject) {
        <section data-testid="settings-section-health">
          <h2 class="mono mb-3 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            system health
          </h2>
          <app-system-health [project]="activeProject" />
        </section>
      }

      <!-- Logging & Danger Zone -->
      <app-advanced-section
        [activeProject]="activeProject"
        [logLevel]="logLevel"
        (errorOccurred)="error = $event"
        (resetCompleted)="onResetCompleted()"
      />
    </div>
  `,
})
export class SettingsComponent implements OnInit, OnDestroy {
  activeProject: string | null = null;
  projectDir = '';
  error = '';
  llmProvider = 'anthropic';
  logLevel = 'info';

  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private unsubProjectReady: (() => void) | null = null;

  /** Loads project information on component initialization. */
  ngOnInit(): void {
    this.loadProjectInfo();
    this.loadLogLevel();

    this.unsubProjectReady = this.projectState.onProjectReady(() => {
      this.loadProjectInfo();
    });
  }

  /** Unsubscribes from the project ready listener. */
  ngOnDestroy(): void {
    if (this.unsubProjectReady) {
      this.unsubProjectReady();
      this.unsubProjectReady = null;
    }
  }

  /** Handles factory reset completion by navigating to setup. */
  onResetCompleted(): void {
    this.router.navigate(['/setup'], { replaceUrl: true });
  }

  private async loadProjectInfo(): Promise<void> {
    try {
      const result = await this.tauri.invoke<ProjectList>('list_projects');
      this.activeProject = result.active_project;
      const entry = result.projects.find((p) => p.name === result.active_project);
      this.projectDir = entry?.dir ?? '';
    } catch {
      // Not running inside Tauri
    }
    this.cdr.markForCheck();
  }

  private async loadLogLevel(): Promise<void> {
    try {
      const level = await this.tauri.invoke<string>('get_log_level');
      this.logLevel = level.toLowerCase();
    } catch {
      // Not running inside Tauri
    }
    this.cdr.markForCheck();
  }
}
