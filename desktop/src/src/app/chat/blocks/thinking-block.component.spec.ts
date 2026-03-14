import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ThinkingBlockComponent } from './thinking-block.component';

describe('ThinkingBlockComponent', () => {
  let component: ThinkingBlockComponent;
  let fixture: ComponentFixture<ThinkingBlockComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ThinkingBlockComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ThinkingBlockComponent);
    component = fixture.componentInstance;
  });

  it('is collapsed by default', () => {
    component.content = 'thinking...';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const thinkingContent = el.querySelector('.thinking-content');
    expect(thinkingContent).toBeNull();
    expect(el.textContent).toContain('Thinking...');
  });

  it('shows content when expanded', () => {
    component.content = 'I should check the file';
    component.collapsed = false;
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const thinkingContent = el.querySelector('.thinking-content');
    expect(thinkingContent?.textContent).toBe('I should check the file');
  });

  it('toggles collapsed state on click', () => {
    component.content = 'thinking content';
    component.collapsed = true;
    fixture.detectChanges();

    const toggle = fixture.nativeElement.querySelector('.thinking-toggle') as HTMLElement;
    toggle.click();
    fixture.detectChanges();

    expect(component.collapsed).toBe(false);
    const thinkingContent = fixture.nativeElement.querySelector('.thinking-content');
    expect(thinkingContent?.textContent).toBe('thinking content');
  });
});
