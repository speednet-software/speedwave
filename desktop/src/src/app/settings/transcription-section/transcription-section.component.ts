import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  inject,
  output,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { TauriService } from '../../services/tauri.service';

/** Settings → Meeting transcription. ADR-056 opt-in toggle (user-level, OFF by default). */
@Component({
  selector: 'app-transcription-section',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section
      id="section-transcription"
      class="border-t border-[var(--line)] pt-6"
      data-testid="settings-section-transcription"
    >
      <h2 class="view-title view-title-section text-[var(--ink)]">Meeting transcription</h2>
      <p class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        When enabled, Speedwave can record system audio and your microphone on this machine.
        Transcription runs locally. Model downloads and sending transcripts to Claude use the
        network.
      </p>

      <div
        class="mt-4 flex items-center justify-between rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2"
      >
        <div>
          <div class="mono text-[12px] text-[var(--ink)]">enable meeting transcription</div>
          <div class="text-[11px] text-[var(--ink-mute)]">
            opens the Meeting transcription tab (⌘4)
          </div>
        </div>
        <button
          type="button"
          role="switch"
          [attr.aria-checked]="enabled() === true"
          class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="transcription-toggle"
          (click)="toggle()"
          [disabled]="busy()"
        >
          {{ enabled() === true ? 'on' : 'off' }}
        </button>
      </div>

      @if (enabled() === true) {
        <div class="mt-3">
          <button
            type="button"
            class="mono text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
            data-testid="transcription-manage"
            (click)="goToTab()"
          >
            manage models &rarr;
          </button>
        </div>
      }
    </section>
  `,
})
export class TranscriptionSectionComponent implements OnInit {
  /** Forwards errors to the Settings shell banner. */
  readonly errorOccurred = output<string>();

  /** Current toggle value; `null` while loading. */
  readonly enabled = signal<boolean | null>(null);
  /** Disables the toggle while a save is in flight. */
  readonly busy = signal(false);

  private readonly tauri = inject(TauriService);
  private readonly router = inject(Router);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Reads the current toggle from the backend on first paint. */
  async ngOnInit(): Promise<void> {
    try {
      const on = await this.tauri.invoke<boolean>('transcription_enabled');
      this.enabled.set(on);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
      this.enabled.set(false);
    }
    this.cdr.markForCheck();
  }

  /** Flips the toggle and persists it to user config. */
  async toggle(): Promise<void> {
    if (this.busy()) {
      return;
    }
    const next = !(this.enabled() ?? false);
    this.busy.set(true);
    try {
      await this.tauri.invoke('set_transcription_enabled', { enabled: next });
      this.enabled.set(next);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.busy.set(false);
    this.cdr.markForCheck();
  }

  /** Navigates to the Meeting transcription tab. */
  goToTab(): void {
    void this.router.navigateByUrl('/meeting-transcription');
  }
}
