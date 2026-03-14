import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TextBlockComponent } from './text-block.component';

describe('TextBlockComponent', () => {
  let component: TextBlockComponent;
  let fixture: ComponentFixture<TextBlockComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TextBlockComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(TextBlockComponent);
    component = fixture.componentInstance;
  });

  it('renders markdown content as HTML', () => {
    component.content = '**bold text**';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const strong = el.querySelector('strong');
    expect(strong?.textContent).toBe('bold text');
  });

  it('renders code blocks', () => {
    component.content = '```\nconst x = 1;\n```';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const code = el.querySelector('code');
    expect(code?.textContent).toContain('const x = 1;');
  });

  it('renders plain text', () => {
    component.content = 'Hello world';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Hello world');
  });
});
