import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ChevronDown, Copy, GripVertical, Languages, Mic, Plus, Redo2, Sheet, Sparkles, Trash2, Undo2, X } from 'lucide-react';
import { Bi, EN_PREFIXES, Guest, TextKey, colorFor, formatDate, formatTime, hostIndex, newId, ordinal, toBnDigits } from '../editor/values';
import { autoGuest, kindOf, postfixBi, prefixBi, withBn, withEn } from '../editor/autoTranslate';
import { Button, IconButton, Menu, cn } from '../ui/ui';
import type { ProjectState } from './useProject';

/**
 * The shared values as a spreadsheet: every value and every guest at a glance,
 * edited in place. Changes apply to every document at once, like the Shared fields panel.
 */

const cell = 'h-7 w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 text-[12.5px] text-zinc-900 placeholder:text-zinc-300 hover:border-zinc-200 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100';
const bnCell = cn(cell, "font-['Hind_Siliguri']");
const th = 'sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50 px-1.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500';
const td = 'border-b border-zinc-100 px-0.5 py-0.5 align-middle';

const Swatch = ({ k }: { k: string }) => <span className="inline-block size-2.5 shrink-0 rounded-[3px] ring-1 ring-inset ring-black/10" style={{ background: colorFor(k) }} />;

function NoTr({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label title="Don't translate — keep the Bangla you type. Auto-translate and “Translate all” skip it." className="flex cursor-pointer justify-center">
      <input type="checkbox" aria-label={`Don't translate ${label}`} checked={on} onChange={e => onChange(e.target.checked)} className="size-3.5 accent-amber-600" />
    </label>
  );
}

function BnTag({ b }: { b?: Bi }) {
  if (!b?.bn || b.noTranslate) return null;
  return b.bnCustom
    ? <span title="Bangla typed by hand" className="shrink-0 rounded-full bg-amber-50 px-1 text-[9.5px] font-medium text-amber-800">custom</span>
    : <span title="Translated automatically from English" className="shrink-0 rounded-full bg-emerald-50 px-1 text-[9.5px] font-medium text-emerald-700">auto</span>;
}

/** "Mr., Dr." ⇄ prefix/postfix tokens (Bangla follows automatically unless locked). */
const tokensText = (l: Bi[]) => l.map(t => t.en).filter(Boolean).join(', ');
const tokensFrom = (s: string, old: Bi[], kind: 'prefix' | 'postfix', lock: boolean): Bi[] =>
  s.split(',').map(x => x.trim()).filter(Boolean).map((en, i) => {
    const prev = old.find(t => t.en === en) || (lock ? old[i] : undefined);
    if (prev && prev.en === en) return prev;
    return lock ? { en, bn: prev?.bn || '' } : kind === 'prefix' ? prefixBi(en) : postfixBi(en);
  });

function TokensCell({ list, kind, lock, label, onChange }: { list: Bi[]; kind: 'prefix' | 'postfix'; lock: boolean; label: string; onChange: (l: Bi[]) => void }) {
  const [text, setText] = useState(tokensText(list));
  useEffect(() => setText(tokensText(list)), [tokensText(list)]);
  return (
    <input value={text} aria-label={label} placeholder={kind === 'prefix' ? 'Mr.' : 'ndc'} list={kind === 'prefix' ? 'sv-prefixes-sheet' : undefined}
      title={list.map(t => t.bn).filter(Boolean).join(', ') || undefined}
      onChange={e => setText(e.target.value)} onBlur={() => { if (text !== tokensText(list)) onChange(tokensFrom(text, list, kind, lock)); }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={cell} />
  );
}

export function SheetDialog({ open, onClose, p, selected, setSelected, onTranslate, providers, translating }: {
  open: boolean; onClose: () => void; p: ProjectState;
  selected: Set<string>; setSelected: (s: Set<string>) => void;
  onTranslate: (engine: string) => void; providers: { id: string; label: string }[]; translating: boolean;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role=menu]')) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const v = p.values;
  const set = p.setValues;
  const guests = v.specialGuests;
  const sel = (k: string) => selected.has(k);
  const toggle = (k: string, on: boolean) => { const n = new Set(selected); on ? n.add(k) : n.delete(k); setSelected(n); };
  const u = (k: string) => p.usage[k]?.count;
  const allKeys = useMemo(() => [
    ...(['exhibitionName', 'shortName', 'visitingHours', 'contactName', 'contactTitle'] as TextKey[]).filter(k => v.text[k]?.en && !v.text[k]?.noTranslate).map(k => 'text:' + k),
    ...(v.chiefGuest && !v.chiefGuest.noTranslate ? ['guest:chief'] : []), ...guests.filter(g => !g.noTranslate).map(g => 'guest:' + g.id),
  ], [v]);
  if (!open) return null;

  /* ---------- Values ---------- */
  const setText = (key: TextKey, lang: 'en' | 'bn', s: string) => set(cur => ({ ...cur, text: { ...cur.text, [key]: lang === 'en' ? withEn(cur.text[key], s, kindOf(key), key) : withBn(cur.text[key], s) } }), [key]);
  const setNoTranslate = (key: TextKey, on: boolean) => {
    set(cur => ({ ...cur, text: { ...cur.text, [key]: { ...(cur.text[key] || { en: '', bn: '' }), noTranslate: on || undefined } } }), [key]);
    if (on) toggle('text:' + key, false);
  };

  const Used = ({ k }: { k: string }) => <span className={cn('block text-center text-[11px] tabular-nums', u(k) ? 'text-zinc-400' : 'text-zinc-300')} title={u(k) ? `Used ${u(k)} times in the documents` : 'Not used in any document yet'}>{u(k) ? `${u(k)}×` : '—'}</span>;

  type Row = { key: string; label: string; en: React.ReactNode; bn: React.ReactNode; check?: React.ReactNode; noTr?: React.ReactNode };
  const textRow = (key: TextKey, label: string, ph?: string): Row => {
    const b = v.text[key];
    return {
      key, label,
      check: b?.noTranslate ? null : <input type="checkbox" aria-label={`Select ${label} for translation`} checked={sel('text:' + key)} onChange={e => toggle('text:' + key, e.target.checked)} className="size-3.5 accent-indigo-600" />,
      en: <input value={b?.en || ''} placeholder={ph} aria-label={`${label} English`} onChange={e => setText(key, 'en', e.target.value)} className={cell} />,
      bn: <div className="flex min-w-0 items-center gap-1"><input lang="bn" value={b?.bn || ''} aria-label={`${label} Bangla`} onChange={e => setText(key, 'bn', e.target.value)} className={bnCell} /><BnTag b={b} /></div>,
      noTr: <NoTr on={!!b?.noTranslate} onChange={on => setNoTranslate(key, on)} label={label} />,
    };
  };
  const numRow = (key: 'edition' | 'year', label: string, bn: string): Row => ({
    key, label,
    en: <input type="number" min={1} max={key === 'year' ? 2200 : 999} value={v[key] ?? ''} aria-label={label}
      onChange={e => { const n = e.target.value === '' ? null : Math.max(0, Math.floor(+e.target.value)); set(cur => ({ ...cur, [key]: n }), [key]); }} className={cn(cell, 'w-24 tabular-nums')} />,
    bn: <span lang="bn" className="px-1.5 font-['Hind_Siliguri'] text-[12.5px] text-zinc-500">{bn}</span>,
  });
  const dateRow = (key: 'eventDate' | 'endDate' | 'issueDate', label: string): Row => ({
    key, label,
    en: <div className="flex items-center gap-2"><input type="date" value={v[key] || ''} aria-label={label} onChange={e => set(cur => ({ ...cur, [key]: e.target.value || null }), [key])} className={cn(cell, 'w-36 shrink-0')} /><span className="min-w-0 truncate text-[12px] text-zinc-500">{v[key] ? formatDate(v[key], 'en') : ''}</span></div>,
    bn: <span lang="bn" className="block truncate px-1.5 font-['Hind_Siliguri'] text-[12.5px] text-zinc-500">{v[key] ? formatDate(v[key], 'bn') : ''}</span>,
  });
  const rows: (Row | string)[] = [
    'Exhibition',
    numRow('edition', 'Edition', v.edition ? ordinal(v.edition, 'bn') : ''),
    textRow('exhibitionName', 'Exhibition name', 'Bangladesh International Marine And Offshore Expo'),
    textRow('shortName', 'Short name', 'BIMOX'),
    numRow('year', 'Year', v.year ? toBnDigits(String(v.year)) : ''),
    'Date and time',
    dateRow('eventDate', 'Event date'),
    {
      key: 'eventTime', label: 'Inauguration time',
      en: <div className="flex items-center gap-2"><input type="time" value={v.eventTime || ''} aria-label="Inauguration time" onChange={e => set(cur => ({ ...cur, eventTime: e.target.value || null }), ['eventTime'])} className={cn(cell, 'w-36 shrink-0')} /><span className="min-w-0 truncate whitespace-nowrap text-[12px] text-zinc-500">{v.eventTime ? formatTime(v.eventTime, 'en') : ''}</span></div>,
      bn: <span lang="bn" className="block truncate px-1.5 font-['Hind_Siliguri'] text-[12.5px] text-zinc-500">{v.eventTime ? formatTime(v.eventTime, 'bn') : ''}</span>,
    },
    dateRow('endDate', 'Last day'),
    dateRow('issueDate', 'Letter date'),
    textRow('visitingHours', 'Visiting hours', '10:00 AM to 7:00 PM'),
    'Message sender',
    textRow('contactName', 'Name', 'Full name'),
    textRow('contactTitle', 'Title', 'Deputy General Manager'),
    {
      key: 'contactPhone', label: 'Phone',
      en: <input value={v.contactPhone} placeholder="017XXXXXXXX" aria-label="Contact phone" onChange={e => set(cur => ({ ...cur, contactPhone: e.target.value }), ['contactPhone'])} className={cn(cell, 'w-48')} />,
      bn: <span lang="bn" className="px-1.5 font-['Hind_Siliguri'] text-[12.5px] text-zinc-500">{v.contactPhone ? toBnDigits(v.contactPhone) : ''}</span>,
    },
  ];

  /* ---------- Guests ---------- */
  const setGuests = (list: Guest[]) => set(cur => ({ ...cur, specialGuests: list }), ['specialGuests']);
  const setChief = (g: Guest | null) => set(cur => ({ ...cur, chiefGuest: g }), ['chiefGuest']);
  const updGuest = (id: string, fn: (g: Guest) => Guest) => {
    if (v.chiefGuest?.id === id) setChief(fn(v.chiefGuest));
    else setGuests(guests.map(g => (g.id === id ? fn(g) : g)));
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d; if (j < 0 || j >= guests.length) return;
    const list = [...guests]; [list[i], list[j]] = [list[j], list[i]]; setGuests(list);
  };
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const list = [...guests];
    const [item] = list.splice(list.findIndex(g => g.id === dragId), 1);
    list.splice(list.findIndex(g => g.id === targetId), 0, item);
    setGuests(list);
  };
  const blank = (): Guest => ({ id: newId(), prefixes: [prefixBi('Mr.')], name: { en: '', bn: '' }, postfixes: [], designation: { en: '', bn: '' } });
  const host = hostIndex(v);

  const guestRow = (g: Guest, i: number | null) => {
    const lock = !!g.noTranslate;
    const key = i === null ? 'chiefGuest' : `specialGuests:${i + 1}`;
    const selKey = i === null ? 'guest:chief' : 'guest:' + g.id;
    const label = g.name.en || (i === null ? 'chief guest' : `guest ${i + 1}`);
    return (
      <tr key={g.id} className={cn('group', overId === g.id && dragId !== g.id && 'border-t-2 border-t-pink-500')}
        onDragOver={i !== null ? e => { if (dragId) { e.preventDefault(); setOverId(g.id); } } : undefined}
        onDrop={i !== null ? e => { e.preventDefault(); dropOn(g.id); setDragId(null); setOverId(null); } : undefined}>
        <td className={cn(td, 'w-6 text-center')}>
          {!lock && <input type="checkbox" aria-label={`Select ${label} for translation`} checked={sel(selKey)} onChange={e => toggle(selKey, e.target.checked)} className="size-3.5 accent-indigo-600" />}
        </td>
        <td className={cn(td, 'w-14 whitespace-nowrap')}>
          <div className="flex items-center gap-0.5">
            {i !== null
              ? <span draggable onDragStart={e => { setDragId(g.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', g.id); }} onDragEnd={() => { setDragId(null); setOverId(null); }}
                title="Drag to reorder" className="cursor-grab text-zinc-300 hover:text-zinc-500 active:cursor-grabbing"><GripVertical className="size-3.5" /></span>
              : <span className="w-3.5" />}
            {i !== null
              ? <span className="flex size-5 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: colorFor(key) }}>{i + 1}</span>
              : <span className="rounded px-1 text-[10px] font-bold uppercase text-white" style={{ background: colorFor('chiefGuest') }}>Chief</span>}
          </div>
        </td>
        <td className={cn(td, 'w-24')}><TokensCell list={g.prefixes} kind="prefix" lock={lock} label={`${label} prefix`} onChange={l => updGuest(g.id, x => ({ ...x, prefixes: l }))} /></td>
        <td className={td}><input value={g.name.en} placeholder="Full name" aria-label={`${label} name English`} onChange={e => updGuest(g.id, x => ({ ...x, name: lock ? { ...x.name, en: e.target.value } : withEn(x.name, e.target.value, 'name') }))} className={cn(cell, 'font-semibold')} /></td>
        <td className={td}><input lang="bn" value={g.name.bn} placeholder="পূর্ণ নাম" aria-label={`${label} name Bangla`} onChange={e => updGuest(g.id, x => ({ ...x, name: withBn(x.name, e.target.value) }))} className={cn(bnCell, 'font-semibold')} /></td>
        <td className={cn(td, 'w-20')}><TokensCell list={g.postfixes} kind="postfix" lock={lock} label={`${label} postfix`} onChange={l => updGuest(g.id, x => ({ ...x, postfixes: l }))} /></td>
        <td className={td}><input value={g.designation.en} placeholder="Title, organization" aria-label={`${label} designation English`} onChange={e => updGuest(g.id, x => ({ ...x, designation: lock ? { ...x.designation, en: e.target.value } : withEn(x.designation, e.target.value, 'designation') }))} title={g.designation.en} className={cell} /></td>
        <td className={td}><input lang="bn" value={g.designation.bn} placeholder="পদবি, প্রতিষ্ঠান" aria-label={`${label} designation Bangla`} onChange={e => updGuest(g.id, x => ({ ...x, designation: withBn(x.designation, e.target.value) }))} title={g.designation.bn} className={bnCell} /></td>
        <td className={cn(td, 'w-12 text-center')}>
          {i !== null && (
            <label title="Host: gives the welcome speech in the MC Script" className="flex cursor-pointer justify-center">
              <input type="radio" name="sv-sheet-host" aria-label={`Host: ${label}`} checked={i === host} onChange={() => set(cur => ({ ...cur, hostGuestId: g.id }), ['specialGuests'])} className="size-3.5 accent-stone-600" />
            </label>
          )}
        </td>
        <td className={cn(td, 'w-14')}><NoTr on={lock} onChange={on => { updGuest(g.id, x => ({ ...x, noTranslate: on || undefined })); if (on) toggle(selKey, false); }} label={label} /></td>
        <td className={cn(td, 'w-[120px] whitespace-nowrap')}>
          <div className="flex justify-end opacity-40 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <IconButton label={`Translate ${label} offline`} className="size-6" disabled={lock} onClick={() => updGuest(g.id, x => autoGuest(x, true))}><Languages className="size-3.5" /></IconButton>
            {i !== null && <IconButton label="Move up" className="size-6" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></IconButton>}
            {i !== null && <IconButton label="Move down" className="size-6" disabled={i === guests.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></IconButton>}
            {i !== null && <IconButton label="Duplicate" className="size-6" onClick={() => { const list = [...guests]; list.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(g)), id: newId() }); setGuests(list); }}><Copy className="size-3.5" /></IconButton>}
            <IconButton label={`Remove ${label}`} className="size-6 text-red-600" onClick={() => (i === null ? setChief(null) : setGuests(guests.filter(x => x.id !== g.id)))}><Trash2 className="size-3.5" /></IconButton>
          </div>
        </td>
      </tr>
    );
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4 backdrop-blur-[2px]" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <datalist id="sv-prefixes-sheet">{EN_PREFIXES.map(x => <option key={x} value={x} />)}</datalist>
      <div role="dialog" aria-modal="true" aria-label="Shared values sheet" className="flex h-[90vh] w-[min(1400px,96vw)] animate-in flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-pop">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2">
          <Sheet className="size-4 text-indigo-600" />
          <h2 className="text-[14px] font-semibold text-zinc-950">Shared values</h2>
          <span className="text-[12px] text-zinc-400">Changes apply to every document instantly</span>
          <div className="ml-auto flex items-center gap-1">
            <IconButton label="Undo" disabled={!p.canUndo} onClick={p.undo}><Undo2 className="size-4" /></IconButton>
            <IconButton label="Redo" disabled={!p.canRedo} onClick={p.redo}><Redo2 className="size-4" /></IconButton>
            <label className="ml-1 flex items-center gap-1 text-[12px] text-zinc-600" title="Select every value for translating">
              <input type="checkbox" className="size-3.5 accent-indigo-600" checked={allKeys.length > 0 && allKeys.every(k => selected.has(k))} onChange={e => setSelected(e.target.checked ? new Set(allKeys) : new Set())} />
              {selected.size ? `${selected.size} selected` : 'All'}
            </label>
            <Menu align="end" width="w-72" items={[
              { label: selected.size ? `Translate ${selected.size} selected to Bangla` : 'Translate all values to Bangla', heading: true },
              { label: 'Offline dictionary', icon: <Languages />, hint: 'instant', onSelect: () => onTranslate('offline') },
              ...providers.map(pr => ({ label: pr.label, icon: <Sparkles />, onSelect: () => onTranslate(pr.id) })),
              { separator: true, label: '' },
              { label: 'Values marked “Don\'t translate” are skipped', disabled: true },
            ]} trigger={t => <Button size="sm" variant={selected.size ? 'primary' : 'outline'} loading={translating} {...t}><Languages className="size-3.5" />{selected.size ? 'Translate' : 'Translate all'}<ChevronDown className="size-3 opacity-60" /></Button>} />
            <IconButton label="Close sheet" onClick={onClose}><X className="size-4" /></IconButton>
          </div>
        </div>

        <div className="sv-scroll min-h-0 flex-1 overflow-auto px-3 pb-4">
          {/* Values */}
          <table className="mt-2 w-full min-w-[860px] table-fixed border-separate border-spacing-0">
            <colgroup><col style={{ width: 28 }} /><col style={{ width: 170 }} /><col /><col /><col style={{ width: 56 }} /><col style={{ width: 48 }} /></colgroup>
            <thead><tr>
              <th className={th} /><th className={th}>Value</th><th className={th}>English</th><th className={th}>বাংলা</th>
              <th className={cn(th, 'text-center normal-case')} title="Don't translate">Don't tr.</th><th className={cn(th, 'text-center')}>Used</th>
            </tr></thead>
            <tbody>
              {rows.map(r => typeof r === 'string'
                ? <tr key={r}><td colSpan={6} className="px-1.5 pb-0.5 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-400">{r}</td></tr>
                : (
                  <tr key={r.key} className="hover:bg-zinc-50/80">
                    <td className={cn(td, 'text-center')}>{r.check}</td>
                    <td className={cn(td, 'whitespace-nowrap')}><span className="flex items-center gap-1.5 truncate px-1 text-[12.5px] font-medium text-zinc-700"><Swatch k={r.key} />{r.label}</span></td>
                    <td className={td}>{r.en}</td>
                    <td className={td}>{r.bn}</td>
                    <td className={td}>{r.noTr}</td>
                    <td className={td}><Used k={r.key} /></td>
                  </tr>
                ))}
            </tbody>
          </table>

          {/* Guests */}
          <div className="mt-5 flex items-center gap-2 px-1">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-zinc-500">Guests</h3>
            <span className="text-[11.5px] text-zinc-400">Chief guest, then special guests in printed order · drag ⋮⋮ to reorder · ◉ = host (welcome speech)</span>
          </div>
          <table className="mt-1 w-full min-w-[1120px] table-fixed border-separate border-spacing-0">
            <colgroup>
              <col style={{ width: 28 }} /><col style={{ width: 64 }} /><col style={{ width: 96 }} /><col style={{ width: '16%' }} /><col style={{ width: '16%' }} />
              <col style={{ width: 80 }} /><col /><col /><col style={{ width: 48 }} /><col style={{ width: 56 }} /><col style={{ width: 132 }} />
            </colgroup>
            <thead><tr>
              <th className={th} /><th className={th}>#</th><th className={th}>Prefix</th><th className={th}>Name</th><th className={th}>নাম</th><th className={th}>Postfix</th>
              <th className={th}>Designation</th><th className={th}>পদবি</th><th className={cn(th, 'text-center')}>Host</th><th className={cn(th, 'text-center normal-case')} title="Don't translate">Don't tr.</th><th className={th} />
            </tr></thead>
            <tbody>
              {v.chiefGuest ? guestRow(v.chiefGuest, null) : (
                <tr><td colSpan={11} className={td}><Button size="sm" variant="ghost" onClick={() => setChief(blank())}><Plus className="size-3.5" />Add chief guest</Button></td></tr>
              )}
              {guests.map((g, i) => guestRow(g, i))}
              <tr><td colSpan={11} className="pt-1"><Button size="sm" variant="outline" className="border-dashed" onClick={() => setGuests([...guests, blank()])}><Plus className="size-3.5" />Add special guest</Button>
                {host >= 0 && guests.length > 0 && <span className="ml-3 inline-flex items-center gap-1 text-[11.5px] text-zinc-400"><Mic className="size-3" />Host: {guests[host]?.name.en || '—'}</span>}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>,
    document.body,
  );
}
