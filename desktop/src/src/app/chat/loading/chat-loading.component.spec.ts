import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatLoadingComponent } from './chat-loading.component';

describe('ChatLoadingComponent', () => {
  let component: ChatLoadingComponent;
  let fixture: ComponentFixture<ChatLoadingComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatLoadingComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatLoadingComponent);
    component = fixture.componentInstance;
  });

  it('renders the default label when no input is provided', () => {
    fixture.detectChanges();

    const label = fixture.nativeElement.querySelector('[data-testid="chat-loading-label"]');
    expect(label?.textContent?.trim()).toBe('Loading conversation history...');
  });

  it('renders the custom label when supplied', () => {
    component.label = 'Fetching messages…';
    fixture.detectChanges();

    const label = fixture.nativeElement.querySelector('[data-testid="chat-loading-label"]');
    expect(label?.textContent?.trim()).toBe('Fetching messages…');
  });

  it('renders the spinner svg with the shared .spin animation class', () => {
    fixture.detectChanges();

    const spinner = fixture.nativeElement.querySelector(
      '[data-testid="chat-loading-spinner"]'
    ) as SVGElement | null;
    expect(spinner).not.toBeNull();
    expect(spinner?.classList.contains('spin')).toBe(true);
    expect(spinner?.tagName.toLowerCase()).toBe('svg');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
  });

  it('applies mono / ink-dim styling on the wrapper card', () => {
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('[data-testid="chat-loading"]') as HTMLElement;
    expect(card.className).toContain('mono');
    expect(card.className).toContain('text-ink-dim');
    expect(card.className).toContain('border-line');
  });

  it('applies role="status" and aria-live="polite" on the host', () => {
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('role')).toBe('status');
    expect(host.getAttribute('aria-live')).toBe('polite');
  });

  it('renders an empty-string label without throwing', () => {
    component.label = '';
    fixture.detectChanges();

    const label = fixture.nativeElement.querySelector('[data-testid="chat-loading-label"]');
    expect(label).not.toBeNull();
    expect(label?.textContent?.trim()).toBe('');
  });
});
