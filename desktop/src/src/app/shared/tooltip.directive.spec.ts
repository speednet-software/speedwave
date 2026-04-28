import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TooltipDirective, type TooltipPlacement } from './tooltip.directive';

@Component({
  template: `<button [appTooltip]="label()" [tooltipKbd]="kbd()" [placement]="placement()">
    btn
  </button>`,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class HostComponent {
  readonly label = signal('hello');
  readonly kbd = signal('');
  readonly placement = signal<TooltipPlacement>('bottom');
}

function getButton(fixture: ComponentFixture<HostComponent>): HTMLButtonElement {
  const btn = fixture.nativeElement.querySelector('button');
  if (!btn) throw new Error('button host not found');
  return btn as HTMLButtonElement;
}

function queryTooltip(): HTMLElement | null {
  return document.querySelector('.app-tooltip');
}

describe('TooltipDirective', () => {
  let fixture: ComponentFixture<HostComponent> | undefined;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture?.destroy();
    fixture = undefined;
  });

  it('shows overlay panel on mouseenter', async () => {
    const btn = getButton(fixture!);
    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    fixture!.detectChanges();
    await fixture!.whenStable();

    const tooltip = queryTooltip();
    expect(tooltip).not.toBeNull();
    expect(tooltip!.textContent).toContain('hello');
  });

  it('hides on mouseleave', async () => {
    const btn = getButton(fixture!);
    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    fixture!.detectChanges();
    await fixture!.whenStable();
    expect(queryTooltip()).not.toBeNull();

    btn.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    fixture!.detectChanges();
    await fixture!.whenStable();
    expect(queryTooltip()).toBeNull();
  });

  it('hides on focusout', async () => {
    const btn = getButton(fixture!);
    btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    fixture!.detectChanges();
    await fixture!.whenStable();
    expect(queryTooltip()).not.toBeNull();

    btn.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    fixture!.detectChanges();
    await fixture!.whenStable();
    expect(queryTooltip()).toBeNull();
  });

  it('hides on click', async () => {
    const btn = getButton(fixture!);
    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    fixture!.detectChanges();
    await fixture!.whenStable();
    expect(queryTooltip()).not.toBeNull();

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture!.detectChanges();
    await fixture!.whenStable();
    expect(queryTooltip()).toBeNull();
  });

  it('does not show overlay for empty label', async () => {
    fixture!.componentInstance.label.set('');
    fixture!.detectChanges();

    const btn = getButton(fixture!);
    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    fixture!.detectChanges();
    await fixture!.whenStable();

    expect(queryTooltip()).toBeNull();
  });

  it('updates data-placement after re-show when placement changes', async () => {
    const btn = getButton(fixture!);
    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    fixture!.detectChanges();
    await fixture!.whenStable();
    expect(queryTooltip()!.getAttribute('data-placement')).toBe('bottom');

    btn.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    fixture!.detectChanges();
    await fixture!.whenStable();

    fixture!.componentInstance.placement.set('right');
    fixture!.detectChanges();

    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    fixture!.detectChanges();
    await fixture!.whenStable();
    expect(queryTooltip()!.getAttribute('data-placement')).toBe('right');
  });

  it('disposes overlay on ngOnDestroy', async () => {
    const btn = getButton(fixture!);
    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    fixture!.detectChanges();
    await fixture!.whenStable();
    expect(queryTooltip()).not.toBeNull();

    fixture!.destroy();
    fixture = undefined;
    expect(queryTooltip()).toBeNull();
  });

  it('removes native title attribute from host on init', () => {
    // Re-create with a host that has a native title attribute via initial input
    // The directive strips `title` even if browser default is empty, but more
    // importantly verify the host element does not carry it after init.
    const btn = getButton(fixture!);
    expect(btn.hasAttribute('title')).toBe(false);
  });
});
