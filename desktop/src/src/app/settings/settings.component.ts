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
    AuthSectionComponent,
    SystemHealthComponent,
    AdvancedSectionComponent,
    UpdateSectionComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="settings-container">
      <h1>Settings</h1>

      @if (error) {
        <div class="error-banner" data-testid="settings-error">{{ error }}</div>
      }

      <!-- Active project info -->
      <section class="section">
        <h2>Project</h2>
        <div class="info-card">
          <div class="info-row">
            <span class="info-label">Active project</span>
            <span class="info-value" data-testid="settings-active-project">{{
              activeProject || 'None'
            }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Directory</span>
            <span class="info-value mono">{{ projectDir || '—' }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Data directory</span>
            <span class="info-value mono">~/.speedwave/</span>
          </div>
        </div>
      </section>

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
        <section class="section">
          <h2>System Health</h2>
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
  styles: [
    `
      .settings-container {
        max-width: 700px;
        margin: 32px auto;
        padding: 24px;
      }
      h1 {
        font-size: 20px;
        color: #e94560;
        margin: 0 0 24px 0;
      }
      h2 {
        font-size: 15px;
        color: #e0e0e0;
        margin: 0 0 12px 0;
      }
      .error-banner {
        margin-bottom: 16px;
        padding: 8px 12px;
        background: #3d0000;
        border: 1px solid #e94560;
        border-radius: 4px;
        color: #e94560;
        font-size: 13px;
      }
      .section {
        margin-bottom: 24px;
      }
      .info-card {
        background: #16213e;
        border: 1px solid #0f3460;
        border-radius: 8px;
        padding: 16px;
      }
      .info-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
      }
      .info-row + .info-row {
        border-top: 1px solid #0f3460;
      }
      .info-label {
        font-size: 13px;
        color: #888;
      }
      .info-value {
        font-size: 13px;
        color: #e0e0e0;
      }
      .info-value.mono {
        font-family: monospace;
        color: #aaa;
      }
    `,
  ],
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
    this.loadLlmProvider();
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

  private async loadLlmProvider(): Promise<void> {
    try {
      const config = await this.tauri.invoke<{ provider: string | null }>('get_llm_config');
      this.llmProvider = config.provider || 'anthropic';
    } catch {
      // Not running inside Tauri or no config yet
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
