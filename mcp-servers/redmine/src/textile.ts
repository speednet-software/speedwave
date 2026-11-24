/** Tags whose entire content (opening tag + body + closing tag) must be removed */
const DANGEROUS_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'applet'];

/** Textile-safe HTML tags (Redmine Textile allows basic formatting) */
const SAFE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'cite',
  'code',
  'dd',
  'del',
  'dfn',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'var',
]);

/**
 * Sanitize Textile markup to remove potentially dangerous content.
 * @param textile - Raw Textile markup to sanitize.
 */
export function sanitizeTextile(textile: string): string {
  let result = textile;
  let previous: string;

  do {
    previous = result;
    for (const tag of DANGEROUS_TAGS) {
      result = result.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}[^>]*>`, 'gi'), '');
      result = result.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '');
      result = result.replace(new RegExp(`<\\/${tag}[^>]*>`, 'gi'), '');
    }
  } while (result !== previous);

  do {
    previous = result;
    result = result.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/gi, (match, tag: string) => {
      return SAFE_TAGS.has(tag.toLowerCase()) ? match : '';
    });
  } while (result !== previous);

  do {
    previous = result;
    result = result.replace(
      /(<[^>]*?)[\s/]+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)([^>]*>)/gi,
      '$1$2'
    );
    result = result.replace(/(<[^>]*?(?:href|src|action)\s*=\s*["']?)\s*javascript\s*:/gi, '$1');
    result = result.replace(/(<[^>]*?(?:href|src|action)\s*=\s*["']?)\s*vbscript\s*:/gi, '$1');
    result = result.replace(/(<[^>]*?(?:href|src|action)\s*=\s*["']?)\s*data\s*:/gi, '$1');
  } while (result !== previous);

  result = result.replace(/javascript\s*:/gi, '');
  result = result.replace(/vbscript\s*:/gi, '');
  result = result.replace(/data\s*:/gi, '');

  return result;
}
