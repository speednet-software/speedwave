import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject,
  NgZone,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TauriService } from '../services/tauri.service';

type StepState = 'pending' | 'active' | 'done' | 'error';

interface SetupStep {
  title: string;
  description: string;
  status: StepState;
  detail?: string;
}

/** Guides the user through initial environment setup and project creation. */
@Component({
  selector: 'app-setup-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex items-center justify-center min-h-screen bg-sw-bg-darkest"
      data-testid="setup-wizard"
    >
      <div class="max-w-[600px] mx-auto p-6">
        <div class="text-center mb-8">
          <h1 class="text-2xl text-sw-accent m-0">Speedwave Setup</h1>
          <p class="text-sw-text-muted text-sm mt-1">Prepare your development environment</p>
        </div>

        <!-- Phase: Welcome — user must click to start -->
        @if (phase === 'welcome') {
          <div class="bg-sw-bg-dark border border-sw-border rounded-lg p-6">
            <p class="text-sw-text-dim leading-relaxed mb-4">
              Speedwave needs a lightweight virtual machine (Lima) to run containers securely.
            </p>
            <ul class="list-none p-0 mb-6">
              <li class="py-1.5 text-sw-text-faint text-sm">
                <span class="text-sw-accent mr-1">&#9656;</span>VM with containerd + nerdctl (docker
                compose compatible)
              </li>
              <li class="py-1.5 text-sw-text-faint text-sm">
                <span class="text-sw-accent mr-1">&#9656;</span>4 CPU, 8 GB RAM, 30 GB disk
              </li>
              <li class="py-1.5 text-sw-text-faint text-sm">
                <span class="text-sw-accent mr-1">&#9656;</span>macOS: Apple
                Virtualization.framework (native performance)
              </li>
            </ul>
            <button
              class="px-6 py-2.5 rounded text-sm font-semibold font-mono border-none cursor-pointer transition-colors bg-sw-accent text-white hover:bg-sw-accent-hover"
              data-testid="setup-start-btn"
              (click)="startSetup()"
            >
              Start Setup
            </button>
          </div>
        }

        <!-- Phase: Progress — steps running -->
        @if (phase === 'progress' || phase === 'project') {
          <div class="flex flex-col gap-1 mb-6" data-testid="setup-steps">
            @for (step of steps; track step.title; let i = $index) {
              <div
                class="flex items-start gap-3 px-3 py-2.5 rounded"
                [class.bg-sw-bg-dark]="step.status === 'active'"
                [class.opacity-40]="step.status === 'pending'"
                [class.opacity-70]="step.status === 'done'"
                data-testid="setup-step"
                [attr.data-status]="step.status"
              >
                <div class="size-[22px] flex items-center justify-center text-sm shrink-0 mt-px">
                  @if (step.status === 'done') {
                    <span class="text-sw-success font-bold">&#10003;</span>
                  } @else if (step.status === 'active') {
                    <span
                      class="inline-block size-3.5 border-2 border-sw-bg-navy border-t-sw-accent rounded-full animate-sw-spin"
                    ></span>
                  } @else if (step.status === 'error') {
                    <span class="text-sw-error font-bold">&#10007;</span>
                  } @else {
                    <span class="text-sw-slider text-lg">&bull;</span>
                  }
                </div>
                <div class="flex-1">
                  <div class="font-semibold text-sm text-sw-text" data-testid="step-title">
                    {{ step.title }}
                  </div>
                  <div class="text-xs text-sw-text-ghost">{{ step.description }}</div>
                  @if (step.detail && (step.status === 'active' || step.status === 'error')) {
                    <div
                      class="text-xs mt-0.5 font-mono"
                      [class.text-sw-text-faint]="step.status === 'active'"
                      [class.text-sw-error]="step.status === 'error'"
                    >
                      {{ step.detail }}
                    </div>
                  }
                </div>
              </div>
            }
          </div>

          <!-- Active step panel -->
          <div class="bg-sw-bg-dark border border-sw-border rounded-lg p-5">
            <!-- Project creation form (step 3) -->
            @if (phase === 'project') {
              <div class="mb-3">
                <label class="block mb-1 text-[13px] text-sw-text-dim"
                  >Project name
                  <input
                    type="text"
                    [(ngModel)]="projectName"
                    placeholder="acme-corp"
                    data-testid="setup-project-name"
                    class="w-full px-3 py-2 bg-sw-bg-darkest border border-sw-border rounded text-sw-text font-mono text-sm box-border focus:outline-none focus:border-sw-accent"
                  />
                </label>
              </div>
              <div class="mb-3">
                <label class="block mb-1 text-[13px] text-sw-text-dim"
                  >Project directory
                  <input
                    type="text"
                    [(ngModel)]="projectDir"
                    placeholder="/Users/you/projects/acme-corp"
                    data-testid="setup-project-dir"
                    class="w-full px-3 py-2 bg-sw-bg-darkest border border-sw-border rounded text-sw-text font-mono text-sm box-border focus:outline-none focus:border-sw-accent"
                  />
                </label>
              </div>
              <button
                class="px-6 py-2.5 rounded text-sm font-semibold font-mono border-none cursor-pointer transition-colors bg-sw-accent text-white hover:bg-sw-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="setup-create-project-btn"
                (click)="createProject()"
                [disabled]="busy || !projectName || !projectDir"
              >
                {{ busy ? 'Creating...' : 'Create Project' }}
              </button>
            }

            <!-- Error state -->
            @if (error) {
              <div
                class="mb-3 px-3 py-2 bg-sw-error-bg border border-sw-error rounded text-sw-error text-[13px] break-words"
                data-testid="setup-error"
              >
                {{ error }}
              </div>
              <div class="flex gap-3">
                <button
                  class="px-6 py-2.5 rounded text-sm font-semibold font-mono border-none cursor-pointer transition-colors bg-sw-accent text-white hover:bg-sw-accent-hover"
                  data-testid="setup-retry-btn"
                  (click)="retryCurrentStep()"
                >
                  Retry
                </button>
                <button
                  class="px-6 py-2.5 rounded text-sm font-semibold font-mono cursor-pointer transition-colors bg-transparent text-sw-text-muted border border-sw-slider hover:text-sw-text hover:border-sw-text-muted"
                  data-testid="setup-back-btn"
                  (click)="backToWelcome()"
                >
                  Back to Start
                </button>
              </div>
            }
          </div>
        }

        <!-- Phase: Complete -->
        @if (phase === 'complete') {
          <div class="bg-sw-bg-dark border border-sw-border rounded-lg p-6 text-center">
            <p class="text-sw-success font-bold text-base" data-testid="setup-success">
              Setup complete! Redirecting to settings...
            </p>
          </div>
        }
      </div>
    </div>
  `,
})
export class SetupWizardComponent {
  phase: 'welcome' | 'progress' | 'project' | 'complete' = 'welcome';
  busy = false;
  error: string | null = null;
  projectName = '';
  projectDir = '';

  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);
  private router = inject(Router);
  private tauri = inject(TauriService);

  // 6 steps: environment setup only, no auth/token configuration.
  // Descriptions are platform-specific — updated in constructor via get_platform.
  steps: SetupStep[] = [
    { title: 'System Check', description: 'Verify system requirements', status: 'pending' },
    { title: 'Initialize VM', description: 'Set up container environment', status: 'pending' },
    { title: 'Build Images', description: 'Build container images', status: 'pending' },
    { title: 'Create Project', description: 'Set up your first project', status: 'pending' },
    { title: 'Start Containers', description: 'Launch project containers', status: 'pending' },
    { title: 'Finalize', description: 'CLI symlink', status: 'pending' },
  ];

  // Track which step index we're on for retry
  private currentStepIndex = 0;

  /** Detect host platform and customize step descriptions. */
  constructor() {
    this.detectPlatform();
  }

  private async detectPlatform(): Promise<void> {
    try {
      const platform = await this.tauri.invoke<string>('get_platform');
      switch (platform) {
        case 'macos':
          this.steps[0].description = 'Verify Lima / nerdctl';
          this.steps[1].description = 'Create and start the Lima VM';
          break;
        case 'windows':
          this.steps[0].description = 'Verify system requirements';
          this.steps[1].description = 'Set up WSL2 distribution';
          break;
        case 'linux':
          this.steps[0].description = 'Verify nerdctl (rootless)';
          this.steps[1].description = 'Set up rootless containerd';
          break;
      }
      this.cdr.markForCheck();
    } catch {
      // Fallback: keep generic descriptions
    }
  }

  /** Begins the setup process by transitioning to the progress phase and running auto steps. */
  async startSetup(): Promise<void> {
    this.phase = 'progress';
    this.error = null;
    this.resetSteps();
    this.cdr.markForCheck();
    await this.runAutoSteps();
  }

  /** Resets all steps and returns to the welcome phase. */
  backToWelcome(): void {
    this.phase = 'welcome';
    this.error = null;
    this.resetSteps();
    this.cdr.markForCheck();
  }

  /** Retries the current failed step from where it left off. */
  async retryCurrentStep(): Promise<void> {
    this.error = null;
    this.steps[this.currentStepIndex].status = 'pending';
    this.steps[this.currentStepIndex].detail = undefined;
    this.cdr.markForCheck();
    await this.runFromStep(this.currentStepIndex);
  }

  /** Creates a new project with the provided name and directory, then continues setup. */
  async createProject(): Promise<void> {
    this.busy = true;
    this.error = null;
    this.setStep(3, 'active', 'Creating project...');
    try {
      await this.tauri.invoke('create_project', { name: this.projectName, dir: this.projectDir });
      this.setStep(3, 'done');
      this.currentStepIndex = 4;
      this.phase = 'progress';
      this.cdr.markForCheck();
      await this.runFromStep(4);
    } catch (err) {
      this.failStep(3, `Project creation failed: ${err}`);
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }

  // ---- Private helpers ----

  private async runAutoSteps(): Promise<void> {
    await this.runFromStep(0);
  }

  private async runFromStep(start: number): Promise<void> {
    for (let i = start; i < this.steps.length; i++) {
      this.currentStepIndex = i;

      // Step 3: Create Project — needs user input
      if (i === 3) {
        this.phase = 'project';
        this.setStep(3, 'active', 'Waiting for project details...');
        return;
      }

      // All other steps: auto-run
      const ok = await this.executeStep(i);
      if (!ok) return; // stop on error

      // If step 0 skipped VM init, jump loop ahead
      if (i === 0 && this.steps[1].status === 'done') {
        i = 1; // loop will increment to 2
      }
    }

    // All done
    this.phase = 'complete';
    this.cdr.markForCheck();
    setTimeout(
      () => this.zone.run(() => this.router.navigate(['/settings'], { replaceUrl: true })),
      1500
    );
  }

  private async executeStep(index: number): Promise<boolean> {
    this.setStep(index, 'active', this.getStepActionText(index));
    try {
      switch (index) {
        case 0: {
          // Check Runtime
          const status = await this.tauri.invoke<string>('check_runtime');
          this.setStep(0, 'done');
          if (status === 'Ready') {
            // Runtime ready — skip VM init
            this.setStep(1, 'done', 'Already available');
            this.currentStepIndex = 2;
            return true;
          }
          break;
        }
        case 1: // Initialize VM
          await this.tauri.invoke('init_vm');
          this.setStep(1, 'done');
          break;
        case 2: // Build Images
          await this.tauri.invoke('build_images');
          this.setStep(2, 'done');
          break;
        case 4: // Start Containers
          await this.tauri.invoke('start_containers', { project: this.projectName });
          this.setStep(4, 'done');
          break;
        case 5: // Finalize
          this.setStep(5, 'active', 'Linking CLI...');
          this.cdr.markForCheck();
          await this.tauri.invoke('link_cli');
          this.setStep(5, 'done');
          break;
      }
      this.cdr.markForCheck();
      return true;
    } catch (err) {
      this.failStep(index, `${this.steps[index].title} failed: ${err}`);
      return false;
    }
  }

  private getStepActionText(index: number): string {
    switch (index) {
      case 0:
        return 'Detecting container runtime...';
      case 1:
        return 'Initializing virtual machine...';
      case 2:
        return 'Building container images (this may take a few minutes)...';
      case 4:
        return 'Starting containers...';
      case 5:
        return 'Finalizing setup...';
      default:
        return 'Working...';
    }
  }

  private setStep(index: number, status: StepState, detail?: string): void {
    this.steps[index].status = status;
    if (detail !== undefined) {
      this.steps[index].detail = detail;
    } else if (status === 'done') {
      this.steps[index].detail = undefined;
    }
    this.cdr.markForCheck();
  }

  private failStep(index: number, message: string): void {
    this.steps[index].status = 'error';
    this.steps[index].detail = message;
    this.error = message;
    this.phase = 'progress';
    this.cdr.markForCheck();
  }

  private resetSteps(): void {
    for (const step of this.steps) {
      step.status = 'pending';
      step.detail = undefined;
    }
    this.currentStepIndex = 0;
  }
}
