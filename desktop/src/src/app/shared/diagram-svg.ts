import DOMPurify, { type Config } from 'dompurify';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const DIAGRAM_PROFILE: Config & { RETURN_DOM_FRAGMENT: true } = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ['foreignobject'],
  ADD_ATTR: ['dominant-baseline'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  RETURN_DOM_FRAGMENT: true,
};

const purifier = DOMPurify(window);
purifier.addHook('uponSanitizeAttribute', (node, data) => {
  const isLink = data.attrName === 'href' || data.attrName === 'xlink:href';
  if (isLink && (node.localName === 'a' || !data.attrValue.startsWith('#'))) {
    data.keepAttr = false;
  }
  if (data.attrName === 'src' && !data.attrValue.startsWith('data:')) data.keepAttr = false;
});

/**
 * Sanitizes mermaid's SVG with Speedwave's diagram profile, on a DOMPurify instance of its own.
 * @param markup - SVG markup returned by `mermaid.render`.
 * @returns The sanitized root `<svg>`, or `null` unless the markup is exactly one SVG element.
 */
export function sanitizeDiagramSvg(markup: string): SVGSVGElement | null {
  const fragment = purifier.sanitize(markup, DIAGRAM_PROFILE);
  const root = fragment.firstElementChild;
  if (fragment.childElementCount !== 1 || root?.namespaceURI !== SVG_NAMESPACE) return null;
  return root.localName === 'svg' ? (root as SVGSVGElement) : null;
}
