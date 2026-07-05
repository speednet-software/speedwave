import { describe, it, expect, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ToggleComponent } from './toggle.component';

describe('ToggleComponent', () => {
  let fixture: ComponentFixture<ToggleComponent>;
  let component: ToggleComponent;

  async function create(): Promise<void> {
    await TestBed.configureTestingModule({ imports: [ToggleComponent] }).compileComponents();
    fixture = TestBed.createComponent(ToggleComponent);
    component = fixture.componentInstance;
  }

  function input(): HTMLInputElement {
    return fixture.nativeElement.querySelector('input[type="checkbox"]');
  }
  function wrapper(): HTMLElement {
    return fixture.nativeElement.querySelector('[data-testid="toggle"]');
  }

  it('renders an sr-only peer checkbox inside a labelled toggle wrapper', async () => {
    await create();
    fixture.detectChanges();
    expect(wrapper()).not.toBeNull();
    expect(input().classList.contains('peer')).toBe(true);
    expect(input().classList.contains('sr-only')).toBe(true);
  });

  it('reflects the checked input', async () => {
    await create();
    fixture.componentRef.setInput('checked', true);
    fixture.detectChanges();
    expect(input().checked).toBe(true);
  });

  it('forwards testId onto the inner checkbox', async () => {
    await create();
    fixture.componentRef.setInput('testId', 'telemetry-enabled');
    fixture.detectChanges();
    expect(input().getAttribute('data-testid')).toBe('telemetry-enabled');
  });

  it('emits the raw change event so callers can read event.target', async () => {
    await create();
    fixture.detectChanges();
    const spy = vi.spyOn(component.changed, 'emit');
    input().dispatchEvent(new Event('change'));
    expect(spy).toHaveBeenCalledTimes(1);
    const event = spy.mock.calls[0][0];
    expect(event?.target).toBe(input());
  });

  it('disables the checkbox and marks the wrapper when disabled', async () => {
    await create();
    fixture.componentRef.setInput('disabled', true);
    fixture.componentRef.setInput('disabledTitle', 'Configure credentials to enable');
    fixture.detectChanges();
    expect(input().disabled).toBe(true);
    expect(wrapper().getAttribute('data-disabled')).toBe('');
    expect(wrapper().getAttribute('title')).toBe('Configure credentials to enable');
    expect(wrapper().classList.contains('opacity-40')).toBe(true);
  });

  it('leaves data-disabled and title absent when enabled', async () => {
    await create();
    fixture.componentRef.setInput('disabledTitle', 'Configure credentials to enable');
    fixture.detectChanges();
    expect(input().disabled).toBe(false);
    expect(wrapper().getAttribute('data-disabled')).toBeNull();
    expect(wrapper().getAttribute('title')).toBeNull();
  });

  it('exposes an accessible switch name from ariaLabel', async () => {
    await create();
    fixture.componentRef.setInput('ariaLabel', 'Send telemetry');
    fixture.detectChanges();
    expect(input().getAttribute('role')).toBe('switch');
    expect(input().getAttribute('aria-label')).toBe('Send telemetry');
  });

  it('omits aria-label when none is given', async () => {
    await create();
    fixture.detectChanges();
    expect(input().getAttribute('aria-label')).toBeNull();
  });
});
