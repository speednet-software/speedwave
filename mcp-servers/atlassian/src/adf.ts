/**
 * Atlassian Document Format (Jira v3) and Confluence storage-representation body helpers; scope enforcement lives in `./scope.ts`.
 * @module mcp-atlassian/adf
 */

import type { AdfDoc, AdfNode } from './types.js';

type AdfMarked = { type: string; attrs?: Record<string, unknown> };

const MARKDOWN_MARKS: ReadonlySet<string> = new Set(['code', 'em', 'strong', 'strike', 'link']);

/**
 * Narrow check: is `value` already a `{ version: 1, type: 'doc', ... }` ADF object?
 * @param value - The value to test.
 * @returns `true` if `value` looks like an ADF document.
 */
export function isAdfDoc(value: unknown): value is AdfDoc {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'doc' &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/**
 * Wrap a value as a Confluence "storage representation" body object. Caller must ensure it is
 * already valid storage XHTML (escape via {@link textToStorage} or use {@link resolveBodyPayload}).
 * @param value - Storage-format body string.
 * @returns Confluence body value object.
 */
export function storageBody(value: string): { representation: 'storage'; value: string } {
  return { representation: 'storage', value: String(value ?? '') };
}

/**
 * Minimal HTML escaping for plain text into a safe Confluence storage body (single `<p>` wrap).
 * Not a sanitizer — only for text the worker itself produces from tool input.
 * @param text - Plain text.
 * @returns A `<p>`-wrapped, HTML-escaped paragraph.
 */
export function textToStorage(text: string): string {
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<p>${escaped}</p>`;
}

/** A Confluence page/comment body supplied to create/update: raw storage XHTML, or plain text. */
export type StorageBodyInput = { storage?: string; text?: string };

/**
 * Resolve a {@link StorageBodyInput}: `storage` (raw XHTML) wins, else `text` is HTML-escaped and
 * wrapped in `<p>`. SSOT for body resolution shared by the Confluence page and content domains.
 * @param body - The body input (`storage` and/or `text`).
 * @returns The Confluence body value object.
 */
export function resolveBodyPayload(body: StorageBodyInput): {
  representation: 'storage';
  value: string;
} {
  if (body.storage !== undefined) return storageBody(body.storage);
  return storageBody(textToStorage(body.text ?? ''));
}

/**
 * Visible stand-in written by {@link adfToMarkdown} for ADF nodes with no Markdown equivalent.
 * Leaf nodes give `[adf:<type> <detail>]`; nodes with content wrap it in `[adf:<type> <detail>]`
 * and `[/adf:<type>]`. `<detail>` is the first of panelType, title, text, id, url, shortName, or
 * the date for `date` nodes, and is omitted when none exists.
 */
export type UnsupportedAdfMarker = `[adf:${string}]` | `[/adf:${string}]`;

type AdfMark = NonNullable<AdfNode['marks']>[number];

/**
 * Convert Markdown (CommonMark subset plus GFM pipe tables) to an ADF document.
 * Mentions are written `[@Name](mention:<accountId>)`, emoji `:shortname:`, inline cards `<https://...>`.
 * @param markdown - Markdown source.
 * @returns ADF document; empty input gives one empty paragraph.
 */
export function markdownToAdf(markdown: string): AdfDoc {
  const content = parseBlocks(
    String(markdown ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
  );
  return {
    version: 1,
    type: 'doc',
    content: content.length > 0 ? content : [{ type: 'paragraph', content: [] }],
  };
}

/**
 * Convert an ADF document to Markdown. Nodes without a Markdown equivalent are written as an
 * {@link UnsupportedAdfMarker} so no content disappears silently.
 * @param doc - ADF document (or nullish).
 * @returns Markdown text; empty string for a missing or empty document.
 */
export function adfToMarkdown(doc: AdfDoc | null | undefined): string {
  return blocksToMarkdown(doc?.content ?? []);
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING_LINE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE_LINE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_LINE = /^ {0,3}> ?/;
const ITEM_LINE = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function parseBlocks(lines: string[]): AdfNode[] {
  const blocks: AdfNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const parsed =
      parseFence(lines, i) ??
      parseHeading(line, i) ??
      parseRule(line, i) ??
      parseQuote(lines, i) ??
      parseList(lines, i) ??
      parseTable(lines, i) ??
      parseParagraph(lines, i);
    blocks.push(parsed.node);
    i = parsed.next;
  }
  return blocks;
}

type Parsed = { node: AdfNode; next: number };

function parseFence(lines: string[], start: number): Parsed | null {
  const open = FENCE_LINE.exec(lines[start]);
  if (!open) return null;
  const marker = open[1];
  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length && !isClosingFence(lines[i], marker)) body.push(lines[i++]);
  const node: AdfNode = { type: 'codeBlock' };
  if (open[2]) node.attrs = { language: open[2] };
  if (body.length > 0) node.content = [{ type: 'text', text: body.join('\n') }];
  return { node, next: i + 1 };
}

function isClosingFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && trimmed === marker[0].repeat(trimmed.length);
}

function parseHeading(line: string, index: number): Parsed | null {
  const match = HEADING_LINE.exec(line);
  if (!match) return null;
  return {
    node: {
      type: 'heading',
      attrs: { level: match[1].length },
      content: parseInline(match[2], []),
    },
    next: index + 1,
  };
}

function parseRule(line: string, index: number): Parsed | null {
  return RULE_LINE.test(line) ? { node: { type: 'rule' }, next: index + 1 } : null;
}

function parseQuote(lines: string[], start: number): Parsed | null {
  if (!QUOTE_LINE.test(lines[start])) return null;
  const inner: string[] = [];
  let i = start;
  while (i < lines.length && QUOTE_LINE.test(lines[i]))
    inner.push(lines[i++].replace(QUOTE_LINE, ''));
  return { node: { type: 'blockquote', content: parseBlocks(inner) }, next: i };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function parseList(lines: string[], start: number): Parsed | null {
  const first = ITEM_LINE.exec(lines[start]);
  if (!first) return null;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2][0]);
  const items: AdfNode[] = [];
  let i = start;
  for (;;) {
    while (i < lines.length && lines[i].trim() === '') i++;
    const match = i < lines.length ? ITEM_LINE.exec(lines[i]) : null;
    if (!match || match[1].length !== baseIndent || /\d/.test(match[2][0]) !== ordered) break;
    const continuation: string[] = [];
    i++;
    while (i < lines.length) {
      if (lines[i].trim() === '') {
        const next = nextNonBlank(lines, i);
        if (next === -1 || indentOf(lines[next]) <= baseIndent) break;
      } else if (indentOf(lines[i]) <= baseIndent) break;
      continuation.push(lines[i++]);
    }
    items.push({
      type: 'listItem',
      content: parseBlocks([match[3], ...dedent(continuation)]),
    });
  }
  const node: AdfNode = { type: ordered ? 'orderedList' : 'bulletList', content: items };
  const startNumber = parseInt(first[2], 10);
  if (ordered && startNumber !== 1) node.attrs = { order: startNumber };
  return { node, next: i };
}

function nextNonBlank(lines: string[], from: number): number {
  return lines.findIndex((line, index) => index > from && line.trim() !== '');
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((line) => line.trim() !== '').map(indentOf);
  const strip = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(Math.min(strip, indentOf(line))));
}

function parseTable(lines: string[], start: number): Parsed | null {
  const separator = lines[start + 1];
  if (!lines[start].includes('|') || separator === undefined) return null;
  if (!separator.includes('|') || !TABLE_SEPARATOR.test(separator)) return null;
  const rows: AdfNode[] = [tableRow(lines[start], 'tableHeader')];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
    rows.push(tableRow(lines[i++], 'tableCell'));
  }
  return { node: { type: 'table', content: rows }, next: i };
}

function tableRow(line: string, cellType: string): AdfNode {
  const cells = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
  return {
    type: 'tableRow',
    content: cells.map((cell) => ({
      type: cellType,
      content: [{ type: 'paragraph', content: parseInline(cell, []) }],
    })),
  };
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  return (
    FENCE_LINE.test(line) ||
    HEADING_LINE.test(line) ||
    RULE_LINE.test(line) ||
    QUOTE_LINE.test(line) ||
    ITEM_LINE.test(line)
  );
}

function parseParagraph(lines: string[], start: number): Parsed {
  const collected = [lines[start]];
  let i = start + 1;
  while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines, i)) {
    collected.push(lines[i++]);
  }
  const text = collected
    .map((line) => line.trimStart())
    .join('\n')
    .trimEnd()
    .replace(/(?: {2,}|\\)\n/g, '<br>')
    .replace(/ *\n/g, ' ');
  return { node: { type: 'paragraph', content: parseInline(text, []) }, next: i };
}

const LINK_PATTERN =
  /^\[((?:\\.|[^\]\\])*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+"[^"]*")?\)/;
const AUTOLINK_PATTERN = /^<(https?:\/\/[^\s>]+)>/;
const BREAK_PATTERN = /^<br\s*\/?>/i;
const EMOJI_PATTERN = /^:([a-z0-9_+-]+):(?!\w)/i;
const ESCAPABLE = /[!-/:-@[-`{-~]/;

function parseInline(text: string, marks: AdfMark[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer === '') return;
    nodes.push(
      marks.length > 0 ? { type: 'text', text: buffer, marks } : { type: 'text', text: buffer }
    );
    buffer = '';
  };
  const emit = (...emitted: AdfNode[]): void => {
    flush();
    nodes.push(...emitted);
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const char = text[i];
    let match: RegExpExecArray | null;
    let span: { code: string; end: number } | null;
    if (char === '\\' && ESCAPABLE.test(text[i + 1] ?? '')) {
      buffer += text[i + 1];
      i += 2;
    } else if (char === '`' && (span = readCodeSpan(text, i))) {
      const linkMarks = marks.filter((mark) => mark.type === 'link');
      emit({ type: 'text', text: span.code, marks: [...linkMarks, { type: 'code' }] });
      i = span.end;
    } else if ((match = BREAK_PATTERN.exec(rest))) {
      emit({ type: 'hardBreak' });
      i += match[0].length;
    } else if ((match = AUTOLINK_PATTERN.exec(rest))) {
      emit({ type: 'inlineCard', attrs: { url: match[1] } });
      i += match[0].length;
    } else if (char === '[' && (match = LINK_PATTERN.exec(rest))) {
      emit(...linkNodes(match[1], match[2], marks));
      i += match[0].length;
    } else if (
      char === ':' &&
      (match = EMOJI_PATTERN.exec(rest)) &&
      !/\w/.test(text[i - 1] ?? '')
    ) {
      emit({ type: 'emoji', attrs: { shortName: match[0] } });
      i += match[0].length;
    } else {
      const emphasis = readEmphasis(text, i);
      if (emphasis) {
        emit(...parseInline(emphasis.inner, [...marks, ...emphasis.marks]));
        i = emphasis.end;
      } else {
        buffer += char;
        i++;
      }
    }
  }
  flush();
  return nodes;
}

function linkNodes(label: string, target: string, marks: AdfMark[]): AdfNode[] {
  if (target.startsWith('mention:')) {
    return [
      {
        type: 'mention',
        attrs: { id: target.slice('mention:'.length), text: label.replace(/\\(.)/g, '$1') },
      },
    ];
  }
  return parseInline(label, [...marks, { type: 'link', attrs: { href: target } }]);
}

function readCodeSpan(text: string, at: number): { code: string; end: number } | null {
  const ticks = /^`+/.exec(text.slice(at)) as RegExpExecArray;
  const fence = ticks[0];
  const bodyStart = at + fence.length;
  for (
    let close = text.indexOf(fence, bodyStart);
    close !== -1;
    close = text.indexOf(fence, close + 1)
  ) {
    const runLength = /^`+/.exec(text.slice(close)) as RegExpExecArray;
    if (runLength[0].length !== fence.length) {
      close += runLength[0].length - 1;
      continue;
    }
    const raw = text.slice(bodyStart, close);
    const padded = raw.length > 2 && raw.startsWith(' ') && raw.endsWith(' ');
    return { code: padded ? raw.slice(1, -1) : raw, end: close + fence.length };
  }
  return null;
}

const EMPHASIS_DELIMITERS: Array<{ token: string; marks: AdfMark[] }> = [
  { token: '***', marks: [{ type: 'strong' }, { type: 'em' }] },
  { token: '**', marks: [{ type: 'strong' }] },
  { token: '__', marks: [{ type: 'strong' }] },
  { token: '~~', marks: [{ type: 'strike' }] },
  { token: '*', marks: [{ type: 'em' }] },
  { token: '_', marks: [{ type: 'em' }] },
];

function readEmphasis(
  text: string,
  at: number
): { inner: string; marks: AdfMark[]; end: number } | null {
  const delimiter = EMPHASIS_DELIMITERS.find(({ token }) => text.startsWith(token, at));
  if (!delimiter) return null;
  const { token } = delimiter;
  const innerStart = at + token.length;
  const opensWord = token[0] === '_' && /\w/.test(text[at - 1] ?? '');
  if (opensWord || /\s/.test(text[innerStart] ?? ' ')) return null;
  for (
    let close = text.indexOf(token, innerStart);
    close !== -1;
    close = text.indexOf(token, close + 1)
  ) {
    const closeAt = token.length > 1 ? lastTokenInRun(text, close, token) : close;
    if (isClosingDelimiter(text, closeAt, token, innerStart)) {
      return {
        inner: text.slice(innerStart, closeAt),
        marks: delimiter.marks,
        end: closeAt + token.length,
      };
    }
  }
  return null;
}

function lastTokenInRun(text: string, from: number, token: string): number {
  let runEnd = from;
  while (text[runEnd] === token[0]) runEnd++;
  return runEnd - token.length;
}

function isClosingDelimiter(
  text: string,
  close: number,
  token: string,
  innerStart: number
): boolean {
  if (close === innerStart || /\s/.test(text[close - 1]) || text[close - 1] === '\\') return false;
  const after = text[close + token.length] ?? '';
  if (token.length === 1 && after === token) return false;
  if (token.length === 1 && text[close - 1] === token) return false;
  return !(token[0] === '_' && /\w/.test(after));
}

function blocksToMarkdown(nodes: AdfNode[]): string {
  return nodes
    .map(blockToMarkdown)
    .filter((block) => block !== '')
    .join('\n\n');
}

function blockToMarkdown(node: AdfNode): string {
  const children = node.content ?? [];
  switch (node.type) {
    case 'paragraph':
      return escapeBlockStart(inlineToMarkdown(children));
    case 'heading':
      return `${'#'.repeat(clampLevel(node.attrs?.level))} ${inlineToMarkdown(children)}`;
    case 'bulletList':
      return children.map((item) => listItemToMarkdown(item, '- ')).join('\n');
    case 'orderedList':
      return children
        .map((item, index) => listItemToMarkdown(item, `${orderStart(node) + index}. `))
        .join('\n');
    case 'codeBlock':
      return codeBlockToMarkdown(node);
    case 'blockquote':
      return blocksToMarkdown(children)
        .split('\n')
        .map((line) => (line === '' ? '>' : `> ${line}`))
        .join('\n');
    case 'rule':
      return '---';
    case 'table':
      return tableToMarkdown(children);
    default:
      return wrapUnsupported(node, blocksToMarkdown(children), '\n\n');
  }
}

function clampLevel(level: unknown): number {
  return Math.min(6, Math.max(1, Number(level) || 1));
}

function orderStart(node: AdfNode): number {
  return Number(node.attrs?.order) || 1;
}

function listItemToMarkdown(item: AdfNode, marker: string): string {
  const blocks = (item.content ?? []).map(blockToMarkdown).filter((block) => block !== '');
  const body = (item.content ?? [])
    .filter((_, index) => blockToMarkdown((item.content ?? [])[index]) !== '')
    .map((child, index) => (index === 0 ? '' : isList(child) ? '\n' : '\n\n') + blocks[index])
    .join('');
  const indent = ' '.repeat(marker.length);
  return body
    .split('\n')
    .map((line, index) => (index === 0 ? marker + line : line === '' ? '' : indent + line))
    .join('\n');
}

function isList(node: AdfNode): boolean {
  return node.type === 'bulletList' || node.type === 'orderedList';
}

function codeBlockToMarkdown(node: AdfNode): string {
  const code = (node.content ?? []).map((child) => child.text ?? '').join('');
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${String(node.attrs?.language ?? '')}\n${code}\n${fence}`;
}

function tableToMarkdown(rows: AdfNode[]): string {
  const rendered = rows.map((row) => (row.content ?? []).map(cellToMarkdown));
  if (rendered.length === 0) return '';
  const lines = rendered.map((cells) => `| ${cells.join(' | ')} |`);
  const separator = `| ${rendered[0].map(() => '---').join(' | ')} |`;
  return [lines[0], separator, ...lines.slice(1)].join('\n');
}

function cellToMarkdown(cell: AdfNode): string {
  return blocksToMarkdown(cell.content ?? [])
    .replace(/\\\n/g, '<br>')
    .replace(/\n+/g, '<br>')
    .replace(/\|/g, '\\|');
}

function escapeBlockStart(line: string): string {
  return line.replace(/^([#>+-])/, '\\$1').replace(/^(\d+)([.)])(\s)/, '$1\\$2$3');
}

function inlineToMarkdown(nodes: AdfNode[]): string {
  return nodes.map(inlineNodeToMarkdown).join('');
}

function inlineNodeToMarkdown(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return textToMarkdown(node);
    case 'hardBreak':
      return '\\\n';
    case 'mention': {
      const id = String(node.attrs?.id ?? '');
      const label = String(node.attrs?.text ?? id).replace(/^@/, '');
      return id === '' ? wrapUnsupported(node, '', '') : `[@${escapeText(label)}](mention:${id})`;
    }
    case 'emoji': {
      const emoji = node.attrs?.shortName ?? node.attrs?.text;
      return emoji === undefined ? wrapUnsupported(node, '', '') : String(emoji);
    }
    case 'inlineCard':
      return typeof node.attrs?.url === 'string'
        ? `<${node.attrs.url}>`
        : wrapUnsupported(node, '', '');
    default:
      return wrapUnsupported(node, inlineToMarkdown(node.content ?? []), '');
  }
}

function textToMarkdown(node: AdfNode): string {
  const marks = node.marks ?? [];
  const [, leading, core, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(
    node.text ?? ''
  ) as RegExpExecArray;
  if (core === '') return node.text ?? '';
  let result = marks.some((mark) => mark.type === 'code') ? codeSpan(core) : escapeText(core);
  if (marks.some((mark) => mark.type === 'em')) result = `*${result}*`;
  if (marks.some((mark) => mark.type === 'strong')) result = `**${result}**`;
  if (marks.some((mark) => mark.type === 'strike')) result = `~~${result}~~`;
  for (const mark of marks.filter((candidate) => !MARKDOWN_MARKS.has(candidate.type))) {
    result = wrapUnsupported(mark, result, '');
  }
  const link = marks.find((mark) => mark.type === 'link');
  if (link) result = `[${result}](${encodeHref(String(link.attrs?.href ?? ''))})`;
  return leading + result + trailing;
}

function codeSpan(code: string): string {
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${code}${pad}${fence}`;
}

function escapeText(text: string): string {
  return text.replace(/[\\`*~[\]<]/g, '\\$&').replace(/(?<!\w)_|_(?!\w)/g, '\\_');
}

function encodeHref(href: string): string {
  return href.replace(
    /[()\s]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  );
}

function wrapUnsupported(node: AdfMarked, content: string, separator: string): string {
  const open: UnsupportedAdfMarker = unsupportedMarker(node);
  if (content === '') return open;
  const close: UnsupportedAdfMarker = `[/adf:${node.type}]`;
  return [open, content, close].join(separator);
}

function unsupportedMarker(node: AdfMarked): UnsupportedAdfMarker {
  const detail = markerDetail(node).replace(/\s+|\]/g, ' ');
  return detail === '' ? `[adf:${node.type}]` : `[adf:${node.type} ${detail}]`;
}

function markerDetail(node: AdfMarked): string {
  const attrs = node.attrs ?? {};
  if (node.type === 'subsup') return String(attrs.type ?? '');
  if (node.type === 'date') {
    const date = new Date(Number(attrs.timestamp));
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }
  const key = ['panelType', 'title', 'text', 'id', 'url', 'shortName', 'color'].find(
    (candidate) => typeof attrs[candidate] === 'string'
  );
  return key === undefined ? '' : String(attrs[key]);
}
