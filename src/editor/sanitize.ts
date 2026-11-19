// Editor HTML sanitizer: rebuilds markup from an allow-list so documents keep
// their layout (fonts, sizes, colours, alignment, spacing, tables, images, field
// links) while scripts, event handlers, external code and forms never survive.

const TAGS = new Set('p div span br strong b em i u s strike del ins sub sup h1 h2 h3 h4 h5 h6 ul ol li blockquote table thead tbody tfoot tr td th caption colgroup col hr a img small mark pre code figure figcaption'.split(' '));
const RENAME: Record<string, string> = { font: 'span', section: 'div', article: 'div', header: 'div', footer: 'div', main: 'div', center: 'div', big: 'span', address: 'div', nav: 'div', aside: 'div' };
const DROP = new Set('script style iframe object embed svg math template link meta noscript form input button textarea select option frame frameset applet base title head audio video canvas'.split(' '));

const STYLE_PROPS = new Set([
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'color', 'background-color',
  'text-decoration', 'text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-align', 'text-indent', 'text-transform',
  'line-height', 'letter-spacing', 'word-spacing', 'white-space', 'vertical-align',
  'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-collapse', 'border-spacing',
  'border-width', 'border-style', 'border-color', 'border-radius',
  'border-top-width', 'border-top-style', 'border-top-color', 'border-right-width', 'border-right-style', 'border-right-color',
  'border-bottom-width', 'border-bottom-style', 'border-bottom-color', 'border-left-width', 'border-left-style', 'border-left-color',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'list-style-type', 'list-style-position', 'display', 'float', 'clear',
  'page-break-before', 'page-break-after', 'page-break-inside', 'break-before', 'break-after', 'break-inside', 'table-layout', 'direction',
  'position', 'top', 'left', 'right', 'bottom', 'box-sizing', 'background', 'overflow',
]);
const BAD_VALUE = /url\s*\(|expression|javascript:|@import|var\s*\(|behavior|-moz-binding/i;
const DISPLAY_OK = new Set(['block', 'inline', 'inline-block', 'none', 'table', 'table-row', 'table-cell', 'list-item']);

export const FIELD_KEY = /^[A-Za-z][A-Za-z0-9.]{0,40}$/;

function safeHref(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  return /^(https?:|mailto:|tel:|#)/i.test(v) ? v : null;
}

function safeImgSrc(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i.test(v)) return v;
  if (/^https:\/\//i.test(v)) return v;
  return null;
}

/** Sanitize an HTML fragment (body content). Browser-only (uses DOMParser). */
export function sanitizeEditorHtml(source: string): string {
  const input = new DOMParser().parseFromString(`<body>${source}</body>`, 'text/html');
  const out = document.implementation.createHTMLDocument('');

  const copy = (node: Node, parent: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { parent.appendChild(out.createTextNode(node.textContent || '')); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    let tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) return;
    if (/^o:p$|^v:|^w:/.test(tag)) { el.childNodes.forEach(c => copy(c, parent)); return; }
    const renamed = RENAME[tag];
    if (renamed) tag = renamed;
    if (!TAGS.has(tag)) { el.childNodes.forEach(c => copy(c, parent)); return; }

    if (tag === 'img') {
      const src = safeImgSrc(el.getAttribute('src'));
      if (!src) return;
      const img = out.createElement('img');
      img.setAttribute('src', src);
      const alt = el.getAttribute('alt'); if (alt) img.setAttribute('alt', alt.slice(0, 300));
      for (const a of ['width', 'height']) { const v = el.getAttribute(a); if (v && /^\d{1,4}$/.test(v)) img.setAttribute(a, v); }
      copyStyle(el, img);
      parent.appendChild(img);
      return;
    }

    const next = out.createElement(tag);
    copyStyle(el, next);
    if (el.tagName.toLowerCase() === 'font') {
      const face = el.getAttribute('face'); if (face && /^[\w\s,'"-]+$/.test(face)) next.style.fontFamily = face;
      const color = el.getAttribute('color'); if (color && /^(#[\da-f]{3,8}|[a-z]+)$/i.test(color)) next.style.color = color;
      const sizes = [0, 8, 10, 12, 14, 18, 24, 36]; const size = Number(el.getAttribute('size')); if (size >= 1 && size <= 7) next.style.fontSize = sizes[size] + 'pt';
    }
    const align = el.getAttribute('align'); if (align && ['left', 'right', 'center', 'justify'].includes(align.toLowerCase())) next.style.textAlign = align.toLowerCase();
    for (const attr of ['colspan', 'rowspan', 'start', 'span']) { const v = el.getAttribute(attr); if (v && /^\d{1,3}$/.test(v)) next.setAttribute(attr, v); }
    if (tag === 'ol') { const t = el.getAttribute('type'); if (t && /^[1aAiI]$/.test(t)) next.setAttribute('type', t); }
    if (['td', 'th', 'col', 'table'].includes(tag)) { const w = el.getAttribute('width'); if (w && /^\d{1,4}%?$/.test(w)) next.setAttribute('width', w); }
    if (['td', 'th'].includes(tag)) { const v = el.getAttribute('valign'); if (v && /^(top|middle|bottom)$/i.test(v)) next.style.verticalAlign = v.toLowerCase(); }
    const dir = el.getAttribute('dir'); if (dir === 'ltr' || dir === 'rtl') next.dir = dir;
    if (tag === 'a') { const href = safeHref(el.getAttribute('href')); if (href) { next.setAttribute('href', href); if (!href.startsWith('#')) next.setAttribute('rel', 'noopener noreferrer'); } }
    const field = el.getAttribute('data-field'); if (field && FIELD_KEY.test(field)) next.setAttribute('data-field', field);
    const fmt = el.getAttribute('data-fmt'); if (fmt && /^[\p{L}\p{M}\p{N} .,:{}\-–\[\]]{1,40}$/u.test(fmt)) next.setAttribute('data-fmt', fmt);
    const sep = el.getAttribute('data-sep'); if (sep && /^(comma|period|and|lines)$/.test(sep)) next.setAttribute('data-sep', sep);
    for (const flag of ['data-bold', 'data-override']) if (el.getAttribute(flag) === '1') next.setAttribute(flag, '1');
    const guest = el.getAttribute('data-guest'); if (guest && /^\d{1,3}$/.test(guest)) next.setAttribute('data-guest', guest);
    // Guest parts, the host and per-guest blocks (MC script).
    const part = el.getAttribute('data-part'); if (part && /^(name|designation|full|his|Sir|sir)$/.test(part)) next.setAttribute('data-part', part);
    if (el.getAttribute('data-pick') === 'host') next.setAttribute('data-pick', 'host');
    const order = el.getAttribute('data-order'); if (order && /^(forward|reverse)$/.test(order)) next.setAttribute('data-order', order);
    if (el.getAttribute('data-skip') === 'host') next.setAttribute('data-skip', 'host');
    const each = el.getAttribute('data-each'); if (each !== null && el.getAttribute('data-field') === 'specialGuests') next.setAttribute('data-each', sanitizeEditorHtml(each));
    const rep = el.getAttribute('data-rep'); if (rep && /^\d{1,3}$/.test(rep)) next.setAttribute('data-rep', rep);
    const tok = el.getAttribute('data-tok'); if (tok && /^(name|designation|full|his|Sir|sir)$/.test(tok)) next.setAttribute('data-tok', tok);
    const gref = el.getAttribute('data-gref'); if (gref && /^\d{1,3}$/.test(gref)) next.setAttribute('data-gref', gref);
    const classes = (el.getAttribute('class') || '').split(/\s+/).filter(c => /^sv-[a-z0-9-]{1,30}$/.test(c));
    if (classes.length) next.setAttribute('class', classes.join(' '));
    parent.appendChild(next);
    el.childNodes.forEach(c => copy(c, next));
  };

  input.body.childNodes.forEach(c => copy(c, out.body));
  return out.body.innerHTML;
}

function copyStyle(from: HTMLElement, to: HTMLElement) {
  const style = from.style;
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    if (!STYLE_PROPS.has(prop)) continue;
    const value = style.getPropertyValue(prop);
    if (!value || BAD_VALUE.test(value)) continue;
    if (prop === 'display' && !DISPLAY_OK.has(value.trim())) continue;
    if (prop === 'position' && !/^(relative|absolute|static)$/.test(value.trim())) continue;
    if (prop === 'background' && !/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(value.trim())) continue;
    if (prop === 'overflow' && !/^(hidden|visible|auto)$/.test(value.trim())) continue;
    to.style.setProperty(prop, value, style.getPropertyPriority(prop));
  }
}
