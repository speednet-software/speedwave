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
import { error as logError } from '@tauri-apps/plugin-log';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import type { ProjectEntry, ProjectList } from '../models/update';

/** Manages project switching and selection in the toolbar. */
@Component({
  selector: 'app-project-switcher',
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="relative">
      <button
        class="bg-sw-bg-navy text-sw-text border border-sw-bg-navy rounded px-3 py-1 text-[13px] font-mono hover:bg-sw-btn-hover"
        data-testid="project-switcher-btn"
        (click)="toggleDropdown()"
      >
        {{ activeProject || 'No project' }}
        <span class="ml-1.5">&#x25BE;</span>
      </button>
      @if (isOpen) {
        <div
          class="absolute top-full right-0 mt-1 bg-sw-bg-dark border border-sw-bg-navy rounded min-w-[220px] z-100"
          data-testid="project-switcher-dropdown"
        >
          @for (project of projects; track project.name) {
            <button
              class="block w-full text-left bg-transparent border-none text-sw-text px-3 py-2 text-[13px] font-mono hover:bg-sw-bg-navy"
              [class.text-sw-accent]="project.name === activeProject"
              [class.font-bold]="project.name === activeProject"
              [attr.data-testid]="'project-switcher-item-' + project.name"
              (click)="switchProject(project.name)"
            >
              {{ project.name }}
            </button>
          }
          @if (projects.length === 0 && !showAddForm) {
            <div class="px-3 py-2 text-sw-text-muted text-[13px]">No projects configured</div>
          }
          <hr class="border-none border-t border-sw-bg-navy my-1" />
          @if (!showAddForm) {
            <button
              class="block w-full text-left bg-transparent border-none text-sw-teal px-3 py-2 text-[13px] font-mono hover:bg-sw-bg-navy"
              data-testid="add-project-btn"
              (click)="showAddForm = true"
            >
              + Add Project
            </button>
          }
          @if (showAddForm) {
            <div class="px-3 py-2" data-testid="add-project-form">
              <input
                class="block w-full box-border bg-sw-bg-panel text-sw-text border border-sw-bg-navy rounded px-2 py-1.5 text-xs font-mono mb-1.5"
                placeholder="Project name"
                data-testid="add-project-name"
                [(ngModel)]="newProjectName"
              />
              <input
                class="block w-full box-border bg-sw-bg-panel text-sw-text border border-sw-bg-navy rounded px-2 py-1.5 text-xs font-mono mb-1.5"
                placeholder="Absolute path"
                data-testid="add-project-dir"
                [(ngModel)]="newProjectDir"
              />
              @if (addError) {
                <div class="text-sw-accent text-xs mb-1.5" data-testid="add-project-error">
                  {{ addError }}
                </div>
              }
              <div class="flex gap-1.5">
                <button
                  class="flex-1 px-2 py-1 border-none rounded text-xs font-mono cursor-pointer bg-sw-teal text-sw-bg-panel disabled:opacity-50"
                  data-testid="add-project-create"
                  [disabled]="addBusy"
                  (click)="addProject()"
                >
                  Create
                </button>
                <button
                  class="flex-1 px-2 py-1 border-none rounded text-xs font-mono cursor-pointer bg-sw-border-dark text-sw-text disabled:opacity-50"
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
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private unsubProjectSettled: (() => void) | null = null;

  /** Loads available projects from the backend on initialization. */
  async ngOnInit(): Promise<void> {
    try {
      const result = await this.tauri.invoke<ProjectList>('list_projects');
      this.projects = result.projects;
      this.activeProject = result.active_project;
      this.cdr.markForCheck();
    } catch {
      // Not running inside Tauri or command not registered yet
    }

    // Refresh list on settled (not just ready — failed add still registers project)
    this.unsubProjectSettled = this.projectState.onProjectSettled(async () => {
      try {
        const result = await this.tauri.invoke<ProjectList>('list_projects');
        this.projects = result.projects;
        this.activeProject = result.active_project;
        this.cdr.markForCheck();
      } catch (err) {
        console.error('project settled: failed to refresh project list:', err);
      }
    });
  }

  /** Unsubscribes from the project settled listener. */
  ngOnDestroy(): void {
    if (this.unsubProjectSettled) {
      this.unsubProjectSettled();
      this.unsubProjectSettled = null;
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
      await this.projectState.switchProject(name);
    } catch (err) {
      logError(`Failed to switch project: ${String(err)}`).catch(() => {});
    }
    this.cdr.markForCheck();
  }

  /** Adds a new project and closes the form. The settled listener handles list refresh. */
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
      await this.projectState.addProject(name, dir);
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
