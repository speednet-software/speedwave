import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { error as logError } from '@tauri-apps/plugin-log';
import type { ProjectEntry, ProjectList } from '../models/update';

/** Manages project switching and selection in the toolbar. */
@Component({
  selector: 'app-project-switcher',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
          @if (projects.length === 0 && !showAddForm) {
            <div class="no-projects">No projects configured</div>
          }
          <hr class="separator" />
          @if (!showAddForm) {
            <button
              class="project-item add-btn"
              data-testid="add-project-btn"
              (click)="showAddForm = true"
            >
              + Add Project
            </button>
          }
          @if (showAddForm) {
            <div class="add-form" data-testid="add-project-form">
              <input
                class="add-input"
                placeholder="Project name"
                data-testid="add-project-name"
                [(ngModel)]="newProjectName"
              />
              <input
                class="add-input"
                placeholder="Absolute path"
                data-testid="add-project-dir"
                [(ngModel)]="newProjectDir"
              />
              @if (addError) {
                <div class="add-error" data-testid="add-project-error">{{ addError }}</div>
              }
              <div class="add-actions">
                <button
                  class="action-btn create-btn"
                  data-testid="add-project-create"
                  [disabled]="addBusy"
                  (click)="addProject()"
                >
                  Create
                </button>
                <button
                  class="action-btn cancel-btn"
                  data-testid="add-project-cancel"
                  [disabled]="addBusy"
                  (click)="cancelAdd()"
                >
                  Cancel
                </button>
              </div>
            </div>
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
        min-width: 220px;
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
      .add-btn {
        color: #4ecdc4;
      }
      .no-projects {
        padding: 8px 12px;
        color: #888;
        font-size: 13px;
      }
      .separator {
        border: none;
        border-top: 1px solid #0f3460;
        margin: 4px 0;
      }
      .add-form {
        padding: 8px 12px;
      }
      .add-input {
        display: block;
        width: 100%;
        box-sizing: border-box;
        background: #0a1628;
        color: #e0e0e0;
        border: 1px solid #0f3460;
        border-radius: 4px;
        padding: 6px 8px;
        font-size: 12px;
        font-family: monospace;
        margin-bottom: 6px;
      }
      .add-error {
        color: #e94560;
        font-size: 12px;
        margin-bottom: 6px;
      }
      .add-actions {
        display: flex;
        gap: 6px;
      }
      .action-btn {
        flex: 1;
        padding: 4px 8px;
        border: none;
        border-radius: 4px;
        font-size: 12px;
        font-family: monospace;
        cursor: pointer;
      }
      .create-btn {
        background: #4ecdc4;
        color: #0a1628;
      }
      .create-btn:disabled {
        opacity: 0.5;
      }
      .cancel-btn {
        background: #333;
        color: #e0e0e0;
      }
      .cancel-btn:disabled {
        opacity: 0.5;
      }
    `,
  ],
})
export class ProjectSwitcherComponent implements OnInit, OnDestroy {
  projects: ProjectEntry[] = [];
  activeProject: string | null = null;
  isOpen = false;

  showAddForm = false;
  newProjectName = '';
  newProjectDir = '';
  addBusy = false;
  addError: string | null = null;

  private cdr = inject(ChangeDetectorRef);
  private unlistenProjectSwitch: UnlistenFn | null = null;

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

    listen<string>('project_switched', async () => {
      try {
        const result = await invoke<ProjectList>('list_projects');
        this.projects = result.projects;
        this.activeProject = result.active_project;
        this.cdr.markForCheck();
      } catch (err) {
        console.error('project_switched: failed to refresh project list:', err);
      }
    })
      .then((unlisten) => {
        this.unlistenProjectSwitch = unlisten;
      })
      // Expected to fail in non-Tauri environments (e.g. unit tests, browser preview)
      .catch(() => {});
  }

  /** Unsubscribes from the project_switched event listener. */
  ngOnDestroy(): void {
    if (this.unlistenProjectSwitch) {
      this.unlistenProjectSwitch();
      this.unlistenProjectSwitch = null;
    }
  }

  /** Toggles the project dropdown visibility. */
  toggleDropdown(): void {
    this.isOpen = !this.isOpen;
    if (!this.isOpen) {
      this.resetAddForm();
    }
  }

  /**
   * Switches the active project to the specified one.
   * @param name - The name of the project to switch to.
   */
  async switchProject(name: string): Promise<void> {
    this.isOpen = false;
    this.resetAddForm();
    try {
      await invoke('switch_project', { name });
      this.activeProject = name;
    } catch (err) {
      logError(`Failed to switch project: ${String(err)}`).catch(() => {});
    }
    this.cdr.markForCheck();
  }

  /** Adds a new project, refreshes the list, and closes the form. */
  async addProject(): Promise<void> {
    const name = this.newProjectName.trim();
    const dir = this.newProjectDir.trim();

    if (!name || !dir) {
      this.addError = 'Name and path are required';
      this.cdr.markForCheck();
      return;
    }

    this.addBusy = true;
    this.addError = null;
    this.cdr.markForCheck();

    try {
      await invoke('add_project', { name, dir });
      // Refresh project list
      const result = await invoke<ProjectList>('list_projects');
      this.projects = result.projects;
      this.activeProject = result.active_project;
      this.resetAddForm();
      this.isOpen = false;
    } catch (err) {
      this.addError = String(err);
      logError(`Failed to add project: ${String(err)}`).catch(() => {});
    }
    this.addBusy = false;
    this.cdr.markForCheck();
  }

  /** Resets the add-project form to its initial state. */
  cancelAdd(): void {
    this.resetAddForm();
    this.cdr.markForCheck();
  }

  private resetAddForm(): void {
    this.showAddForm = false;
    this.newProjectName = '';
    this.newProjectDir = '';
    this.addBusy = false;
    this.addError = null;
  }
}
