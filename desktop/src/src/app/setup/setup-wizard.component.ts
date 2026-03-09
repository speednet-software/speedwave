import { ChangeDetectionStrategy, ChangeDetectorRef, Component, inject } from '@angular/core';
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
    <div class="wizard-container">
      <div class="wizard-header">
        <h1>Speedwave Setup</h1>
        <p class="subtitle">Prepare your development environment</p>
      </div>

      <!-- Phase: Welcome — user must click to start -->
      @if (phase === 'welcome') {
        <div class="wizard-body">
          <p>Speedwave needs a lightweight virtual machine (Lima) to run containers securely.</p>
          <ul class="features">
            <li>VM with containerd + nerdctl (docker compose compatible)</li>
            <li>4 CPU, 8 GB RAM, 30 GB disk</li>
            <li>macOS: Apple Virtualization.framework (native performance)</li>
          </ul>
          <button class="btn btn-primary" (click)="startSetup()">Start Setup</button>
        </div>
      }

      <!-- Phase: Progress — steps running -->
      @if (phase === 'progress' || phase === 'project') {
        <div class="steps">
          @for (step of steps; track step.title; let i = $index) {
            <div class="step" [class]="step.status">
              <div class="step-icon">
                @if (step.status === 'done') {
                  <span class="icon-check">&#10003;</span>
                } @else if (step.status === 'active') {
                  <span class="spinner"></span>
                } @else if (step.status === 'error') {
                  <span class="icon-error">&#10007;</span>
                } @else {
                  <span class="icon-pending">&bull;</span>
                }
              </div>
              <div class="step-content">
                <div class="step-title">{{ step.title }}</div>
                <div class="step-desc">{{ step.description }}</div>
                @if (step.detail && (step.status === 'active' || step.status === 'error')) {
                  <div class="step-detail">{{ step.detail }}</div>
                }
              </div>
            </div>
          }
        </div>

        <!-- Active step panel -->
        <div class="step-panel">
          <!-- Project creation form (step 3) -->
          @if (phase === 'project') {
            <div class="form-group">
              <label
                >Project name
                <input type="text" [(ngModel)]="projectName" placeholder="acme-corp" />
              </label>
            </div>
            <div class="form-group">
              <label
                >Project directory
                <input
                  type="text"
                  [(ngModel)]="projectDir"
                  placeholder="/Users/you/projects/acme-corp"
                />
              </label>
            </div>
            <button
              class="btn btn-primary"
              (click)="createProject()"
              [disabled]="busy || !projectName || !projectDir"
            >
              {{ busy ? 'Creating...' : 'Create Project' }}
            </button>
          }

          <!-- Error state -->
          @if (error) {
            <div class="error-banner">{{ error }}</div>
            <div class="retry-actions">
              <button class="btn btn-primary" (click)="retryCurrentStep()">Retry</button>
              <button class="btn btn-secondary" (click)="backToWelcome()">Back to Start</button>
            </div>
          }
        </div>
      }

      <!-- Phase: Complete -->
      @if (phase === 'complete') {
        <div class="wizard-body success-body">
          <p class="success-text">Setup complete! Redirecting to settings...</p>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        background: #1a1a2e;
      }
      .wizard-container {
        max-width: 600px;
        margin: 0 auto;
        padding: 24px;
      }
      .wizard-header {
        text-align: center;
        margin-bottom: 32px;
      }
      .wizard-header h1 {
        font-size: 24px;
        color: #e94560;
        margin: 0;
      }
      .subtitle {
        color: #888;
        font-size: 14px;
        margin-top: 4px;
      }
      .wizard-body {
        background: #16213e;
        border: 1px solid #0f3460;
        border-radius: 8px;
        padding: 24px;
      }
      .wizard-body p {
        color: #bbb;
        line-height: 1.6;
        margin-bottom: 16px;
      }
      .features {
        list-style: none;
        padding: 0;
        margin: 0 0 24px 0;
      }
      .features li {
        padding: 6px 0;
        color: #999;
        font-size: 14px;
      }
      .features li::before {
        content: '\\25B8  ';
        color: #e94560;
      }

      /* Buttons */
      .btn {
        padding: 10px 24px;
        border-radius: 4px;
        font-size: 14px;
        font-weight: 600;
        font-family: monospace;
        border: none;
        cursor: pointer;
        transition: background 0.2s;
      }
      .btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .btn-primary {
        background: #e94560;
        color: #fff;
      }
      .btn-primary:hover:not(:disabled) {
        background: #c23152;
      }
      .btn-secondary {
        background: transparent;
        color: #888;
        border: 1px solid #555;
      }
      .btn-secondary:hover:not(:disabled) {
        color: #e0e0e0;
        border-color: #888;
      }

      /* Steps list */
      .steps {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-bottom: 24px;
      }
      .step {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 10px 12px;
        border-radius: 4px;
      }
      .step.active {
        background: #16213e;
      }
      .step.pending {
        opacity: 0.4;
      }
      .step.done {
        opacity: 0.7;
      }
      .step.error {
        opacity: 1;
      }

      .step-icon {
        width: 22px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        flex-shrink: 0;
        margin-top: 1px;
      }
      .icon-check {
        color: #2ecc71;
        font-weight: bold;
      }
      .icon-error {
        color: #e94560;
        font-weight: bold;
      }
      .icon-pending {
        color: #555;
        font-size: 18px;
      }
      .spinner {
        display: inline-block;
        width: 14px;
        height: 14px;
        border: 2px solid #0f3460;
        border-top-color: #e94560;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .step-content {
        flex: 1;
      }
      .step-title {
        font-weight: 600;
        font-size: 14px;
        color: #e0e0e0;
      }
      .step-desc {
        font-size: 12px;
        color: #666;
      }
      .step-detail {
        font-size: 12px;
        color: #999;
        margin-top: 2px;
        font-family: monospace;
      }
      .step.error .step-detail {
        color: #e94560;
      }

      /* Active step panel */
      .step-panel {
        background: #16213e;
        border: 1px solid #0f3460;
        border-radius: 8px;
        padding: 20px;
      }
      .form-group {
        margin-bottom: 12px;
      }
      .form-group label {
        display: block;
        margin-bottom: 4px;
        font-size: 13px;
        color: #aaa;
      }
      .form-group input {
        width: 100%;
        padding: 8px 12px;
        background: #1a1a2e;
        border: 1px solid #0f3460;
        border-radius: 4px;
        color: #e0e0e0;
        font-family: monospace;
        font-size: 14px;
        box-sizing: border-box;
      }
      .form-group input:focus {
        outline: none;
        border-color: #e94560;
      }
      .error-banner {
        margin-bottom: 12px;
        padding: 8px 12px;
        background: #3d0000;
        border: 1px solid #e94560;
        border-radius: 4px;
        color: #e94560;
        font-size: 13px;
        word-break: break-word;
      }
      .retry-actions {
        display: flex;
        gap: 12px;
      }
      .success-body {
        text-align: center;
      }
      .success-text {
        color: #2ecc71;
        font-weight: bold;
        font-size: 16px;
      }
    `,
  ],
})
export class SetupWizardComponent {
  phase: 'welcome' | 'progress' | 'project' | 'complete' = 'welcome';
  busy = false;
  error: string | null = null;
  projectName = '';
  projectDir = '';

  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  private tauri = inject(TauriService);

  // 6 steps: environment setup only, no auth/token configuration
  steps: SetupStep[] = [
    { title: 'Check Runtime', description: 'Verify Lima / nerdctl / WSL2', status: 'pending' },
    { title: 'Initialize VM', description: 'Create and start the VM (macOS)', status: 'pending' },
    { title: 'Build Images', description: 'Build container images', status: 'pending' },
    { title: 'Create Project', description: 'Set up your first project', status: 'pending' },
    { title: 'Start Containers', description: 'Launch project containers', status: 'pending' },
    { title: 'Finalize', description: 'CLI symlink', status: 'pending' },
  ];

  // Track which step index we're on for retry
  private currentStepIndex = 0;

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
    setTimeout(() => this.router.navigate(['/settings'], { replaceUrl: true }), 1500);
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
