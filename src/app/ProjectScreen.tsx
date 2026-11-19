import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, ChevronDown, Cloud, CloudOff, Code2, Copy, Download, Eye, EyeOff, FileCode2, FileDown, FilePlus2, FileText,
  FileType2, History, LayoutGrid, Loader2, MoreHorizontal, PanelLeft, PanelRight, Pencil, Plus, Printer, RotateCcw, Trash2, Upload, X,
  UnfoldVertical, Square, Underline, PaintBucket, Mic,
} from 'lucide-react';
import { Store } from '../editor/store';
import { DocModel, FONTS, parseDoc, serializeDoc } from '../editor/doc';
import { ACCEPTED_UPLOADS, fileToDoc } from '../editor/importers';
import { MC_SCRIPT, docOrder, mcScriptDoc, shortDocLabel } from '../editor/templates';
import { copyText, downloadDocx, downloadHtml, downloadPdf, ensureDocFonts, printDoc } from '../editor/export';
import { aiProviders, defaultProvider, geminiAvailable, getPasscode, passcodeRequired, setPasscode, translateFields } from '../editor/translate';
import { FIELD, FIELD_DEFS, RETIRED_FIELDS, Guest, ProjectValues, TextKey, slotHtml } from '../editor/values';
import { AutoMode, autoBn, autoGuest, getAutoMode, kindOf, setAutoMode } from '../editor/autoTranslate';
import { applyInlineEdits } from '../editor/inlineEdits';
import { HighlightMode, focusCss, highlightCss as buildHighlightCss } from '../editor/highlight';
import { applyValuesToBody, applyValuesToRoot, cleanEditorHtml, clearOverrides, readInlineEdits, syncEachBlock } from '../editor/bindings';
import { DetectionSummary, detectProject, finalizeBodies } from '../editor/detect';
import { MARGIN_PRESETS, MARGIN_SIDES, clampMargin } from '../utils/pageMargins';
import { StudioError, StudioVersion } from '../utils/studioServer';
import { Badge, Button, Dialog, IconButton, Input, Label, Menu, MenuItem, Segmented, Select, Spinner, cn, relativeTime, useConfirm, useToast, AppZoomControl } from '../ui/ui';
import { EMPTY_STATE, EditorApi, ToolbarState, VisualEditor } from './VisualEditor';
import { Toolbar } from './Toolbar';
import { DuplicateProjectDialog, Logo, RenameDialog } from './HomeScreen';
import { DETECT_FLAG, blankDoc, projectNameTaken, uniqueName } from './projects';
import { useProject } from './useProject';
import { GlobalFieldsPanel } from './GlobalFieldsPanel';
import { CanvasApi, CanvasView } from './CanvasView';
import { MarginControl } from './MarginControl';
import { PrintPreview } from './PrintPreview';
import { HtmlPanel } from './HtmlPanel';
import { sanitizeEditorHtml } from '../editor/sanitize';
import { DetectDialog } from './DetectDialog';

const prettyHtml = (html: string) => html
  .replace(/>\s*(<(?:p|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|hr|div|figure|pre)\b)/g, '>\n$1')
  .replace(/(<\/(?:p|h[1-6]|ul|ol|table|thead|tbody|tr|blockquote|div|figure|pre)>)(?!\n)/g, '$1\n');


export function ProjectScreen({ store, project, file, onNavigate, onClose }: { store: Store; project: string; file?: string; onNavigate: (file?: string) => void; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const p = useProject(store, project);
  const docs = p.docs;
  const view: 'canvas' | 'doc' = file ? 'doc' : 'canvas';
  const [focusFile, setFocusFile] = useState<string | null>(null);
  const active = useMemo(() => (docs || []).find(d => d.file === (file || focusFile)) || (!file ? (docs || [])[0] : undefined), [docs, file, focusFile]);
  const activeFile = active?.file;
  const editor = useRef<EditorApi>(null);
  const [tbState, setTbState] = useState<ToolbarState>(EMPTY_STATE);
  const [mode, setMode] = useState<'visual' | 'code'>('visual');
  const [code, setCode] = useState('');
  const [codeDirty, setCodeDirty] = useState(false);
  const codeRef = useRef<HTMLTextAreaElement>(null);
  const [reload, setReload] = useState(0);
  const [fieldsOpen, setFieldsOpen] = useState(true);
  const [docPanel, setDocPanel] = useState<'page' | 'history' | null>(null);
  const [showFields, setShowFields] = useState(true);
  const [preview, setPreview] = useState(false);
  const [htmlOpen, setHtmlOpen] = useState(false);
  const codeDocs = useMemo(() => (p.docs || []).map(d => ({ file: d.file, label: shortDocLabel(d.file), model: d.model })), [p.docs]);
  const [zoomPref, setZoomPref] = useState<'fit' | number>('fit');
  const [canvasWidth, setCanvasWidth] = useState(1000);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renameDoc, setRenameDoc] = useState<string | null>(null);
  const [renameProject, setRenameProject] = useState(false);
  const [dupTaken, setDupTaken] = useState<string[] | null>(null);
  const openDuplicate = async () => {
    await p.saveAll();
    const items = await store.list();
    setDupTaken(items.filter(i => i.type === 'folder' && !i.path.includes('/')).map(i => i.path));
  };
  const [passOpen, setPassOpen] = useState<null | (() => void)>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadMode = useRef<{ kind: 'add' } | { kind: 'replace'; file: string }>({ kind: 'add' });
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<{ key: string; n: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detection, setDetection] = useState<DetectionSummary | null>(null);
  const gemini = geminiAvailable();
  const [hlMode, setHlModeState] = useState<HighlightMode>(() => { try { const m = localStorage.getItem('savor-studio-hl-mode'); if (m === 'outline' || m === 'underline' || m === 'fill') return m; } catch {} return 'outline'; });
  const setHlMode = (m: HighlightMode) => { setHlModeState(m); try { localStorage.setItem('savor-studio-hl-mode', m); } catch {} };
  const baseHighlight = useMemo(() => buildHighlightCss('body.sv-doc ', hlMode), [hlMode]);
  // View-only line spacing for the canvas: never saved into the documents.
  const [lineView, setLineViewState] = useState<{ on: boolean; value: number }>(() => {
    try { const v = JSON.parse(localStorage.getItem('savor-studio-line-view') || ''); if (typeof v?.on === 'boolean' && v.value > 0) return v; } catch {}
    return { on: false, value: 1.8 };
  });
  const setLineView = (v: { on: boolean; value: number }) => { setLineViewState(v); try { localStorage.setItem('savor-studio-line-view', JSON.stringify(v)); } catch {} };
  const lineCss = lineView.on ? `body.sv-doc, body.sv-doc *:not(sup):not(sub) { line-height: ${lineView.value} !important; }` : '';
  const highlightCss = baseHighlight + '\n' + focusCss(hoverKey, selectedKey, 'body.sv-doc ', hlMode) + '\n' + lineCss;
  const editors = useRef<Record<string, EditorApi | null>>({});
  const allMargins = () => {
    const list = docs || [];
    if (!list.length) return null;
    const a = list[0].model.margins;
    return list.every(d => (['top', 'right', 'bottom', 'left'] as const).every(k => d.model.margins[k] === a[k])) ? a : null;
  };
  const marginsForAll = (
    <MarginControl value={allMargins()} align="end" title="Margins · all documents"
      onChange={fn => (docs || []).forEach(d => p.updateModel(d.file, m => ({ ...m, margins: fn(m.margins) })))} />
  );
  const canvasApi = useRef<CanvasApi>(null);
  const [autoMode, setAutoModeState] = useState<AutoMode>(getAutoMode);
  const [aiError, setAiError] = useState('');
  const providers = aiProviders();
  const changeAutoMode = (m: AutoMode) => { setAutoMode(m); setAutoModeState(m); aiSent.current = null; };

  useEffect(() => { ensureDocFonts(); }, []);

  /* ---------- Live editor documents ---------- */
  const docFiles = (docs || []).map(d => d.file).join('|');
  useEffect(() => {
    const map = p.live.current;
    map.clear();
    const register = (f: string) => map.set(f, { file: f, root: () => editors.current[f]?.root() || null, getBody: () => editors.current[f]?.getBody() || '' });
    if (view === 'canvas') (docs || []).forEach(d => register(d.file));
    else if (mode === 'visual' && activeFile) register(activeFile);
    return () => map.clear();
  }, [view, mode, activeFile, docFiles]);

  const flushEditor = () => {
    for (const [f, api] of Object.entries(editors.current)) {
      if (!api || !p.live.current.has(f)) continue;
      const body = api.getBody();
      p.updateModel(f, m => (m.body === body ? m : { ...m, body }));
    }
  };

  /** Text typed into any page becomes the shared value and updates every other page. */
  const onEditorChange = (f: string, body: string) => {
    const doc = p.docsRef.current.find(d => d.file === f);
    if (!doc) return;
    const root = editors.current[f]?.root();
    // Per-guest blocks (MC script): new wording in the first copy is copied to every guest.
    if (root) {
      let synced = false;
      root.querySelectorAll<HTMLElement>('[data-each]').forEach(el => { if (syncEachBlock(el, doc.model.lang, p.valuesRef.current, true)) synced = true; });
      if (synced) body = cleanEditorHtml(editors.current[f]!.getBody());
    }
    p.updateModel(f, m => (m.body === body ? m : { ...m, body }));
    if (!root) return;
    const edits = readInlineEdits(root, doc.model.lang, p.valuesRef.current);
    if (!edits.length) return;
    let keys: string[] = [];
    p.setValues(cur => { const r = applyInlineEdits(cur, edits, doc.model.lang); keys = r.keys; return r.next; }, ['specialGuests', 'chiefGuest', ...edits.map(e => ('key' in e ? e.key : 'specialGuests'))]);
  };

  // Changes made elsewhere (e.g. by the AI connector) were loaded: say so.
  useEffect(() => {
    if (!p.remote.n) return;
    toast('Updated from elsewhere', { description: p.remote.files.map(f => (f.endsWith('.html') ? shortDocLabel(f) : f)).join(', ') });
  }, [p.remote.n]);

  /** Bodies edited in the HTML panel: show them in the pages and pick up changed shared values. */
  const applyHtml = (changes: { file: string; body: string }[]) => {
    for (const c of changes) {
      const doc = p.docsRef.current.find(d => d.file === c.file);
      if (!doc) continue;
      const body = sanitizeEditorHtml(c.body) || '<p><br></p>';
      const ed = editors.current[c.file];
      if (ed) { ed.setBody(body); onEditorChange(c.file, ed.getBody()); continue; }
      p.updateModel(c.file, m => ({ ...m, body }));
      const root = document.createElement('div'); root.innerHTML = body;
      const edits = readInlineEdits(root, doc.model.lang, p.valuesRef.current);
      if (edits.length) p.setValues(cur => applyInlineEdits(cur, edits, doc.model.lang).next, ['specialGuests', 'chiefGuest', ...edits.map(e => ('key' in e ? e.key : 'specialGuests'))]);
    }
  };

  const activate = (f: string) => {
    if (focusFile !== f) setFocusFile(f);
    (editor as React.MutableRefObject<EditorApi | null>).current = editors.current[f] || null;
  };

  /* ---------- Auto-detect on first open ---------- */
  const autoDetected = useRef(false);
  useEffect(() => {
    if (!docs || autoDetected.current || !docs.length) return;
    autoDetected.current = true;
    let flagged = false;
    try { flagged = sessionStorage.getItem(DETECT_FLAG + project) === '1'; sessionStorage.removeItem(DETECT_FLAG + project); } catch {}
    const linked = docs.some(d => d.model.body.includes('data-field'));
    if (flagged || (!p.hasValuesFile && !linked)) runDetect(true);
  }, [docs]);

  const runDetect = (silentIfNothing = false) => {
    flushEditor();
    setTimeout(() => {
      const list = p.docsRef.current.map(d => ({ file: d.file, lang: d.model.lang, body: d.model.body }));
      const summary = detectProject(list);
      const n = Object.keys(summary.counts).length;
      if (!n) { if (!silentIfNothing) toast('No shared fields found', { tone: 'info', description: 'Select text in a document and use Field in the toolbar to link it.' }); return; }
      setDetection(summary);
    }, 0);
  };

  const applyDetection = (keep: Set<string>) => {
    if (!detection) return;
    const bodies = finalizeBodies(detection.bodies, keep);
    const cur = p.valuesRef.current, d = detection.values;
    const merged: ProjectValues = {
      ...cur,
      edition: d.edition ?? cur.edition, year: d.year ?? cur.year, hall: d.hall ?? cur.hall,
      eventDate: d.eventDate ?? cur.eventDate, endDate: d.endDate ?? cur.endDate, issueDate: d.issueDate ?? cur.issueDate, eventTime: d.eventTime ?? cur.eventTime,
      contactPhone: d.contactPhone || cur.contactPhone,
      text: { ...cur.text, ...d.text },
      chiefGuest: d.chiefGuest || cur.chiefGuest,
      specialGuests: d.specialGuests.length ? d.specialGuests : cur.specialGuests,
    };
    p.replaceAll(merged, bodies);
    setDetection(null);
    setReload(r => r + 1);
    toast(`Linked ${Object.keys(detection.counts).length} shared fields`, { description: 'Edit them in the Shared fields panel — every document updates.' });
  };

  /* ---------- Field focus from pages ---------- */
  const panelKeyFor = (key: string) => {
    if (key.startsWith('specialGuests:')) return key;
    return key;
  };
  const onFieldClick = (key: string, override = false, docFile?: string) => {
    setFieldsOpen(true);
    setSelectedKey(key);
    setFocusKey(f => ({ key: panelKeyFor(key), n: (f?.n || 0) + 1 }));
    if (override && docFile) {
      toast('This place keeps its own text', {
        tone: 'info', description: `${FIELD.get(key.split(':')[0])?.label || key} in ${shortDocLabel(docFile)} doesn't follow the shared value.`,
        action: { label: 'Use shared value', onClick: () => { p.updateModel(docFile, m => ({ ...m, body: clearOverrides(m.body, key.split(':')[0]) })); p.setValues(v => ({ ...v }), [key]); setReload(r => r + 1); } },
      });
    }
  };

  /* ---------- Translate selected ---------- */
  const withPasscode = (run: () => void) => { if (passcodeRequired() && !getPasscode()) setPassOpen(() => run); else run(); };
  const aiLabel = (id: string) => providers.find(x => x.id === id)?.label || 'AI';
  const geminiError = (e: any, provider = '') => {
    if (e instanceof StudioError && e.status === 401) { setPasscode(''); toast('Translation passcode is incorrect', { tone: 'error' }); return; }
    setAiError(e?.message || 'Translation failed.');
    toast(`${aiLabel(provider)} translation failed`, { tone: 'error', description: e?.message });
  };

  /** Every translatable value (used when nothing is ticked). */
  const allTranslatableKeys = () => {
    const v = p.valuesRef.current;
    return [
      ...(Object.keys(v.text) as TextKey[]).filter(k => v.text[k]?.en && !v.text[k]?.noTranslate && !RETIRED_FIELDS.has(k)).map(k => 'text:' + k),
      ...(v.chiefGuest && !v.chiefGuest.noTranslate ? ['guest:chief'] : []),
      ...v.specialGuests.filter(g => !g.noTranslate).map(g => 'guest:' + g.id),
    ];
  };

  const translateSelected = (engine: string) => {
    // "Don't translate" values are never translated, even when ticked.
    const allowed = new Set(allTranslatableKeys());
    const keys = (selected.size ? [...selected] : [...allowed]).filter(k => allowed.has(k));
    if (!keys.length) { toast('Nothing to translate yet', { tone: 'info' }); return; }
    if (engine === 'offline') {
      p.setValues(cur => {
        const next: ProjectValues = { ...cur, text: { ...cur.text } };
        for (const k of keys) {
          if (k.startsWith('text:')) { const key = k.slice(5) as TextKey; const t = cur.text[key]; if (t?.en) next.text[key] = { en: t.en, bn: autoBn(t.en, kindOf(key), key), bnCustom: false }; }
          if (k === 'guest:chief' && cur.chiefGuest) next.chiefGuest = autoGuest(cur.chiefGuest, true);
        }
        next.specialGuests = cur.specialGuests.map(g => (keys.includes('guest:' + g.id) ? autoGuest(g, true) : g));
        return next;
      }, ['specialGuests', 'chiefGuest', ...keys.filter(k => k.startsWith('text:')).map(k => k.slice(5))]);
      toast(`Translated ${keys.length} field${keys.length > 1 ? 's' : ''} offline`, { description: 'Check names and designations before publishing.' });
      return;
    }
    withPasscode(async () => {
      const v = p.valuesRef.current;
      const items: { id: string; text: string }[] = [];
      const guestOf = (k: string): Guest | null => (k === 'guest:chief' ? v.chiefGuest : v.specialGuests.find(g => 'guest:' + g.id === k) || null);
      for (const k of keys) {
        if (k.startsWith('text:')) { const t = v.text[k.slice(5) as TextKey]; if (t?.en) items.push({ id: k, text: t.en }); }
        else { const g = guestOf(k); if (g) { if (g.name.en) items.push({ id: k + '|name', text: g.name.en }); if (g.designation.en) items.push({ id: k + '|designation', text: g.designation.en }); } }
      }
      if (!items.length) { toast('Nothing to translate — fill in the English first', { tone: 'info' }); return; }
      setBusy('translate');
      try {
        const out = await translateFields(items.map(i => ({ id: i.id.replace(/[^\w.-]/g, '_'), text: i.text })), engine);
        setAiError('');
        const res = (id: string) => out[id.replace(/[^\w.-]/g, '_')];
        p.setValues(cur => {
          const next: ProjectValues = { ...cur, text: { ...cur.text } };
          const fixGuest = (g: Guest, k: string): Guest => {
            const base = autoGuest(g, true);
            const n = res(k + '|name'), d = res(k + '|designation');
            return { ...base, name: n ? { ...base.name, bn: n, bnCustom: false } : base.name, designation: d ? { ...base.designation, bn: d, bnCustom: false } : base.designation };
          };
          for (const k of keys) {
            if (k.startsWith('text:')) { const key = k.slice(5) as TextKey; const r = res(k); if (r && cur.text[key]) next.text[key] = { ...cur.text[key]!, bn: r, bnCustom: false }; }
            if (k === 'guest:chief' && cur.chiefGuest) next.chiefGuest = fixGuest(cur.chiefGuest, k);
          }
          next.specialGuests = cur.specialGuests.map(g => (keys.includes('guest:' + g.id) ? fixGuest(g, 'guest:' + g.id) : g));
          return next;
        }, ['specialGuests', 'chiefGuest', ...keys.filter(k => k.startsWith('text:')).map(k => k.slice(5))]);
        toast(`${aiLabel(engine)} translated ${keys.length} field${keys.length > 1 ? 's' : ''}`, { description: 'Review names and designations before publishing.' });
      } catch (e) { geminiError(e, engine); } finally { setBusy(null); }
    });
  };

  /* ---------- Auto-translate with AI while typing ---------- */
  const aiSent = useRef<Record<string, string> | null>(null);
  const aiTimer = useRef<number | undefined>(undefined);
  const autoItems = (v: ProjectValues) => {
    const items: Record<string, string> = {};
    for (const k of Object.keys(v.text) as TextKey[]) { const t = v.text[k]; if (t?.en && !t.bnCustom && !t.noTranslate && !RETIRED_FIELDS.has(k)) items['t.' + k] = t.en; }
    const guests: [string, Guest | null][] = [['chief', v.chiefGuest], ...v.specialGuests.map(g => [g.id, g] as [string, Guest])];
    for (const [id, g] of guests) {
      if (!g || g.noTranslate) continue;
      if (g.name.en && !g.name.bnCustom) items[`g.${id}.name`] = g.name.en;
      if (g.designation.en && !g.designation.bnCustom) items[`g.${id}.designation`] = g.designation.en;
    }
    return items;
  };
  useEffect(() => {
    const aiOn = autoMode.on && autoMode.engine !== 'offline' && providers.some(x => x.id === autoMode.engine);
    if (!docs) { aiSent.current = null; return; }
    const items = autoItems(p.values);
    if (!aiOn || aiSent.current === null) { aiSent.current = items; return; } // start from what's there now
    const changed = Object.entries(items).filter(([id, en]) => aiSent.current![id] !== en);
    if (!changed.length) return;
    window.clearTimeout(aiTimer.current);
    aiTimer.current = window.setTimeout(async () => {
      const batch = changed.map(([id, text]) => ({ id: id.replace(/[^\w.-]/g, '_'), text }));
      changed.forEach(([id, en]) => { aiSent.current![id] = en; });
      try {
        const out = await translateFields(batch, autoMode.engine);
        setAiError('');
        p.setValues(cur => {
          const now = autoItems(cur);
          const next: ProjectValues = { ...cur, text: { ...cur.text } };
          const fix = (id: string) => { const r = out[id.replace(/[^\w.-]/g, '_')]; return r && now[id] === aiSent.current![id] ? r : null; };
          for (const k of Object.keys(cur.text) as TextKey[]) { const r = fix('t.' + k); if (r) next.text[k] = { ...cur.text[k]!, bn: r, bnCustom: false }; }
          const g2 = (g: Guest, id: string): Guest => {
            const n = fix(`g.${id}.name`), d = fix(`g.${id}.designation`);
            return n || d ? { ...g, name: n ? { ...g.name, bn: n, bnCustom: false } : g.name, designation: d ? { ...g.designation, bn: d, bnCustom: false } : g.designation } : g;
          };
          if (cur.chiefGuest) next.chiefGuest = g2(cur.chiefGuest, 'chief');
          next.specialGuests = cur.specialGuests.map(g => g2(g, g.id));
          return next;
        }, ['specialGuests', 'chiefGuest']);
      } catch (e: any) { setAiError(e?.message || 'Auto-translate failed.'); }
    }, 1400);
  }, [p.values, autoMode.on, autoMode.engine, docs === null]);

  /* ---------- Editor helpers ---------- */
  useEffect(() => {
    const el = canvasRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setCanvasWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view, docs !== null]);
  const zoom = zoomPref === 'fit' ? Math.max(0.4, Math.min(1.25, (canvasWidth - 64) / 794)) : zoomPref;

  const switchTo = (f?: string) => {
    if (f === file) return;
    if (mode === 'code') applyCode();
    else flushEditor();
    setMode('visual');
    onNavigate(f);
  };

  const enterCode = () => {
    if (!active) return;
    const body = editor.current?.getBody() ?? active.model.body;
    p.updateModel(active.file, m => (m.body === body ? m : { ...m, body }));
    setCode(serializeDoc({ ...active.model, body: prettyHtml(body) }));
    setCodeDirty(false);
    setMode('code');
    requestAnimationFrame(() => {
      const t = codeRef.current; if (!t) return;
      const i = t.value.indexOf('<body'); if (i < 0) return;
      t.focus(); t.setSelectionRange(i, i);
      t.scrollTop = Math.max(0, (t.value.slice(0, i).split('\n').length - 1) * 20.6 - 40);
    });
  };
  const applyCode = () => {
    if (!active || !codeDirty) return;
    p.updateModel(active.file, () => parseDoc(code, active.model.title));
    setCodeDirty(false);
    setReload(r => r + 1);
  };
  const changeMode = (m: 'visual' | 'code') => { if (m === mode) return; if (m === 'code') enterCode(); else { applyCode(); setMode('visual'); } };

  const fieldMenu = (hasSelection: boolean): MenuItem[] => {
    if (!active) return [];
    const lang = active.model.lang;
    const textual = FIELD_DEFS.filter(f => f.type === 'text' || f.type === 'phone');
    return hasSelection ? [
      { label: 'Link selected text to…', heading: true },
      ...textual.map(f => ({ label: f.label, onSelect: () => { editor.current?.linkSelectionToField(f.key); } })),
    ] : [
      { label: 'Insert shared field', heading: true },
      ...FIELD_DEFS.map(f => ({
        label: f.label,
        onSelect: () => {
          const fmt = f.type === 'date' ? ' data-fmt="D MMMM, YYYY"' : f.type === 'time' ? ` data-fmt="${lang === 'bn' ? 'P h.mm ঘটিকায়' : 'h:mm A'}"` : f.type === 'hall' ? ` data-fmt="${lang === 'bn' ? 'হল-{nn}' : 'Hall-{nn}'}"` : f.type === 'ordinal' ? ' data-fmt="ordinal"' : '';
          editor.current?.insertHtml(`<span data-field="${f.key}"${fmt}>${slotHtml(p.valuesRef.current, f.key, lang, { fmt: fmt ? fmt.match(/"(.*)"/)?.[1] : undefined })}</span>&nbsp;`);
        },
      })),
    ];
  };

  /* ---------- Documents ---------- */
  const replaceModel = (f: string, model: DocModel) => { p.updateModel(f, () => model); if (f === activeFile) setReload(r => r + 1); };

  const onUpload = async (list: FileList | null) => {
    if (!list?.length) return;
    const target = uploadMode.current;
    setBusy('upload');
    try {
      if (target.kind === 'replace') {
        replaceModel(target.file, await fileToDoc(list[0]));
        toast(`Replaced with “${list[0].name}”`, { action: { label: 'Find fields', onClick: () => runDetect() } });
      } else {
        let first = '';
        for (const f of Array.from(list)) {
          const model = await fileToDoc(f);
          const name = uniqueName(f.name.replace(/\.[^.]+$/, ''), p.docsRef.current.map(d => d.file.replace(/\.html$/i, '')), '.html');
          const r = await store.save(p.pathOf(name), serializeDoc(model), null, 'create');
          p.setDocs(prev => [...(prev || []), { file: name, model, etag: r.etag, dirty: false, status: 'saved', savedAt: Date.now() }]);
          first ||= name;
        }
        toast(list.length > 1 ? `Added ${list.length} documents` : `Added “${list[0].name}”`, { action: { label: 'Find fields', onClick: () => runDetect() } });
        if (first && view === 'doc') switchTo(first);
      }
    } catch (e: any) { toast('Upload failed', { tone: 'error', description: e?.message }); }
    finally { setBusy(null); }
  };

  const addBlank = async (lang: 'bn' | 'en') => {
    const name = uniqueName(lang === 'bn' ? 'নতুন ডকুমেন্ট' : 'New document', p.docsRef.current.map(d => d.file.replace(/\.html$/i, '')), '.html');
    const model = blankDoc(lang);
    try {
      const r = await store.save(p.pathOf(name), serializeDoc(model), null, 'create');
      p.setDocs(prev => [...(prev || []), { file: name, model, etag: r.etag, dirty: false, status: 'saved', savedAt: Date.now() }]);
      switchTo(name);
    } catch (e: any) { toast('Could not add document', { tone: 'error', description: e?.message }); }
  };

  /** The MC script of the inauguration: guests, host and chief guest come from the shared values. */
  const addMcScript = async () => {
    const name = uniqueName(MC_SCRIPT.file.replace(/\.html$/i, ''), p.docsRef.current.map(d => d.file.replace(/\.html$/i, '')), '.html');
    const model = mcScriptDoc();
    model.body = applyValuesToBody(model.body, model.lang, p.valuesRef.current);
    try {
      const r = await store.save(p.pathOf(name), serializeDoc(model), null, 'create');
      p.setDocs(prev => [...(prev || []), { file: name, model, etag: r.etag, dirty: false, status: 'saved', savedAt: Date.now() }]);
      switchTo(name);
      toast('MC Script added', { description: 'Speeches and crests follow the special guests. Pick the host (welcome speech) on a guest card.' });
    } catch (e: any) { toast('Could not add MC Script', { tone: 'error', description: e?.message }); }
  };

  const deleteDoc = async (f: string) => {
    if (!(await confirm({ title: `Delete “${f.replace(/\.html$/i, '')}”?`, description: store.kind === 'server' ? 'It moves to the server trash for 30 days.' : 'It will be removed from this browser.', confirm: 'Delete', danger: true }))) return;
    try {
      await store.remove(p.pathOf(f));
      p.setDocs(prev => (prev || []).filter(d => d.file !== f));
      if (f === activeFile) onNavigate(undefined);
      toast('Document deleted');
    } catch (e: any) { toast('Could not delete', { tone: 'error', description: e?.message }); }
  };

  /* ---------- Versions ---------- */
  const [versions, setVersions] = useState<StudioVersion[] | null>(null);
  useEffect(() => {
    if (docPanel !== 'history' || !activeFile) return;
    setVersions(null);
    store.versions(p.pathOf(activeFile)).then(setVersions).catch(() => setVersions([]));
  }, [docPanel, activeFile]);
  const restoreVersion = async (id: string) => {
    if (!activeFile || !active) return;
    if (!(await confirm({ title: 'Restore this version?', description: 'The current content is kept as a version too, so you can switch back.', confirm: 'Restore' }))) return;
    try { replaceModel(activeFile, parseDoc(await store.version(p.pathOf(activeFile), id), active.model.title)); toast('Version restored'); }
    catch (e: any) { toast('Could not restore', { tone: 'error', description: e?.message }); }
  };

  /* ---------- Export ---------- */
  const modelOf = (f: string): DocModel | null => {
    const d = p.docsRef.current.find(x => x.file === f);
    if (!d) return null;
    if (f === activeFile && view === 'doc') {
      if (mode === 'code') { try { return parseDoc(code, d.model.title); } catch { return d.model; } }
      return { ...d.model, body: editor.current?.getBody() ?? d.model.body };
    }
    return d.model;
  };
  const runExport = async (kind: 'html' | 'docx' | 'pdf' | 'print' | 'copy', files: string[]) => {
    setBusy('export');
    try {
      for (const f of files) {
        const m = modelOf(f); if (!m) continue;
        if (kind === 'html') downloadHtml(m);
        else if (kind === 'docx') await downloadDocx(m);
        else if (kind === 'pdf') await downloadPdf(m);
        else if (kind === 'print') await printDoc(m);
        else { await copyText(serializeDoc(m)); toast('HTML copied to clipboard'); }
        if (files.length > 1) await new Promise(r => setTimeout(r, 400));
      }
    } catch (e: any) { toast('Export failed', { tone: 'error', description: e?.message }); }
    finally { setBusy(null); }
  };
  const allFiles = (docs || []).map(d => d.file);
  const exportItems: MenuItem[] = [
    ...(active ? [
      { label: shortDocLabel(active.file), heading: true },
      { label: 'Download PDF', icon: <FileDown />, onSelect: () => void runExport('pdf', [active.file]) },
      { label: 'Download Word (.docx)', icon: <FileType2 />, onSelect: () => void runExport('docx', [active.file]) },
      { label: 'Download HTML', icon: <FileCode2 />, onSelect: () => void runExport('html', [active.file]) },
      { label: 'Print / Save as PDF', icon: <Printer />, hint: 'best quality', onSelect: () => void runExport('print', [active.file]) },
      { label: 'Copy HTML code', icon: <Copy />, onSelect: () => void runExport('copy', [active.file]) },
      { separator: true, label: '' },
    ] as MenuItem[] : []),
    { label: `All ${allFiles.length} documents`, heading: true },
    { label: 'Download all as PDF', icon: <FileDown />, onSelect: () => void runExport('pdf', allFiles) },
    { label: 'Download all as Word', icon: <FileType2 />, onSelect: () => void runExport('docx', allFiles) },
    { label: 'Download all as HTML', icon: <FileCode2 />, onSelect: () => void runExport('html', allFiles) },
  ];

  /* ---------- Keyboard ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void p.saveAll().then(ok => ok && toast('All changes saved')); }
      if (e.key === 'Escape' && selectedKey && !document.querySelector('[role=dialog]')) setSelectedKey(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ---------- Status ---------- */
  const conflictDoc = (docs || []).find(d => d.status === 'conflict');
  const errorDoc = (docs || []).find(d => d.status === 'error');
  const statusEl = p.status === 'conflict' && conflictDoc ? (
    <span className="flex items-center gap-1.5 text-[13px] text-amber-700"><AlertTriangle className="size-4" />Changed elsewhere
      <Menu width="w-64" items={[
        { label: 'Load the other version', icon: <RotateCcw />, onSelect: async () => { const r = await store.read(p.pathOf(conflictDoc.file)); p.patch(conflictDoc.file, d => ({ ...d, model: parseDoc(r.content, d.model.title), etag: r.etag, dirty: false, status: 'saved' })); if (conflictDoc.file === activeFile) setReload(x => x + 1); } },
        { label: 'Keep mine (overwrite)', icon: <Check />, onSelect: () => void p.save(conflictDoc.file, true) },
      ]} trigger={t => <Button size="sm" variant="ghost" {...t}>Resolve<ChevronDown className="size-3.5" /></Button>} />
    </span>
  ) : p.status === 'error' ? (
    <span className="flex items-center gap-1.5 text-[13px] text-red-600" title={errorDoc?.error}><CloudOff className="size-4" />Not saved<Button size="sm" variant="ghost" onClick={() => void p.saveAll()}>Retry</Button></span>
  ) : p.status === 'saving' ? <span className="flex items-center gap-1.5 text-[13px] text-zinc-500"><Loader2 className="size-4 animate-spin" />Saving…</span>
    : p.status === 'pending' ? <span className="flex items-center gap-1.5 text-[13px] text-zinc-500"><Cloud className="size-4" />Unsaved changes</span>
      : <span className="flex items-center gap-1.5 text-[13px] text-zinc-500"><Cloud className="size-4 text-emerald-600" />Saved{p.lastSaved ? <span className="hidden text-zinc-400 xl:inline">· {relativeTime(p.lastSaved / 1000)}</span> : null}</span>;

  /* ---------- Render ---------- */
  if (!docs) return <div className="flex h-full items-center justify-center"><Spinner className="size-6" /></div>;
  if (p.loadError) return (
    <div className="mx-auto mt-24 max-w-md rounded-xl border border-red-200 bg-white p-6 text-center shadow-soft">
      <AlertTriangle className="mx-auto size-6 text-red-500" /><p className="mt-2 font-medium">{p.loadError}</p>
      <div className="mt-4 flex justify-center gap-2"><Button onClick={onClose}>Back to projects</Button><Button variant="primary" onClick={p.load}>Try again</Button></div>
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-zinc-100">
      {/* App bar */}
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-zinc-200 bg-white px-2">
        <IconButton label="All projects" onClick={async () => { flushEditor(); if (mode === 'code') applyCode(); await p.saveAll(); onClose(); }}><ArrowLeft className="size-4" /></IconButton>
        <div className="hidden sm:block"><Logo compact /></div>
        <Menu width="w-52" items={[
          { label: 'Rename project', icon: <Pencil />, onSelect: () => setRenameProject(true) },
          { label: 'Duplicate project…', icon: <Copy />, onSelect: () => void openDuplicate() },
        ]} trigger={t => (
          <button {...t} className="flex max-w-[24vw] items-center gap-1 rounded-md px-1.5 py-0.5 text-[14px] font-semibold text-zinc-900 hover:bg-zinc-100">
            <span className="truncate">{project}</span><ChevronDown className="size-4 shrink-0 text-zinc-400" />
          </button>
        )} />
        <div className="ml-1 hidden md:block">{statusEl}</div>
        <div className="ml-auto flex items-center gap-1">
          <AppZoomControl className="mr-1" />
          <Segmented label="View" value={view === 'canvas' ? 'canvas' : 'doc'} onChange={v => v === 'canvas' ? switchTo(undefined) : switchTo(activeFile || docs[0]?.file)} options={[
            { value: 'canvas', label: <><LayoutGrid className="size-3.5" /><span className="hidden lg:inline">All pages</span></>, title: 'See all four documents together' },
            { value: 'doc', label: <><Pencil className="size-3.5" /><span className="hidden lg:inline">Edit</span></>, title: 'Edit one document' },
          ]} />
          {view === 'doc' && <Segmented label="Editor mode" value={mode} onChange={changeMode} options={[
            { value: 'visual', label: <span className="text-[12px]">Visual</span>, title: 'Visual editor' },
            { value: 'code', label: <><Code2 className="size-3.5" /><span className="hidden lg:inline text-[12px]">HTML</span></>, title: 'Edit HTML code' },
          ]} />}
          <IconButton label={preview ? 'Close print preview' : 'Print preview (A4)'} active={preview} onClick={() => setPreview(v => !v)}><Printer className="size-4" /></IconButton>
          <IconButton label={showFields ? 'Hide field highlights' : 'Show field highlights'} active={showFields} onClick={() => setShowFields(s => !s)}>{showFields ? <Eye className="size-4" /> : <EyeOff className="size-4" />}</IconButton>
          <Menu align="end" width="w-64" items={exportItems} trigger={t => <Button size="sm" variant="primary" loading={busy === 'export'} {...t}><Download className="size-4" /><span className="hidden sm:inline">Export</span></Button>} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Shared fields */}
        {fieldsOpen ? (
          <aside className="flex w-[350px] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 max-md:absolute max-md:bottom-0 max-md:left-0 max-md:top-10 max-md:z-30 max-md:shadow-pop max-lg:w-[320px]">
            <div className="flex justify-end px-1 lg:hidden"><IconButton label="Close shared fields" onClick={() => setFieldsOpen(false)}><X className="size-4" /></IconButton></div>
            <div className="min-h-0 flex-1">
            <GlobalFieldsPanel p={p} selected={selected} setSelected={setSelected} hoverKey={hoverKey} onHover={setHoverKey}
              focusKey={focusKey} onTranslate={translateSelected} providers={providers} translating={busy === 'translate'} onDetect={() => runDetect()}
              autoMode={autoMode} onAutoMode={changeAutoMode} aiError={aiError} onDismissError={() => setAiError('')}
              htmlOpen={htmlOpen} onToggleHtml={() => setHtmlOpen(o => !o)} onHide={() => setFieldsOpen(false)} />
            </div>
          </aside>
        ) : (
          <button onClick={() => setFieldsOpen(true)} title="Show shared fields" className="flex w-8 shrink-0 flex-col items-center gap-2 border-r border-zinc-200 bg-zinc-50 pt-2 text-zinc-500 hover:bg-zinc-100">
            <PanelLeft className="size-4" /><span className="text-[11px] font-medium [writing-mode:vertical-rl]">Shared fields</span>
          </button>
        )}

        {htmlOpen && fieldsOpen && docs.length > 0 && (
          <HtmlPanel docs={codeDocs} values={p.values}
            onApply={applyHtml} onClose={() => setHtmlOpen(false)} />
        )}

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col">
          {view === 'canvas' ? (
            docs.length ? (
              <>
                <Toolbar api={editor} state={tbState} disabled={busy === 'upload'} fieldMenu={fieldMenu} extra={marginsForAll} />
                <div className="min-h-0 flex-1">
                  <CanvasView ref={canvasApi} controls={
                    <>
                    <div role="radiogroup" aria-label="How linked values are marked" className="flex items-center gap-0.5 pl-1">
                      {([['outline', 'Thin border', Square], ['underline', 'Thick underline', Underline], ['fill', 'Light background', PaintBucket]] as const).map(([m, label, Icon]) => (
                        <button key={m} role="radio" aria-checked={hlMode === m} aria-label={label} title={`Mark linked values: ${label.toLowerCase()}`} onClick={() => setHlMode(m)}
                          className={cn('grid size-7 place-items-center rounded-md', hlMode === m ? 'bg-indigo-50 text-indigo-700' : 'text-zinc-500 hover:bg-zinc-100')}>
                          <Icon className="size-4" />
                        </button>
                      ))}
                    </div>
                    <span className="mx-1 h-5 w-px bg-zinc-200" />
                    <div className="flex items-center gap-1" title="Line spacing on the canvas only — your documents are not changed">
                      <button role="switch" aria-checked={lineView.on} aria-label="Canvas line spacing" onClick={() => setLineView({ ...lineView, on: !lineView.on })}
                        className={cn('flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12.5px]', lineView.on ? 'bg-indigo-50 text-indigo-700' : 'text-zinc-600 hover:bg-zinc-100')}>
                        <UnfoldVertical className="size-4" />
                        <span className={cn('relative h-3.5 w-6 rounded-full transition-colors', lineView.on ? 'bg-indigo-600' : 'bg-zinc-300')}>
                          <span className={cn('absolute top-0.5 size-2.5 rounded-full bg-white transition-all', lineView.on ? 'left-3' : 'left-0.5')} />
                        </span>
                      </button>
                      <input type="number" aria-label="Canvas line height" min={1} max={4} step={0.1} value={lineView.value}
                        onChange={e => { const n = Number(e.target.value); if (n >= 1 && n <= 4) setLineView({ on: true, value: Math.round(n * 10) / 10 }); }}
                        className="h-7 w-12 rounded-md border border-zinc-200 px-1 text-center text-[12.5px] tabular-nums text-zinc-700 focus:border-indigo-400 focus:outline-none" />
                    </div>
                    </>
                  } pages={docs.map(d => ({
                    key: d.file,
                    active: d.file === active?.file,
                    label: <><span className="truncate">{shortDocLabel(d.file)}</span>{d.model.lang === 'bn' ? <Badge tone="indigo">বাংলা</Badge> : <Badge>English</Badge>}{(d.status === 'pending' || d.status === 'saving') && <span className="size-2 rounded-full bg-amber-400" title="Saving" />}
                      <MarginControl compact className="ml-auto shrink-0" value={d.model.margins} title={`Margins · ${shortDocLabel(d.file)}`} align="end"
                        onChange={fn => p.updateModel(d.file, m => ({ ...m, margins: fn(m.margins) }))} /></>,
                    node: (
                      <VisualEditor ref={api => { editors.current[d.file] = api; if (d.file === active?.file) (editor as React.MutableRefObject<EditorApi | null>).current = api; }}
                        docKey={`${d.file}:${reload}:${d.rev || 0}`} model={d.model} initialBody={d.model.body} showFields={showFields} zoom={1} framed={false}
                        extraCss={highlightCss}
                        onLoaded={root => applyValuesToRoot(root, d.model.lang, p.valuesRef.current, { lockStructured: true })}
                        onFieldClick={(k, ov) => onFieldClick(k, ov, d.file)}
                        onHoverField={setHoverKey}
                        onActivate={() => activate(d.file)}
                        onBlurDoc={() => p.reapply(d.file)}
                        onWheel={(e, frame) => canvasApi.current?.forwardWheel(e, frame)}
                        onChange={body => onEditorChange(d.file, body)} onState={st => { if (d.file === (focusFile || docs[0]?.file)) setTbState(st); }} onSave={() => void p.saveAll()} />
                    ),
                  }))} />
                </div>
              </>
            ) : (
              <div className="mx-auto mt-24 max-w-md text-center">
                <FileText className="mx-auto size-8 text-zinc-400" /><p className="mt-3 font-medium">This project has no documents</p>
                <div className="mt-4 flex justify-center gap-2">
                  <Button onClick={() => void addBlank('bn')}>Blank Bangla</Button><Button onClick={() => void addBlank('en')}>Blank English</Button>
                  <Button variant="primary" onClick={() => { uploadMode.current = { kind: 'add' }; uploadRef.current?.click(); }}><Upload className="size-4" />Upload</Button>
                </div>
              </div>
            )
          ) : (
            <>
              {/* Document tabs */}
              <div className="flex h-8 shrink-0 items-center gap-1 border-b border-zinc-200 bg-zinc-50/80 px-2">
                <nav role="tablist" aria-label="Documents" className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                  {docs.map(d => {
                    const on = d.file === activeFile;
                    return (
                      <div key={d.file} className={cn('group flex h-6 shrink-0 items-center rounded-md pl-2 pr-0.5 text-[12.5px] transition-colors', on ? 'bg-white font-medium text-zinc-900 shadow-soft ring-1 ring-zinc-200' : 'text-zinc-600 hover:bg-zinc-200/60')}>
                        <button role="tab" aria-selected={on} onClick={() => switchTo(d.file)} className="flex items-center gap-2" title={d.file}>
                          <FileText className={cn('size-3.5', on ? 'text-indigo-600' : 'text-zinc-400')} />
                          <span className="max-w-[180px] truncate">{shortDocLabel(d.file)}</span>
                          {(d.status === 'pending' || d.status === 'saving') && <span className="size-1.5 rounded-full bg-amber-400" />}
                          {(d.status === 'error' || d.status === 'conflict') && <span className="size-1.5 rounded-full bg-red-500" />}
                        </button>
                        <Menu width="w-56" items={[
                          { label: 'Rename', icon: <Pencil />, onSelect: () => setRenameDoc(d.file) },
                          { label: 'Replace with upload…', icon: <Upload />, onSelect: () => { uploadMode.current = { kind: 'replace', file: d.file }; uploadRef.current?.click(); } },
                          { separator: true, label: '' },
                          { label: 'Delete document', icon: <Trash2 />, danger: true, onSelect: () => void deleteDoc(d.file) },
                        ]} trigger={t => <button {...t} aria-label={`Actions for ${d.file}`} className={cn('ml-1 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700', !on && 'opacity-0 group-hover:opacity-100')}><MoreHorizontal className="size-3.5" /></button>} />
                      </div>
                    );
                  })}
                  <Menu width="w-56" items={[
                    { label: 'MC Script (English)', icon: <Mic />, onSelect: () => void addMcScript() },
                    { separator: true, label: '' },
                    { label: 'Blank Bangla document', icon: <FilePlus2 />, onSelect: () => void addBlank('bn') },
                    { label: 'Blank English document', icon: <FilePlus2 />, onSelect: () => void addBlank('en') },
                    { separator: true, label: '' },
                    { label: 'Upload Word / HTML…', icon: <Upload />, onSelect: () => { uploadMode.current = { kind: 'add' }; uploadRef.current?.click(); } },
                  ]} trigger={t => <IconButton label="Add document" {...t} className="ml-1 shrink-0"><Plus className="size-4" /></IconButton>} />
                </nav>
                <select aria-label="Zoom" value={String(zoomPref)} onChange={e => setZoomPref(e.target.value === 'fit' ? 'fit' : Number(e.target.value))}
                  className="hidden h-6 rounded-md border-0 bg-transparent px-1.5 text-[12px] text-zinc-600 hover:bg-zinc-200/60 focus:outline-none md:block">
                  <option value="fit">Fit ({Math.round(zoom * 100)}%)</option>
                  {[0.5, 0.75, 0.9, 1, 1.25, 1.5].map(z => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
                </select>
                <IconButton label="Page settings and history" active={!!docPanel} onClick={() => setDocPanel(d => (d ? null : 'page'))}><PanelRight className="size-4" /></IconButton>
              </div>
              {mode === 'visual' && active && <Toolbar api={editor} state={tbState} disabled={busy === 'upload'} fieldMenu={fieldMenu} extra={marginsForAll} />}
              <div className="flex min-h-0 flex-1">
                <div ref={canvasRef} className="sv-canvas sv-scroll relative min-w-0 flex-1 overflow-auto">
                  {!active ? (
                    <p className="mt-24 text-center text-zinc-500">Document not found. <button className="font-semibold text-indigo-600" onClick={() => switchTo(undefined)}>Back to all pages</button></p>
                  ) : mode === 'visual' ? (
                    <div className="px-4 py-4">
                      <VisualEditor ref={api => { editors.current[active.file] = api; (editor as React.MutableRefObject<EditorApi | null>).current = api; }} docKey={`${active.file}:${reload}:${active.rev || 0}`} model={active.model} initialBody={active.model.body} showFields={showFields} zoom={zoom}
                        extraCss={highlightCss} onHoverField={setHoverKey} onBlurDoc={() => p.reapply(active.file)}
                        onLoaded={root => applyValuesToRoot(root, active.model.lang, p.valuesRef.current, { lockStructured: true })}
                        onFieldClick={(k, ov) => onFieldClick(k, ov, active.file)}
                        onChange={body => onEditorChange(active.file, body)} onState={setTbState} onSave={() => void p.saveAll()} />
                      <p className="mx-auto mt-3 w-fit text-[11px] text-zinc-400">Coloured text is linked to Shared fields · Grey lines mark approximate A4 page breaks · Ctrl+S saves now</p>
                    </div>
                  ) : (
                    <div className="flex h-full flex-col p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <p className="text-[13px] text-zinc-600">HTML of <strong>{active.file}</strong>. Edit directly — changes apply when you switch back to Visual.</p>
                        <div className="ml-auto flex gap-2">
                          <Button size="sm" onClick={() => void copyText(code).then(() => toast('HTML copied'))}><Copy className="size-3.5" />Copy</Button>
                          <Button size="sm" variant="primary" disabled={!codeDirty} onClick={() => { applyCode(); toast('HTML applied'); }}><Check className="size-3.5" />Apply</Button>
                        </div>
                      </div>
                      <textarea ref={codeRef} aria-label="HTML code" spellCheck={false} value={code} onChange={e => { setCode(e.target.value); setCodeDirty(true); }}
                        className="sv-scroll min-h-0 flex-1 resize-none rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-[12.5px] leading-relaxed text-zinc-100 shadow-pop outline-none focus:ring-4 focus:ring-indigo-200" />
                    </div>
                  )}
                </div>
                {docPanel && active && (
                  <aside className="sv-scroll flex w-[320px] shrink-0 flex-col overflow-y-auto border-l border-zinc-200 bg-zinc-50 max-xl:absolute max-xl:bottom-0 max-xl:right-0 max-xl:top-[100px] max-xl:z-30 max-xl:shadow-pop">
                    <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-zinc-200 bg-zinc-50/95 px-3 py-2 backdrop-blur">
                      <Segmented label="Document panel" value={docPanel} onChange={setDocPanel} options={[{ value: 'page', label: 'Page' }, { value: 'history', label: 'History' }]} />
                      <IconButton label="Close panel" className="ml-auto" onClick={() => setDocPanel(null)}><X className="size-4" /></IconButton>
                    </div>
                    <div className="p-4">
                      {docPanel === 'page' ? <PagePanel model={active.model} onChange={fn => p.updateModel(active.file, fn)} /> : (
                        <div className="space-y-3">
                          <p className="text-[13px] text-zinc-500">Earlier versions of <strong>{shortDocLabel(active.file)}</strong>, kept every 5 minutes while you work (last 30).</p>
                          {store.kind !== 'server' ? <p className="rounded-lg bg-zinc-100 px-3 py-2 text-[13px] text-zinc-600">Version history is available on the website.</p>
                            : versions === null ? <Spinner /> : !versions.length ? <p className="text-[13px] text-zinc-500">No earlier versions yet.</p> : (
                              <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
                                {versions.map(v => {
                                  const m = v.id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
                                  const date = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
                                  return (
                                    <li key={v.id} className="flex items-center gap-2 px-3 py-2">
                                      <History className="size-4 text-zinc-400" />
                                      <span className="flex-1 text-[13px]">{date ? date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : v.id}</span>
                                      <Button size="sm" variant="ghost" onClick={() => void restoreVersion(v.id)}>Restore</Button>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                        </div>
                      )}
                    </div>
                  </aside>
                )}
              </div>
            </>
          )}
        </div>
        {preview && docs.length > 0 && (
          <PrintPreview docs={docs.map(d => ({ file: d.file, label: shortDocLabel(d.file), model: d.model }))} activeFile={active?.file}
            onPick={f => (view === 'canvas' ? activate(f) : switchTo(f))} onClose={() => setPreview(false)} />
        )}
      </div>
      <div className="flex items-center border-t border-zinc-200 bg-white px-3 py-1.5 md:hidden">{statusEl}</div>
      <input ref={uploadRef} type="file" multiple accept={ACCEPTED_UPLOADS} className="hidden" onChange={e => { void onUpload(e.target.files); e.target.value = ''; }} />

      <DetectDialog summary={detection} open={!!detection} onClose={() => setDetection(null)} onApply={applyDetection} />
      <RenameDialog open={!!renameDoc} onClose={() => setRenameDoc(null)} initial={(renameDoc || '').replace(/\.html$/i, '')} title="Rename document"
        onSubmit={async name => {
          const from = renameDoc!;
          const to = uniqueName(name, p.docsRef.current.filter(d => d.file !== from).map(d => d.file.replace(/\.html$/i, '')), '.html');
          if (to === from) return;
          await p.save(from);
          await store.move(p.pathOf(from), p.pathOf(to));
          p.setDocs(prev => prev && prev.map(d => (d.file === from ? { ...d, file: to } : d)));
          if (from === activeFile) onNavigate(to);
          toast('Document renamed');
        }} />
      <RenameDialog open={renameProject} onClose={() => setRenameProject(false)} initial={project} title="Rename project"
        onSubmit={async name => {
          await p.saveAll();
          const items = await store.list();
          if (projectNameTaken(name, items.filter(i => i.type === 'folder' && !i.path.includes('/') && i.path !== project).map(i => i.path))) throw new Error(`A project named “${name}” already exists. Choose another name.`);
          const to = uniqueName(name, []);
          if (to !== project) { await store.move(project, to); location.hash = `#/p/${encodeURIComponent(to)}`; }
        }} />
      <DuplicateProjectDialog store={store} from={dupTaken ? project : null} taken={dupTaken || []} onClose={() => setDupTaken(null)}
        onDone={name => { toast(`Duplicated as “${name}”`, { description: 'You are still in the original project.' }); }} />
      <PasscodeDialog open={!!passOpen} onClose={() => setPassOpen(null)} onDone={() => { const run = passOpen; setPassOpen(null); run?.(); }} />
    </div>
  );
}

function PagePanel({ model, onChange }: { model: DocModel; onChange: (fn: (m: DocModel) => DocModel) => void }) {
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="pp-title">Document title</Label>
        <Input id="pp-title" value={model.title} onChange={e => { const v = e.target.value; onChange(m => ({ ...m, title: v })); }} />
      </div>
      <div className="space-y-1.5">
        <Label>Language</Label>
        <div><Segmented label="Language" value={model.lang} onChange={lang => onChange(m => ({ ...m, lang }))} options={[{ value: 'bn', label: 'বাংলা' }, { value: 'en', label: 'English' }]} /></div>
        <p className="text-[12px] text-zinc-500">Decides whether shared fields show their English or Bangla value.</p>
      </div>
      <div className="grid grid-cols-[1fr_88px] gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="pp-font">Default font</Label>
          <Select id="pp-font" value={FONTS.find(f => f.value === model.font)?.value || ''} onChange={e => { const v = e.target.value; if (v) onChange(m => ({ ...m, font: v })); }}>
            {!FONTS.some(f => f.value === model.font) && <option value="">{model.font.split(',')[0].replace(/['"]/g, '')}</option>}
            {FONTS.map(f => <option key={f.label} value={f.value}>{f.label}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-size">Size (pt)</Label>
          <Input id="pp-size" type="number" min={6} max={72} step={0.5} value={model.fontSize} onChange={e => { const v = Number(e.target.value); if (v >= 6 && v <= 72) onChange(m => ({ ...m, fontSize: v })); }} />
        </div>
      </div>
      <div className="space-y-2">
        <Label>Page margins (inches) · A4</Label>
        <div className="flex flex-wrap gap-1.5">
          {MARGIN_PRESETS.map(pr => (
            <button key={pr.id} onClick={() => onChange(m => ({ ...m, margins: { ...pr.margins } }))}
              className={cn('rounded-full border px-2.5 py-1 text-[12px]', MARGIN_SIDES.every(s => pr.margins[s] === model.margins[s]) ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300')}>{pr.label}</button>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {MARGIN_SIDES.map(side => (
            <label key={side} className="space-y-1">
              <span className="block text-[11px] capitalize text-zinc-500">{side}</span>
              <Input type="number" min={0} max={3} step={0.05} value={model.margins[side]} className="h-8 px-2 text-[13px]"
                onChange={e => { const v = clampMargin(Number(e.target.value), model.margins[side]); onChange(m => ({ ...m, margins: { ...m.margins, [side]: v } })); }} />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function PasscodeDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState('');
  return (
    <Dialog open={open} onClose={onClose} title="Gemini passcode" description="This studio asks for a passcode before using Gemini. You only need to enter it once on this computer." width="max-w-sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => { setPasscode(value.trim()); onDone(); }} disabled={!value.trim()}>Continue</Button></>}>
      <form onSubmit={e => { e.preventDefault(); if (value.trim()) { setPasscode(value.trim()); onDone(); } }}>
        <Input data-autofocus type="password" value={value} onChange={e => setValue(e.target.value)} aria-label="Passcode" />
      </form>
    </Dialog>
  );
}
