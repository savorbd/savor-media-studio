import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { DocModel, FONT_LINK, documentCss } from '../editor/doc';
import { sanitizeEditorHtml } from '../editor/sanitize';
import { textToBody } from '../editor/importers';

/** Linked values (a per-guest block is a container of text, not a value). */
const SLOT = '[data-field]:not([data-each]),[data-guest]';
import { SHEET_CSS, flowBoxes, movableBoxes, moveBox, paginate, stripPagination } from '../editor/paginate';

export interface ToolbarState {
  bold: boolean; italic: boolean; underline: boolean; strike: boolean; sup: boolean; sub: boolean;
  /** Paragraph: line height (× font size), space before/after (pt), first-line indent (in). */
  lineHeight: number; spaceBefore: number; spaceAfter: number; firstLine: number;
  block: string; align: string; font: string; size: number;
  ul: boolean; ol: boolean; hasSelection: boolean; inTable: boolean;
}

export const EMPTY_STATE: ToolbarState = { bold: false, italic: false, underline: false, strike: false, sup: false, sub: false, lineHeight: 1.6, spaceBefore: 0, spaceAfter: 0, firstLine: 0, block: 'p', align: 'left', font: '', size: 12, ul: false, ol: false, hasSelection: false, inTable: false };

export interface EditorApi {
  exec: (cmd: string, value?: string) => void;
  setBlock: (tag: string) => void;
  setFontSize: (pt: number) => void;
  insertHtml: (html: string) => void;
  getBody: () => string;
  setBody: (html: string) => void;
  getSelectionHtml: () => string;
  getSelectionText: () => string;
  replaceSelection: (html: string) => void;
  linkSelectionToField: (key: string) => string | null;
  doc: () => Document | null;
  tableAction: (action: 'row-above' | 'row-below' | 'col-left' | 'col-right' | 'del-row' | 'del-col' | 'del-table') => void;
  root: () => HTMLElement | null;
  focus: () => void;
  /** Paragraph formatting for the paragraphs in the selection. */
  setParagraph: (p: { lineHeight?: number; spaceBefore?: number; spaceAfter?: number; firstLine?: number; leftIndent?: number }) => void;
  /** Change the case of the selected text. */
  changeCase: (mode: 'upper' | 'lower' | 'title' | 'sentence') => void;
  /** Find (and optionally replace) text in this document. Returns the number of matches. */
  find: (text: string, opts: { replace?: string; all?: boolean; matchCase?: boolean }) => number;
}

const EDITOR_CSS = `
${SHEET_CSS}
html{overflow:hidden}
body.sv-doc{outline:none;caret-color:#4f46e5}
[data-sv-grip]{position:absolute;z-index:50;width:20px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:#4f46e5;color:#fff;font:700 12px/1 Inter,system-ui,sans-serif;cursor:ns-resize;user-select:none;box-shadow:0 1px 3px rgba(0,0,0,.25);opacity:.85}
[data-sv-grip]:hover{opacity:1}
.sv-textbox{outline:1px dashed rgba(79,70,229,.35);outline-offset:1px}
body.sv-hide-fields [data-field],body.sv-hide-fields [data-guest],body.sv-hide-fields [data-gref]{background:none!important;box-shadow:none!important;border-bottom:none!important}
body.sv-hide-fields ~ [data-sv-badges]{display:none}
[contenteditable="false"][data-field]{cursor:pointer}
body.sv-doc hr.sv-page-break{outline:1.5px dashed #a5b4fc;outline-offset:0}
body.sv-doc table.sv-plain td,body.sv-doc table.sv-plain th{outline:1px dashed #e4e4e7;outline-offset:-1px}
body.sv-doc img:hover{outline:2px solid #a5b4fc}
::selection{background:#c7d2fe}
`;

interface Props {
  extraCss?: string;
  onFieldClick?: (key: string, override: boolean) => void;
  onLoaded?: (root: HTMLElement) => void;
  docKey: string;
  model: DocModel;
  initialBody: string;
  showFields: boolean;
  zoom: number;
  onChange: (body: string) => void;
  onState: (state: ToolbarState) => void;
  onSave: () => void;
  /** Canvas integration: wheel/zoom forwarding, focus and hover reporting. */
  onWheel?: (e: WheelEvent, frame: HTMLIFrameElement) => void;
  onActivate?: () => void;
  onHoverField?: (key: string | null) => void;
  onBlurDoc?: () => void;
  framed?: boolean;
}

export const VisualEditor = forwardRef<EditorApi, Props>(function VisualEditor({ docKey, model, initialBody, showFields, zoom, onChange, onState, onSave, extraCss, onFieldClick, onLoaded, onWheel, onActivate, onHoverField, onBlurDoc, framed = true }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const lastRange = useRef<Range | null>(null);
  const changeTimer = useRef<number | undefined>(undefined);
  const cb = useRef({ onChange, onState, onSave, onFieldClick, onLoaded, onWheel, onActivate, onHoverField, onBlurDoc });
  cb.current = { onChange, onState, onSave, onFieldClick, onLoaded, onWheel, onActivate, onHoverField, onBlurDoc };
  const pendingBody = useRef<string | null>(initialBody);
  const live = useRef({ model, showFields, extraCss });
  live.current = { model, showFields, extraCss };

  const doc = () => frame.current?.contentDocument || null;
  const body = () => doc()?.body || null;

  const resize = () => {
    const f = frame.current, b = body();
    if (f && b) f.style.height = Math.max(b.scrollHeight, 1123) + 'px';
  };

  // A4 sheets + movable text boxes.
  const layoutTimer = useRef<number | undefined>(undefined);
  const dragging = useRef(false);
  const grips = useRef<HTMLDivElement | null>(null);
  const refreshGrips = () => {
    const d = doc(); const layer = grips.current; if (!d || !layer) return;
    const boxes = movableBoxes(d.body);
    while (layer.children.length > boxes.length) layer.lastElementChild!.remove();
    boxes.forEach((box, i) => {
      let g = layer.children[i] as HTMLDivElement | undefined;
      if (!g) {
        g = d.createElement('div');
        g.setAttribute('data-sv-grip', '');
        g.title = 'Drag to move this box up or down — text always flows below it';
        g.textContent = '⇕';
        layer.appendChild(g);
        g.addEventListener('pointerdown', e => {
          const target = (g as any).__box as HTMLElement | undefined;
          if (!target) return;
          e.preventDefault(); e.stopPropagation();
          g!.setPointerCapture(e.pointerId);
          dragging.current = true;
          const start = { y: e.clientY, top: target.getBoundingClientRect().top };
          const move = (ev: PointerEvent) => { moveBox(target, start.top + ev.clientY - start.y); refreshGrips(); resize(); };
          const up = (ev: PointerEvent) => {
            g!.removeEventListener('pointermove', move); g!.removeEventListener('pointerup', up); g!.removeEventListener('pointercancel', up);
            try { g!.releasePointerCapture(ev.pointerId); } catch {}
            dragging.current = false;
            scheduleChange(); layout();
          };
          g!.addEventListener('pointermove', move); g!.addEventListener('pointerup', up); g!.addEventListener('pointercancel', up);
        });
      }
      (g as any).__box = box;
      const r = box.getBoundingClientRect();
      const w = d.defaultView!;
      g.style.left = Math.max(2, r.left + w.scrollX - 26) + 'px';
      g.style.top = (r.top + w.scrollY) + 'px';
      g.style.height = Math.max(24, Math.min(r.height, 80)) + 'px';
    });
  };
  const badges = useRef<HTMLDivElement | null>(null);
  /** Guest numbers, drawn over the page (outside the text) so they never move a word. */
  const refreshBadges = () => {
    const d = doc(); const layer = badges.current; if (!d || !layer) return;
    const list = Array.from(d.body.querySelectorAll<HTMLElement>('[data-guest]'));
    while (layer.children.length > list.length) layer.lastElementChild!.remove();
    list.forEach((g, i) => {
      let b = layer.children[i] as HTMLElement | undefined;
      if (!b) { b = d.createElement('span'); layer.appendChild(b); }
      const n = g.getAttribute('data-guest') || '';
      b.setAttribute('data-sv-badge', n);
      b.textContent = n;
      const rects = g.getClientRects();
      const r = rects[rects.length - 1];
      if (!r) { b.style.display = 'none'; return; }
      b.style.display = '';
      const w = d.defaultView!;
      b.style.left = (r.right + w.scrollX - 2) + 'px';
      b.style.top = (r.top + w.scrollY - 6) + 'px';
    });
  };
  const layout = () => {
    window.clearTimeout(layoutTimer.current);
    layoutTimer.current = window.setTimeout(() => {
      const d = doc(); if (!d || dragging.current) return;
      paginate(d, live.current.model.margins);
      refreshGrips();
      refreshBadges();
      resize();
    }, 60);
  };

  const flushChange = () => {
    window.clearTimeout(changeTimer.current);
    const b = body();
    if (b) cb.current.onChange(stripPagination(b.innerHTML.replace(/\scontenteditable="false"/g, '')));
  };
  const scheduleChange = () => {
    window.clearTimeout(changeTimer.current);
    changeTimer.current = window.setTimeout(flushChange, 300);
    resize();
  };

  const restoreSelection = () => {
    const d = doc(); const w = frame.current?.contentWindow;
    if (!d || !w) return;
    w.focus();
    const sel = d.getSelection();
    if (lastRange.current && sel && (!sel.rangeCount || !d.body.contains(sel.anchorNode))) {
      sel.removeAllRanges(); sel.addRange(lastRange.current);
    }
  };

  const computeState = () => {
    const d = doc(); if (!d) return;
    const sel = d.getSelection();
    if (sel && sel.rangeCount && d.body.contains(sel.anchorNode)) lastRange.current = sel.getRangeAt(0).cloneRange();
    let el: Element | null = sel?.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode as Element : sel.anchorNode.parentElement) : null;
    if (!el || !d.body.contains(el)) el = d.body;
    const block = el.closest('p,h1,h2,h3,h4,h5,h6,blockquote,li,pre,td,th,div') as HTMLElement | null;
    const cs = d.defaultView!.getComputedStyle(el);
    const bcs = d.defaultView!.getComputedStyle(block || d.body);
    const fpx = parseFloat(bcs.fontSize) || 16;
    const q = (c: string) => { try { return d.queryCommandState(c); } catch { return false; } };
    cb.current.onState({
      bold: q('bold'), italic: q('italic'), underline: q('underline'), strike: q('strikeThrough'), sup: q('superscript'), sub: q('subscript'),
      lineHeight: Math.round((bcs.lineHeight === 'normal' ? 1.2 : parseFloat(bcs.lineHeight) / fpx) * 100) / 100,
      spaceBefore: Math.round((parseFloat(bcs.marginTop) || 0) * 0.75 * 10) / 10,
      spaceAfter: Math.round((parseFloat(bcs.marginBottom) || 0) * 0.75 * 10) / 10,
      firstLine: Math.round((parseFloat(bcs.textIndent) || 0) / 96 * 100) / 100,
      block: block && /^(H[1-6]|BLOCKQUOTE|PRE|P)$/.test(block.tagName) ? block.tagName.toLowerCase() : 'p',
      align: block ? d.defaultView!.getComputedStyle(block).textAlign.replace('start', 'left').replace('end', 'right') : 'left',
      font: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      size: Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2,
      ul: q('insertUnorderedList'), ol: q('insertOrderedList'),
      hasSelection: !!sel && !sel.isCollapsed,
      inTable: !!el.closest('td,th'),
    });
  };

  const applyCss = () => {
    const d = doc(); if (!d) return;
    const { model: m, showFields: show } = live.current;
    const style = d.getElementById('sv-doc-css');
    if (style) style.textContent = documentCss(m) + '\n' + (live.current.extraCss || '');
    d.documentElement.lang = m.lang;
    d.body.classList.toggle('sv-hide-fields', !show);
    layout();
  };

  // Build the editing frame once.
  useEffect(() => {
    const f = frame.current!;
    f.srcdoc = `<!DOCTYPE html><html lang="${model.lang}"><head><meta charset="utf-8"><link rel="stylesheet" href="${FONT_LINK}"><style id="sv-doc-css"></style><style>${EDITOR_CSS}</style></head><body class="sv-doc" contenteditable="true" spellcheck="true"></body></html>`;
    const onLoad = () => {
      const d = f.contentDocument!;
      ready.current = true;
      try { d.execCommand('styleWithCSS', false, 'true'); d.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}
      d.addEventListener('input', scheduleChange);
      d.addEventListener('selectionchange', computeState);
      d.addEventListener('keyup', computeState);
      d.addEventListener('mouseup', computeState);
      d.addEventListener('blur', flushChange, true);
      f.contentWindow?.addEventListener('blur', () => { flushChange(); cb.current.onBlurDoc?.(); });
      f.contentWindow?.addEventListener('focus', () => cb.current.onActivate?.());
      d.addEventListener('mousedown', () => cb.current.onActivate?.());
      d.addEventListener('wheel', e => { if (cb.current.onWheel) { e.preventDefault(); cb.current.onWheel(e, f); } }, { passive: false });
      let lastHover: string | null = null;
      d.addEventListener('mouseover', e => {
        const el = (e.target as HTMLElement)?.closest?.('[data-guest],[data-field]') as HTMLElement | null;
        const k = !el ? null : el.hasAttribute('data-guest') ? `specialGuests:${el.getAttribute('data-guest')}` : el.getAttribute('data-field');
        if (k !== lastHover) { lastHover = k; cb.current.onHoverField?.(k); }
      });
      d.documentElement.addEventListener('mouseleave', () => { if (lastHover) { lastHover = null; cb.current.onHoverField?.(null); } });
      d.addEventListener('click', e => {
        const el = (e.target as HTMLElement)?.closest?.('[data-guest],[data-field]') as HTMLElement | null;
        if (!el) return;
        const field = el.closest('[data-field]') as HTMLElement | null;
        const key = el.hasAttribute('data-guest') ? `specialGuests:${el.getAttribute('data-guest')}` : field?.getAttribute('data-field');
        if (key) cb.current.onFieldClick?.(key, !!field?.hasAttribute('data-override'));
      });
      d.addEventListener('keydown', e => {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); flushChange(); cb.current.onSave(); return; }
        if (e.key === 'Tab') {
          e.preventDefault();
          const inList = (d.getSelection()?.anchorNode?.parentElement)?.closest('li');
          if (inList) d.execCommand(e.shiftKey ? 'outdent' : 'indent');
          else if (!e.shiftKey) d.execCommand('insertHTML', false, '<span style="display:inline-block;width:0.5in"></span>');
          scheduleChange();
        }
      });
      // Enter (or Shift+Enter) in or next to a linked value: break the line *outside* the value.
      // Otherwise the browser splits the value in two and both halves get filled with it.
      let ownBreak = false;
      d.addEventListener('beforeinput', e => {
        if (ownBreak || (e.inputType !== 'insertParagraph' && e.inputType !== 'insertLineBreak')) return;
        const sel = d.getSelection(); if (!sel || !sel.rangeCount) return;
        const r0 = sel.getRangeAt(0);
        const node = r0.startContainer;
        const el = (node.nodeType === 1 ? node as Element : node.parentElement);
        // The outermost linked value around the caret (a guest list, not one guest in it).
        let slot: HTMLElement | null = null;
        // (A per-guest block's first copy is ordinary text: Enter works as usual inside it.)
        for (let x = el?.closest(SLOT) as HTMLElement | null; x; x = x.parentElement?.closest(SLOT) as HTMLElement | null) slot = x;
        if (!slot || !d.body.contains(slot)) return;
        e.preventDefault();
        if (!r0.collapsed) r0.deleteContents();
        const before = d.createRange();
        before.setStart(slot, 0);
        before.setEnd(r0.startContainer, r0.startOffset);
        const atStart = !before.toString().replace(/\u200B/g, '').trim();
        const r = d.createRange();
        if (atStart) r.setStartBefore(slot); else r.setStartAfter(slot);
        r.collapse(true);
        const block = slot.parentElement?.closest('p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,div') as HTMLElement | null;
        const place = (n: Node, offset: number) => { const c = d.createRange(); c.setStart(n, offset); c.collapse(true); sel.removeAllRanges(); sel.addRange(c); };
        if (e.inputType === 'insertLineBreak' || !block || !d.body.contains(block) || /^(TD|TH)$/.test(block.tagName)) {
          const br = d.createElement('br');
          r.insertNode(br);
          if (!br.nextSibling || (br.nextSibling.nodeType === 3 && !br.nextSibling.textContent) ) br.after(d.createElement('br'));
          place(br.parentNode!, Array.prototype.indexOf.call(br.parentNode!.childNodes, br) + 1);
        } else {
          // Split the paragraph at the edge of the value; the value moves whole.
          const tail = d.createRange();
          tail.setStart(r.startContainer, r.startOffset);
          tail.setEnd(block, block.childNodes.length);
          const frag = tail.extractContents();
          const next = block.cloneNode(false) as HTMLElement;
          next.removeAttribute('data-sv-pb'); next.removeAttribute('id');
          next.appendChild(frag);
          const empty = (b: HTMLElement) => !(b.textContent || '').replace(/\u200B/g, '').trim() && !b.querySelector('img,br,[data-field]');
          if (empty(next)) next.innerHTML = '<br>';
          if (empty(block)) block.innerHTML = '<br>';
          block.after(next);
          if (atStart) place(block, 0); else place(next, 0);
        }
        cleanSlots(); scheduleChange(); computeState();
      });
      /** Linked values left empty by editing (e.g. a split) are removed, unless you're typing in one. */
      const cleanSlots = () => {
        const sel = d.getSelection();
        const caret = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
        d.body.querySelectorAll<HTMLElement>(SLOT).forEach(el => {
          if ((el.textContent || '').replace(/[\u200B\s]/g, '') !== '' || el.querySelector('img')) return;
          if (caret && (el === caret || el.contains(caret))) return;
          el.remove();
        });
      };
      d.addEventListener('input', () => cleanSlots());
      // Typing over a whole linked value (e.g. select a name and retype it) must stay inside
      // the value, or the browser drops the link and the change is never picked up.
      d.addEventListener('beforeinput', e => {
        if (!/^(insertText|insertReplacementText|insertFromPaste|deleteContentBackward|deleteContentForward|deleteByCut|deleteWordBackward|deleteWordForward)$/.test(e.inputType)) return;
        const sel = d.getSelection(); if (!sel || !sel.rangeCount || sel.isCollapsed) return;
        const r = sel.getRangeAt(0);
        const picked = r.toString().replace(/\s+/g, ' ').trim();
        if (!picked) return;
        const slots = Array.from(d.body.querySelectorAll<HTMLElement>(SLOT)).filter(el => r.intersectsNode(el) && el.getAttribute('contenteditable') !== 'false');
        // The innermost value whose whole text is selected (a guest before its list).
        const slot = slots.reverse().find(el => (el.textContent || '').replace(/\s+/g, ' ').trim() === picked);
        if (!slot) return;
        const text = e.inputType.startsWith('delete') ? '' : (e.data ?? e.dataTransfer?.getData('text/plain') ?? '').replace(/\s*\n\s*/g, ' ');
        e.preventDefault();
        const walker = d.createTreeWalker(slot, NodeFilter.SHOW_TEXT);
        const texts: Text[] = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
        let target: Text;
        if (texts.length) {
          target = texts.find(t => t.data.trim()) || texts[0];
          target.data = text;
          texts.forEach(t => { if (t !== target) t.remove(); });
          // Drop empty wrappers left behind, but keep the one holding the text.
          slot.querySelectorAll('*').forEach(el => { if (!el.contains(target) && !(el.textContent || '').length && !/^(BR|IMG)$/.test(el.tagName)) el.remove(); });
        } else {
          target = d.createTextNode(text); slot.appendChild(target);
        }
        const nr = d.createRange(); nr.setStart(target, text.length); nr.collapse(true);
        sel.removeAllRanges(); sel.addRange(nr);
        scheduleChange(); computeState();
      });
      const layer = d.createElement('div');
      layer.setAttribute('data-sv-ui', '');
      d.documentElement.appendChild(layer); // outside <body>, so it is never saved
      grips.current = layer;
      const badgeLayer = d.createElement('div');
      badgeLayer.setAttribute('data-sv-badges', '');
      badgeLayer.setAttribute('data-sv-ui', '');
      d.documentElement.appendChild(badgeLayer);
      badges.current = badgeLayer;
      new (d.defaultView as any).MutationObserver(() => layout()).observe(d.body, { childList: true, subtree: true, characterData: true });
      // Floating boxes (text boxes from Word) can be dragged up and down by a handle.
      d.addEventListener('paste', e => {
        const html = e.clipboardData?.getData('text/html');
        const text = e.clipboardData?.getData('text/plain') || '';
        e.preventDefault();
        if (html) d.execCommand('insertHTML', false, sanitizeEditorHtml(html.replace(/^[\s\S]*?<body[^>]*>|<\/body>[\s\S]*$/gi, '')));
        else if (/\n/.test(text)) d.execCommand('insertHTML', false, textToBody(text));
        else d.execCommand('insertText', false, text);
        scheduleChange();
      });
      d.fonts?.ready.then(() => { if (flowBoxes(d)) scheduleChange(); layout(); });
      new (d.defaultView as any).ResizeObserver(resize).observe(d.body);
      applyCss();
      if (pendingBody.current !== null) { d.body.innerHTML = pendingBody.current || '<p><br></p>'; pendingBody.current = null; }
      cb.current.onLoaded?.(d.body);
      resize();
      computeState();
    };
    f.addEventListener('load', onLoad, { once: true });
    return () => { window.clearTimeout(changeTimer.current); };
  }, []);

  // Switch document.
  useEffect(() => {
    if (!ready.current) { pendingBody.current = initialBody; return; }
    const b = body(); if (!b) return;
    b.innerHTML = initialBody || '<p><br></p>';
    lastRange.current = null;
    cb.current.onLoaded?.(b);
    if (flowBoxes(doc()!)) scheduleChange();
    applyCss();
    frame.current?.closest('.sv-canvas')?.scrollTo?.({ top: 0 });
    computeState();
  }, [docKey]);

  useEffect(() => { if (ready.current) applyCss(); }, [model.font, model.fontSize, model.margins.top, model.margins.right, model.margins.bottom, model.margins.left, model.lang, showFields, extraCss]);

  /** Paragraph-level elements touched by the selection (or the one with the caret). */
  const selectedBlocks = (): HTMLElement[] => {
    const d = doc(); if (!d) return [];
    restoreSelection();
    const sel = d.getSelection(); if (!sel || !sel.rangeCount) return [];
    const r = sel.getRangeAt(0);
    const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,td,th';
    const leafs = Array.from(d.body.querySelectorAll<HTMLElement>(BLOCK)).filter(el => !el.querySelector('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,table') && r.intersectsNode(el));
    if (leafs.length) return leafs;
    const n = r.startContainer;
    const own = (n.nodeType === 1 ? n as Element : n.parentElement)?.closest(BLOCK) as HTMLElement | null;
    return own && d.body.contains(own) ? [own] : [];
  };
  const caseOf = (t: string, mode: 'upper' | 'lower' | 'title' | 'sentence', start: boolean) =>
    mode === 'upper' ? t.toUpperCase() : mode === 'lower' ? t.toLowerCase()
      : mode === 'title' ? t.toLowerCase().replace(/(^|[\s(“"'\-])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase())
        : t.toLowerCase().replace(/(^|[.!?।]\s+)(\p{L})/gu, (m, a, b, off) => (off === 0 && !start ? m : a + b.toUpperCase()));

  useImperativeHandle(ref, () => ({
    setParagraph: p => {
      const blocks = selectedBlocks();
      blocks.forEach(b => {
        if (p.lineHeight !== undefined) b.style.lineHeight = String(Math.round(p.lineHeight * 100) / 100);
        if (p.spaceBefore !== undefined) b.style.marginTop = `${Math.max(0, p.spaceBefore)}pt`;
        if (p.spaceAfter !== undefined) b.style.marginBottom = `${Math.max(0, p.spaceAfter)}pt`;
        if (p.firstLine !== undefined) b.style.textIndent = p.firstLine ? `${p.firstLine}in` : '';
        if (p.leftIndent !== undefined) b.style.marginLeft = p.leftIndent ? `${p.leftIndent}in` : '';
      });
      if (blocks.length) { scheduleChange(); layout(); computeState(); }
    },
    changeCase: mode => {
      const d = doc(); if (!d) return;
      restoreSelection();
      const sel = d.getSelection(); if (!sel || !sel.rangeCount || sel.isCollapsed) return;
      const r = sel.getRangeAt(0);
      const walker = d.createTreeWalker(r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentNode! : r.commonAncestorContainer, NodeFilter.SHOW_TEXT);
      let first = true;
      const nodes: Text[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (r.intersectsNode(n)) nodes.push(n as Text);
      nodes.forEach(t => {
        const s = t === r.startContainer ? r.startOffset : 0;
        const e = t === r.endContainer ? r.endOffset : t.data.length;
        if (e <= s) return;
        t.data = t.data.slice(0, s) + caseOf(t.data.slice(s, e), mode, first) + t.data.slice(e);
        first = false;
      });
      scheduleChange(); computeState();
    },
    find: (text, opts) => {
      const d = doc(); if (!d || !text) return 0;
      const flags = opts.matchCase ? 'g' : 'gi';
      const re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      const texts: Text[] = [];
      const w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) texts.push(n as Text);
      let count = 0;
      for (const t of texts) count += (t.data.match(re) || []).length;
      if (opts.replace === undefined) {
        // Select the next match after the caret.
        const sel = d.getSelection()!;
        const from = sel.rangeCount ? sel.getRangeAt(0) : null;
        const hits: Range[] = [];
        for (const t of texts) { re.lastIndex = 0; let m; while ((m = re.exec(t.data))) { const r = d.createRange(); r.setStart(t, m.index); r.setEnd(t, m.index + m[0].length); hits.push(r); } }
        const next = hits.find(h => !from || h.compareBoundaryPoints(Range.START_TO_END, from) > 0) || hits[0];
        if (next) { sel.removeAllRanges(); sel.addRange(next); (next.startContainer.parentElement as HTMLElement)?.scrollIntoView?.({ block: 'center' }); lastRange.current = next.cloneRange(); }
        return count;
      }
      if (opts.all) {
        for (const t of texts) { re.lastIndex = 0; if (re.test(t.data)) { re.lastIndex = 0; t.data = t.data.replace(re, opts.replace); } }
      } else {
        const sel = d.getSelection()!;
        const r = sel.rangeCount ? sel.getRangeAt(0) : null;
        const same = r && !r.collapsed && (opts.matchCase ? r.toString() === text : r.toString().toLowerCase() === text.toLowerCase());
        if (same && r) { r.deleteContents(); r.insertNode(d.createTextNode(opts.replace)); }
      }
      scheduleChange(); computeState();
      return count;
    },
    exec: (cmd, value) => {
      const d = doc(); if (!d) return;
      restoreSelection();
      // Superscript/subscript as real <sup>/<sub> (smaller text, like Word), not a raised span.
      const tag = cmd === 'superscript' || cmd === 'subscript';
      if (tag) { try { d.execCommand('styleWithCSS', false, 'false'); } catch {} }
      d.execCommand(cmd, false, value);
      if (tag) { try { d.execCommand('styleWithCSS', false, 'true'); } catch {} }
      scheduleChange(); computeState();
    },
    setBlock: tag => {
      const d = doc(); if (!d) return;
      restoreSelection();
      d.execCommand('formatBlock', false, `<${tag}>`);
      scheduleChange(); computeState();
    },
    setFontSize: pt => {
      const d = doc(); if (!d) return;
      restoreSelection();
      d.execCommand('fontSize', false, '7');
      d.body.querySelectorAll('font[size="7"]').forEach(el => {
        const span = d.createElement('span');
        span.style.fontSize = pt + 'pt';
        while (el.firstChild) span.appendChild(el.firstChild);
        el.replaceWith(span);
      });
      d.body.querySelectorAll<HTMLElement>('[style*="xxx-large"]').forEach(el => { el.style.fontSize = pt + 'pt'; });
      scheduleChange(); computeState();
    },
    insertHtml: html => {
      const d = doc(); if (!d) return;
      restoreSelection();
      d.execCommand('insertHTML', false, html);
      scheduleChange(); computeState();
    },
    getBody: () => stripPagination((body()?.innerHTML ?? '').replace(/\scontenteditable="false"/g, '')),
    doc: () => doc(),
    setBody: html => { const b = body(); if (b) { b.innerHTML = html || '<p><br></p>'; flowBoxes(doc()!); scheduleChange(); layout(); } },
    getSelectionHtml: () => {
      const d = doc(); const sel = d?.getSelection();
      const range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : lastRange.current;
      if (!d || !range || range.collapsed) return '';
      const div = d.createElement('div'); div.appendChild(range.cloneContents());
      return div.innerHTML;
    },
    getSelectionText: () => {
      const d = doc(); const sel = d?.getSelection();
      const range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : lastRange.current;
      return range && !range.collapsed ? range.toString() : '';
    },
    replaceSelection: html => {
      const d = doc(); if (!d) return;
      restoreSelection();
      d.execCommand('insertHTML', false, html);
      scheduleChange();
    },
    linkSelectionToField: key => {
      const d = doc(); if (!d) return null;
      restoreSelection();
      const sel = d.getSelection();
      if (!sel || sel.isCollapsed) return null;
      const text = sel.toString().replace(/\s+$/, '');
      const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      d.execCommand('insertHTML', false, `<span data-field="${key}">${safe}</span>`);
      scheduleChange();
      return text;
    },
    tableAction: action => {
      const d = doc(); if (!d) return;
      restoreSelection();
      const cell = (d.getSelection()?.anchorNode as Node | null);
      const td = (cell?.nodeType === 1 ? cell as Element : cell?.parentElement)?.closest('td,th') as HTMLTableCellElement | null;
      if (!td) return;
      const row = td.parentElement as HTMLTableRowElement;
      const table = td.closest('table') as HTMLTableElement;
      const index = td.cellIndex;
      if (action === 'row-above' || action === 'row-below') {
        const nr = row.cloneNode(true) as HTMLTableRowElement;
        nr.querySelectorAll('td,th').forEach(c => { c.innerHTML = '<br>'; });
        row.parentElement!.insertBefore(nr, action === 'row-above' ? row : row.nextSibling);
      } else if (action === 'col-left' || action === 'col-right') {
        Array.from(table.rows).forEach(r => {
          const ref = r.cells[Math.min(index, r.cells.length - 1)];
          const c = d.createElement(ref?.tagName.toLowerCase() || 'td'); c.innerHTML = '<br>';
          if (ref) r.insertBefore(c, action === 'col-left' ? ref : ref.nextSibling); else r.appendChild(c);
        });
      } else if (action === 'del-row') {
        row.remove(); if (!table.rows.length) table.remove();
      } else if (action === 'del-col') {
        Array.from(table.rows).forEach(r => r.cells[Math.min(index, r.cells.length - 1)]?.remove());
        if (!table.rows[0]?.cells.length) table.remove();
      } else table.remove();
      scheduleChange();
    },
    root: () => body(),
    focus: () => restoreSelection(),
  }));

  return (
    <div style={zoom !== 1 ? ({ zoom } as React.CSSProperties) : undefined} className={framed ? 'mx-auto w-[210mm]' : 'w-[210mm]'}>
      <div className="[filter:drop-shadow(0_1px_2px_rgb(24_24_27/0.12))_drop-shadow(0_6px_14px_rgb(24_24_27/0.08))]">
        <iframe ref={frame} title="Document editor" className="block w-[210mm] border-0 bg-transparent" style={{ height: '297mm' }} />
      </div>
    </div>
  );
});
