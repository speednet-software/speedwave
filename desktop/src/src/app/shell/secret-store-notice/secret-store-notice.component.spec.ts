import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SecretStoreNoticeComponent } from './secret-store-notice.component';
import { TauriService } from '../../services/tauri.service';
import { LoggerService } from '../../services/logger.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { makeMockLogger } from '../../testing/mock-logger';

describe('SecretStoreNoticeComponent', () => {
  let mockTauri: MockTauriService;
  let fixture: ComponentFixture<SecretStoreNoticeComponent>;
  let unreadable: string[];
  let migrationNotices: string[];

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;

  async function render(): Promise<void> {
    fixture = TestBed.createComponent(SecretStoreNoticeComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  beforeEach(() => {
    mockTauri = new MockTauriService();
    unreadable = [];
    migrationNotices = [];
    mockTauri.invokeHandler = async (cmd) =>
      cmd === 'get_secret_store_status'
        ? { state: 'ready', integrations: [], unreadable, migrationNotices }
        : undefined;
    TestBed.configureTestingModule({
      imports: [SecretStoreNoticeComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: makeMockLogger() },
      ],
    });
  });

  it('renders nothing without unreadable integrations', async () => {
    await render();

    expect(root().querySelector('[data-testid="secret-store-notice"]')).toBeNull();
  });

  it('lists each message in a status region', async () => {
    unreadable = ['Integration slack: cannot read it.', 'Integration redmine: cannot read it.'];
    await render();

    const notice = root().querySelector('[data-testid="secret-store-notice"]');
    expect(notice?.getAttribute('role')).toBe('status');
    const items = [...root().querySelectorAll('[data-testid="secret-store-notice-item"]')];
    expect(items.map((li) => li.textContent?.trim())).toEqual(unreadable);
  });

  it('lists failed-migration notices in the same region', async () => {
    unreadable = ['Integration slack: cannot read the secret.'];
    migrationNotices = ['Startup migration secrets_at_rest did not finish: 1 problem(s).'];
    await render();

    const items = [...root().querySelectorAll('[data-testid="secret-store-notice-item"]')];
    expect(items.map((li) => li.textContent?.trim())).toEqual([...unreadable, ...migrationNotices]);
  });

  it('hides the notice after Dismiss', async () => {
    unreadable = ['Integration slack: cannot read the secret.'];
    await render();

    const dismiss = '[data-testid="secret-store-notice-dismiss"]';
    root().querySelector<HTMLButtonElement>(dismiss)?.click();
    fixture.detectChanges();

    expect(root().querySelector('[data-testid="secret-store-notice"]')).toBeNull();
  });
});
