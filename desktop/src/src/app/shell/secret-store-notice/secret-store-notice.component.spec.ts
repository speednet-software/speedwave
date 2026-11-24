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

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;

  async function render(): Promise<void> {
    fixture = TestBed.createComponent(SecretStoreNoticeComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    mockTauri = new MockTauriService();
    unreadable = [];
    mockTauri.invokeHandler = async (cmd) =>
      cmd === 'get_secret_store_status'
        ? { state: 'ready', integrations: [], plaintextCount: 0, unreadable }
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

  it('hides the notice after Dismiss', async () => {
    unreadable = ['Integration slack: cannot read the secret.'];
    await render();

    const dismiss = '[data-testid="secret-store-notice-dismiss"]';
    root().querySelector<HTMLButtonElement>(dismiss)?.click();
    fixture.detectChanges();

    expect(root().querySelector('[data-testid="secret-store-notice"]')).toBeNull();
  });
});
