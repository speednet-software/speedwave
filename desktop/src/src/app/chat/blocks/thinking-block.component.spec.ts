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

  // happy — collapsed by default
  it('is collapsed by default (hides content, shows ▶)', () => {
    component.content = 'thinking...';
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="thinking-content"]')).toBeNull();
    const toggle = el.querySelector('[data-testid="thinking-toggle"]');
    expect(toggle?.textContent).toContain('▶');
    expect(toggle?.textContent).toContain('Thinking');
  });

  // state — clicking toggle expands
  it('expands when the toggle is clicked (▶ → ▼)', () => {
    component.content = 'I should check the file';
    fixture.detectChanges();

    const toggle = el.querySelector('[data-testid="thinking-toggle"]') as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();

    const content = el.querySelector('[data-testid="thinking-content"]');
    expect(content?.textContent?.trim()).toBe('I should check the file');
    expect(toggle.textContent).toContain('▼');
  });

  it('collapses again on a second click', () => {
    component.content = 'loop';
    fixture.detectChanges();

    const toggle = el.querySelector('[data-testid="thinking-toggle"]') as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();
    toggle.click();
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="thinking-content"]')).toBeNull();
    expect(toggle.textContent).toContain('▶');
  });

  it('respects collapsedDefault=false input — starts expanded', () => {
    component.content = 'visible up front';
    component.collapsedDefault = false;
    fixture.detectChanges();

    const content = el.querySelector('[data-testid="thinking-content"]');
    expect(content?.textContent?.trim()).toBe('visible up front');
  });

  // edge — empty / long content
  it('renders empty content without error', () => {
    component.content = '';
    component.collapsedDefault = false;
    fixture.detectChanges();

    const content = el.querySelector('[data-testid="thinking-content"]');
    expect(content).not.toBeNull();
    expect(content?.textContent?.trim()).toBe('');
  });

  it('renders multi-paragraph long content preserving newlines (whitespace-pre-wrap)', () => {
    const long = 'paragraph one\n\nparagraph two\n\n' + 'line '.repeat(500);
    component.content = long;
    component.collapsedDefault = false;
    fixture.detectChanges();

    const content = el.querySelector('[data-testid="thinking-content"]');
    expect(content?.textContent).toContain('paragraph one');
    expect(content?.textContent).toContain('paragraph two');
  });

  it('renders content as plain text (markdown is NOT interpreted)', () => {
    component.content = '**not bold** and `not code`';
    component.collapsedDefault = false;
    fixture.detectChanges();

    const content = el.querySelector('[data-testid="thinking-content"]');
    expect(content?.querySelector('strong')).toBeNull();
    expect(content?.querySelector('code')).toBeNull();
    expect(content?.textContent).toContain('**not bold**');
  });

  // ARIA — aria-expanded reflects state, aria-controls pairs correctly
  it('wires aria-expanded to reflect collapsed state', () => {
    component.content = 'x';
    fixture.detectChanges();
    const toggle = el.querySelector('[data-testid="thinking-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('wires aria-controls on the toggle to the id of the expanded content region', () => {
    component.content = 'x';
    component.collapsedDefault = false;
    fixture.detectChanges();

    const toggle = el.querySelector('[data-testid="thinking-toggle"]') as HTMLButtonElement;
    const content = el.querySelector('[data-testid="thinking-content"]') as HTMLElement;
    const controls = toggle.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(content.id).toBe(controls);
  });

  it('omits aria-controls when collapsed (target element absent from DOM)', () => {
    // ARIA forbids aria-controls referencing a non-existent element.
    component.content = 'x';
    component.collapsedDefault = true;
    fixture.detectChanges();

    const toggle = el.querySelector('[data-testid="thinking-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-controls')).toBeNull();
    expect(el.querySelector('[data-testid="thinking-content"]')).toBeNull();
  });

  it('renders the toggle as a <button type="button">', () => {
    component.content = 'x';
    fixture.detectChanges();
    const toggle = el.querySelector('[data-testid="thinking-toggle"]') as HTMLButtonElement;
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('type')).toBe('button');
  });
});
