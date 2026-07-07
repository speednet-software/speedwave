/** Minimal structural surface shared by the `marked` namespace and scoped `Marked` instances. */
interface SyncMarkdownParser {
  parse(src: string, options: { async: false }): string | Promise<string>;
}

/**
 * Parses Markdown synchronously; throws if an async extension made `parse` return a Promise.
 * @param parser - the `marked` namespace or a scoped `Marked` instance
 * @param src - Markdown source
 * @returns HTML string (sanitise at bind time)
 */
export function parseMarkdownSync(parser: SyncMarkdownParser, src: string): string {
  const html = parser.parse(src, { async: false });
  if (typeof html !== 'string') {
    throw new Error('marked.parse returned a Promise; async option must remain false');
  }
  return html;
}
