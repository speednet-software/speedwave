import { describe, it, expect } from 'vitest';
import DOMPurify from 'dompurify';
import { sanitizeDiagramSvg } from './diagram-svg';

const SVG = 'xmlns="http://www.w3.org/2000/svg"';

describe('sanitizeDiagramSvg', () => {
  it('keeps the parts mermaid draws with: style, ids, markers, classes and baselines', () => {
    const svg = sanitizeDiagramSvg(
      `<svg id="m1" ${SVG} viewBox="0 0 10 10" style="max-width: 120px;"><style>#m1 .node rect{fill:red}</style>` +
        '<defs><marker id="arrow"><path d="M0 0 L10 5"/></marker></defs>' +
        '<g class="node"><rect width="5" height="5"/><path marker-end="url(#arrow)" d="M0 0"/></g>' +
        '<text dominant-baseline="middle">A</text></svg>'
    );
    expect(svg?.localName).toBe('svg');
    expect(svg?.getAttribute('id')).toBe('m1');
    expect(svg?.getAttribute('style')).toBe('max-width: 120px;');
    expect(svg?.querySelector('style')?.textContent).toBe('#m1 .node rect{fill:red}');
    expect(svg?.querySelector('marker#arrow')).not.toBeNull();
    expect(svg?.querySelector('path[marker-end]')?.getAttribute('marker-end')).toBe('url(#arrow)');
    expect(svg?.querySelector('g.node rect')).not.toBeNull();
    expect(svg?.querySelector('text')?.getAttribute('dominant-baseline')).toBe('middle');
  });

  it('strips scripts and event handlers', () => {
    const svg = sanitizeDiagramSvg(
      `<svg ${SVG} onload="alert(1)"><script>alert(2)</script><rect onclick="alert(3)"/></svg>`
    );
    expect(svg?.outerHTML).toBe(`<svg ${SVG}><rect></rect></svg>`);
  });

  it('keeps a link wrapper as a plain group, so the node mermaid placed through it stays put', () => {
    const svg = sanitizeDiagramSvg(
      `<svg ${SVG} xmlns:xlink="http://www.w3.org/1999/xlink">` +
        '<a href="https://evil.example" xlink:href="https://evil.example" transform="translate(65, 103)">' +
        '<g class="node clickable"><text>keep me</text></g></a>' +
        '<a href="#frag" xlink:href="#frag"><text>local</text></a></svg>'
    );
    const [external, local] = Array.from(svg?.querySelectorAll('a') ?? []);
    expect(external?.getAttribute('transform')).toBe('translate(65, 103)');
    expect(external?.querySelector('g.node text')?.textContent).toBe('keep me');
    expect(local?.textContent).toBe('local');
    for (const link of [external, local]) {
      expect(link?.hasAttribute('href')).toBe(false);
      expect(link?.hasAttribute('xlink:href')).toBe(false);
    }
  });

  it('keeps only same-document references in href and xlink:href', () => {
    const svg = sanitizeDiagramSvg(
      `<svg ${SVG} xmlns:xlink="http://www.w3.org/1999/xlink">` +
        '<image href="https://evil.example/x.png"/><image xlink:href="data:image/png;base64,AAAA"/>' +
        '<rect fill="url(#grad)"/><textPath href="#curve">t</textPath></svg>'
    );
    const images = Array.from(svg?.querySelectorAll('image') ?? []);
    expect(images.map((image) => image.attributes.length)).toEqual([0, 0]);
    expect(svg?.querySelector('rect')?.getAttribute('fill')).toBe('url(#grad)');
    expect(svg?.querySelector('textPath')?.getAttribute('href')).toBe('#curve');
  });

  it('keeps HTML labels in foreignObject but strips their scripts, handlers and remote sources', () => {
    const svg = sanitizeDiagramSvg(
      `<svg ${SVG}><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">` +
        '<span>label</span><img src="https://evil.example/p.png" onerror="alert(1)">' +
        '<img src="data:image/png;base64,AAAA"><script>alert(2)</script></div></foreignObject></svg>'
    );
    expect(svg?.querySelector('foreignObject span')?.textContent).toBe('label');
    const images = Array.from(svg?.querySelectorAll('img') ?? []);
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      null,
      'data:image/png;base64,AAAA',
    ]);
    expect(images[0]?.hasAttribute('onerror')).toBe(false);
    expect(svg?.querySelector('script')).toBeNull();
  });

  it.each([
    ['an HTML root', '<div>not svg</div>'],
    ['two roots', `<svg ${SVG}></svg><svg ${SVG}></svg>`],
    ['text only', 'graph TD'],
    ['an empty string', ''],
  ])('returns null for %s', (_label, markup) => {
    expect(sanitizeDiagramSvg(markup)).toBeNull();
  });

  it('leaves the shared DOMPurify instance without its hook', () => {
    sanitizeDiagramSvg(`<svg ${SVG}></svg>`);
    expect(DOMPurify.sanitize('<a href="https://example.com">y</a>')).toBe(
      '<a href="https://example.com">y</a>'
    );
  });
});
