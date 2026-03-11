import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { invoke } from '@tauri-apps/api/core';
import { error as logError } from '@tauri-apps/plugin-log';

interface ProjectEntry {
  name: string;
  dir: string;
}

interface ProjectList {
  projects: ProjectEntry[];
  active_project: string | null;
}

/** Manages project switching and selection in the toolbar. */
@Component({
  selector: 'app-project-switcher',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="switcher">
      <button class="current-project" data-testid="project-switcher-btn" (click)="toggleDropdown()">
        {{ activeProject || 'No project' }}
        <span class="arrow">&#x25BE;</span>
      </button>
      @if (isOpen) {
        <div class="dropdown" data-testid="project-switcher-dropdown">
          @for (project of projects; track project.name) {
            <button
              class="project-item"
              [class.active]="project.name === activeProject"
              [attr.data-testid]="'project-switcher-item-' + project.name"
              (click)="switchProject(project.name)"
            >
              {{ project.name }}
            </button>
          }
          @if (projects.length === 0) {
            <div class="no-projects">No projects configured</div>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      .switcher {
        position: relative;
      }
      .current-project {
        background: #0f3460;
        color: #e0e0e0;
        border: 1px solid #0f3460;
        border-radius: 4px;
        padding: 4px 12px;
        font-size: 13px;
        font-family: monospace;
      }
      .current-project:hover {
        background: #1a4a7a;
      }
      .arrow {
        margin-left: 6px;
      }
      .dropdown {
        position: absolute;
        top: 100%;
        right: 0;
        margin-top: 4px;
        background: #16213e;
        border: 1px solid #0f3460;
        border-radius: 4px;
        min-width: 180px;
        z-index: 100;
      }
      .project-item {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        color: #e0e0e0;
        padding: 8px 12px;
        font-size: 13px;
        font-family: monospace;
      }
      .project-item:hover {
        background: #0f3460;
      }
      .project-item.active {
        color: #e94560;
        font-weight: bold;
      }
      .no-projects {
        padding: 8px 12px;
        color: #888;
        font-size: 13px;
      }
    `,
  ],
})
export class ProjectSwitcherComponent implements OnInit {
  projects: ProjectEntry[] = [];
  activeProject: string | null = null;
  isOpen = false;
  private cdr = inject(ChangeDetectorRef);

  /** Loads available projects from the backend on initialization. */
  async ngOnInit(): Promise<void> {
    try {
      const result = await invoke<ProjectList>('list_projects');
      this.projects = result.projects;
      this.activeProject = result.active_project;
      this.cdr.markForCheck();
    } catch {
      // Not running inside Tauri or command not registered yet
    }
  }

  /** Toggles the project dropdown visibility. */
  toggleDropdown(): void {
    this.isOpen = !this.isOpen;
  }

  /**
   * Switches the active project to the specified one.
   * @param name - The name of the project to switch to.
   */
  async switchProject(name: string): Promise<void> {
    this.isOpen = false;
    try {
      await invoke('switch_project', { name });
      this.activeProject = name;
    } catch (err) {
      logError(`Failed to switch project: ${String(err)}`).catch(() => {});
    }
    this.cdr.markForCheck();
  }
}
