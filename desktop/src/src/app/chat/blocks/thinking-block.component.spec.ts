import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ThinkingBlockComponent } from './thinking-block.component';

describe('ThinkingBlockComponent', () => {
  let component: ThinkingBlockComponent;
  let fixture: ComponentFixture<ThinkingBlockComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ThinkingBlockComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ThinkingBlockComponent);
    component = fixture.componentInstance;
    el = fixture.nativeElement as HTMLElement;
  });

  /** Sets `open` on `<details>` and dispatches the native `toggle` event. */
  function activateToggle(): void {
    const details = el.querySelector('details') as HTMLDetailsElement;
    details.open = !details.open;
    details.dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
  }

  // happy — collapsed by default
  it('is collapsed by default (details closed, chevron not rotated)', () => {
    fixture.componentRef.setInput('content', 'thinking...');
    fixture.detectChanges();

    const details = el.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const toggle = el.querySelector('[data-testid="thinking-toggle"]');
    expect(toggle?.textContent).toContain('thinking');
    const chevron = toggle?.querySelector('app-icon');
    expect(chevron?.classList.contains('rotate-90')).toBe(false);
  });

  // state — toggling expands
  it('expands when the toggle is activated (chevron rotates 90°)', () => {
    fixture.componentRef.setInput('content', 'I should check the file');
    fixture.detectChanges();

    activateToggle();

    const details = el.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    const content = el.querySelector('[data-testid="thinking-content"]');
    expect(content?.textContent?.trim()).toBe('I should check the file');
    const toggle = el.querySelector('[data-testid="thinking-toggle"]') as HTMLElement;
    const chevron = toggle.querySelector('app-icon');
    expect(chevron?.classList.contains('rotate-90')).toBe(true);
  });

  it('collapses again on a second toggle', () => {
    fixture.componentRef.setInput('content', 'loop');
    fixture.detectChanges();

    activateToggle();
    activateToggle();

    const details = el.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const toggle = el.querySelector('[data-testid="thinking-toggle"]') as HTMLElement;
    const chevron = toggle.querySelector('app-icon');
    expect(chevron?.classList.contains('rotate-90')).toBe(false);
  });

  it('respects collapsedDefault=false input — starts expanded', () => {
    fixture.componentRef.setInput('content', 'visible up front');
    fixture.componentRef.setInput('collapsedDefault', false);
    fixture.detectChanges();

    const content = el.querySelector('[data-testid="thinking-content"]');
    expect(content?.textContent?.trim()).toBe('visible up front');
  });

  // edge — empty / long content
  it('renders empty content without error', () => {
    fixture.componentRef.setInput('content', '');
    fixture.componentRef.setInput('collapsedDefault', false);
    fixture.detectChanges();

    const content = el.querySelector('[data-testid="thinking-content"]');
    expect(content).not.toBeNull();
    expect(content?.textContent?.trim()).toBe('');
  });

  it('renders multi-paragraph long content preserving newlines (whitespace-pre-wrap)', () => {
    const long = 'paragraph one\n\nparagraph two\n\n' + 'line '.repeat(500);
    fixture.componentRef.setInput('content', long);
    fixture.componentRef.setInput('collapsedDefault', false);
    fixture.detectChanges();

    const content = el.querySelector('[data-testid="thinking-content"]');
    expect(content?.textContent).toContain('paragraph one');
    expect(content?.textContent).toContain('paragraph two');
  });

  it('renders content as plain text (markdown is NOT interpreted)', () => {
    fixture.componentRef.setInput('content', '**not bold** and `not code`');
    fixture.componentRef.setInput('collapsedDefault', false);
    fixture.detectChanges();

    const content = el.querySelector('[data-testid="thinking-content"]');
    expect(content?.querySelector('strong')).toBeNull();
    expect(content?.querySelector('code')).toBeNull();
    expect(content?.textContent).toContain('**not bold**');
  });

  // ARIA — aria-expanded reflects state, aria-controls pairs correctly
  it('wires aria-expanded to reflect collapsed state', () => {
    fixture.componentRef.setInput('content', 'x');
    fixture.detectChanges();
    const toggle = el.querySelector('[data-testid="thinking-toggle"]') as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    activateToggle();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('wires aria-controls on the toggle to the id of the expanded content region', () => {
    fixture.componentRef.setInput('content', 'x');
    fixture.componentRef.setInput('collapsedDefault', false);
    fixture.detectChanges();

    const toggle = el.querySelector('[data-testid="thinking-toggle"]') as HTMLElement;
    const content = el.querySelector('[data-testid="thinking-content"]') as HTMLElement;
    const controls = toggle.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(content.id).toBe(controls);
  });

  it('omits aria-controls when collapsed (details closed)', () => {
    // aria-controls is nulled while collapsed.
    fixture.componentRef.setInput('content', 'x');
    fixture.componentRef.setInput('collapsedDefault', true);
    fixture.detectChanges();

    const toggle = el.querySelector('[data-testid="thinking-toggle"]') as HTMLElement;
    const details = el.querySelector('details') as HTMLDetailsElement;
    expect(toggle.getAttribute('aria-controls')).toBeNull();
    expect(details.open).toBe(false);
  });

  it('renders the toggle as a <summary> inside <details>', () => {
    fixture.componentRef.setInput('content', 'x');
    fixture.detectChanges();
    const toggle = el.querySelector('[data-testid="thinking-toggle"]') as HTMLElement;
    expect(toggle.tagName).toBe('SUMMARY');
    expect(toggle.parentElement?.tagName).toBe('DETAILS');
  });

  it('toggles the collapsed signal when the native <details> toggle event fires', () => {
    // jsdom does not fire toggle from a summary click; dispatched manually.
    fixture.componentRef.setInput('content', 'click activates');
    fixture.detectChanges();

    const before = component.collapsed();
    activateToggle();

    expect(component.collapsed()).toBe(!before);
  });
});
