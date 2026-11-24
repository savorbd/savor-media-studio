import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, Bot, ChevronDown, ChevronLeft, ChevronRight, Eye, FileText, GitCompareArrows, History, LayoutGrid, Loader2, Monitor, RotateCcw, Save,
  Search, SlidersHorizontal, Tag, User, X,
} from 'lucide-react';
import {
  HistoryHunk, HistoryInfo, HistoryResult, ProjectVersion, RenderResult, TrackChanges, TrackHead, TrackMove, TrackVersion,
  getAuthor, setAuthor, studioApi,
} from '../utils/studioServer';
import { shortDocLabel } from '../editor/templates';
import { wordDiff } from '../editor/wordDiff';
import { Button, Dialog, IconButton, Input, Label, Spinner, Textarea, cn, relativeTime, useConfirm, useToast } from '../ui/ui';

/* ---------- Small helpers ---------- */

export const VALUES = 'values';
export const trackName = (t: { kind: string; file?: string; label?: string }) => (t.kind === 'values' ? 'Shared values' : shortDocLabel(t.file || `${t.label}.html`));
export const trackChip = (t: { kind: string; file?: string; label?: string }) => {
  if (t.kind === 'values') return 'Values';
  return shortDocLabel(t.file || `${t.label}.html`).replace('Invitation', 'Inv').replace('Press Release', 'PR').replace('MC Script', 'MC')
    .replace(/\s*\(?Bangla\)?/, ' BN').replace(/\s*\(?English\)?/, ' EN');
};
const secs = (iso: string) => Date.parse(iso) / 1000;
export const fullTime = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const isProjectVersion = (v: ProjectVersion | TrackVersion): v is ProjectVersion => 'n' in v;
export const vcode = (k: number) => (k / 10).toFixed(1);

export const SOURCE: Record<string, { label: string; icon: React.ReactNode }> = {
  studio: { label: 'Studio', icon: <Monitor className="size-3" /> },
  mcp: { label: 'AI (MCP)', icon: <Bot className="size-3" /> },
  restore: { label: 'Restore', icon: <RotateCcw className="size-3" /> },
  import: { label: 'Older history', icon: <Archive className="size-3" /> },
};

/** Rendered versions never change: cache them for the canvas and previews. */
const renderCache = new Map<string, Promise<RenderResult>>();
export function renderVersion(project: string, track: string, k: number, against?: number | null): Promise<RenderResult> {
  const key = `${project}|${track}|${k}|${against ?? ''}`;
  let p = renderCache.get(key);
  if (!p) {
    p = studioApi.historyRender(project, track, k, against);
    p.catch(() => renderCache.delete(key));
    renderCache.set(key, p);
    if (renderCache.size > 400) renderCache.delete(renderCache.keys().next().value as string);
  }
  return p;
}

/* ---------- Current versions ---------- */

/** The project's and every document's current version, refreshed after saves and remote changes. */
export function useHistoryInfo(enabled: boolean, project: string, tick: number) {
  const [info, setInfo] = useState<HistoryInfo | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    try { const r = await studioApi.history(project, '', 0, 1); setInfo({ head: r.head, tracks: r.tracks }); } catch { /* offline: keep the last one */ }
  }, [enabled, project]);
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void refresh(), tick ? 700 : 0);
    return () => window.clearTimeout(timer.current);
  }, [refresh, tick]);
  return { info, setInfo, refresh };
}

type StepHead = { effective: number; effective_code: string; can_back: boolean; can_forward: boolean; latest: number };
export const projectStepHead = (i: HistoryInfo | null): StepHead | null => (i ? { ...i.head, latest: i.head.n } : null);
export const trackStepHead = (t: TrackHead | undefined): StepHead | null => (t ? { ...t, latest: t.k } : null);

/** ◀ v1.3 ▶ — for the project, or (compact) for one document. */
export function VersionStepper({ head, label, open, busy, onToggle, onStep, compact, arrows = true }: {
  head: StepHead | null; label?: string; open: boolean; busy: boolean; onToggle: () => void; onStep: (dir: 'back' | 'forward') => void; compact?: boolean; arrows?: boolean;
}) {
  const arrow = cn('grid place-items-center rounded-md text-zinc-600 hover:bg-white hover:shadow-soft disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:shadow-none', compact ? 'size-5' : 'size-6');
  const who = label || 'Project';
  return (
    <div className={cn('flex shrink-0 items-center rounded-lg bg-zinc-100 p-0.5', compact ? 'h-6' : 'h-7')} role="group" aria-label={`${who} versions`}>
      {arrows && <button aria-label={`${who}: previous version`} title={head?.can_back ? `${who}: go back one version` : 'No earlier version'} disabled={!head?.can_back || busy}
        onClick={() => onStep('back')} className={arrow}><ChevronLeft className={compact ? 'size-3.5' : 'size-4'} /></button>}
      <button onClick={onToggle} aria-pressed={open} title={`${who} version history`}
        className={cn('flex items-center gap-1 rounded-md font-semibold tabular-nums transition-colors', compact ? 'h-5 px-1 text-[11.5px]' : 'h-6 px-1.5 text-[12.5px]', open ? 'bg-white text-indigo-700 shadow-soft' : 'text-zinc-700 hover:bg-white hover:shadow-soft')}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : label ? <FileText className={compact ? 'size-3' : 'size-3.5'} /> : <History className="size-3.5" />}
        {label && <span className="font-medium text-zinc-500">{label}</span>}
        {head?.effective ? `v${head.effective_code}` : label ? '—' : 'History'}
        {head && head.effective !== head.latest && <span className="size-1.5 rounded-full bg-amber-500" title={`Showing an earlier version (latest v${vcode(head.latest)})`} />}
      </button>
      {arrows && <button aria-label={`${who}: next version`} title={head?.can_forward ? `${who}: go forward one version` : 'No later version'} disabled={!head?.can_forward || busy}
        onClick={() => onStep('forward')} className={arrow}><ChevronRight className={compact ? 'size-3.5' : 'size-4'} /></button>}
    </div>
  );
}

/* ---------- Tag / description / author ---------- */

export function VersionInfoDialog({ open, title, description, initial, submit, onClose, onSubmit }: {
  open: boolean; title: string; description?: string; initial?: { tag: string; desc: string; author: string }; submit: string;
  onClose: () => void; onSubmit: (v: { tag: string; desc: string; author: string }) => Promise<void>;
}) {
  const [tag, setTag] = useState('');
  const [desc, setDesc] = useState('');
  const [author, setAuth] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setTag(initial?.tag || ''); setDesc(initial?.desc || ''); setAuth(initial ? initial.author : getAuthor()); setBusy(false); } }, [open]);
  const go = async () => {
    setBusy(true);
    try { if (author.trim() && !initial) setAuthor(author); await onSubmit({ tag: tag.trim(), desc: desc.trim(), author: author.trim() }); onClose(); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} width="max-w-md"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void go()}>{submit}</Button></>}>
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void go(); }}>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label htmlFor="sv-tag">Tag <span className="font-normal text-zinc-400">(optional)</span></Label>
            <Input id="sv-tag" data-autofocus maxLength={40} value={tag} onChange={e => setTag(e.target.value)} placeholder="e.g. Sent to press" className="mt-1" />
          </div>
          <div>
            <Label htmlFor="sv-author">Author <span className="font-normal text-zinc-400">(optional)</span></Label>
            <Input id="sv-author" maxLength={60} value={author} onChange={e => setAuth(e.target.value)} placeholder="Your name" className="mt-1" />
          </div>
        </div>
        <div>
          <Label htmlFor="sv-desc">Description <span className="font-normal text-zinc-400">(optional)</span></Label>
          <Textarea id="sv-desc" maxLength={500} rows={3} value={desc} onChange={e => setDesc(e.target.value)} placeholder="What changed and why" className="mt-1"
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void go(); }} />
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

/* ---------- Diff rendering ---------- */

const CONTEXT = 48;
/** Long unchanged stretches are shortened so the changed words stand out. */
function trimEq(s: string, first: boolean, last: boolean) {
  if (s.length <= CONTEXT * 2 + 10) return s;
  if (first && last) return s;
  if (first) return '… ' + s.slice(-CONTEXT).replace(/^\S*\s/, '');
  if (last) return s.slice(0, CONTEXT).replace(/\s\S*$/, '') + ' …';
  return s.slice(0, CONTEXT).replace(/\s\S*$/, '') + ' … ' + s.slice(-CONTEXT).replace(/^\S*\s/, '');
}

export function DiffText({ before, after, full }: { before?: string; after?: string; full?: boolean }) {
  const parts = useMemo(() => {
    const p = wordDiff(before || '', after || '');
    if (full || !before || !after) return p;
    return p.map((x, i) => (x.t === 'eq' ? { ...x, s: trimEq(x.s, i === 0, i === p.length - 1) } : x));
  }, [before, after, full]);
  if (!parts.length) return <span className="italic text-zinc-400">(empty)</span>;
  return (
    <>
      {parts.map((p, i) => p.t === 'eq'
        ? <span key={i} className="text-zinc-600">{p.s}</span>
        : p.t === 'add'
          ? <ins key={i} className="rounded-[3px] bg-emerald-100 px-px text-emerald-900 no-underline">{p.s}</ins>
          : <del key={i} className="rounded-[3px] bg-red-100 px-px text-red-800 decoration-red-400">{p.s}</del>)}
    </>
  );
}

function HunkRow({ h }: { h: HistoryHunk }) {
  const tone = h.label.startsWith('Removed') || h.op === 'removed' || h.op === 'deleted' || / removed$/.test(h.label) ? 'text-red-600'
    : h.label.startsWith('Added') || h.op === 'added' || h.op === 'created' || / added$/.test(h.label) ? 'text-emerald-700' : 'text-zinc-500';
  return (
    <li className="rounded-md border border-zinc-200 bg-white px-2 py-1.5">
      <span className={cn('text-[10.5px] font-semibold uppercase tracking-wide', tone)}>{h.label}</span>
      <div className="sv-scroll mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-snug">
        {h.kind === 'file' ? <span className="text-zinc-500">{h.text || '(empty)'}</span> : <DiffText before={h.before} after={h.after} />}
      </div>
    </li>
  );
}

/** The changes of one document (or the shared values) between two versions. */
export function ChangeList({ c, actions }: { c: TrackChanges; actions?: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-1">
        {c.kind === 'values' ? <SlidersHorizontal className="size-3.5 text-violet-600" /> : <FileText className="size-3.5 text-zinc-400" />}
        <span className="truncate text-[12px] font-semibold text-zinc-800">{c.kind === 'values' ? 'Shared values' : shortDocLabel(`${c.label}.html`)}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-zinc-400">{c.from_code ? `v${c.from_code} → ` : ''}{c.to_code ? `v${c.to_code}` : ''}</span>
        {c.op !== 'changed' && <span className={cn('rounded px-1 text-[10px] font-semibold uppercase', c.op === 'deleted' ? 'bg-red-50 text-red-700' : c.op === 'created' ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-600')}>{c.op}</span>}
        {actions && <span className="ml-auto flex shrink-0 items-center">{actions}</span>}
      </div>
      {!c.hunks.length ? <p className="pl-5 text-[11.5px] italic text-zinc-400">No visible change.</p> : (
        <ul className="space-y-1 pl-1">{c.hunks.map(h => <HunkRow key={h.id} h={h} />)}</ul>
      )}
    </section>
  );
}

export function MoveChip({ m }: { m: TrackMove }) {
  return (
    <span title={`${trackName(m)}: ${m.from_code ? `v${m.from_code} → ` : ''}v${m.to_code} (${m.op})`}
      className={cn('inline-flex items-center gap-0.5 rounded px-1 text-[10.5px] font-medium',
        m.op === 'created' ? 'bg-emerald-50 text-emerald-700' : m.op === 'deleted' ? 'bg-red-50 text-red-700' : m.kind === 'values' ? 'bg-violet-50 text-violet-700' : 'bg-zinc-100 text-zinc-600')}>
      {m.op === 'created' ? '+' : m.op === 'deleted' ? '−' : ''}{trackChip(m)}<span className="font-mono opacity-70">{m.to_code}</span>
    </span>
  );
}

function Meta({ v }: { v: ProjectVersion | TrackVersion }) {
  const src = SOURCE[v.source] || SOURCE.studio;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-zinc-400" title={`${src.label}${v.author ? ` · ${v.author}` : ''} · ${fullTime(v.time)}`}>
      {v.author && <span className="max-w-[80px] truncate text-zinc-500">{v.author}</span>}{src.icon}{relativeTime(secs(v.end))}
    </span>
  );
}

/* ---------- Panel ---------- */

export type HistoryScope = 'project' | string; // or a track id
type Filter = 'all' | 'tagged';
export type AnyVersion = ProjectVersion | TrackVersion;
export const vnum = (v: AnyVersion) => (isProjectVersion(v) ? v.n : v.k);

export function HistoryPanel({ project, info, onInfo, tick, scope, onScope, run, onPreview, onCompare, onCanvas, onClose }: {
  project: string;
  info: HistoryInfo | null;
  onInfo: (i: HistoryInfo) => void;
  tick: number;
  scope: HistoryScope;
  onScope: (s: HistoryScope) => void;
  /** Runs a restore or step on the server: saves first, reloads the pages after. */
  run: (label: string, fn: () => Promise<HistoryResult>) => Promise<HistoryResult | null>;
  onPreview: (scope: HistoryScope, v: AnyVersion, prev: number | null) => void;
  onCompare: (scope: HistoryScope, a: number, b: number) => void;
  onCanvas: (scope: HistoryScope) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [versions, setVersions] = useState<AnyVersion[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const openRef = useRef<number | null>(null);
  openRef.current = open;
  const fetchDetailRef = useRef<(n: number, force?: boolean) => Promise<void>>(async () => {});
  const [details, setDetails] = useState<Record<string, TrackChanges[]>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState<AnyVersion | 'new' | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [author, setAuth] = useState(getAuthor());
  const isTrack = scope !== 'project';
  const track = isTrack ? info?.tracks.find(t => t.track === scope) : undefined;
  const scopeKey = isTrack ? scope : '';
  const head = isTrack ? trackStepHead(track) : projectStepHead(info);

  const load = useCallback(async () => {
    try {
      const r = await studioApi.history<AnyVersion>(project, scopeKey, 0, 300);
      setVersions(r.versions); setMore(r.more); onInfo({ head: r.head, tracks: r.tracks }); setError('');
      // A version still collecting changes may have grown: reload its details (now, if it is expanded).
      const grown = r.versions.filter(v => isProjectVersion(v) && v.open).map(vnum);
      if (grown.length) {
        setDetails(d => { const n = { ...d }; for (const g of grown) delete n[`${scopeKey}:${g}`]; return n; });
        if (openRef.current !== null && grown.includes(openRef.current)) void fetchDetailRef.current(openRef.current, true);
      }
    } catch (e: any) { setError(e?.message || 'Could not load the history.'); setVersions(v => v || []); }
  }, [project, scopeKey]);
  useEffect(() => { setVersions(null); setOpen(null); setPicking(null); }, [scopeKey]);
  useEffect(() => { void load(); }, [load, tick]);

  const loadOlder = async () => {
    if (!versions?.length) return;
    const r = await studioApi.history<AnyVersion>(project, scopeKey, vnum(versions[versions.length - 1]), 300);
    setVersions([...versions, ...r.versions]); setMore(r.more);
  };

  const fetchDetail = async (n: number, force = false) => {
    const key = `${scopeKey}:${n}`;
    if (details[key] && !force) return;
    try { const r = await studioApi.historyVersion(project, n, scopeKey); setDetails(d => ({ ...d, [key]: r.changes })); }
    catch (e: any) { toast('Could not load this version', { tone: 'error', description: e?.message }); }
  };
  fetchDetailRef.current = fetchDetail;
  const toggle = (n: number) => {
    if (picking !== null) { if (n !== picking) onCompare(scope, Math.min(picking, n), Math.max(picking, n)); setPicking(null); return; }
    setOpen(o => (o === n ? null : n)); void fetchDetail(n);
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (versions || []).filter(v => {
      if (filter === 'tagged' && !v.tag) return false;
      if (!q) return true;
      const extra = isProjectVersion(v) ? v.changes.map(c => trackName(c)) : [`p${v.project_code}`];
      return [`v${v.code}`, v.code, v.tag, v.desc, v.author, ...extra].some(s => s.toLowerCase().includes(q));
    });
  }, [versions, filter, query]);
  const prevOf = (v: AnyVersion) => {
    const list = versions || [];
    const i = list.indexOf(v);
    return i >= 0 && i + 1 < list.length ? vnum(list[i + 1]) : null;
  };

  const act = async (label: string, fn: () => Promise<HistoryResult>) => {
    setBusy(true);
    try { const r = await run(label, fn); if (r) { onInfo({ head: r.head, tracks: r.tracks }); await load(); } } finally { setBusy(false); }
  };
  const name = isTrack ? (track ? trackName(track) : 'Document') : 'Project';
  const restore = async (v: AnyVersion) => {
    const what = isTrack ? `${name} to v${v.code}` : `the project to v${v.code}`;
    const description = !isTrack ? 'Every document and the shared values go back to how they were in this version.'
      : track?.kind === 'values' ? 'The shared values go back to this version — every document follows.'
        : 'Only this document changes. It shows the current shared values.';
    if (!(await confirm({ title: `Restore ${what}?`, description: `${description} This becomes a new version, so you can go forward again.`, confirm: 'Restore' }))) return;
    await act(`Restored ${what}`, () => studioApi.historyRestore(project, vnum(v), scopeKey));
  };
  const step = (dir: 'back' | 'forward') => act('', () => studioApi.historyStep(project, dir, scopeKey));

  const saveInfo = async ({ tag, desc, author: who }: { tag: string; desc: string; author: string }) => {
    if (naming === 'new') {
      const r = await studioApi.historyCommit(project, tag, desc, who);
      onInfo({ head: r.head, tracks: r.tracks });
      toast(r.new_changes ? `Saved version v${r.version?.code}` : `Named v${r.version?.code}`);
    } else if (naming) {
      await studioApi.historyInfo(project, vnum(naming), { tag, description: desc, author: who }, scopeKey);
      toast(`Updated v${naming.code}`);
    }
    await load();
  };

  const tabs: { id: HistoryScope; label: string; code: string; earlier?: boolean; deleted?: boolean }[] = [
    { id: 'project', label: 'Project', code: info?.head.effective_code || '', earlier: !!info && info.head.effective !== info.head.n },
    ...(info?.tracks || []).map(t => ({ id: t.track, label: trackChip(t), code: t.effective_code, earlier: t.effective !== t.k, deleted: t.deleted })),
  ];

  return (
    <aside className="flex w-[370px] shrink-0 flex-col border-l border-zinc-200 bg-zinc-50 max-xl:absolute max-xl:bottom-0 max-xl:right-0 max-xl:top-10 max-xl:z-30 max-xl:shadow-pop">
      <div className="flex items-center gap-1 border-b border-zinc-200 bg-white px-2 py-1.5">
        <History className="size-4 text-indigo-600" />
        <h2 className="text-[13px] font-semibold text-zinc-900">History</h2>
        <Button size="sm" variant="ghost" className="ml-auto h-6 px-1.5 text-[12px]" onClick={() => onCanvas(scope)} title="See every version side by side"><LayoutGrid className="size-3.5" />Canvas</Button>
        <Button size="sm" variant="primary" className="h-6 px-2 text-[12px]" onClick={() => setNaming('new')} title="Close the current version, with an optional tag, description and author (Ctrl+S also saves a version)">
          <Save className="size-3.5" />Save version
        </Button>
        <IconButton label="Close history" onClick={onClose}><X className="size-4" /></IconButton>
      </div>

      {/* Every timeline at a glance: the project, the shared values and each document. */}
      <div role="tablist" aria-label="Timelines" className="no-scrollbar flex gap-0.5 overflow-x-auto border-b border-zinc-200 bg-white px-1.5 pt-1">
        {tabs.map(t => (
          <button key={t.id} role="tab" aria-selected={scope === t.id} onClick={() => onScope(t.id)} title={t.id === 'project' ? 'Project versions (every change)' : `${t.label} versions`}
            className={cn('flex shrink-0 items-center gap-1 border-b-2 px-1.5 pb-1 pt-0.5 text-[11.5px] font-medium transition-colors', scope === t.id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-zinc-500 hover:text-zinc-800', t.deleted && 'line-through opacity-60')}>
            {t.id === VALUES && <SlidersHorizontal className="size-3" />}{t.label}
            {t.code && <span className={cn('rounded px-0.5 font-mono text-[10.5px]', scope === t.id ? 'bg-indigo-50' : 'bg-zinc-100')}>{t.code}</span>}
            {t.earlier && <span className="size-1.5 rounded-full bg-amber-500" title="Showing an earlier version" />}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1 border-b border-zinc-200 px-2 py-1.5">
        <VersionStepper compact head={head} label={isTrack && track ? trackChip(track) : undefined} open={false} busy={busy} onToggle={() => {}} onStep={d => void step(d)} />
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search tag, author, v1.2…" aria-label="Search versions"
            className="h-6 w-full rounded-md border border-zinc-200 bg-white pl-7 pr-2 text-[12px] placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none" />
        </div>
        <div role="radiogroup" aria-label="Show" className="flex h-6 items-center rounded-md bg-zinc-200/60 p-0.5">
          {([['all', 'All'], ['tagged', 'Tagged']] as [Filter, string][]).map(([f, l]) => (
            <button key={f} role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}
              className={cn('h-5 rounded px-1.5 text-[11px] font-medium', filter === f ? 'bg-white text-zinc-900 shadow-soft' : 'text-zinc-500 hover:text-zinc-800')}>{l}</button>
          ))}
        </div>
      </div>

      {picking !== null && (
        <div className="flex items-center gap-2 border-b border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-[12px] text-indigo-800">
          <GitCompareArrows className="size-3.5" />Pick another version to compare with v{vcode(picking)}
          <button className="ml-auto font-medium hover:underline" onClick={() => setPicking(null)}>Cancel</button>
        </div>
      )}

      <div className="sv-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
        {versions === null ? <div className="grid place-items-center py-10"><Spinner /></div>
          : error && !versions.length ? <p className="m-2 rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{error}</p>
            : !versions.length ? (
              <div className="px-4 py-10 text-center">
                <History className="mx-auto size-6 text-zinc-300" />
                <p className="mt-2 text-[13px] font-medium text-zinc-700">No versions yet</p>
                <p className="mt-1 text-[12px] text-zinc-500">Every saved change becomes a version: 0.1, 0.2 … 1.0. Edits within a minute are grouped together.</p>
              </div>
            ) : !shown.length ? <p className="px-3 py-6 text-center text-[12.5px] text-zinc-500">No versions match.</p> : (
              <ol className="space-y-1">
                {shown.map(v => {
                  const n = vnum(v);
                  const isOpen = open === n;
                  const now = head?.effective === n;
                  const ch = details[`${scopeKey}:${n}`];
                  const pv = isProjectVersion(v) ? v : null;
                  const tv = isProjectVersion(v) ? null : v;
                  return (
                    <li key={n} className={cn('rounded-lg border bg-white transition-shadow', isOpen ? 'border-indigo-200 shadow-soft' : 'border-transparent hover:border-zinc-200',
                      now && !isOpen && 'border-indigo-100 bg-indigo-50/40', picking !== null && picking !== n && 'cursor-copy ring-1 ring-indigo-200 hover:ring-indigo-400')}>
                      <button onClick={() => toggle(n)} aria-expanded={isOpen} className="block w-full px-2 py-1.5 text-left">
                        <div className="flex items-center gap-1.5">
                          <span className={cn('rounded px-1 font-mono text-[11.5px] font-semibold tabular-nums', now ? 'bg-indigo-600 text-white' : 'bg-zinc-100 text-zinc-700')}>v{v.code}</span>
                          {tv && <span className="font-mono text-[10.5px] text-zinc-400" title={`Part of project version ${tv.project_code}`}>p{tv.project_code}</span>}
                          {v.tag && <span className="flex min-w-0 items-center gap-0.5 truncate rounded-full bg-amber-100 px-1.5 text-[11px] font-medium text-amber-800"><Tag className="size-2.5 shrink-0" /><span className="truncate">{v.tag}</span></span>}
                          {now && <span className="text-[10.5px] font-semibold uppercase tracking-wide text-indigo-600">Now</span>}
                          {pv?.open && <span className="flex items-center gap-1 text-[10.5px] text-emerald-700" title="Changes in the next minute join this version"><span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />Open</span>}
                          <Meta v={v} />
                          <ChevronDown className={cn('size-3.5 shrink-0 text-zinc-400 transition-transform', isOpen && 'rotate-180')} />
                        </div>
                        {v.desc && <p className={cn('mt-0.5 text-[12px] text-zinc-600', !isOpen && 'truncate')}>{v.desc}</p>}
                        {!isOpen && pv && !!pv.changes.length && (
                          <div className="mt-1 flex flex-wrap gap-0.5">{pv.changes.map(m => <MoveChip key={m.track} m={m} />)}</div>
                        )}
                      </button>
                      {isOpen && (
                        <div className="space-y-2 border-t border-zinc-100 px-2 pb-2 pt-1.5">
                          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500">
                            <span className="flex items-center gap-1">{(SOURCE[v.source] || SOURCE.studio).icon}{(SOURCE[v.source] || SOURCE.studio).label}</span>
                            {v.author && <span className="flex items-center gap-1"><User className="size-3" />{v.author}</span>}
                            <span>{fullTime(v.time)}</span>
                            <button onClick={() => setNaming(v)} className="ml-auto flex items-center gap-1 rounded px-1 font-medium text-indigo-600 hover:bg-indigo-50"><Tag className="size-3" />{v.tag || v.desc || v.author ? 'Edit' : 'Tag'}</button>
                          </div>
                          {!ch ? <div className="py-3 text-center"><Spinner /></div> : !ch.length ? <p className="text-[12px] italic text-zinc-400">No visible changes.</p> : (
                            <div className="space-y-2">
                              {ch.map(c => (
                                <ChangeList key={c.track} c={c} actions={!isTrack ? (
                                  <button onClick={() => onScope(c.track)} title={`Open the ${c.kind === 'values' ? 'shared values' : 'document'} history`} className="rounded px-1 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800">History</button>
                                ) : undefined} />
                              ))}
                            </div>
                          )}
                          <div className="flex flex-wrap items-center gap-1 pt-0.5">
                            <Button size="sm" className="h-6 px-2 text-[12px]" onClick={() => onPreview(scope, v, prevOf(v))}><Eye className="size-3.5" />Preview</Button>
                            <Button size="sm" className="h-6 px-2 text-[12px]" onClick={() => setPicking(n)} title="Compare with any other version"><GitCompareArrows className="size-3.5" />Compare</Button>
                            {now ? <span className="px-1 text-[11.5px] font-medium text-indigo-600" title="The pages already look like this version">Current version</span>
                              : <Button size="sm" className="h-6 px-2 text-[12px]" disabled={busy} onClick={() => void restore(v)}><RotateCcw className="size-3.5" />{busy ? 'Restoring…' : `Restore v${v.code}`}</Button>}
                            {busy && <Loader2 className="ml-auto size-3.5 animate-spin text-zinc-400" />}
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
        {more && !query && filter === 'all' && (
          <div className="py-2 text-center"><Button size="sm" variant="ghost" onClick={() => void loadOlder()}>Load older versions</Button></div>
        )}
      </div>
      <div className="flex items-center gap-1.5 border-t border-zinc-200 px-2.5 py-1 text-[11px] text-zinc-400">
        <User className="size-3" />
        <input value={author} onChange={e => { setAuth(e.target.value); setAuthor(e.target.value); }} placeholder="Your name (shown on versions)" aria-label="Your name"
          className="h-5 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-[11.5px] text-zinc-600 placeholder:text-zinc-400 hover:border-zinc-200 focus:border-indigo-300 focus:bg-white focus:outline-none" />
        <span className="shrink-0">Kept forever</span>
      </div>

      <VersionInfoDialog open={!!naming} onClose={() => setNaming(null)} onSubmit={saveInfo}
        title={naming === 'new' ? 'Save version' : naming ? `${isTrack ? name + ' ' : 'Project '}v${naming.code}` : ''}
        description={naming === 'new' ? 'Closes the current project version so the next change starts a new one.' : undefined}
        submit={naming === 'new' ? 'Save version' : 'Save'}
        initial={naming && naming !== 'new' ? { tag: naming.tag, desc: naming.desc, author: naming.author } : undefined} />
    </aside>
  );
}

/* ---------- Preview & compare ---------- */

const PREVIEW_CSS = `<style>
html{background:#f4f4f5}
body.sv-doc{margin:16px auto!important;box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06)}
[data-sv-diff]{position:relative;border-radius:3px}
[data-sv-diff=add]{background:#dcfce7;box-shadow:-6px 0 0 #22c55e}
[data-sv-diff=chg]{background:#fef9c3;box-shadow:-6px 0 0 #eab308}
[data-sv-diff=del]{background:#fee2e2;box-shadow:-6px 0 0 #ef4444;text-decoration:line-through;text-decoration-color:#f87171;opacity:.75}
[data-sv-diff=edit]{box-shadow:-6px 0 0 #eab308}
[data-sv-w=add]{background:#bbf7d0;color:#14532d;border-radius:2px;box-shadow:0 0 0 1px #86efac}
[data-sv-w=del]{background:#fecaca;color:#7f1d1d;border-radius:2px;text-decoration:line-through;text-decoration-color:#dc2626}
</style>`;
export const withPreviewCss = (html: string, extra = '') => html.replace('</head>', PREVIEW_CSS + extra + '</head>');

export function ValuesCard({ r, dense }: { r: RenderResult; dense?: boolean }) {
  const fields = (r.fields || []).filter(f => !dense || f.changed || f.en || f.bn);
  return (
    <div className={cn('space-y-0.5', dense ? 'text-[11px]' : 'text-[12.5px]')}>
      {fields.map(f => (
        <div key={f.key} className={cn('flex gap-2 rounded px-1.5 py-0.5', f.changed && 'bg-yellow-100 ring-1 ring-yellow-300')}>
          <span className={cn('shrink-0 text-zinc-500', dense ? 'w-20 truncate' : 'w-32')}>{f.label}</span>
          <span className="min-w-0 flex-1 truncate text-zinc-900" title={[f.en, f.bn].filter(Boolean).join(' · ')}>{f.en || <span className="text-zinc-300">—</span>}{f.bn && f.bn !== f.en && <span className="text-zinc-500"> · {f.bn}</span>}</span>
        </div>
      ))}
      <div className={cn('rounded px-1.5 py-0.5', r.guests_changed && 'bg-yellow-100 ring-1 ring-yellow-300')}>
        <span className="text-zinc-500">Special guests ({r.guests?.length || 0})</span>
        <ol className="ml-4 list-decimal">
          {(r.guests || []).slice(0, dense ? 6 : 99).map((g, i) => <li key={i} className="truncate text-zinc-800">{g.en}{g.host && <span className="ml-1 rounded bg-indigo-50 px-1 text-[10px] text-indigo-700">host</span>}</li>)}
          {dense && (r.guests?.length || 0) > 6 && <li className="list-none text-zinc-400">+{(r.guests?.length || 0) - 6} more</li>}
        </ol>
      </div>
    </div>
  );
}

export type PreviewTarget = {
  title: React.ReactNode; subtitle?: string;
  tabs: { track: string; label: string; k: number; against?: number; changed: boolean }[]; // against: undefined = the version before
  initial?: string; onRestore?: () => void; restoreLabel?: string; changes?: TrackChanges[];
};

/** A document (or the shared values) at a version with what changed marked. Also shows a comparison of two versions. */
export function VersionPreview({ project, target, onClose }: { project: string; target: PreviewTarget | null; onClose: () => void }) {
  const [tab, setTab] = useState<string | undefined>();
  const [data, setData] = useState<RenderResult | null>(null);
  const [error, setError] = useState('');
  const [showList, setShowList] = useState(false);
  useEffect(() => { setTab(target?.initial || target?.tabs.find(t => t.changed)?.track || target?.tabs[0]?.track); setShowList(!!target?.changes && !target.tabs.length); }, [target]);
  const cur = target?.tabs.find(t => t.track === tab);
  useEffect(() => {
    if (!cur) return;
    setData(null); setError('');
    renderVersion(project, cur.track, cur.k, cur.against).then(setData).catch(e => setError(e?.message || 'Could not load this version.'));
  }, [project, cur?.track, cur?.k, cur?.against]);
  if (!target) return null;
  return (
    <Dialog open onClose={onClose} width="max-w-5xl" title={target.title} description={target.subtitle}
      footer={<>
        <span className="mr-auto flex items-center gap-3 text-[12px] text-zinc-500">
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-emerald-400" />Added</span>
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-yellow-400" />Changed</span>
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-red-400" />Removed</span>
        </span>
        {target.changes && !!target.tabs.length && <Button onClick={() => setShowList(s => !s)}>{showList ? 'Show pages' : 'List of changes'}</Button>}
        {target.onRestore && <Button variant="primary" onClick={() => { target.onRestore!(); onClose(); }}><RotateCcw className="size-4" />{target.restoreLabel || 'Restore'}</Button>}
      </>}>
      <div className="-mt-1 mb-2 flex flex-wrap items-center gap-1">
        {target.tabs.map(t => (
          <button key={t.track} onClick={() => { setTab(t.track); setShowList(false); }} className={cn('flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium', t.track === tab && !showList ? 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200' : 'text-zinc-600 hover:bg-zinc-100')}>
            {t.changed && <span className="size-1.5 rounded-full bg-amber-500" title="Changed" />}{t.label}<span className="font-mono text-[11px] text-zinc-400">v{vcode(t.k)}</span>
          </button>
        ))}
        {data && !showList && <span className="ml-auto text-[12px] text-zinc-500">{data.deleted ? 'Deleted' : data.changes ? `${data.changes} change${data.changes === 1 ? '' : 's'} highlighted${data.against && data.against !== data.code ? ` (since v${data.against})` : ''}` : 'No changes'}</span>}
      </div>
      <div className="h-[66vh] overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100">
        {showList && target.changes ? (
          <div className="sv-scroll h-full space-y-3 overflow-y-auto bg-white p-3">
            {target.changes.length ? target.changes.map(c => <ChangeList key={c.track} c={c} />) : <p className="py-10 text-center text-[13px] text-zinc-500">No differences.</p>}
          </div>
        ) : error ? <p className="p-6 text-center text-[13px] text-red-600">{error}</p>
          : !data ? <div className="grid h-full place-items-center"><Spinner className="size-5" /></div>
            : data.kind === 'values' ? <div className="sv-scroll h-full overflow-y-auto bg-white p-4"><ValuesCard r={data} /></div>
              : <iframe title="Version preview" sandbox="allow-same-origin" srcDoc={withPreviewCss(data.html || '')} className="size-full bg-zinc-100" />}
      </div>
    </Dialog>
  );
}

const TagPill = ({ tag }: { tag: string }) => <span className="rounded-full bg-amber-100 px-2 text-[12px] font-medium text-amber-800">{tag}</span>;

/** Every document and the values at a project version, with that version's changes marked. */
export function projectPreview(v: ProjectVersion, tracks: TrackHead[], opts: { initial?: string; onRestore?: () => void }): PreviewTarget {
  const moves = new Map(v.changes.map(m => [m.track, m]));
  const tabs = tracks.filter(t => v.heads[t.track] != null && moves.get(t.track)?.op !== 'deleted')
    .map(t => ({ track: t.track, label: trackChip(t), k: v.heads[t.track], against: moves.has(t.track) ? (moves.get(t.track)!.from ?? 0) : v.heads[t.track], changed: moves.has(t.track) }));
  return {
    title: <span className="flex items-center gap-2">Project v{v.code}{v.tag && <TagPill tag={v.tag} />}<span className="text-[13px] font-normal text-zinc-500">{fullTime(v.end)}{v.author ? ` · ${v.author}` : ''}</span></span>,
    subtitle: v.desc || undefined, tabs, initial: opts.initial && moves.has(opts.initial) ? opts.initial : undefined, onRestore: opts.onRestore, restoreLabel: `Restore project to v${v.code}`,
  };
}

/** One document's (or the values') version, marked against the version before it. */
export function trackPreview(v: TrackVersion, track: TrackHead, prevK: number | null, onRestore?: () => void): PreviewTarget {
  return {
    title: <span className="flex items-center gap-2">{trackName(track)} v{v.code}{v.tag && <TagPill tag={v.tag} />}<span className="text-[13px] font-normal text-zinc-500">project v{v.project_code} · {fullTime(v.end)}{v.author ? ` · ${v.author}` : ''}</span></span>,
    subtitle: v.desc || undefined, tabs: [{ track: track.track, label: trackChip(track), k: v.k, against: prevK ?? undefined, changed: true }],
    onRestore, restoreLabel: `Restore ${trackChip(track)} to v${v.code}`,
  };
}
