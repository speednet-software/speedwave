import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SecretStoreDialogComponent } from './secret-store-dialog.component';
import { TauriService } from '../../services/tauri.service';
import { LoggerService } from '../../services/logger.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { makeMockLogger } from '../../testing/mock-logger';
import type { SecretStoreStatus } from '../../models/secret-store';

const READY: SecretStoreStatus = {
  state: 'ready',
  integrations: [],
  plaintextCount: 0,
  unreadable: [],
  migrationNotices: [],
};

const KEY_MISSING: SecretStoreStatus = {
  state: 'keyMissing',
  integrations: [
    { project: 'alpha', service: 'redmine' },
    { project: 'alpha', service: 'slack' },
    { project: 'beta', service: 'gitlab' },
  ],
  plaintextCount: 0,
  unreadable: [],
  migrationNotices: [],
};

describe('SecretStoreDialogComponent', () => {
  let mockTauri: MockTauriService;
  let fixture: ComponentFixture<SecretStoreDialogComponent>;
  let resetCalls: unknown[];
  let status: SecretStoreStatus;
  let resetHandler: () => Promise<unknown>;

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    root().querySelector<T>(`[data-testid="${id}"]`);

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function render(initial: SecretStoreStatus): Promise<void> {
    status = initial;
    fixture = TestBed.createComponent(SecretStoreDialogComponent);
    fixture.detectChanges();
    await settle();
  }

  beforeEach(() => {
    mockTauri = new MockTauriService();
    resetCalls = [];
    resetHandler = async () => READY;
    mockTauri.invokeHandler = async (cmd, args) => {
      if (cmd === 'get_secret_store_status') return status;
      if (cmd === 'reset_secret_store') {
        resetCalls.push(args);
        return resetHandler();
      }
      return undefined;
    };
    TestBed.configureTestingModule({
      imports: [SecretStoreDialogComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: makeMockLogger() },
      ],
    });
  });

  it('renders nothing while the store is ready', async () => {
    await render(READY);

    expect(byId('secret-store-dialog')).toBeNull();
  });

  describe('key missing', () => {
    beforeEach(async () => {
      await render(KEY_MISSING);
    });

    it('is an accessible blocking dialog with a label and a description', () => {
      const dialog = byId('secret-store-dialog');

      expect(dialog?.getAttribute('role')).toBe('alertdialog');
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      const labelId = dialog?.getAttribute('aria-labelledby') ?? '';
      const describedId = dialog?.getAttribute('aria-describedby') ?? '';
      expect(root().querySelector(`#${labelId}`)?.textContent).toContain('key');
      expect(root().querySelector(`#${describedId}`)).not.toBeNull();
    });

    it('lists the affected services per project', () => {
      const items = [...root().querySelectorAll('[data-testid="secret-store-integrations"] li')];

      expect(items.map((li) => li.textContent?.trim())).toEqual([
        'alpha: redmine, slack',
        'beta: gitlab',
      ]);
    });

    it('warns about reconnecting and the irreversible loss of PII tokens', () => {
      const text = root().textContent ?? '';

      expect(text).toContain('reconnect');
      expect(text).toContain('PII tokens');
      expect(text).toContain('cannot be undone');
    });

    it('offers only the create button; the first click does not reset', async () => {
      const buttons = [...root().querySelectorAll('button')];
      expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Create a new key']);

      byId('secret-store-create-btn')?.click();
      await settle();

      expect(resetCalls).toEqual([]);
      expect(byId('secret-store-confirm-text')).not.toBeNull();
    });

    it('moves focus to the confirm button on the second step', async () => {
      byId('secret-store-create-btn')?.click();
      await settle();

      expect(document.activeElement).toBe(byId('secret-store-confirm-btn'));
    });

    it('goes back to the first step without calling the backend', async () => {
      byId('secret-store-create-btn')?.click();
      await settle();
      byId('secret-store-back-btn')?.click();
      await settle();

      expect(byId('secret-store-create-btn')).not.toBeNull();
      expect(byId('secret-store-confirm-btn')).toBeNull();
      expect(resetCalls).toEqual([]);
    });

    it('resets with confirmed true on the second click and closes the dialog', async () => {
      byId('secret-store-create-btn')?.click();
      await settle();
      byId('secret-store-confirm-btn')?.click();
      await settle();

      expect(resetCalls).toEqual([{ confirmed: true }]);
      expect(byId('secret-store-dialog')).toBeNull();
    });

    it('stays open and shows the error when the reset fails', async () => {
      resetHandler = async () => {
        throw new Error('The secret store does not need a new key.');
      };
      byId('secret-store-create-btn')?.click();
      await settle();
      byId('secret-store-confirm-btn')?.click();
      await settle();

      expect(byId('secret-store-dialog')).not.toBeNull();
      expect(byId('secret-store-error')?.textContent).toContain('does not need a new key');
    });

    it('disables both buttons while the reset runs', async () => {
      let release: (value: unknown) => void = () => undefined;
      resetHandler = () => new Promise((resolve) => (release = resolve));
      byId('secret-store-create-btn')?.click();
      await settle();
      byId('secret-store-confirm-btn')?.click();
      fixture.detectChanges();

      expect(byId<HTMLButtonElement>('secret-store-confirm-btn')?.disabled).toBe(true);
      expect(byId<HTMLButtonElement>('secret-store-back-btn')?.disabled).toBe(true);
      release(READY);
      await settle();
    });
  });

  describe('plaintext in the store', () => {
    it('shows the count and has no button', async () => {
      await render({ ...READY, state: 'plaintextInStore', plaintextCount: 3 });

      const text = byId('secret-store-plaintext-text')?.textContent ?? '';
      expect(text).toContain('3 plaintext files');
      expect(text).toContain('removed or the app is reinstalled');
      expect(root().querySelectorAll('button')).toHaveLength(0);
    });

    it('uses the singular for one file', async () => {
      await render({ ...READY, state: 'plaintextInStore', plaintextCount: 1 });

      expect(byId('secret-store-plaintext-text')?.textContent).toContain('1 plaintext file ');
    });
  });

  describe('key unreadable', () => {
    it('says the key file is damaged and has no button', async () => {
      await render({ ...READY, state: 'keyUnreadable' });

      expect(byId('secret-store-title')?.textContent).toContain('damaged');
      expect(byId('secret-store-damaged-text')?.textContent).toContain('reinstalled');
      expect(root().querySelectorAll('button')).toHaveLength(0);
    });
  });
});
