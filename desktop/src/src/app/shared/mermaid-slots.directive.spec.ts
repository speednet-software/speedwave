import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MermaidSlotsDirective } from './mermaid-slots.directive';
import { MermaidRendererService, type DiagramEntry } from './mermaid-renderer.service';

@Component({
  imports: [MermaidSlotsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="prose-sw" [innerHTML]="html()" [appMermaidSlots]="html()"></div>`,
})
class HostComponent {
  readonly html = signal('');
}

const slot = (source: string): string =>
  `<div class="mermaid-slot"><pre><code class="language-mermaid">${source}\n</code></pre></div>`;

function ready(label: string): DiagramEntry {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('data-label', label);
  return { kind: 'ready', svg };
}

describe('MermaidSlotsDirective', () => {
  let fixture: ComponentFixture<HostComponent>;
  let entries: Map<string, DiagramEntry>;
  let version: ReturnType<typeof signal<number>>;
  let lookup: ReturnType<typeof vi.fn>;

  function slots(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.mermaid-slot'));
  }

  function drawn(element: HTMLElement): SVGSVGElement | null {
    return element.shadowRoot?.querySelector('svg') ?? null;
  }

  async function show(html: string): Promise<void> {
    fixture.componentInstance.html.set(html);
    await fixture.whenStable();
  }

  async function settle(source: string, entry: DiagramEntry): Promise<void> {
    entries.set(source, entry);
    version.update((n) => n + 1);
    await fixture.whenStable();
  }

  beforeEach(() => {
    entries = new Map();
    version = signal(0);
    lookup = vi.fn((source: string) => entries.get(source) ?? null);
    TestBed.configureTestingModule({
      providers: [{ provide: MermaidRendererService, useValue: { version, lookup } }],
    });
    fixture = TestBed.createComponent(HostComponent);
  });

  it('draws a ready diagram in the slot shadow root and keeps the code block beneath', async () => {
    entries.set('graph TD', ready('a'));
    await show(slot('graph TD'));
    const [element] = slots();
    expect(drawn(element)?.getAttribute('data-label')).toBe('a');
    expect(element.shadowRoot?.querySelector('style')?.textContent).toContain('svg{');
    expect(element.querySelector('code')?.textContent).toBe('graph TD\n');
  });

  it('draws a copy, never the cached element itself', async () => {
    const entry = ready('a');
    entries.set('graph TD', entry);
    await show(slot('graph TD'));
    expect(drawn(slots()[0])).not.toBe(entry.kind === 'ready' ? entry.svg : null);
  });

  it('keeps the code block while the diagram renders and draws it once settled', async () => {
    await show(slot('graph TD'));
    expect(slots()[0].shadowRoot).toBeNull();
    await settle('graph TD', ready('a'));
    expect(drawn(slots()[0])?.getAttribute('data-label')).toBe('a');
  });

  it('keeps the code block for a diagram that failed', async () => {
    entries.set('graph TD', { kind: 'failed' });
    await show(slot('graph TD'));
    expect(slots()[0].shadowRoot).toBeNull();
    expect(slots()[0].querySelector('code')).not.toBeNull();
  });

  it('looks up the decoded source without the trailing newline', async () => {
    await show(slot('A --&gt; B[&quot;x&quot;]'));
    expect(lookup).toHaveBeenCalledWith('A --> B["x"]');
  });

  it('draws every slot with its own diagram', async () => {
    entries.set('graph A', ready('a'));
    entries.set('graph B', ready('b'));
    await show(`<p>x</p>${slot('graph A')}<ul><li>${slot('graph B')}</li></ul>`);
    expect(slots().map((element) => drawn(element)?.getAttribute('data-label'))).toEqual([
      'a',
      'b',
    ]);
  });

  it('draws the new slots after the HTML changes, as each streamed delta does', async () => {
    entries.set('graph TD', ready('a'));
    await show(slot('graph TD'));
    await show(`${slot('graph TD')}<p>more</p>`);
    expect(drawn(slots()[0])?.getAttribute('data-label')).toBe('a');
  });

  it('leaves a slot alone while it already shows the current entry', async () => {
    entries.set('graph TD', ready('a'));
    await show(slot('graph TD'));
    const first = drawn(slots()[0]);
    await settle('graph other', ready('b'));
    expect(drawn(slots()[0])).toBe(first);
  });

  it('keeps the old diagram until the entry for a new mode is ready, then swaps it', async () => {
    entries.set('graph TD', ready('dark'));
    await show(slot('graph TD'));
    entries.delete('graph TD');
    version.update((n) => n + 1);
    await fixture.whenStable();
    expect(drawn(slots()[0])?.getAttribute('data-label')).toBe('dark');
    await settle('graph TD', ready('light'));
    expect(drawn(slots()[0])?.getAttribute('data-label')).toBe('light');
    expect(slots()[0].shadowRoot?.querySelectorAll('svg').length).toBe(1);
  });

  it('skips a slot without source', async () => {
    await show(
      '<div class="mermaid-slot"><pre><code class="language-mermaid">\n</code></pre></div>'
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(slots()[0].shadowRoot).toBeNull();
  });

  it('touches nothing in HTML without slots', async () => {
    await show('<pre><code class="language-ts">const a = 1;\n</code></pre>');
    expect(lookup).not.toHaveBeenCalled();
  });
});
