import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Code2, Copy, GripVertical, Languages, Mic, PanelLeftClose, Plus, Redo2, RotateCcw, ScanSearch, Sparkles, Trash2, Undo2, X } from 'lucide-react';
import { Bi, EN_PREFIXES, FieldGroup, Guest, ProjectValues, TextKey, colorFor, formatDate, formatTime, guestText, hostIndex, newId, ordinal, toBnDigits } from '../editor/values';
import type { AutoMode } from '../editor/autoTranslate';
import { autoGuest, kindOf, postfixBi, prefixBi, withBn, withEn } from '../editor/autoTranslate';
import { Badge, Button, IconButton, Menu, cn, inputClass } from '../ui/ui';
import type { ProjectState } from './useProject';

export const GROUP_COLOR: Record<FieldGroup, { dot: string; ring: string; hex: string; tint: string }> = {
  exhibition: { dot: 'bg-violet-500', ring: 'ring-violet-300', hex: '#7c3aed', tint: 'rgba(124,58,237,.10)' },
  venue: { dot: 'bg-teal-500', ring: 'ring-teal-300', hex: '#0d9488', tint: 'rgba(13,148,136,.11)' },
  chief: { dot: 'bg-orange-500', ring: 'ring-orange-300', hex: '#ea580c', tint: 'rgba(234,88,12,.11)' },
  special: { dot: 'bg-pink-500', ring: 'ring-pink-300', hex: '#db2777', tint: 'rgba(219,39,119,.10)' },
  contact: { dot: 'bg-blue-500', ring: 'ring-blue-300', hex: '#2563eb', tint: 'rgba(37,99,235,.10)' },
};

interface Props {
  p: ProjectState;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  hoverKey: string | null;
  onHover: (key: string | null) => void;
  focusKey: { key: string; n: number } | null;
  onTranslate: (engine: string) => void;
  providers: { id: string; label: string }[];
  translating: boolean;
  onDetect: () => void;
  autoMode: AutoMode;
  onAutoMode: (m: AutoMode) => void;
  aiError: string;
  onDismissError: () => void;
  htmlOpen?: boolean;
  onToggleHtml?: () => void;
  onHide?: () => void;
}

/** Small colour dot matching the value's border in the pages. */
const Swatch = ({ k }: { k: string }) => <span className="size-2.5 shrink-0 rounded-[3px] ring-1 ring-inset ring-black/10" style={{ background: colorFor(k) }} />;

const small = cn(inputClass, 'h-7 rounded-md px-2 text-[12.5px] shadow-none focus:ring-2');

function Usage({ n }: { n?: number }) {
  return n ? <span className="text-[11px] tabular-nums text-zinc-400">{n}×</span> : <span className="text-[11px] text-zinc-300" title="Not used in any document yet">unused</span>;
}

function Row({ k, hoverKey, onHover, children, className }: { k: string; hoverKey: string | null; onHover: (k: string | null) => void; children: React.ReactNode; className?: string }) {
  return (
    <div data-panel-key={k} onMouseEnter={() => onHover(k)} onMouseLeave={() => onHover(null)}
      className={cn('rounded-md px-1.5 py-1 transition-colors', hoverKey === k ? 'bg-white shadow-soft ring-1 ring-zinc-200' : 'hover:bg-white/70', className)}>
      {children}
    </div>
  );
}

/** "Don't translate": the Bangla is typed by hand and never translated automatically. */
function NoTranslate({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label title="Don't translate — keep the Bangla you type. Auto-translate and “Translate all” skip this value." className={cn('flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 text-[10.5px] font-medium', on ? 'bg-amber-50 text-amber-800' : 'text-zinc-400 hover:text-zinc-600')}>
      <input type="checkbox" aria-label={`Don't translate ${label}`} checked={on} onChange={e => onChange(e.target.checked)} className="size-3 accent-amber-600" />Don't translate
    </label>
  );
}

function BnStatus({ b, onReset }: { b?: Bi; onReset: () => void }) {
  if (!b?.bn || b.noTranslate) return null;
  return b.bnCustom
    ? <button onClick={onReset} title="Typed by hand — click to translate automatically again" className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-100">custom</button>
    : <span title="Translated automatically from English" className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">auto</span>;
}

function Check({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <input type="checkbox" aria-label={label} title="Include in “Translate selected”" checked={on} onChange={e => onChange(e.target.checked)} className="size-3.5 shrink-0 cursor-pointer accent-indigo-600" />;
}

function BiInputs({ value, onEn, onBn, multiline, enPlaceholder, bnPlaceholder }: { value?: Bi; onEn: (s: string) => void; onBn: (s: string) => void; multiline?: boolean; enPlaceholder?: string; bnPlaceholder?: string }) {
  const El = (multiline ? 'textarea' : 'input') as any;
  return (
    <div className="space-y-0.5">
      <div className="flex items-start gap-1"><span className="mt-1.5 w-4 shrink-0 text-[9.5px] font-semibold text-zinc-400">EN</span>
        <El rows={multiline ? 2 : undefined} value={value?.en || ''} placeholder={enPlaceholder} aria-label="English" onChange={(e: any) => onEn(e.target.value)} className={cn(small, multiline && 'h-auto py-1')} /></div>
      <div className="flex items-start gap-1"><span className="mt-1.5 w-4 shrink-0 text-[9.5px] font-semibold text-zinc-400">বাং</span>
        <El rows={multiline ? 2 : undefined} lang="bn" value={value?.bn || ''} placeholder={bnPlaceholder} aria-label="Bangla" onChange={(e: any) => onBn(e.target.value)} className={cn(small, "font-['Hind_Siliguri']", multiline && 'h-auto py-1')} /></div>
    </div>
  );
}

/* ---------- Guest card ---------- */

function TokenList({ label, list, onChange, kind, lock }: { label: string; list: Bi[]; onChange: (l: Bi[]) => void; kind: 'prefix' | 'postfix'; lock?: boolean }) {
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between"><span className="text-[11px] font-medium text-zinc-500">{label}</span>
        <button className="text-[11px] font-medium text-indigo-600 hover:underline" onClick={() => onChange([...list, { en: '', bn: '' }])}>+ Add</button></div>
      {!list.length && <p className="text-[11px] text-zinc-400">None</p>}
      <div className="space-y-1">
        {list.map((t, i) => (
          <div key={i} className="flex items-center gap-1">
            <input value={t.en} list={kind === 'prefix' ? 'sv-prefixes' : undefined} placeholder={kind === 'prefix' ? 'Mr.' : 'ndc'} aria-label={`${label} ${i + 1} English`}
              onChange={e => { const v = e.target.value; onChange(list.map((x, j) => (j === i ? (x.bnCustom || lock ? { ...x, en: v } : (kind === 'prefix' ? prefixBi(v) : postfixBi(v))) : x))); }}
              className={cn(small, 'h-7 w-0 flex-1')} />
            <input value={t.bn} lang="bn" aria-label={`${label} ${i + 1} Bangla`} placeholder="বাংলা"
              onChange={e => onChange(list.map((x, j) => (j === i ? withBn(x, e.target.value) : x)))} className={cn(small, "h-7 w-0 flex-1 font-['Hind_Siliguri']")} />
            <IconButton label="Remove" className="size-6" onClick={() => onChange(list.filter((_, j) => j !== i))}><X className="size-3" /></IconButton>
          </div>
        ))}
      </div>
    </div>
  );
}

function GuestCard({ g, index, onChange, onRemove, onMove, onDuplicate, selected, onSelect, open, setOpen, color, drag, hovered, onHover, host, onMakeHost }: {
  host?: boolean; onMakeHost?: (on: boolean) => void;
  g: Guest; index?: number; onChange: (g: Guest) => void; onRemove?: () => void; onMove?: (d: -1 | 1) => void; onDuplicate?: () => void;
  selected: boolean; onSelect: (v: boolean) => void; open: boolean; setOpen: (v: boolean) => void; color: string;
  drag?: { onDragStart: (e: React.DragEvent) => void; onDragOver: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void; onDragEnd: () => void; over: boolean };
  hovered: boolean; onHover: (v: boolean) => void;
}) {
  const custom = !g.noTranslate && (g.name.bnCustom || g.designation.bnCustom);
  const lock = !!g.noTranslate;
  return (
    <div onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}
      onKeyDown={e => { if (e.altKey && onMove && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); onMove(e.key === 'ArrowUp' ? -1 : 1); } }}
      onDragOver={drag?.onDragOver} onDrop={drag?.onDrop}
      className={cn('group rounded-lg border bg-white transition-all', hovered ? 'border-zinc-300 shadow-soft' : 'border-zinc-200', drag?.over && 'border-t-2 border-t-pink-500')}>
      <div className="flex items-start gap-1 p-1.5">
        {drag ? (
          <span draggable onDragStart={drag.onDragStart} onDragEnd={drag.onDragEnd} title="Drag to reorder (or Alt+↑/↓)" className="mt-0.5 cursor-grab text-zinc-300 hover:text-zinc-500 active:cursor-grabbing"><GripVertical className="size-4" /></span>
        ) : null}
        {index !== undefined ? <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: colorFor(`specialGuests:${index}`) }}>{index}</span>
          : <span className="mt-1 size-3 shrink-0 rounded-full" style={{ background: colorFor('chiefGuest') }} />}
        <button onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left" aria-expanded={open}>
          <p className="text-[13px] leading-snug text-zinc-900">
            {g.prefixes.filter(p => p.en).map((p, i) => <span key={i} className="mr-1 rounded bg-zinc-100 px-1 text-[11px] text-zinc-600">{p.en}</span>)}
            <strong className="font-semibold">{g.name.en || <span className="text-zinc-400">Name</span>}</strong>
            {g.postfixes.filter(p => p.en).map((p, i) => <span key={i} className="ml-1 rounded bg-zinc-100 px-1 text-[10px] text-zinc-500">{p.en}</span>)}
          </p>
          <p className="truncate text-[12px] text-zinc-500">{g.designation.en || '—'}</p>
          <p lang="bn" className="truncate font-['Hind_Siliguri'] text-[12px] text-zinc-500">{guestText(g, 'bn') || '—'}</p>
        </button>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-1">
            {custom && <span className="rounded-full bg-amber-50 px-1.5 text-[10px] text-amber-800">custom</span>}
            {lock && <span title="Don't translate — Bangla is typed by hand" className="rounded-full bg-amber-50 px-1.5 text-[10px] font-medium text-amber-800">no translate</span>}
            {host && <span title="Host: gives the welcome speech in the MC Script and exchanges crests with the chief guest" className="flex items-center gap-0.5 rounded-full bg-stone-100 px-1.5 text-[10px] font-medium text-stone-700"><Mic className="size-2.5" />host</span>}
            {!lock && <Check on={selected} onChange={onSelect} label={`Select ${g.name.en || 'guest'} for translation`} />}
          </div>
          <div className="flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {onMove && <IconButton label="Move up" className="size-6" onClick={() => onMove(-1)}><ArrowUp className="size-3.5" /></IconButton>}
            {onMove && <IconButton label="Move down" className="size-6" onClick={() => onMove(1)}><ArrowDown className="size-3.5" /></IconButton>}
            {onDuplicate && <IconButton label="Duplicate" className="size-6" onClick={onDuplicate}><Copy className="size-3.5" /></IconButton>}
            {onRemove && <IconButton label="Remove guest" className="size-6 text-red-600" onClick={onRemove}><Trash2 className="size-3.5" /></IconButton>}
          </div>
        </div>
      </div>
      {open && (
        <div className="space-y-2 border-t border-zinc-100 bg-zinc-50/60 p-2">
          <div className="flex items-center justify-end gap-1">
            {onMakeHost && (
              <label title="The host gives the welcome speech in the MC Script and exchanges crests with the chief guest. Without a choice, the last special guest is the host." className={cn('mr-auto flex cursor-pointer items-center gap-1 rounded px-1 text-[10.5px] font-medium', host ? 'bg-stone-100 text-stone-800' : 'text-zinc-400 hover:text-zinc-600')}>
                <input type="radio" aria-label={`Host of the MC Script: ${g.name.en || 'guest'}`} checked={!!host} onChange={() => onMakeHost(true)} className="size-3 accent-stone-600" />Host (welcome speech)
              </label>
            )}
            <NoTranslate on={lock} onChange={on => { onChange({ ...g, noTranslate: on || undefined }); if (on) onSelect(false); }} label={g.name.en || 'guest'} />
          </div>
          <TokenList label="Before the name (prefix)" kind="prefix" lock={lock} list={g.prefixes} onChange={l => onChange({ ...g, prefixes: l })} />
          <div>
            <span className="mb-1 block text-[11px] font-medium text-zinc-500">Name</span>
            <BiInputs value={g.name} onEn={v => onChange({ ...g, name: lock ? { ...g.name, en: v } : withEn(g.name, v, 'name') })} onBn={v => onChange({ ...g, name: withBn(g.name, v) })} enPlaceholder="Full name" bnPlaceholder="পূর্ণ নাম" />
          </div>
          <TokenList label="After the name (postfix)" kind="postfix" lock={lock} list={g.postfixes} onChange={l => onChange({ ...g, postfixes: l })} />
          <div>
            <span className="mb-1 block text-[11px] font-medium text-zinc-500">Designation</span>
            <BiInputs multiline value={g.designation} onEn={v => onChange({ ...g, designation: lock ? { ...g.designation, en: v } : withEn(g.designation, v, 'designation') })} onBn={v => onChange({ ...g, designation: withBn(g.designation, v) })} enPlaceholder="Title, organization" bnPlaceholder="পদবি, প্রতিষ্ঠান" />
          </div>
          <div className="flex justify-between">
            <Button size="sm" variant="ghost" disabled={lock} onClick={() => onChange(autoGuest(g, true))}><Languages className="size-3.5" />Translate guest offline</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Done</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Panel ---------- */

export function GlobalFieldsPanel({ p, selected, setSelected, hoverKey, onHover, focusKey, onTranslate, providers, translating, onDetect, autoMode, onAutoMode, aiError, onDismissError, htmlOpen, onToggleHtml, onHide }: Props) {
  const v = p.values;
  const [openGuests, setOpenGuests] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<FieldGroup>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusKey) return;
    const group = focusKey.key === 'chiefGuest' ? 'chief' : focusKey.key.startsWith('specialGuests') ? 'special' : null;
    if (group && collapsed.has(group)) setCollapsed(c => { const n = new Set(c); n.delete(group); return n; });
    requestAnimationFrame(() => {
      const el = scroller.current?.querySelector<HTMLElement>(`[data-panel-key="${focusKey.key}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.animate([{ boxShadow: '0 0 0 3px rgba(99,102,241,.5)' }, { boxShadow: '0 0 0 0 rgba(99,102,241,0)' }], { duration: 1200 });
      el.querySelector<HTMLElement>('input,textarea,button')?.focus({ preventScroll: true });
    });
  }, [focusKey?.n]);

  const set = p.setValues;
  const setText = (key: TextKey, lang: 'en' | 'bn', s: string) => set(cur => ({ ...cur, text: { ...cur.text, [key]: lang === 'en' ? withEn(cur.text[key], s, kindOf(key), key) : withBn(cur.text[key], s) } }), [key]);
  const setNoTranslate = (key: TextKey, on: boolean) => {
    set(cur => ({ ...cur, text: { ...cur.text, [key]: { ...(cur.text[key] || { en: '', bn: '' }), noTranslate: on || undefined } } }), [key]);
    if (on) toggle('text:' + key, false);
  };
  const resetText = (key: TextKey) => set(cur => ({ ...cur, text: { ...cur.text, [key]: withEn({ ...(cur.text[key] || { en: '', bn: '' }), bnCustom: false }, cur.text[key]?.en || '', kindOf(key), key) } }), [key]);
  const sel = (k: string) => selected.has(k);
  const toggle = (k: string, on: boolean) => { const n = new Set(selected); on ? n.add(k) : n.delete(k); setSelected(n); };
  const u = (k: string) => p.usage[k]?.count;

  const textRow = (key: TextKey, label: string, opts: { multiline?: boolean; en?: string; bn?: string } = {}) => (
    <Row k={key} hoverKey={hoverKey} onHover={onHover} key={key}>
      <div className="mb-0.5 flex items-center gap-1.5">
        {v.text[key]?.noTranslate ? <span className="size-3.5 shrink-0" /> : <Check on={sel('text:' + key)} onChange={on => toggle('text:' + key, on)} label={`Select ${label} for translation`} />}
        <Swatch k={key} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-700">{label}</span>
        <NoTranslate on={!!v.text[key]?.noTranslate} onChange={on => setNoTranslate(key, on)} label={label} />
        <BnStatus b={v.text[key]} onReset={() => resetText(key)} />
        <Usage n={u(key)} />
      </div>
      <BiInputs value={v.text[key]} multiline={opts.multiline} enPlaceholder={opts.en} bnPlaceholder={opts.bn} onEn={s => setText(key, 'en', s)} onBn={s => setText(key, 'bn', s)} />
      {!!p.usage[key]?.overrides && <OverrideNote n={p.usage[key].overrides} />}
    </Row>
  );

  const numberRow = (key: 'edition' | 'year' | 'hall', label: string, preview: string) => (
    <Row k={key} hoverKey={hoverKey} onHover={onHover} key={key}>
      <div className="flex items-center gap-1.5">
        <Swatch k={key} />
        <span className="w-[72px] shrink-0 text-[12px] font-medium text-zinc-700">{label}</span>
        <input type="number" min={1} max={key === 'year' ? 2200 : 999} value={v[key] ?? ''} aria-label={label}
          onChange={e => { const n = e.target.value === '' ? null : Math.max(0, Math.floor(+e.target.value)); set(cur => ({ ...cur, [key]: n }), [key]); }}
          className={cn(small, 'w-16 tabular-nums')} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-500">{preview}</span>
        <Usage n={u(key)} />
      </div>
    </Row>
  );

  const dateRow = (key: 'eventDate' | 'endDate' | 'issueDate', label: string) => (
    <Row k={key} hoverKey={hoverKey} onHover={onHover} key={key}>
      <div className="flex items-center gap-1.5">
        <Swatch k={key} />
        <span className="w-[72px] shrink-0 text-[12px] font-medium text-zinc-700">{label}</span>
        <input type="date" value={v[key] || ''} aria-label={label} onChange={e => set(cur => ({ ...cur, [key]: e.target.value || null }), [key])} className={cn(small, 'w-[128px]')} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-zinc-500" lang="bn">{v[key] ? formatDate(v[key], 'bn') : ''}</span>
        <Usage n={u(key)} />
      </div>
    </Row>
  );

  /* ---------- Guests ---------- */
  const guests = v.specialGuests;
  const setGuests = (list: Guest[], keys = ['specialGuests']) => set(cur => ({ ...cur, specialGuests: list }), keys);
  const move = (i: number, d: -1 | 1) => {
    const j = i + d; if (j < 0 || j >= guests.length) return;
    const list = [...guests]; [list[i], list[j]] = [list[j], list[i]]; setGuests(list);
  };
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const list = [...guests];
    const from = list.findIndex(g => g.id === dragId);
    const [item] = list.splice(from, 1);
    const to = list.findIndex(g => g.id === targetId);
    list.splice(to, 0, item);
    setGuests(list);
  };
  const toggleOpen = (id: string, on: boolean) => setOpenGuests(s => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });

  const allKeys = useMemo(() => [
    ...(['exhibitionName', 'shortName', 'visitingHours', 'contactName', 'contactTitle'] as TextKey[]).filter(k => v.text[k]?.en && !v.text[k]?.noTranslate).map(k => 'text:' + k),
    ...(v.chiefGuest && !v.chiefGuest.noTranslate ? ['guest:chief'] : []), ...guests.filter(g => !g.noTranslate).map(g => 'guest:' + g.id),
  ], [v]);

  const section = (group: FieldGroup, title: string, children: React.ReactNode, extra?: React.ReactNode) => {
    const isCollapsed = collapsed.has(group);
    return (
      <section className="border-b border-zinc-200/80 py-0.5">
        <div className="flex items-center gap-2 px-2 py-0.5">
          <button onClick={() => setCollapsed(c => { const n = new Set(c); isCollapsed ? n.delete(group) : n.add(group); return n; })} className="flex flex-1 items-center gap-2 text-left">
            {isCollapsed ? <ChevronRight className="size-3.5 text-zinc-400" /> : <ChevronDown className="size-3.5 text-zinc-400" />}
            <span className={cn('size-2 rounded-full', GROUP_COLOR[group].dot)} />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{title}</span>
          </button>
          {extra}
        </div>
        {!isCollapsed && <div className="space-y-0 px-1">{children}</div>}
      </section>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <datalist id="sv-prefixes">{EN_PREFIXES.map(x => <option key={x} value={x} />)}</datalist>
      <div className="space-y-1 border-b border-zinc-200 px-2 py-1">
        <div className="flex items-center gap-0.5">
          <h2 className="flex-1 text-[13px] font-semibold text-zinc-900" title="Change a value here or type it in any page — all four documents update, in English and Bangla.">Shared fields</h2>
          {onToggleHtml && (
            <button onClick={onToggleHtml} aria-pressed={!!htmlOpen} title="Edit all four documents as HTML"
              className={cn('mr-0.5 flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11.5px] font-semibold', htmlOpen ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300')}>
              <Code2 className="size-3.5" />HTML
            </button>
          )}
          <IconButton label="Undo field change" disabled={!p.canUndo} onClick={p.undo}><Undo2 className="size-4" /></IconButton>
          <IconButton label="Redo field change" disabled={!p.canRedo} onClick={p.redo}><Redo2 className="size-4" /></IconButton>
          <IconButton label="Find fields in the documents again" onClick={onDetect}><ScanSearch className="size-4" /></IconButton>
          {onHide && <IconButton label="Hide shared fields" onClick={onHide}><PanelLeftClose className="size-4" /></IconButton>}
        </div>
        <div className="flex items-center gap-1.5">
          <label className="flex shrink-0 items-center gap-1 text-[11.5px] text-zinc-600" title="Select every value for “Translate selected”">
            <input type="checkbox" className="size-3.5 accent-indigo-600" checked={allKeys.length > 0 && allKeys.every(k => selected.has(k))}
              onChange={e => setSelected(e.target.checked ? new Set(allKeys) : new Set())} />
            {selected.size ? `${selected.size} sel.` : 'All'}
          </label>
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md bg-white px-1 py-0.5 ring-1 ring-zinc-200" title="Translate English to Bangla automatically while you type">
            <button role="switch" aria-checked={autoMode.on} aria-label="Auto-translate to Bangla while typing" onClick={() => onAutoMode({ ...autoMode, on: !autoMode.on })}
              className={cn('relative h-4 w-7 shrink-0 rounded-full transition-colors', autoMode.on ? 'bg-indigo-600' : 'bg-zinc-300')}>
              <span className={cn('absolute top-0.5 size-3 rounded-full bg-white shadow transition-all', autoMode.on ? 'left-[14px]' : 'left-0.5')} />
            </button>
            <span className="truncate text-[11.5px] text-zinc-700">Auto-translate</span>
            <select aria-label="Auto-translate with" value={autoMode.engine} disabled={!autoMode.on} onChange={e => onAutoMode({ ...autoMode, engine: e.target.value })}
              className="ml-auto h-5 min-w-0 rounded border border-zinc-200 bg-white px-0.5 text-[11px] text-zinc-700 disabled:opacity-50">
              <option value="offline">Offline</option>
              {providers.map(pr => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
            </select>
          </div>
          <Menu align="end" width="w-72" items={[
            { label: selected.size ? `Translate ${selected.size} selected to Bangla` : 'Translate all fields to Bangla', heading: true },
            { label: 'Offline dictionary', icon: <Languages />, hint: 'instant', onSelect: () => onTranslate('offline') },
            ...providers.map(pr => ({ label: pr.label, icon: <Sparkles />, onSelect: () => onTranslate(pr.id) })),
            ...(providers.length ? [] : [{ separator: true, label: '' }, { label: 'Add a Gemini, Claude, ChatGPT or OpenRouter key in WordPress → Settings → Media Studio', disabled: true }]),
            { separator: true, label: '' },
            { label: 'Values marked “Don\'t translate” are skipped', disabled: true },
          ]} trigger={t => <Button size="sm" variant={selected.size ? 'primary' : 'outline'} loading={translating} className="h-6 px-1.5 text-[11.5px]" {...t} title={selected.size ? 'Translate the selected values to Bangla' : 'Translate all values to Bangla'}><Languages className="size-3.5" />{selected.size ? 'Translate' : 'Translate all'}<ChevronDown className="size-3 opacity-60" /></Button>} />
        </div>
        {aiError && (
          <div role="alert" className="flex items-start gap-2 rounded-md bg-red-50 px-2 py-1 text-[11.5px] text-red-800 ring-1 ring-red-200">
            <span className="flex-1">{aiError}</span>
            <button aria-label="Dismiss" onClick={onDismissError} className="text-red-500 hover:text-red-800"><X className="size-3.5" /></button>
          </div>
        )}
      </div>

      <div ref={scroller} className="sv-scroll min-h-0 flex-1 overflow-y-auto">
        {section('exhibition', 'Exhibition', <>
          {numberRow('edition', 'Edition', v.edition ? `${ordinal(v.edition, 'en')} · ${ordinal(v.edition, 'bn')}` : '')}
          {textRow('exhibitionName', 'Exhibition name', { en: 'Bangladesh International Marine And Offshore Expo' })}
          {textRow('shortName', 'Short name', { en: 'BIMOX', bn: 'বিমক্স' })}
          {numberRow('year', 'Year', v.year ? `${v.year} · ${toBnDigits(String(v.year))}` : '')}
        </>)}
        {section('venue', 'Date and time', <>
          {dateRow('eventDate', 'Event date')}
          <Row k="eventTime" hoverKey={hoverKey} onHover={onHover}>
            <div className="flex items-center gap-1.5">
              <Swatch k="eventTime" />
              <span className="w-[72px] shrink-0 text-[12px] font-medium text-zinc-700">Time</span>
              <input type="time" value={v.eventTime || ''} aria-label="Inauguration time" onChange={e => set(cur => ({ ...cur, eventTime: e.target.value || null }), ['eventTime'])} className={cn(small, 'w-[128px]')} />
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-zinc-500" lang="bn">{v.eventTime ? formatTime(v.eventTime, 'bn') : ''}</span>
              <Usage n={u('eventTime')} />
            </div>
          </Row>
          {dateRow('endDate', 'Last day')}
          {dateRow('issueDate', 'Letter date')}
          {textRow('visitingHours', 'Visiting hours', { en: '10:00 AM to 7:00 PM' })}
        </>)}
        {section('chief', 'Chief guest', (
          <div className="px-0.5 py-0.5" data-panel-key="chiefGuest">
            {v.chiefGuest ? (
              <GuestCard g={v.chiefGuest} color={GROUP_COLOR.chief.dot} onChange={g => set(cur => ({ ...cur, chiefGuest: g }), ['chiefGuest'])}
                onRemove={() => set(cur => ({ ...cur, chiefGuest: null }), ['chiefGuest'])}
                selected={sel('guest:chief')} onSelect={on => toggle('guest:chief', on)}
                open={openGuests.has('chief')} setOpen={o => toggleOpen('chief', o)}
                hovered={hoverKey === 'chiefGuest'} onHover={h => onHover(h ? 'chiefGuest' : null)} />
            ) : <Button size="sm" variant="outline" className="w-full" onClick={() => { set(cur => ({ ...cur, chiefGuest: { id: newId(), prefixes: [prefixBi('Mr.')], name: { en: '', bn: '' }, postfixes: [], designation: { en: '', bn: '' } } }), ['chiefGuest']); toggleOpen('chief', true); }}><Plus className="size-3.5" />Add chief guest</Button>}
          </div>
        ), <Usage n={u('chiefGuest')} />)}
        {section('special', `Special guests (${guests.length})`, (
          <div className="space-y-1 px-0.5 py-0.5" data-panel-key="specialGuests" onMouseEnter={() => onHover('specialGuests')} onMouseLeave={() => onHover(null)}>
            {guests.map((g, i) => (
              <div key={g.id} data-panel-key={`specialGuests:${i + 1}`}>
                <GuestCard g={g} index={i + 1} color={GROUP_COLOR.special.dot}
                  host={i === hostIndex(v)} onMakeHost={() => set(cur => ({ ...cur, hostGuestId: g.id }), ['specialGuests'])}
                  onChange={ng => setGuests(guests.map(x => (x.id === g.id ? ng : x)))}
                  onRemove={() => setGuests(guests.filter(x => x.id !== g.id))}
                  onMove={d => move(i, d)}
                  onDuplicate={() => { const copy = { ...JSON.parse(JSON.stringify(g)), id: newId() }; const list = [...guests]; list.splice(i + 1, 0, copy); setGuests(list); }}
                  selected={sel('guest:' + g.id)} onSelect={on => toggle('guest:' + g.id, on)}
                  open={openGuests.has(g.id)} setOpen={o => toggleOpen(g.id, o)}
                  hovered={hoverKey === `specialGuests:${i + 1}`} onHover={h => onHover(h ? `specialGuests:${i + 1}` : 'specialGuests')}
                  drag={{
                    onDragStart: e => { setDragId(g.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', g.id); },
                    onDragOver: e => { if (dragId) { e.preventDefault(); setOverId(g.id); } },
                    onDrop: e => { e.preventDefault(); dropOn(g.id); setDragId(null); setOverId(null); },
                    onDragEnd: () => { setDragId(null); setOverId(null); },
                    over: overId === g.id && dragId !== g.id,
                  }} />
              </div>
            ))}
            <Button size="sm" variant="outline" className="w-full border-dashed" onClick={() => { const g: Guest = { id: newId(), prefixes: [prefixBi('Mr.')], name: { en: '', bn: '' }, postfixes: [], designation: { en: '', bn: '' } }; setGuests([...guests, g]); toggleOpen(g.id, true); }}><Plus className="size-3.5" />Add special guest</Button>
          </div>
        ), <Usage n={u('specialGuests')} />)}
        {section('contact', 'Message sender', <>
          {textRow('contactName', 'Name', { en: 'Full name' })}
          {textRow('contactTitle', 'Title', { en: 'Deputy General Manager' })}
          <Row k="contactPhone" hoverKey={hoverKey} onHover={onHover}>
            <div className="flex items-center gap-1.5">
              <Swatch k="contactPhone" />
              <span className="w-[72px] shrink-0 text-[12px] font-medium text-zinc-700">Phone</span>
              <input value={v.contactPhone} placeholder="017XXXXXXXX" aria-label="Contact phone" onChange={e => set(cur => ({ ...cur, contactPhone: e.target.value }), ['contactPhone'])} className={cn(small, 'flex-1')} />
              <Usage n={u('contactPhone')} />
            </div>
          </Row>
        </>)}
        <p className="px-2.5 py-2 text-[11px] leading-snug text-zinc-400">Tip: hover a field to see it in every document. Click a highlighted value in a page to jump here. Bangla marked <span className="text-emerald-600">auto</span> follows the English; <span className="text-amber-700">custom</span> Bangla is never changed unless you select it and translate.</p>
      </div>
    </div>
  );
}

function OverrideNote({ n }: { n: number }) {
  return <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-700"><RotateCcw className="size-3" />{n} place{n > 1 ? 's keep' : ' keeps'} its own text (click it in the page to reset)</p>;
}
