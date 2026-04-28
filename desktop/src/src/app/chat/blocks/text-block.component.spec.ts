import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { marked } from 'marked';
import { TextBlockComponent } from './text-block.component';

describe('TextBlockComponent', () => {
  let component: TextBlockComponent;
  let fixture: ComponentFixture<TextBlockComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TextBlockComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(TextBlockComponent);
    component = fixture.componentInstance;
    el = fixture.nativeElement as HTMLElement;
  });

  // happy
  it('renders markdown content as HTML', () => {
    fixture.componentRef.setInput('content', '**bold text**');
    fixture.detectChanges();

    const strong = el.querySelector('strong');
    expect(strong?.textContent).toBe('bold text');
  });

  it('renders code blocks', () => {
    fixture.componentRef.setInput('content', '```\nconst x = 1;\n```');
    fixture.detectChanges();

    const code = el.querySelector('code');
    expect(code?.textContent).toContain('const x = 1;');
  });

  it('renders plain text paragraphs', () => {
    fixture.componentRef.setInput('content', 'Hello world');
    fixture.detectChanges();

    expect(el.textContent).toContain('Hello world');
  });

  // ── security (DomSanitizer behavior locked in from dev) ──────────────────
  it('strips script tags via Angular DomSanitizer', () => {
    fixture.componentRef.setInput(
      'content',
      "Safe **bold** text <script>alert('xss')</script> tail"
    );
    fixture.detectChanges();

    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.textContent).toContain('tail');
  });

  it('strips event-handler attributes via Angular DomSanitizer', () => {
    fixture.componentRef.setInput('content', '<img src=x onerror="alert(1)">');
    fixture.detectChanges();

    expect(el.innerHTML).not.toContain('onerror');
    const img = el.querySelector('img');
    expect(img?.hasAttribute('onerror') ?? false).toBe(false);
  });

  it('rewrites javascript: URLs to unsafe:javascript: via Angular DomSanitizer', () => {
    fixture.componentRef.setInput('content', '[click](javascript:alert(1))');
    fixture.detectChanges();

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
    fixture.componentRef.setInput('content', '[d](data:text/html,x) [v](vbscript:MsgBox(1))');
    fixture.detectChanges();

    const anchors = fixture.nativeElement.querySelectorAll('a');
    expect(anchors[0]?.getAttribute('href')).toMatch(/^data:/);
    expect(anchors[1]?.getAttribute('href')).toMatch(/^vbscript:/);
  });

  it('rendered() returns unsanitized HTML containing script tags', () => {
    fixture.componentRef.setInput('content', '<script>alert(1)</script>');
    // The computed itself does not sanitize — sanitization happens at [innerHTML] binding time.
    expect(component.rendered()).toContain('<script>');
  });

  it('rendered() throws if marked.parse returns a Promise', () => {
    vi.spyOn(marked, 'parse').mockReturnValueOnce(Promise.resolve('<p>hi</p>') as never);
    fixture.componentRef.setInput('content', 'irrelevant');
    expect(() => component.rendered()).toThrow(
      'marked.parse returned a Promise; async option must remain false'
    );
  });

  // ── edge ──────────────────────────────────────────────────────────────────
  it('renders empty content without error', () => {
    fixture.componentRef.setInput('content', '');
    fixture.detectChanges();

    expect(el.querySelector('.prose-sw')).not.toBeNull();
    expect(el.querySelector('[data-testid="streaming-caret"]')).toBeNull();
  });

  it('renders very long content without crashing', () => {
    const long = 'paragraph '.repeat(2000);
    fixture.componentRef.setInput('content', long);
    fixture.detectChanges();

    expect((el.textContent ?? '').length).toBeGreaterThan(1000);
  });

  it('renders unicode/special characters correctly', () => {
    fixture.componentRef.setInput('content', 'mañana — Ω 🚀 — **ok**');
    fixture.detectChanges();

    expect(el.textContent).toContain('mañana');
    expect(el.textContent).toContain('🚀');
    expect(el.querySelector('strong')?.textContent).toBe('ok');
  });

  // ── error — malformed markdown should not throw ──────────────────────────
  it('renders malformed markdown without throwing', () => {
    fixture.componentRef.setInput('content', '```unbalanced\nno closing fence');
    expect(() => fixture.detectChanges()).not.toThrow();
    expect(el.querySelector('.prose-sw')).not.toBeNull();
  });

  // ── state transitions — streaming caret on/off ───────────────────────────
  it('shows the streaming caret when streaming is true', () => {
    fixture.componentRef.setInput('content', 'partial');
    fixture.componentRef.setInput('streaming', true);
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="streaming-caret"]')).not.toBeNull();
  });

  it('hides the streaming caret when streaming is false', () => {
    fixture.componentRef.setInput('content', 'done');
    fixture.componentRef.setInput('streaming', false);
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="streaming-caret"]')).toBeNull();
  });

  it('toggles the caret reactively when streaming changes', () => {
    fixture.componentRef.setInput('content', 'text');
    fixture.componentRef.setInput('streaming', true);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="streaming-caret"]')).not.toBeNull();

    fixture.componentRef.setInput('streaming', false);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="streaming-caret"]')).toBeNull();
  });

  // ── ARIA ─────────────────────────────────────────────────────────────────
  it('sets role="status" and aria-live="polite" on the host while streaming', () => {
    fixture.componentRef.setInput('content', 'streaming...');
    fixture.componentRef.setInput('streaming', true);
    fixture.detectChanges();

    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
  });

  it('does not set role/aria-live when not streaming', () => {
    fixture.componentRef.setInput('content', 'static');
    fixture.detectChanges();

    expect(el.getAttribute('role')).toBeNull();
    expect(el.getAttribute('aria-live')).toBeNull();
  });
});
