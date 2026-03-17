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
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mb-6" data-testid="integrations-ide-bridge">
      <h2 class="text-[15px] text-sw-text m-0 mb-3">IDE Bridge</h2>
      @if (lastEvent) {
        <div
          class="mb-4 px-3 py-2 bg-sw-bg-navy border border-sw-border rounded font-mono text-xs text-sw-text-muted transition-opacity duration-1000 ease-out"
          [class.opacity-0]="eventFading"
          data-testid="event-banner"
        >
          {{ lastEvent }}
        </div>
      }
      <div class="bg-sw-bg-dark border border-sw-border rounded-lg mb-3 overflow-hidden">
        <div class="flex justify-between items-center px-5 py-4 cursor-default">
          <div class="flex items-center gap-3">
            <span class="font-semibold text-base">Available IDEs</span>
          </div>
        </div>
        <div class="px-5 pb-4">
          @if (availableIdes.length === 0) {
            <div class="text-sw-text-dim text-[13px] py-2" data-testid="no-data">
              No IDE detected — open Cursor or VS Code with the Claude Code extension.
            </div>
          } @else {
            <div class="flex flex-col gap-2">
              @for (ide of availableIdes; track ide.ide_name + ':' + ide.port) {
                <div
                  class="flex items-center gap-2.5 px-3 py-2 bg-sw-bg-darkest rounded"
                  [style.border-left-width]="
                    selectedIde?.ide_name === ide.ide_name && selectedIde?.port === ide.port
                      ? '3px'
                      : ''
                  "
                  [class.border-sw-success]="
                    selectedIde?.ide_name === ide.ide_name && selectedIde?.port === ide.port
                  "
                  data-testid="ide-row"
                >
                  <span
                    class="flex-1 font-mono text-[13px] text-sw-text"
                    data-testid="ide-row-name"
                    >{{ ide.ide_name }}</span
                  >
                  @if (ide.port !== null) {
                    <span class="font-mono text-xs text-sw-success">:{{ ide.port }}</span>
                  }
                  <button
                    class="px-3 py-1 bg-sw-border text-sw-text border border-sw-border rounded text-xs font-mono cursor-pointer transition-colors duration-200 hover:enabled:bg-sw-bg-navy disabled:opacity-40 disabled:cursor-not-allowed"
                    [class.!bg-sw-btn-active]="
                      selectedIde?.ide_name === ide.ide_name && selectedIde?.port === ide.port
                    "
                    [class.!border-sw-success]="
                      selectedIde?.ide_name === ide.ide_name && selectedIde?.port === ide.port
                    "
                    [class.!text-sw-success]="
                      selectedIde?.ide_name === ide.ide_name && selectedIde?.port === ide.port
                    "
                    [attr.data-active]="
                      selectedIde?.ide_name === ide.ide_name && selectedIde?.port === ide.port
                        ? 'true'
                        : null
                    "
                    [disabled]="ideConnecting"
                    (click)="connectIde(ide)"
                    data-testid="connect-btn"
                  >
                    {{
                      selectedIde?.ide_name === ide.ide_name && selectedIde?.port === ide.port
                        ? 'Connected'
                        : 'Connect'
                    }}
                  </button>
                </div>
              }
            </div>
          }
          @if (ideError) {
            <div
              class="mt-4 px-3 py-2 bg-sw-error/10 border border-sw-error rounded text-sw-error text-[13px]"
              data-testid="error-banner"
            >
              {{ ideError }}
            </div>
          }
        </div>
      </div>
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
