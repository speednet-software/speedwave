import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SleepSectionComponent } from './sleep-section.component';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { createDeferred } from '../../testing/deferred';

describe('SleepSectionComponent', () => {
  let fixture: ComponentFixture<SleepSectionComponent>;
  let component: SleepSectionComponent;
  let mockTauri: MockTauriService;
  let stored: boolean;
  let saveError: Error | null;
  let platform: string;
  let saved: boolean[];
  let errors: string[];

  async function render(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(SleepSectionComponent);
    component = fixture.componentInstance;
    component.errorOccurred.subscribe((m) => errors.push(m));
    fixture.detectChanges();
    await settle();
    return fixture.nativeElement as HTMLElement;
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
  }

  function toggle(el: HTMLElement): HTMLInputElement {
    return el.querySelector('[data-testid="keep-awake-toggle"]') as HTMLInputElement;
  }

  function flip(box: HTMLInputElement, on: boolean): void {
    box.checked = on;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    stored = true;
    saveError = null;
    platform = 'macos';
    saved = [];
    errors = [];
    mockTauri.invokeHandler = async (cmd, args) => {
      if (cmd === 'get_platform') return platform;
      if (cmd === 'get_keep_awake') return stored;
      if (cmd === 'set_keep_awake') {
        if (saveError) throw saveError;
        stored = args?.['enabled'] as boolean;
        saved.push(stored);
        return undefined;
      }
      return undefined;
    };
    await TestBed.configureTestingModule({
      imports: [SleepSectionComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();
  });

  it('is a block so the page spacing applies above it', async () => {
    const el = await render();

    expect(el.classList).toContain('block');
  });

  it('shows the switch on by default and explains what still puts the computer to sleep', async () => {
    const el = await render();

    expect(toggle(el).checked).toBe(true);
    expect(el.textContent).toContain('The screen can still turn off and lock.');
    expect(el.textContent).toContain('Closing the lid, choosing Sleep or a low battery');
    expect(el.textContent).not.toContain('Windows');
    expect(el.textContent).not.toContain('Claude');
  });

  it('names the Windows battery limit only on Windows', async () => {
    platform = 'windows';
    const el = await render();

    expect(el.textContent).toContain('On battery, Windows may still sleep');
  });

  it('shows the last pick once a failed save is followed by saves that succeed', async () => {
    const el = await render();
    let failNext = true;
    const base = mockTauri.invokeHandler;
    mockTauri.invokeHandler = async (cmd, args) => {
      if (cmd === 'set_keep_awake' && failNext) {
        failNext = false;
        throw new Error('disk busy');
      }
      return base(cmd, args);
    };

    flip(toggle(el), false);
    flip(toggle(el), true);
    flip(toggle(el), false);
    await component.onToggle({ target: { checked: false } } as unknown as Event);
    fixture.detectChanges();

    expect(errors).toEqual(['disk busy']);
    expect(stored).toBe(false);
    expect(toggle(el).checked).toBe(stored);
  });

  it('shows a switch the user turned off', async () => {
    stored = false;
    const el = await render();

    expect(toggle(el).checked).toBe(false);
  });

  it('shows no switch until the stored value arrives', async () => {
    const pending = createDeferred<boolean>();
    mockTauri.invokeHandler = async (cmd) => (cmd === 'get_keep_awake' ? pending.promise : null);
    const el = await render();
    expect(toggle(el)).toBeNull();

    pending.resolve(false);
    await settle();
    expect(toggle(el).checked).toBe(false);
  });

  it('stores every change in the order the user made it', async () => {
    const el = await render();

    flip(toggle(el), false);
    flip(toggle(el), true);
    flip(toggle(el), false);
    await settle();

    expect(saved).toEqual([false, true, false]);
    expect(component.enabled()).toBe(false);
  });

  it('reports a failed save and shows the value that is still stored', async () => {
    const el = await render();
    saveError = new Error('config is read-only');

    await component.onToggle({ target: { checked: false } } as unknown as Event);
    fixture.detectChanges();

    expect(errors).toEqual(['config is read-only']);
    expect(toggle(el).checked).toBe(true);
  });

  it('reports a setting it cannot read', async () => {
    mockTauri.invokeHandler = async () => {
      throw 'config.json is not valid JSON';
    };
    const el = await render();

    expect(errors).toEqual(['config.json is not valid JSON']);
    expect(toggle(el)).toBeNull();
  });
});
