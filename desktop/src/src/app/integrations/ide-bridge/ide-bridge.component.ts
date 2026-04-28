import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TauriService } from '../../services/tauri.service';
import { DetectedIde } from '../../models/health';

/** Manages IDE Bridge detection, connection, and event display. */
@Component({
  selector: 'app-ide-bridge',
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section id="ide-bridge" class="mb-6" data-testid="integrations-ide-bridge">
      <h2 class="view-title view-title-section text-[var(--ink)]">IDE Bridge</h2>

      @if (lastEvent) {
        <div
          class="mono mt-3 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-1.5 text-[11px] text-[var(--ink-mute)] transition-opacity duration-1000 ease-out"
          [class.opacity-0]="eventFading"
          data-testid="event-banner"
        >
          {{ lastEvent }}
        </div>
      }

      <div class="mt-3 overflow-hidden rounded border border-[var(--line)]">
        <table class="mono w-full border-collapse text-[12.5px]">
          <thead>
            <tr
              class="bg-[var(--bg-1)] text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            >
              <th class="px-3 py-2 text-left font-medium">ide</th>
              <th class="px-3 py-2 text-left font-medium">port</th>
              <th class="px-3 py-2 text-right font-medium">status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--line)]">
            @if (availableIdes.length === 0) {
              <tr>
                <td colspan="3" class="px-3 py-3 text-[var(--ink-mute)]" data-testid="no-data">
                  No IDE detected — open Cursor or VS Code with the Claude Code extension.
                </td>
              </tr>
            } @else {
              @for (ide of availableIdes; track ide.ide_name + ':' + ide.port) {
                <tr data-testid="ide-row">
                  <td class="px-3 py-2 text-[var(--ink)]" data-testid="ide-row-name">
                    {{ ide.ide_name }}
                  </td>
                  <td class="px-3 py-2 text-[var(--ink-dim)]">
                    @if (ide.port !== null) {
                      :{{ ide.port }}
                    } @else {
                      —
                    }
                  </td>
                  <td class="px-3 py-2 text-right">
                    @if (selectedIde?.ide_name === ide.ide_name && selectedIde?.port === ide.port) {
                      <span class="pill green" data-testid="connect-btn" data-active="true"
                        >connected</span
                      >
                    } @else {
                      <button
                        type="button"
                        class="pill accent hover:bg-[var(--accent-soft)] disabled:opacity-40 disabled:cursor-not-allowed"
                        [disabled]="ideConnecting"
                        (click)="connectIde(ide)"
                        data-testid="connect-btn"
                      >
                        connect →
                      </button>
                    }
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>

      @if (ideError) {
        <div
          class="mono mt-3 rounded border border-red-500/40 bg-red-500/5 px-3 py-2 text-[11px] text-red-300"
          data-testid="error-banner"
        >
          {{ ideError }}
        </div>
      }
    </section>
  `,
})
export class IdeBridgeComponent implements OnInit, OnDestroy {
  /** IDEs detected by the IDE Bridge scanner. */
  availableIdes: DetectedIde[] = [];
  /** Currently connected IDE, or null if none. */
  selectedIde: { ide_name: string; port: number } | null = null;
  /** Whether an IDE connection attempt is in progress. */
  ideConnecting = false;
  /** IDE-specific error message. */
  ideError: string | null = null;
  /** Latest IDE Bridge event description. */
  lastEvent: string | null = null;
  /** Whether the event banner is fading out. */
  eventFading = false;

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private ideIntervalId: ReturnType<typeof setInterval> | null = null;
  private eventTimerId: ReturnType<typeof setTimeout> | null = null;
  private unlistenEvent: (() => void) | null = null;

  /** Loads the selected IDE, starts polling, and subscribes to bridge events. */
  async ngOnInit(): Promise<void> {
    await this.loadSelectedIde();
    this.pollIdes();
    this.ideIntervalId = setInterval(() => this.pollIdes(), 5000);

    this.tauri
      .listen<{ kind: string; detail: string }>('ide_bridge_event', (event) => {
        this.lastEvent = `${event.payload.kind}: ${event.payload.detail}`;
        this.eventFading = false;
        this.cdr.markForCheck();
        if (this.eventTimerId !== null) clearTimeout(this.eventTimerId);
        this.eventTimerId = setTimeout(() => {
          this.eventFading = true;
          this.cdr.markForCheck();
          this.eventTimerId = setTimeout(() => {
            this.lastEvent = null;
            this.eventFading = false;
            this.cdr.markForCheck();
            this.eventTimerId = null;
          }, 1000);
        }, 9000);
      })
      .then((unlisten) => {
        this.unlistenEvent = unlisten;
      })
      .catch(() => {
        // Tauri event listener not available outside desktop context
      });
  }

  /** Cleans up IDE polling interval, event fade timer, and Tauri event listener. */
  ngOnDestroy(): void {
    if (this.ideIntervalId !== null) {
      clearInterval(this.ideIntervalId);
      this.ideIntervalId = null;
    }
    if (this.eventTimerId !== null) {
      clearTimeout(this.eventTimerId);
      this.eventTimerId = null;
    }
    if (this.unlistenEvent) {
      this.unlistenEvent();
      this.unlistenEvent = null;
    }
  }

  /**
   * Connects the IDE Bridge to the selected IDE instance.
   * @param ide - The detected IDE to connect to via the bridge.
   */
  async connectIde(ide: DetectedIde): Promise<void> {
    if (ide.port === null) {
      this.ideError = `${ide.ide_name} has no port — cannot connect`;
      this.cdr.markForCheck();
      return;
    }
    this.ideConnecting = true;
    this.ideError = null;
    try {
      await this.tauri.invoke('select_ide', { ideName: ide.ide_name, port: ide.port });
      this.selectedIde = { ide_name: ide.ide_name, port: ide.port };
    } catch (err) {
      this.ideError = `Failed to connect to ${ide.ide_name}: ${err}`;
    } finally {
      this.ideConnecting = false;
      this.cdr.markForCheck();
    }
  }

  private async loadSelectedIde(): Promise<void> {
    try {
      const sel = await this.tauri.invoke<{ ide_name: string; port: number } | null>(
        'get_selected_ide'
      );
      if (sel) this.selectedIde = { ide_name: sel.ide_name, port: sel.port };
    } catch (e: unknown) {
      if (this.tauri.isRunningInTauri()) {
        console.warn('loadSelectedIde failed:', e);
      }
    }
    this.cdr.markForCheck();
  }

  private async pollIdes(): Promise<void> {
    try {
      this.availableIdes = await this.tauri.invoke<DetectedIde[]>('list_available_ides');
    } catch (e: unknown) {
      if (this.tauri.isRunningInTauri()) {
        console.warn('pollIdes failed:', e);
      }
    }
    this.cdr.markForCheck();
  }
}
