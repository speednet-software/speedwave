import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { marked } from 'marked';
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

  it('strips script tags via Angular DomSanitizer', () => {
    component.content = "Safe **bold** text <script>alert('xss')</script> tail";
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.textContent).toContain('tail');
  });

  it('strips event-handler attributes via Angular DomSanitizer', () => {
    component.content = '<img src=x onerror="alert(1)">';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.innerHTML).not.toContain('onerror');
    const img = el.querySelector('img');
    expect(img?.hasAttribute('onerror') ?? false).toBe(false);
  });

  it('rewrites javascript: URLs to unsafe:javascript: via Angular DomSanitizer', () => {
    component.content = '[click](javascript:alert(1))';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const href = el.querySelector('a')?.getAttribute('href') ?? '';
    // Angular's HTML sanitizer rewrites javascript: to unsafe:javascript:, making it inert.
    expect(href).toBe('unsafe:javascript:alert(1)');
  });

  it('does NOT rewrite data: or vbscript: URLs — only javascript: is prefixed with unsafe:', () => {
    // Angular's URL sanitizer for [innerHTML] anchors only rewrites the
    // javascript: scheme (SRC_URL_SANITIZATION_REGEX = /^(?!javascript:)/i).
    // data: and vbscript: pass through unchanged. Any future user-facing
    // render path that can receive attacker-controlled URLs must rely on
    // CSP (img-src/frame-src restrictions) or its own pre-sanitization —
    // it cannot assume Angular's HTML sanitizer will block these schemes.
    // This test locks that contract in so a future refactor can't silently
    // widen the trust boundary.
    component.content = '[d](data:text/html,x) [v](vbscript:MsgBox(1))';
    fixture.detectChanges();

    const anchors = fixture.nativeElement.querySelectorAll('a');
    expect(anchors[0]?.getAttribute('href')).toMatch(/^data:/);
    expect(anchors[1]?.getAttribute('href')).toMatch(/^vbscript:/);
  });

  it('rendered getter returns unsanitized HTML containing script tags', () => {
    component.content = '<script>alert(1)</script>';
    // The getter itself does not sanitize — sanitization happens at [innerHTML] binding time.
    expect(component.rendered).toContain('<script>');
  });

  it('rendered getter throws if marked.parse returns a Promise', () => {
    vi.spyOn(marked, 'parse').mockReturnValueOnce(Promise.resolve('<p>hi</p>') as never);
    component.content = 'irrelevant';
    expect(() => component.rendered).toThrow(
      'marked.parse returned a Promise; async option must remain false'
    );
  });

  it('renders empty content without error', () => {
    component.content = '';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const prose = el.querySelector('.prose-sw');
    expect(prose).not.toBeNull();
    expect(prose?.textContent?.trim()).toBe('');
  });
});
