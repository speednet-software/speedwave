import {
  Marked,
  Renderer,
  type MarkedExtension,
  type RendererExtensionFunction,
  type RendererThis,
  type Tokens,
} from 'marked';
import { markedHighlight } from 'marked-highlight';
import markedFootnote, { type FootnoteRef, type Footnotes } from 'marked-footnote';
import markedAlert from 'marked-alert';
import hljs from 'highlight.js/lib/common';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import { LruCache } from './lru-cache';

/** Minimal structural surface shared by the `marked` namespace and scoped `Marked` instances. */
interface SyncMarkdownParser {
  parse(src: string, options: { async: false }): string | Promise<string>;
}

const HIGHLIGHT_CACHE_SIZE = 64;
const MERMAID_SLOT_CLASS = 'mermaid-slot';
const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'];
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const plainRenderer = new Renderer();
const highlighted = new LruCache<string, string>(HIGHLIGHT_CACHE_SIZE);

hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('powershell', powershell);

export const chatMarkdown = createMarkdown();

export const pluginMarkdown = createMarkdown({ renderer: { link: renderNewTabLink } });

/**
 * Parses Markdown synchronously; throws if an async extension made `parse` return a Promise.
 * @param parser - The `marked` namespace or a scoped `Marked` instance.
 * @param src - Markdown source.
 */
export function parseMarkdownSync(parser: SyncMarkdownParser, src: string): string {
  const html = parser.parse(src, { async: false });
  if (typeof html !== 'string') {
    throw new Error('marked.parse returned a Promise; async option must remain false');
  }
  return html;
}

/**
 * Lists the diagram slots that `chatMarkdown` and `pluginMarkdown` leave in rendered HTML.
 * @param root - Element holding the rendered Markdown.
 * @returns Each slot whose code block holds a source, with that source.
 */
export function findMermaidSlots(root: ParentNode): { slot: Element; source: string }[] {
  return Array.from(root.querySelectorAll(`.${MERMAID_SLOT_CLASS}`)).flatMap((slot) => {
    const source = slot.querySelector('code')?.textContent?.replace(/\n$/, '');
    return source ? [{ slot, source }] : [];
  });
}

function createMarkdown(...extra: MarkedExtension[]): Marked {
  return new Marked(
    markedHighlight({ highlight: highlightCode }),
    plainFootnotes(),
    markedAlert({ variants: ALERT_TYPES.map((type) => ({ type, icon: '' })) }),
    { renderer: { checkbox: renderTaskCheckbox, code: renderMermaidSlot } },
    ...extra
  );
}

function highlightCode(code: string, lang: string): string {
  if (!lang || !hljs.getLanguage(lang)) return code;
  const key = `${lang}\u0000${code}`;
  const cached = highlighted.get(key);
  if (cached !== undefined) return cached;
  const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  highlighted.set(key, html);
  return html;
}

function plainFootnotes(): MarkedExtension {
  const footnotes = markedFootnote();
  return {
    ...footnotes,
    extensions: footnotes.extensions?.map((extension) => {
      if (!('renderer' in extension)) return extension;
      if (extension.name === 'footnoteRef') {
        return { ...extension, renderer: numberOnlyFootnoteRef(extension.renderer) };
      }
      if (extension.name === 'footnotes') return { ...extension, renderer: renderFootnoteList };
      return extension;
    }),
  };
}

function numberOnlyFootnoteRef(original: RendererExtensionFunction): RendererExtensionFunction {
  return function (this: RendererThis, token: Tokens.Generic) {
    original.call(this, token);
    return `<sup class="footnote-ref">${escapeHtml((token as FootnoteRef).id)}</sup>`;
  };
}

function renderFootnoteList(this: RendererThis, token: Tokens.Generic): string {
  const { items } = token as Footnotes;
  if (items.length === 0) return '';
  const entries = items.map((item) => `<li>${this.parser.parse(item.content)}</li>`).join('');
  return `<section class="footnotes"><ol>${entries}</ol></section>`;
}

function renderTaskCheckbox({ checked }: Tokens.Checkbox): string {
  return `<span class="task-checkbox" role="checkbox" aria-checked="${checked}" aria-disabled="true"></span> `;
}

function renderMermaidSlot(token: Tokens.Code): string | false {
  if (!isClosedMermaidFence(token)) return false;
  return `<div class="${MERMAID_SLOT_CLASS}">${plainRenderer.code(token)}</div>`;
}

function isClosedMermaidFence({ lang, raw, codeBlockStyle }: Tokens.Code): boolean {
  if (codeBlockStyle === 'indented') return false;
  if ((lang ?? '').match(/^\S*/)?.[0].toLowerCase() !== 'mermaid') return false;
  const lines = raw.replace(/\n+$/, '').split('\n');
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0])?.[1];
  if (!opening || lines.length < 2) return false;
  const closing = new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*$`);
  return closing.test(lines[lines.length - 1]);
}

function renderNewTabLink({ href, title, text }: Tokens.Link): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}
