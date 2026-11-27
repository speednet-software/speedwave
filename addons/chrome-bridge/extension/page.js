export function pageLib() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'svg']);
  const ROLES = new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'tab',
    'menuitem',
    'option',
    'switch',
    'combobox',
    'textbox',
    'searchbox',
    'slider',
    'treeitem',
  ]);
  const TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);

  const clean = (s, max) =>
    String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);

  const hidden = (el) => {
    const style = getComputedStyle(el);
    return (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      (el.type === 'hidden' && el.tagName === 'INPUT')
    );
  };

  const interactive = (el) => {
    if (TAGS.has(el.tagName)) return true;
    if (el.tagName === 'A') return el.hasAttribute('href');
    const role = el.getAttribute('role');
    if (role && ROLES.has(role)) return true;
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return true;
    return el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.hasAttribute('tabindex'));
  };

  const ref = (el) => {
    let value = el.getAttribute('data-sw-ref');
    if (!value) {
      window.__swSeq = (window.__swSeq ?? 0) + 1;
      value = `e${window.__swSeq}`;
      el.setAttribute('data-sw-ref', value);
    }
    return value;
  };

  const label = (el) => {
    const byId = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return clean(
      el.getAttribute('aria-label') ||
        (byId && byId.innerText) ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
          ? ''
          : el.innerText) ||
        el.getAttribute('placeholder') ||
        '',
      120
    );
  };

  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const parts = [`[${ref(el)}]`, el.getAttribute('role') || (tag === 'a' ? 'link' : tag)];
    if (tag === 'input') parts.push(`type=${el.type}`);
    if (el.name) parts.push(`name=${JSON.stringify(el.name)}`);
    const text = label(el);
    if (text) parts.push(JSON.stringify(text));
    if (tag === 'a') parts.push(`-> ${el.getAttribute('href')}`);
    if ((tag === 'input' || tag === 'textarea') && el.value) {
      parts.push(
        el.type === 'password' ? 'value=<hidden>' : `value=${JSON.stringify(clean(el.value, 120))}`
      );
    }
    if (el.placeholder && text !== clean(el.placeholder, 120))
      parts.push(`placeholder=${JSON.stringify(el.placeholder)}`);
    if (tag === 'select') {
      parts.push(`selected=${JSON.stringify(el.selectedOptions[0]?.text ?? '')}`);
      parts.push(`options=${JSON.stringify([...el.options].slice(0, 30).map((o) => o.text))}`);
    }
    if (el.checked) parts.push('checked');
    if (el.disabled) parts.push('disabled');
    if (el.getAttribute('aria-expanded'))
      parts.push(`expanded=${el.getAttribute('aria-expanded')}`);
    return parts.join(' ');
  };

  const deepFind = (root, selector) => {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const found = deepFind(el.shadowRoot, selector);
        if (found) return found;
      }
    }
    return null;
  };

  const find = ({ ref: wanted, selector }) =>
    wanted
      ? deepFind(document, `[data-sw-ref="${CSS.escape(wanted)}"]`)
      : selector
        ? deepFind(document, selector)
        : null;

  return {
    read({ mode, maxChars }) {
      const out = [
        `URL: ${location.href}`,
        `Title: ${document.title}`,
        `Viewport: ${innerWidth}x${innerHeight}, scrolled ${Math.round(scrollY)} of ${document.documentElement.scrollHeight}`,
        '',
      ];
      if (mode === 'text') {
        out.push(document.body?.innerText ?? '');
      } else {
        const walk = (node, depth) => {
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              const text = clean(child.textContent, 300);
              if (mode === 'all' && text) out.push(`${'  '.repeat(depth)}${text}`);
              continue;
            }
            if (child.nodeType !== Node.ELEMENT_NODE || SKIP.has(child.tagName) || hidden(child))
              continue;
            if (/^H[1-6]$/.test(child.tagName)) {
              out.push(
                `${'  '.repeat(depth)}${'#'.repeat(Number(child.tagName[1]))} ${clean(child.innerText, 200)}`
              );
              continue;
            }
            if (interactive(child)) {
              if (child.getClientRects().length > 0)
                out.push(`${'  '.repeat(depth)}${describe(child)}`);
              continue;
            }
            walk(child.shadowRoot ?? child, depth);
          }
        };
        walk(document.body ?? document.documentElement, 0);
      }
      const text = out.join('\n');
      return text.length > maxChars
        ? `${text.slice(0, maxChars)}\n[truncated at ${maxChars} chars of ${text.length}]`
        : text;
    },

    locate(args) {
      const el = find(args);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },

    selectAll() {
      const el = document.activeElement;
      if (el && typeof el.select === 'function') el.select();
      else document.execCommand('selectAll');
      return true;
    },

    scroll(args) {
      if (args.ref || args.selector) {
        const el = find(args);
        if (!el) throw new Error('Element not found');
        el.scrollIntoView({ block: 'center' });
      } else {
        window.scrollBy(0, args.dy);
      }
      return { scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight };
    },
  };
}
