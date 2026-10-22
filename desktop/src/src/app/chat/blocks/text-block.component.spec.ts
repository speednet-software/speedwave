import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { chatMarkdown } from '../../shared/markdown';
import { MERMAID_LOADER, MermaidRendererService } from '../../shared/mermaid-renderer.service';
import { createFakeMermaid, fakeMermaidLoader, type FakeMermaid } from '../../testing/fake-mermaid';
import { TextBlockComponent } from './text-block.component';

describe('TextBlockComponent', () => {
  let component: TextBlockComponent;
  let fixture: ComponentFixture<TextBlockComponent>;
  let el: HTMLElement;
  let mermaid: FakeMermaid;

  beforeEach(async () => {
    mermaid = createFakeMermaid();
    await TestBed.configureTestingModule({
      imports: [TextBlockComponent],
      providers: [{ provide: MERMAID_LOADER, useValue: fakeMermaidLoader(mermaid) }],
    }).compileComponents();

    fixture = TestBed.createComponent(TextBlockComponent);
    component = fixture.componentInstance;
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => vi.restoreAllMocks());

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
    expect(href).toBe('unsafe:javascript:alert(1)');
  });

  it('does NOT rewrite data: or vbscript: URLs — only javascript: is prefixed with unsafe:', () => {
    fixture.componentRef.setInput('content', '[d](data:text/html,x) [v](vbscript:MsgBox(1))');
    fixture.detectChanges();

    const anchors = fixture.nativeElement.querySelectorAll('a');
    expect(anchors[0]?.getAttribute('href')).toMatch(/^data:/);
    expect(anchors[1]?.getAttribute('href')).toMatch(/^vbscript:/);
  });

  it('rendered() returns unsanitized HTML containing script tags', () => {
    fixture.componentRef.setInput('content', '<script>alert(1)</script>');
    expect(component.rendered()).toContain('<script>');
  });

  it('rendered() throws if marked.parse returns a Promise', () => {
    vi.spyOn(chatMarkdown, 'parse').mockReturnValueOnce(Promise.resolve('<p>hi</p>') as never);
    fixture.componentRef.setInput('content', 'irrelevant');
    expect(() => component.rendered()).toThrow(
      'marked.parse returned a Promise; async option must remain false'
    );
  });

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

  it('renders malformed markdown without throwing', () => {
    fixture.componentRef.setInput('content', '```unbalanced\nno closing fence');
    expect(() => fixture.detectChanges()).not.toThrow();
    expect(el.querySelector('.prose-sw')).not.toBeNull();
  });

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

  describe('rich Markdown (SPEED-759)', () => {
    const closed = '```mermaid\ngraph TD\n  A --> B\n```';

    function slot(): HTMLElement | null {
      return el.querySelector('.mermaid-slot');
    }

    async function diagramDrawn(): Promise<SVGSVGElement> {
      let svg: SVGSVGElement | null = null;
      await vi.waitFor(async () => {
        await fixture.whenStable();
        svg = slot()?.shadowRoot?.querySelector('svg') ?? null;
        expect(svg).not.toBeNull();
      });
      return svg as unknown as SVGSVGElement;
    }

    it('draws a closed mermaid fence as a diagram', async () => {
      fixture.componentRef.setInput('content', `Flow:\n\n${closed}`);
      fixture.detectChanges();
      const svg = await diagramDrawn();
      expect(svg.querySelector('text')?.textContent).toContain('A --> B');
      expect(el.querySelector('p')?.textContent).toBe('Flow:');
    });

    it('keeps an invalid diagram as its code block in an intact message and logs no error', async () => {
      const error = vi.spyOn(console, 'error');
      const source = 'graph invalid';
      fixture.componentRef.setInput(
        'content',
        `Before\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nAfter`
      );
      fixture.detectChanges();
      const renderer = TestBed.inject(MermaidRendererService);
      await vi.waitFor(() => expect(renderer.lookup(source)).toEqual({ kind: 'failed' }));
      await fixture.whenStable();
      expect(slot()?.shadowRoot ?? null).toBeNull();
      expect(slot()?.querySelector('code')?.textContent).toContain(source);
      expect(Array.from(el.querySelectorAll('p'), (p) => p.textContent)).toEqual([
        'Before',
        'After',
      ]);
      expect(error).not.toHaveBeenCalled();
    });

    it('shows a streaming fence as code and draws it once the fence closes', async () => {
      const open = '```mermaid\ngraph TD\n  A --> B';
      fixture.componentRef.setInput('streaming', true);
      fixture.componentRef.setInput('content', open);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(slot()).toBeNull();
      expect(el.querySelector('pre code.language-mermaid')?.textContent).toContain('A --> B');
      expect(mermaid.parse).not.toHaveBeenCalled();

      fixture.componentRef.setInput('content', `${open}\n\`\`\``);
      fixture.detectChanges();
      expect(slot()?.shadowRoot ?? null).toBeNull();
      expect(slot()?.querySelector('pre code')?.textContent).toContain('A --> B');
      await diagramDrawn();
      expect(mermaid.render).toHaveBeenCalledTimes(1);
    });

    it('keeps the drawn diagram through further streamed deltas without rendering it again', async () => {
      fixture.componentRef.setInput('streaming', true);
      fixture.componentRef.setInput('content', closed);
      fixture.detectChanges();
      await diagramDrawn();
      fixture.componentRef.setInput('content', `${closed}\n\nMore text`);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(slot()?.shadowRoot?.querySelector('svg') ?? null).not.toBeNull();
      expect(mermaid.render).toHaveBeenCalledTimes(1);
    });

    it('keeps highlighting, footnotes, alerts and task lists through the sanitizer', () => {
      fixture.componentRef.setInput(
        'content',
        [
          '```ts\nconst x = 1;\n```',
          'See[^1].',
          '> [!TIP]\n> Try it.',
          '- [ ] todo',
          '[^1]: The note.',
        ].join('\n\n')
      );
      fixture.detectChanges();
      expect(el.querySelector('pre code span.hljs-keyword')?.textContent).toBe('const');
      expect(el.querySelector('sup.footnote-ref')?.textContent).toBe('1');
      expect(el.querySelector('section.footnotes li')?.textContent).toContain('The note.');
      expect(el.querySelector('.markdown-alert-tip .markdown-alert-title')?.textContent).toBe(
        'Tip'
      );
      expect(el.querySelector('span.task-checkbox')?.getAttribute('aria-checked')).toBe('false');
      expect(el.querySelector('input')).toBeNull();
    });
  });
});
