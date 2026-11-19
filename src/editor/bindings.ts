// Write shared values into documents (live DOM or saved HTML) and read
// direct edits back out of them. Browser-only.

import { EachOrder, FIELD, RETIRED_FIELDS, GuestPart, GuestSep, Lang, ProjectValues, TextKey, eachHtml, guestText, slotHtml, toEnDigits } from './values';

const norm = (s: string) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** A per-guest block's wording, read back from its first (editable) copy: guest text → {tokens}. */
export function templateFromCopy(copy: Element): string {
  const c = copy.cloneNode(true) as Element;
  c.querySelectorAll('[data-tok]').forEach(t => t.replaceWith(c.ownerDocument!.createTextNode(`{${t.getAttribute('data-tok')}}`)));
  c.querySelectorAll('[contenteditable]').forEach(e => e.removeAttribute('contenteditable'));
  return c.innerHTML;
}

/**
 * Per-guest blocks (<div data-field="specialGuests" data-each="…wording…">): keep the wording in step with
 * the first copy (when it was edited) and write one copy per guest. Copies that are already right are left
 * alone, so the caret in the first copy stays where it is.
 */
export function syncEachBlock(el: HTMLElement, lang: Lang, values: ProjectValues, locked: boolean): boolean {
  let changed = false;
  const first = el.querySelector(':scope > [data-rep="0"]');
  if (locked && first) {
    const tpl = templateFromCopy(first);
    if (tpl.trim() && tpl !== el.getAttribute('data-each')) { el.setAttribute('data-each', tpl); changed = true; }
  }
  const html = eachHtml(el.getAttribute('data-each') || '', values, lang, (el.getAttribute('data-order') as EachOrder) || 'forward', el.getAttribute('data-skip') === 'host', locked);
  const want = el.ownerDocument.createElement('div');
  want.innerHTML = html;
  const wanted = Array.from(want.children);
  const have = Array.from(el.children);
  wanted.forEach((w, i) => {
    const h = have[i];
    if (h && h.outerHTML === w.outerHTML) return;
    if (h) h.replaceWith(w); else el.appendChild(w);
    changed = true;
  });
  have.slice(wanted.length).forEach(h => { h.remove(); changed = true; });
  return changed;
}

/** Update every linked slot under `root`. Returns true when something changed. */
export function applyValuesToRoot(root: ParentNode, lang: Lang, values: ProjectValues, opts: { lockStructured?: boolean; skip?: Element | null } = {}): boolean {
  let changed = false;
  // Values that are no longer shared become plain text (keeping their formatting).
  root.querySelectorAll<HTMLElement>('[data-field]').forEach(el => {
    if (RETIRED_FIELDS.has(el.getAttribute('data-field')!)) { el.replaceWith(...Array.from(el.childNodes)); changed = true; }
  });
  root.querySelectorAll<HTMLElement>('[data-field]').forEach(el => {
    const key = el.getAttribute('data-field')!;
    const def = FIELD.get(key);
    if (!def) return;
    if (opts.lockStructured) {
      // Dates and times are picked in the panel; everything else can be typed straight into the page.
      if (def.type === 'date' || def.type === 'time') el.setAttribute('contenteditable', 'false');
    }
    if (el.hasAttribute('data-each')) {
      // A per-guest block: the copy being typed in is never rewritten (its wording becomes the template).
      if (el.hasAttribute('data-override')) return;
      if (syncEachBlock(el, lang, values, !!opts.lockStructured)) changed = true;
      return;
    }
    if (opts.lockStructured && (el.hasAttribute('data-part') || el.hasAttribute('data-pick'))) el.setAttribute('contenteditable', 'false');
    if (el.hasAttribute('data-override') || el === opts.skip) return;
    const html = slotHtml(values, key, lang, {
      fmt: el.getAttribute('data-fmt') || undefined,
      sep: (el.getAttribute('data-sep') as GuestSep) || undefined,
      bold: el.getAttribute('data-bold') === '1',
      part: (el.getAttribute('data-part') as GuestPart) || undefined,
      pick: el.getAttribute('data-pick') || undefined,
    });
    if (def.type === 'text' || def.type === 'phone') {
      // Text slots: compare text so we don't disturb formatting or the caret.
      const tmp = document.createElement('span'); tmp.innerHTML = html;
      if (norm(el.textContent || '') === norm(tmp.textContent || '')) return;
    } else if (el.innerHTML === html) return;
    el.innerHTML = html;
    changed = true;
  });
  return changed;
}

export function applyValuesToBody(body: string, lang: Lang, values: ProjectValues): string {
  if (!body.includes('data-field')) return body;
  const t = document.createElement('template');
  t.innerHTML = body;
  return applyValuesToRoot(t.content, lang, values) ? t.innerHTML : body;
}

export type InlineEdit =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'number'; key: 'edition' | 'year' | 'hall'; value: number }
  | { kind: 'guest'; index: number; text: string }; // index 0 = chief guest

/** Values typed straight into linked slots that differ from the shared values. */
export function readInlineEdits(root: ParentNode, lang: Lang, values: ProjectValues): InlineEdit[] {
  const out: InlineEdit[] = [];
  const seen = new Set<string>();
  root.querySelectorAll<HTMLElement>('[data-field]').forEach(el => {
    if (el.hasAttribute('data-override')) return;
    // Parts of a guest, the host and per-guest blocks are written from the guest cards, never read back.
    if (el.hasAttribute('data-each') || el.hasAttribute('data-part') || el.hasAttribute('data-pick') || el.closest('[data-each]')) return;
    const key = el.getAttribute('data-field')!;
    const def = FIELD.get(key);
    if (!def || seen.has(key)) return;
    const text = norm(el.textContent || '');
    if (/^\[.*\]$/.test(text)) return;
    if (def.type === 'text' || def.type === 'phone') {
      const current = def.type === 'phone' ? values.contactPhone : (lang === 'bn' ? values.text[key as TextKey]?.bn : values.text[key as TextKey]?.en) || '';
      if (text !== norm(current)) { out.push({ kind: 'text', key, text }); seen.add(key); }
    } else if (def.type === 'ordinal' || def.type === 'year' || def.type === 'hall') {
      const m = toEnDigits(text).match(/\d+/);
      const n = m ? +m[0] : NaN;
      const cur = values[key as 'edition' | 'year' | 'hall'];
      if (Number.isFinite(n) && n > 0 && n !== cur) { out.push({ kind: 'number', key: key as 'edition' | 'year' | 'hall', value: n }); seen.add(key); }
    } else if (def.type === 'guest' && values.chiefGuest) {
      if (text && text !== norm(guestText(values.chiefGuest, lang))) { out.push({ kind: 'guest', index: 0, text }); seen.add(key); }
    } else if (def.type === 'guests') {
      el.querySelectorAll<HTMLElement>('[data-guest]').forEach(g => {
        const i = +(g.getAttribute('data-guest') || 0);
        const guest = values.specialGuests[i - 1];
        const t = norm(g.textContent || '');
        if (guest && t && t !== norm(guestText(guest, lang)) && !seen.has('g' + i)) { out.push({ kind: 'guest', index: i, text: t }); seen.add('g' + i); }
      });
    }
  });
  return out;
}

export interface SlotInfo { key: string; count: number; overrides: number }

/** How often each field is used in a body (and how many places keep their own text). */
export function slotUsage(body: string): Record<string, { count: number; overrides: number }> {
  const out: Record<string, { count: number; overrides: number }> = {};
  const re = /<(?:span|div)\b[^>]*\bdata-field="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const e = (out[m[1]] ||= { count: 0, overrides: 0 });
    e.count++;
    if (/\bdata-override="1"/.test(m[0])) e.overrides++;
  }
  return out;
}

/** Remove the per-document override of a field so it follows the shared value again. */
export function clearOverrides(body: string, key: string): string {
  const t = document.createElement('template');
  t.innerHTML = body;
  let changed = false;
  t.content.querySelectorAll(`[data-field="${key}"][data-override]`).forEach(el => { el.removeAttribute('data-override'); changed = true; });
  return changed ? t.innerHTML : body;
}

/** Strip editor-only attributes before saving. */
export const cleanEditorHtml = (html: string) => html.replace(/\scontenteditable="false"/g, '');
