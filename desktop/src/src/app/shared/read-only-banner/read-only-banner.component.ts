import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { TauriService } from '../../services/tauri.service';
import { AccessSettingsView } from '../../models/access';

/** Notice that every integration and plugin of the project is read-only. */
@Component({
  selector: 'app-read-only-banner',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = view();
    @if (current?.read_only) {
      <div
        class="mb-4 rounded ring-1 ring-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-amber-300"
        data-testid="read-only-banner"
        role="status"
      >
        @if (current?.read_only_locked) {
          All integrations and plugins are read-only, set by your organization. The agent can read
          from them but cannot change anything in them.
        } @else {
          All integrations and plugins are read-only. The agent can read from them but cannot change
          anything in them.
        }
        @if (mentionsBrowser()) {
          Playwright cannot open pages in this mode, so the browser does not work.
        }
        @if (!current?.read_only_locked) {
          <a
            routerLink="/settings"
            fragment="section-access"
            class="whitespace-nowrap font-medium text-inherit underline decoration-current/40 underline-offset-2 hover:decoration-current focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
            data-testid="read-only-banner-settings-link"
            >Turn off in Settings</a
          >
        }
      </div>
    }
  `,
})
export class ReadOnlyBannerComponent {
  readonly project = input<string | null>(null);
  readonly mentionsBrowser = input(false);

  protected readonly view = signal<AccessSettingsView | null>(null);

  private readonly tauri = inject(TauriService);

  /** Reloads the state when the project changes. */
  constructor() {
    effect(() => {
      const project = this.project();
      untracked(() => {
        this.view.set(null);
        if (project) void this.load(project);
      });
    });
  }

  private async load(project: string): Promise<void> {
    try {
      const next = await this.tauri.invoke<AccessSettingsView>('get_access_settings', { project });
      if (this.project() === project && next) this.view.set(next);
    } catch {
      this.view.set(null);
    }
  }
}
