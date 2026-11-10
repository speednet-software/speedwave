import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { ReadOnlyBannerComponent } from './read-only-banner.component';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { createDeferred } from '../../testing/deferred';
import type { AccessSettingsView } from '../../models/access';

describe('ReadOnlyBannerComponent', () => {
  let fixture: ComponentFixture<ReadOnlyBannerComponent>;
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  let response: (project: string) => Promise<AccessSettingsView | undefined>;

  const banner = (): HTMLElement | null =>
    fixture.nativeElement.querySelector('[data-testid="read-only-banner"]');
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  };

  const settingsLink = (): HTMLAnchorElement | null =>
    fixture.nativeElement.querySelector('[data-testid="read-only-banner-settings-link"]');

  async function create(project: string | null = 'proj', mentionsBrowser = false): Promise<void> {
    fixture = TestBed.createComponent(ReadOnlyBannerComponent);
    fixture.componentRef.setInput('project', project);
    fixture.componentRef.setInput('mentionsBrowser', mentionsBrowser);
    fixture.detectChanges();
    await settle();
  }

  beforeEach(() => {
    calls = [];
    response = async () => ({ read_only: false, read_only_locked: false });
    const tauri = new MockTauriService();
    tauri.invokeHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd !== 'get_access_settings') throw new Error(`unexpected ${cmd}`);
      return response(args?.['project'] as string);
    };
    TestBed.configureTestingModule({
      imports: [ReadOnlyBannerComponent],
      providers: [{ provide: TauriService, useValue: tauri }, provideRouter([])],
    });
  });

  it('shows nothing while the switch is off', async () => {
    await create();

    expect(banner()).toBeNull();
    expect(calls).toEqual([{ cmd: 'get_access_settings', args: { project: 'proj' } }]);
  });

  it('names the scope and links to the switch in Settings while the switch is on', async () => {
    response = async () => ({ read_only: true, read_only_locked: false });
    await create();

    expect(banner()?.textContent).toContain('All integrations and plugins are read-only');
    expect(banner()?.getAttribute('role')).toBe('status');
    expect(settingsLink()?.textContent?.trim()).toBe('Turn off in Settings');
    expect(settingsLink()?.getAttribute('href')).toBe('/settings#section-access');
  });

  it('says the organization set it and offers no way to turn it off when locked', async () => {
    response = async () => ({ read_only: true, read_only_locked: true });
    await create();

    expect(banner()?.textContent).toContain('set by your organization');
    expect(settingsLink()).toBeNull();
  });

  it('says the browser does not work when asked to mention it', async () => {
    response = async () => ({ read_only: true, read_only_locked: false });
    await create('proj', true);

    expect(banner()?.textContent).toContain('Playwright cannot open pages in this mode');
  });

  it('does not mention the browser by default', async () => {
    response = async () => ({ read_only: true, read_only_locked: false });
    await create();

    expect(banner()?.textContent).not.toContain('Playwright');
  });

  it('asks nothing without a project', async () => {
    await create(null);

    expect(banner()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('shows nothing when the state cannot be read', async () => {
    response = async () => {
      throw new Error('backend down');
    };
    await create();

    expect(banner()).toBeNull();
  });

  it('shows nothing for an empty answer', async () => {
    response = async () => undefined;
    await create();

    expect(banner()).toBeNull();
  });

  it('drops the answer for a project it no longer shows', async () => {
    const first = createDeferred<AccessSettingsView | undefined>();
    response = async (project) =>
      project === 'old' ? first.promise : { read_only: false, read_only_locked: false };
    await create('old');
    fixture.componentRef.setInput('project', 'new');
    fixture.detectChanges();
    await settle();
    first.resolve({ read_only: true, read_only_locked: false });
    await settle();

    expect(banner()).toBeNull();
  });
});
