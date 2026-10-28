import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CdkContextMenuTrigger, CdkMenu, CdkMenuItem } from '@angular/cdk/menu';
import { IconComponent } from '../../shared/icon.component';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { ProjectStateService } from '../../services/project-state.service';
import { TauriService } from '../../services/tauri.service';

const COPIED_NOTICE_MS = 2000;
const ERROR_NOTICE_MS = 6000;

interface TerminalNotice {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * Chat header terminal button: a click opens the system terminal on the active project's CLI session, a right click offers "Copy command".
 * Each action belongs to the project it started for and reports only while the app is still settled on it.
 */
@Component({
  selector: 'app-chat-header-terminal',
  imports: [IconComponent, TooltipDirective, CdkContextMenuTrigger, CdkMenu, CdkMenuItem],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex flex-shrink-0 items-center gap-2' },
  template: `
    <button
      type="button"
      data-testid="chat-header-terminal"
      class="inline-flex flex-shrink-0 items-center justify-center text-[var(--ink-mute)] hover:text-[var(--ink)] disabled:opacity-50"
      appTooltip="Open in terminal"
      aria-label="Open project in terminal"
      [disabled]="!available()"
      [cdkContextMenuTriggerFor]="menu"
      [cdkContextMenuDisabled]="!available()"
      (click)="openTerminal()"
    >
      <app-icon name="terminal" class="h-4 w-4" />
    </button>

    @if (notice(); as current) {
      <span
        role="status"
        data-testid="chat-header-terminal-notice"
        class="max-w-[16rem] truncate text-[11px]"
        [class.text-[var(--ink-mute)]]="!current.isError"
        [class.text-[var(--red)]]="current.isError"
        [attr.title]="current.text"
      >
        {{ current.text }}
      </span>
    }

    <ng-template #menu>
      <div cdkMenu class="app-menu">
        <button
          type="button"
          cdkMenuItem
          class="app-menu-item"
          data-testid="chat-header-terminal-copy"
          (cdkMenuItemTriggered)="copyCommand()"
        >
          Copy command
        </button>
      </div>
    </ng-template>
  `,
})
export class ChatHeaderTerminalComponent {
  private readonly projectState = inject(ProjectStateService);
  private readonly tauri = inject(TauriService);

  protected readonly notice = signal<TerminalNotice | null>(null);
  protected readonly available = computed(() => {
    const project = this.projectState.activeProject();
    return project !== null && this.projectState.isSettledOn(project);
  });

  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Clears a pending notice timer when the button is destroyed. */
  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearNoticeTimer());
  }

  /** Opens the system terminal on the active project's CLI session. */
  protected async openTerminal(): Promise<void> {
    await this.runForActiveProject('open_project_terminal', null);
  }

  /** Copies the terminal command of the active project to the clipboard on the Rust side. */
  protected async copyCommand(): Promise<void> {
    await this.runForActiveProject('copy_project_terminal_command', 'Command copied');
  }

  private async runForActiveProject(command: string, successText: string | null): Promise<void> {
    const project = this.projectState.activeProject();
    const mark = this.projectState.settledMark(project);
    if (project === null || mark === null) return;
    try {
      await this.tauri.invoke<void>(command, { project });
    } catch (error) {
      if (this.projectState.isStillSettledOn(project, mark)) {
        this.showNotice(describeError(error), true);
      }
      return;
    }
    if (successText !== null && this.projectState.isStillSettledOn(project, mark)) {
      this.showNotice(successText, false);
    }
  }

  private showNotice(text: string, isError: boolean): void {
    this.clearNoticeTimer();
    this.notice.set({ text, isError });
    this.noticeTimer = setTimeout(
      () => {
        this.noticeTimer = null;
        this.notice.set(null);
      },
      isError ? ERROR_NOTICE_MS : COPIED_NOTICE_MS
    );
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
