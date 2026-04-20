import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
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
    CommonModule,
    LlmProviderComponent,
    AuthSectionComponent,
    SystemHealthComponent,
    AdvancedSectionComponent,
    UpdateSectionComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="max-w-[700px] mx-auto mt-8 px-6">
      <h1 class="text-xl text-sw-accent m-0 mb-6">Settings</h1>

      @if (error) {
        <div
          class="mb-4 px-3 py-2 bg-sw-error-bg border border-sw-error rounded text-sw-error text-[13px]"
          data-testid="settings-error"
        >
          {{ error }}
        </div>
      }

      <!-- Active project info -->
      <section class="mb-6">
        <h2 class="text-[15px] text-sw-text m-0 mb-3">Project</h2>
        <div class="bg-sw-bg-dark border border-sw-border rounded-lg p-4">
          <div class="flex justify-between items-center py-2">
            <span class="text-[13px] text-sw-text-muted">Active project</span>
            <span class="text-[13px] text-sw-text" data-testid="settings-active-project">{{
              activeProject || 'None'
            }}</span>
          </div>
          <div class="flex justify-between items-center py-2 border-t border-sw-border">
            <span class="text-[13px] text-sw-text-muted">Directory</span>
            <span class="text-[13px] font-mono text-sw-text-dim">{{ projectDir || '—' }}</span>
          </div>
          <div class="flex justify-between items-center py-2 border-t border-sw-border">
            <span class="text-[13px] text-sw-text-muted">Data directory</span>
            <span class="text-[13px] font-mono text-sw-text-dim">~/.speedwave/</span>
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
        <section class="mb-6">
          <h2 class="text-[15px] text-sw-text m-0 mb-3">System Health</h2>
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
