import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PermissionPromptComponent, type PermissionDecision } from './permission-prompt.component';

describe('PermissionPromptComponent', () => {
  let component: PermissionPromptComponent;
  let fixture: ComponentFixture<PermissionPromptComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PermissionPromptComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(PermissionPromptComponent);
    component = fixture.componentInstance;
  });

  function setInputs(command: string, description = ''): void {
    component.command = command;
    component.description = description;
    fixture.detectChanges();
  }

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('happy: renders the command and three decision buttons', () => {
    setInputs('rm -rf ~/.speedwave/cache/*');
    expect(el().querySelector('[data-testid="permission-prompt"]')).toBeTruthy();
    expect(el().querySelector('[data-testid="permission-header"]')?.textContent).toContain(
      'permission required'
    );
    expect(el().querySelector('[data-testid="permission-command"]')?.textContent).toContain(
      'rm -rf ~/.speedwave/cache/*'
    );
    expect(el().querySelector('[data-testid="permission-allow-once"]')).toBeTruthy();
    expect(el().querySelector('[data-testid="permission-allow-always"]')).toBeTruthy();
    expect(el().querySelector('[data-testid="permission-deny"]')).toBeTruthy();
  });

  it('happy: each button emits the expected decision', () => {
    setInputs('ls');
    const events: PermissionDecision[] = [];
    component.decided.subscribe((d) => events.push(d));

    (
      el().querySelector('[data-testid="permission-allow-once"]') as HTMLButtonElement | null
    )?.click();
    (
      el().querySelector('[data-testid="permission-allow-always"]') as HTMLButtonElement | null
    )?.click();
    (el().querySelector('[data-testid="permission-deny"]') as HTMLButtonElement | null)?.click();

    expect(events).toEqual(['allow_once', 'allow_always', 'deny']);
  });

  it('state: a single button click emits exactly once', () => {
    setInputs('cat /etc/passwd');
    const spy = vi.fn();
    component.decided.subscribe(spy);
    (
      el().querySelector('[data-testid="permission-allow-once"]') as HTMLButtonElement | null
    )?.click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('allow_once');
  });

  it('edge: empty description hides the description paragraph', () => {
    setInputs('ls');
    expect(el().querySelector('[data-testid="permission-description"]')).toBeNull();
  });

  it('edge: description renders when provided', () => {
    setInputs('ls', 'List files in the working directory');
    expect(el().querySelector('[data-testid="permission-description"]')?.textContent?.trim()).toBe(
      'List files in the working directory'
    );
  });

  it('edge: very long command renders without truncation', () => {
    const long = 'echo ' + 'abc '.repeat(1000);
    setInputs(long);
    expect(el().querySelector('[data-testid="permission-command"]')?.textContent).toContain(long);
  });

  it('ARIA: wrapper has role=dialog and aria-labelledby', () => {
    setInputs('ls');
    const wrapper = el().querySelector('[data-testid="permission-prompt"]');
    expect(wrapper?.getAttribute('role')).toBe('dialog');
    const labelled = wrapper?.getAttribute('aria-labelledby');
    expect(labelled).toBeTruthy();
    if (labelled) {
      const header = el().querySelector(`[id="${labelled}"]`);
      expect(header).toBeTruthy();
    }
  });

  it('ARIA: decision buttons are real buttons with accessible text', () => {
    setInputs('ls');
    for (const id of ['allow-once', 'allow-always', 'deny']) {
      const btn = el().querySelector(
        `[data-testid="permission-${id}"]`
      ) as HTMLButtonElement | null;
      expect(btn?.tagName).toBe('BUTTON');
      expect(btn?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it('ARIA: button group has an aria-label', () => {
    setInputs('ls');
    const group = el().querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Permission decision');
  });
});
