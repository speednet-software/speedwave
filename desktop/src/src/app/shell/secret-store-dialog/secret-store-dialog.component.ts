import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { SecretStoreService } from '../../services/secret-store.service';

const BUTTON_PRIMARY =
  'mono cursor-pointer rounded border-none bg-[var(--accent)] px-4 py-2 text-[13px] font-semibold text-[var(--on-accent)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40';
const BUTTON_SECONDARY =
  'mono cursor-pointer rounded border border-[var(--line)] bg-transparent px-4 py-2 text-[13px] text-[var(--ink)] hover:bg-[var(--bg-2)] disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Blocking dialog shown while the secret store is not ready: a missing key offers one confirmed
 * way forward (a new key), a plaintext or damaged store offers none.
 */
@Component({
  selector: 'app-secret-store-dialog',
  imports: [A11yModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.blocking()) {
      <div
        class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-sm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="secret-store-title"
        aria-describedby="secret-store-body"
        tabindex="-1"
        cdkTrapFocus
        [cdkTrapFocusAutoCapture]="true"
        data-testid="secret-store-dialog"
      >
        <div
          class="w-[min(32rem,calc(100vw-2rem))] rounded border border-red-500/30 bg-[var(--bg-1)] p-6"
          role="document"
        >
          <div class="mono text-[11px] uppercase tracking-widest text-red-400">
            {{ kicker() }}
          </div>
          <h2
            id="secret-store-title"
            class="mono mt-2 text-base font-semibold text-[var(--ink)]"
            data-testid="secret-store-title"
          >
            {{ title() }}
          </h2>
          <div id="secret-store-body" class="mono mt-3 text-[13px] text-[var(--ink-mute)]">
            @switch (store.state()) {
              @case ('keyMissing') {
                @if (confirming()) {
                  <p data-testid="secret-store-confirm-text">
                    Creating a new key cannot be undone. The saved credentials of the affected
                    integrations are deleted and PII tokens already present in chat history become
                    impossible to read. Continue?
                  </p>
                } @else {
                  <p>
                    The key that protects your saved credentials is missing, so Speedwave cannot
                    read them. These integrations are affected:
                  </p>
                  <ul class="mt-3 space-y-1" data-testid="secret-store-integrations">
                    @for (group of store.affectedProjects(); track group.project) {
                      <li>{{ group.project }}: {{ group.services.join(', ') }}</li>
                    }
                  </ul>
                  <p class="mt-3">
                    Creating a new key means you reconnect each of these integrations. PII tokens
                    already present in chat history will become impossible to read. This cannot be
                    undone.
                  </p>
                }
              }
              @case ('plaintextInStore') {
                <p data-testid="secret-store-plaintext-text">
                  {{ plaintextSentence() }} Speedwave will not start projects until they are removed
                  or the app is reinstalled.
                </p>
              }
              @case ('storeUnavailable') {
                <p data-testid="secret-store-unavailable-text">
                  The secrets directory cannot be read. Check its permissions. Speedwave will not
                  start projects until it can be read.
                </p>
              }
              @default {
                <p data-testid="secret-store-damaged-text">
                  The key file secret-store.key in the Speedwave data directory is damaged and
                  cannot be read. Restore it from a backup, or remove it together with the
                  encrypted secrets in the secrets directory. Reinstalling alone may keep the data
                  directory. Speedwave will not start projects until then.
                </p>
              }
            }
          </div>

          @if (store.resetError(); as error) {
            <div
              class="mono mt-3 rounded border border-red-500/30 bg-red-500/5 p-2 text-[12px] text-red-300"
              role="alert"
              data-testid="secret-store-error"
            >
              {{ error }}
            </div>
          }

          @if (store.state() === 'keyMissing') {
            <div class="mt-5 flex gap-3">
              @if (confirming()) {
                <button
                  #confirmButton
                  type="button"
                  [class]="buttonPrimary"
                  [disabled]="store.resetting()"
                  data-testid="secret-store-confirm-btn"
                  (click)="confirm()"
                >
                  {{ store.resetting() ? 'Creating...' : 'Yes, create a new key' }}
                </button>
                <button
                  type="button"
                  [class]="buttonSecondary"
                  [disabled]="store.resetting()"
                  data-testid="secret-store-back-btn"
                  (click)="back()"
                >
                  Back
                </button>
              } @else {
                <button
                  #createButton
                  type="button"
                  [class]="buttonPrimary"
                  data-testid="secret-store-create-btn"
                  (click)="askConfirmation()"
                >
                  Create a new key
                </button>
              }
            </div>
          }
        </div>
      </div>
    }
  `,
})
export class SecretStoreDialogComponent {
  protected readonly store = inject(SecretStoreService);
  private readonly injector = inject(Injector);
  private readonly confirmButton = viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  private readonly createButton = viewChild<ElementRef<HTMLButtonElement>>('createButton');

  protected readonly buttonPrimary = BUTTON_PRIMARY;
  protected readonly buttonSecondary = BUTTON_SECONDARY;
  protected readonly confirming = signal(false);

  protected readonly kicker = computed(() =>
    this.store.state() === 'keyMissing' ? 'secret store key missing' : 'secret store unavailable'
  );

  protected readonly title = computed(() => {
    switch (this.store.state()) {
      case 'keyMissing':
        return 'The key for your saved credentials is missing';
      case 'plaintextInStore':
        return 'Unexpected files in the secrets directory';
      case 'storeUnavailable':
        return 'The secrets directory cannot be read';
      default:
        return 'The secret store key file is damaged';
    }
  });

  protected readonly plaintextSentence = computed(() => {
    const count = this.store.plaintextCount();
    return count === 1
      ? 'Speedwave found 1 plaintext file in the secrets directory.'
      : `Speedwave found ${count} plaintext files in the secrets directory.`;
  });

  /** Moves to the second step; the irreversible call needs one more click. */
  protected askConfirmation(): void {
    this.confirming.set(true);
    this.focusAfterRender(this.confirmButton);
  }

  /** Returns to the first step without changing anything. */
  protected back(): void {
    this.confirming.set(false);
    this.focusAfterRender(this.createButton);
  }

  /** Creates the new key; on failure the dialog stays and shows the error. */
  protected async confirm(): Promise<void> {
    await this.store.createNewKey();
    if (!this.store.blocking()) this.confirming.set(false);
  }

  private focusAfterRender(target: () => ElementRef<HTMLButtonElement> | undefined): void {
    afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
  }
}
