import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, Bot, ChevronDown, ChevronLeft, ChevronRight, Eye, FileText, History, Loader2, Monitor, RotateCcw, Save, Search, SlidersHorizontal, Tag, Undo2, X,
} from 'lucide-react';
import {
  HistoryChange, HistoryHead, HistoryHunk, HistoryResult, HistoryVersion, studioApi,
} from '../utils/studioServer';
import { shortDocLabel } from '../editor/templates';
import { wordDiff } from '../editor/wordDiff';
import { Button, Dialog, IconButton, Input, Label, Spinner, Textarea, cn, relativeTime, useConfirm, useToast } from '../ui/ui';

export const fileLabel = (f: string) => (f === 'project.json' ? 'Shared values' : shortDocLabel(f));
const shortChip = (f: string) => {
  if (f === 'project.json') return 'Values';
  const l = shortDocLabel(f);
  return l.replace('Invitation', 'Inv').replace('Press Release', 'PR').replace('MC Script', 'MC').replace(/\(Bangla\)|Bangla/, 'BN').replace(/\(English\)|English/, 'EN');
};
const secs = (iso: string) => Date.parse(iso) / 1000;
const fullTime = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

const SOURCE: Record<string, { label: string; icon: React.ReactNode }> = {
  studio: { label: 'Studio', icon: <Monitor className="size-3" /> },
  mcp: { label: 'AI (MCP)', icon: <Bot className="size-3" /> },
  restore: { label: 'Restore', icon: <RotateCcw className="size-3" /> },
  import: { label: 'Older history', icon: <Archive className="size-3" /> },
};

/* ---------- Head (current version) ---------- */

/** The project's latest version, refreshed after saves and remote changes. */
export function useVersionHead(enabled: boolean, project: string, tick: number) {
  const [head, setHead] = useState<HistoryHead | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    try { setHead((await studioApi.history(project, 0, 1)).head); } catch { /* offline: keep the last one */ }
  }, [enabled, project]);
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void refresh(), tick ? 700 : 0);
    return () => window.clearTimeout(timer.current);
  }, [refresh, tick]);
  return { head, setHead, refresh };
}

/** ◀ v1.3 ▶ in the app bar. */
export function VersionStepper({ head, open, busy, onToggle, onStep }: {
  head: HistoryHead | null; open: boolean; busy: boolean; onToggle: () => void; onStep: (dir: 'back' | 'forward') => void;
}) {
  const code = head?.effective_code;
  return (
    <div className="flex h-7 items-center rounded-lg bg-zinc-100 p-0.5" role="group" aria-label="Versions">
      <button aria-label="Previous version" title={head?.can_back ? 'Go back one version' : 'No earlier version'} disabled={!head?.can_back || busy}
        onClick={() => onStep('back')} className="grid h-6 w-6 place-items-center rounded-md text-zinc-600 hover:bg-white hover:shadow-soft disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:shadow-none">
        <ChevronLeft className="size-4" />
      </button>
      <button onClick={onToggle} aria-pressed={open} title="Version history"
        className={cn('flex h-6 items-center gap-1 rounded-md px-1.5 text-[12.5px] font-semibold tabular-nums transition-colors', open ? 'bg-white text-indigo-700 shadow-soft' : 'text-zinc-700 hover:bg-white hover:shadow-soft')}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <History className="size-3.5" />}
        {code ? `v${code}` : 'History'}
        {head && head.effective !== head.n && <span className="size-1.5 rounded-full bg-amber-500" title={`Showing an earlier version (latest is v${head.code})`} />}
      </button>
      <button aria-label="Next version" title={head?.can_forward ? 'Go forward one version' : 'No later version'} disabled={!head?.can_forward || busy}
        onClick={() => onStep('forward')} className="grid h-6 w-6 place-items-center rounded-md text-zinc-600 hover:bg-white hover:shadow-soft disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:shadow-none">
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

/* ---------- Save / name a version ---------- */

export function VersionInfoDialog({ open, title, description, initial, submit, onClose, onSubmit }: {
  open: boolean; title: string; description?: string; initial?: { tag: string; desc: string }; submit: string; onClose: () => void; onSubmit: (tag: string, desc: string) => Promise<void>;
}) {
  const [tag, setTag] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setTag(initial?.tag || ''); setDesc(initial?.desc || ''); setBusy(false); } }, [open]);
  const go = async () => { setBusy(true); try { await onSubmit(tag.trim(), desc.trim()); onClose(); } finally { setBusy(false); } };
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} width="max-w-md"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void go()}>{submit}</Button></>}>
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void go(); }}>
        <div>
          <Label htmlFor="sv-tag">Tag <span className="font-normal text-zinc-400">(optional)</span></Label>
          <Input id="sv-tag" data-autofocus maxLength={40} value={tag} onChange={e => setTag(e.target.value)} placeholder="e.g. Sent to press, Final draft" className="mt-1" />
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

function DiffText({ before, after }: { before?: string; after?: string }) {
  const parts = useMemo(() => wordDiff(before || '', after || ''), [before, after]);
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

function HunkRow({ h, onUndo, busy }: { h: HistoryHunk; onUndo: () => void; busy: boolean }) {
  const shared = h.kind === 'value';
  return (
    <li className="group/h relative rounded-md border border-zinc-200 bg-white px-2 py-1.5">
      <div className="flex items-center gap-1">
        <span className={cn('text-[10.5px] font-semibold uppercase tracking-wide', h.label.startsWith('Removed') || h.op === 'removed' || h.op === 'deleted' ? 'text-red-600' : h.label.startsWith('Added') || h.op === 'added' || h.op === 'created' ? 'text-emerald-700' : 'text-zinc-500')}>{h.label}</span>
        <button onClick={onUndo} disabled={busy} title={shared ? 'Undo this change — updates it in all documents' : 'Undo just this change'}
          className="ml-auto flex h-5 items-center gap-1 rounded px-1 text-[11px] font-medium text-zinc-500 opacity-70 hover:bg-indigo-50 hover:text-indigo-700 group-hover/h:opacity-100 disabled:opacity-30">
          <Undo2 className="size-3" />Undo{shared && <span className="text-zinc-400">· all docs</span>}
        </button>
      </div>
      <div className="sv-scroll mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-snug">
        {h.kind === 'file' ? <span className="text-zinc-500">{h.text || '(empty)'}</span> : <DiffText before={h.before} after={h.after} />}
      </div>
    </li>
  );
}

/* ---------- Panel ---------- */

type Filter = 'all' | 'tagged' | 'doc';

export function HistoryPanel({ project, head, onHead, tick, activeFile, run, onPreview, onClose }: {
  project: string;
  head: HistoryHead | null;
  onHead: (h: HistoryHead) => void;
  tick: number;
  activeFile?: string;
  /** Runs a server change (restore/undo/step): saves first, reloads after. */
  run: (label: string, fn: () => Promise<HistoryResult>) => Promise<HistoryResult | null>;
  onPreview: (v: HistoryVersion, file?: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [versions, setVersions] = useState<HistoryVersion[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, HistoryChange[]>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState<HistoryVersion | 'new' | null>(null);
  const loaded = useRef(0);

  const load = useCallback(async () => {
    try {
      const r = await studioApi.history(project, 0, Math.max(60, loaded.current));
      setVersions(r.versions); setMore(r.more); onHead(r.head); setError('');
      loaded.current = r.versions.length;
      // Open versions keep growing: drop their cached details.
      setDetails(d => { const n = { ...d }; for (const v of r.versions) if (v.open) delete n[v.n]; return n; });
    } catch (e: any) { setError(e?.message || 'Could not load the history.'); setVersions(v => v || []); }
  }, [project]);
  useEffect(() => { void load(); }, [load, tick]);

  const loadOlder = async () => {
    if (!versions?.length) return;
    const r = await studioApi.history(project, versions[versions.length - 1].n, 100);
    setVersions([...versions, ...r.versions]); setMore(r.more); loaded.current += r.versions.length;
  };

  const fetchDetail = async (n: number, force = false) => {
    if (details[n] && !force) return;
    try {
      const r = await studioApi.historyVersion(project, n);
      setDetails(d => ({ ...d, [n]: r.changes }));
    } catch (e: any) { toast('Could not load this version', { tone: 'error', description: e?.message }); }
  };
  const toggle = (n: number) => { setOpen(o => (o === n ? null : n)); void fetchDetail(n); };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (versions || []).filter(v => {
      if (filter === 'tagged' && !v.tag) return false;
      if (filter === 'doc' && activeFile && !v.files.some(f => f.file === activeFile)) return false;
      if (!q) return true;
      return [`v${v.code}`, v.code, v.tag, v.desc, ...v.files.map(f => fileLabel(f.file))].some(s => s.toLowerCase().includes(q));
    });
  }, [versions, filter, query, activeFile]);

  const act = async (label: string, fn: () => Promise<HistoryResult>) => {
    setBusy(true);
    try {
      const r = await run(label, fn);
      if (r) { onHead(r.head); await load(); if (r.version) { setOpen(r.version.n); void fetchDetail(r.version.n, true); } }
    } finally { setBusy(false); }
  };

  const restore = async (v: HistoryVersion, file?: string) => {
    const what = file ? fileLabel(file) : 'all documents';
    if (!(await confirm({ title: `Restore ${what} to v${v.code}?`, description: 'Shared values stay as they are now. This becomes a new version, so you can go back again.', confirm: 'Restore' }))) return;
    await act(`Restored ${what} to v${v.code}`, () => studioApi.historyRestore(project, v.n, file ? [file] : undefined));
  };

  const undo = async (v: HistoryVersion, h: HistoryHunk) => {
    await act(h.kind === 'value' ? `Undid "${h.label}" in all documents` : `Undid "${h.label}"`, () => studioApi.historyUndo(project, v.n, h.id));
  };

  const saveInfo = async (tag: string, desc: string) => {
    if (naming === 'new') {
      const r = await studioApi.historyCommit(project, tag, desc);
      onHead(r.head);
      toast(r.new_changes ? `Saved version v${r.version?.code}` : `Named v${r.version?.code}`);
    } else if (naming) {
      await studioApi.historyInfo(project, naming.n, tag, desc);
      toast(`Updated v${naming.code}`);
    }
    await load();
  };

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-zinc-200 bg-zinc-50 max-xl:absolute max-xl:bottom-0 max-xl:right-0 max-xl:top-10 max-xl:z-30 max-xl:shadow-pop">
      <div className="flex items-center gap-1.5 border-b border-zinc-200 bg-white px-2.5 py-1.5">
        <History className="size-4 text-indigo-600" />
        <h2 className="text-[13px] font-semibold text-zinc-900">Version history</h2>
        {head?.code && <span className="rounded bg-zinc-100 px-1 text-[11px] font-medium tabular-nums text-zinc-500">{head.count} version{head.count === 1 ? '' : 's'}</span>}
        <Button size="sm" variant="primary" className="ml-auto h-6 px-2 text-[12px]" onClick={() => setNaming('new')} title="Close the current version, with an optional tag and description (Ctrl+S saves a version too)">
          <Save className="size-3.5" />Save version
        </Button>
        <IconButton label="Close history" onClick={onClose}><X className="size-4" /></IconButton>
      </div>
      <div className="flex items-center gap-1 border-b border-zinc-200 px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search tag, note, v1.2…" aria-label="Search versions"
            className="h-7 w-full rounded-md border border-zinc-200 bg-white pl-7 pr-2 text-[12.5px] placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none" />
        </div>
        <div role="radiogroup" aria-label="Show" className="flex h-7 items-center rounded-md bg-zinc-200/60 p-0.5">
          {([['all', 'All'], ['tagged', 'Tagged'], ['doc', 'This doc']] as [Filter, string][]).filter(([f]) => f !== 'doc' || activeFile).map(([f, l]) => (
            <button key={f} role="radio" aria-checked={filter === f} onClick={() => setFilter(f)} title={f === 'doc' && activeFile ? `Only versions that changed ${fileLabel(activeFile)}` : undefined}
              className={cn('h-6 rounded px-1.5 text-[11.5px] font-medium', filter === f ? 'bg-white text-zinc-900 shadow-soft' : 'text-zinc-500 hover:text-zinc-800')}>{l}</button>
          ))}
        </div>
      </div>

      <div className="sv-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
        {versions === null ? <div className="grid place-items-center py-10"><Spinner /></div>
          : error && !versions.length ? <p className="m-2 rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{error}</p>
            : !versions.length ? (
              <div className="px-4 py-10 text-center">
                <History className="mx-auto size-6 text-zinc-300" />
                <p className="mt-2 text-[13px] font-medium text-zinc-700">No versions yet</p>
                <p className="mt-1 text-[12px] text-zinc-500">Every change you save becomes part of a version: 0.1, 0.2 … 1.0. Edits within a minute are grouped together.</p>
              </div>
            ) : !shown.length ? <p className="px-3 py-6 text-center text-[12.5px] text-zinc-500">No versions match.</p> : (
              <ol className="relative space-y-1">
                {shown.map(v => {
                  const isOpen = open === v.n;
                  const now = head?.effective === v.n;
                  const src = SOURCE[v.source] || SOURCE.studio;
                  const ch = details[v.n];
                  return (
                    <li key={v.n} className={cn('rounded-lg border bg-white transition-shadow', isOpen ? 'border-indigo-200 shadow-soft' : 'border-transparent hover:border-zinc-200', now && !isOpen && 'border-indigo-100 bg-indigo-50/40')}>
                      <button onClick={() => toggle(v.n)} aria-expanded={isOpen} className="block w-full px-2 py-1.5 text-left">
                        <div className="flex items-center gap-1.5">
                          <span className={cn('rounded px-1 font-mono text-[11.5px] font-semibold tabular-nums', now ? 'bg-indigo-600 text-white' : 'bg-zinc-100 text-zinc-700')}>v{v.code}</span>
                          {v.tag && <span className="flex min-w-0 items-center gap-0.5 truncate rounded-full bg-amber-100 px-1.5 text-[11px] font-medium text-amber-800"><Tag className="size-2.5 shrink-0" /><span className="truncate">{v.tag}</span></span>}
                          {now && <span className="text-[10.5px] font-semibold uppercase tracking-wide text-indigo-600">Now</span>}
                          {v.open && <span className="flex items-center gap-1 text-[10.5px] text-emerald-700" title="Changes in the next minute join this version"><span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />Open</span>}
                          <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-zinc-400" title={`${src.label} · ${fullTime(v.time)}`}>{src.icon}{relativeTime(secs(v.end))}</span>
                          <ChevronDown className={cn('size-3.5 shrink-0 text-zinc-400 transition-transform', isOpen && 'rotate-180')} />
                        </div>
                        {v.desc && <p className={cn('mt-0.5 text-[12px] text-zinc-600', !isOpen && 'truncate')}>{v.desc}</p>}
                        {!isOpen && (
                          <div className="mt-1 flex flex-wrap gap-0.5">
                            {v.files.slice(0, 6).map(f => (
                              <span key={f.file} title={`${fileLabel(f.file)} ${f.op}`} className={cn('rounded px-1 text-[10.5px] font-medium', f.op === 'created' ? 'bg-emerald-50 text-emerald-700' : f.op === 'deleted' ? 'bg-red-50 text-red-700' : f.file === 'project.json' ? 'bg-violet-50 text-violet-700' : 'bg-zinc-100 text-zinc-600')}>
                                {f.op === 'created' ? '+' : f.op === 'deleted' ? '−' : ''}{shortChip(f.file)}
                              </span>
                            ))}
                            {v.files.length > 6 && <span className="px-1 text-[10.5px] text-zinc-400">+{v.files.length - 6}</span>}
                          </div>
                        )}
                      </button>
                      {isOpen && (
                        <div className="space-y-2 border-t border-zinc-100 px-2 pb-2 pt-1.5">
                          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500">
                            <span className="flex items-center gap-1">{src.icon}{src.label}</span>
                            <span>{fullTime(v.time)}{v.end !== v.time && secs(v.end) - secs(v.time) > 60 ? ` – ${new Date(v.end).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
                            <button onClick={() => setNaming(v)} className="ml-auto flex items-center gap-1 rounded px-1 font-medium text-indigo-600 hover:bg-indigo-50"><Tag className="size-3" />{v.tag || v.desc ? 'Edit tag' : 'Add tag'}</button>
                          </div>
                          {!ch ? <div className="py-3 text-center"><Spinner /></div> : (
                            <div className="space-y-2">
                              {ch.map(c => (
                                <section key={c.file}>
                                  <div className="mb-1 flex items-center gap-1">
                                    {c.file === 'project.json' ? <SlidersHorizontal className="size-3.5 text-violet-600" /> : <FileText className="size-3.5 text-zinc-400" />}
                                    <span className="truncate text-[12px] font-semibold text-zinc-800">{fileLabel(c.file)}</span>
                                    {c.op !== 'changed' && <span className={cn('rounded px-1 text-[10px] font-semibold uppercase', c.op === 'created' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700')}>{c.op}</span>}
                                    {c.file !== 'project.json' && (
                                      <span className="ml-auto flex shrink-0 items-center">
                                        <IconButton label={`Preview ${fileLabel(c.file)} at v${v.code}`} className="size-6" onClick={() => onPreview(v, c.file)}><Eye className="size-3.5" /></IconButton>
                                        {c.op !== 'deleted' && <IconButton label={`Restore ${fileLabel(c.file)} to v${v.code}`} className="size-6" disabled={busy} onClick={() => void restore(v, c.file)}><RotateCcw className="size-3.5" /></IconButton>}
                                      </span>
                                    )}
                                  </div>
                                  {c.values_only ? <p className="pl-5 text-[11.5px] italic text-zinc-400">Only shared values were filled in.</p> : (
                                    <ul className="space-y-1 pl-1">
                                      {c.hunks.map(h => <HunkRow key={h.id} h={h} busy={busy} onUndo={() => void undo(v, h)} />)}
                                    </ul>
                                  )}
                                </section>
                              ))}
                            </div>
                          )}
                          <div className="flex items-center gap-1 pt-0.5">
                            <Button size="sm" className="h-6 px-2 text-[12px]" onClick={() => onPreview(v)}><Eye className="size-3.5" />Preview</Button>
                            <Button size="sm" className="h-6 px-2 text-[12px]" disabled={busy} onClick={() => void restore(v)}><RotateCcw className="size-3.5" />Restore v{v.code}</Button>
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
      <p className="border-t border-zinc-200 px-2.5 py-1 text-[10.5px] text-zinc-400">Restoring brings back document text; shared values stay current. Kept forever.</p>

      <VersionInfoDialog open={!!naming} onClose={() => setNaming(null)} onSubmit={saveInfo}
        title={naming === 'new' ? 'Save version' : naming ? `Tag v${naming.code}` : ''}
        description={naming === 'new' ? 'Closes the current version so the next change starts a new one.' : undefined}
        submit={naming === 'new' ? 'Save version' : 'Save'}
        initial={naming && naming !== 'new' ? { tag: naming.tag, desc: naming.desc } : undefined} />
    </aside>
  );
}

/* ---------- Preview ---------- */

const PREVIEW_CSS = `<style>
html{background:#f4f4f5}
body.sv-doc{margin:16px auto!important;box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06)}
[data-sv-diff]{position:relative;border-radius:3px}
[data-sv-diff=add]{background:#dcfce7;box-shadow:-6px 0 0 #22c55e}
[data-sv-diff=chg]{background:#fef9c3;box-shadow:-6px 0 0 #eab308}
[data-sv-diff=del]{background:#fee2e2;box-shadow:-6px 0 0 #ef4444;text-decoration:line-through;text-decoration-color:#f87171;opacity:.75}
</style>`;

export function VersionPreview({ project, version, files, initialFile, onClose, onRestore }: {
  project: string; version: HistoryVersion | null; files: string[]; initialFile?: string; onClose: () => void; onRestore: (v: HistoryVersion, file?: string) => void;
}) {
  const [file, setFile] = useState<string | undefined>(initialFile);
  const [data, setData] = useState<{ html: string; changes: number; deleted?: boolean } | null>(null);
  const [error, setError] = useState('');
  const list = useMemo(() => {
    if (!version) return [];
    const changed = version.files.map(f => f.file).filter(f => f !== 'project.json');
    return [...changed, ...files.filter(f => !changed.includes(f))];
  }, [version, files]);
  useEffect(() => { setFile(initialFile || list[0]); }, [version, initialFile]);
  useEffect(() => {
    if (!version || !file) return;
    setData(null); setError('');
    studioApi.historyPreview(project, version.n, file)
      .then(r => setData({ ...r, html: r.html.replace('</head>', PREVIEW_CSS + '</head>') }))
      .catch(e => setError(e?.message || 'Could not load this version.'));
  }, [project, version, file]);
  if (!version) return null;
  const changedSet = new Set(version.files.map(f => f.file));
  return (
    <Dialog open onClose={onClose} width="max-w-5xl" title={<span className="flex items-center gap-2">v{version.code}{version.tag && <span className="rounded-full bg-amber-100 px-2 text-[12px] font-medium text-amber-800">{version.tag}</span>}<span className="text-[13px] font-normal text-zinc-500">{fullTime(version.end)}</span></span>}
      description={version.desc || undefined}
      footer={<>
        <span className="mr-auto flex items-center gap-3 text-[12px] text-zinc-500">
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-emerald-400" />Added</span>
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-yellow-400" />Changed</span>
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-red-400" />Removed</span>
        </span>
        {file && !data?.deleted && <Button onClick={() => { onRestore(version, file); onClose(); }}><RotateCcw className="size-4" />Restore this document</Button>}
        <Button variant="primary" onClick={() => { onRestore(version); onClose(); }}><RotateCcw className="size-4" />Restore all to v{version.code}</Button>
      </>}>
      <div className="-mt-1 mb-2 flex flex-wrap gap-1">
        {list.map(f => (
          <button key={f} onClick={() => setFile(f)} className={cn('flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium', f === file ? 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200' : 'text-zinc-600 hover:bg-zinc-100')}>
            {changedSet.has(f) && <span className="size-1.5 rounded-full bg-amber-500" title="Changed in this version" />}{fileLabel(f)}
          </button>
        ))}
        {data && <span className="ml-auto self-center text-[12px] text-zinc-500">{data.deleted ? 'Deleted in this version' : data.changes ? `${data.changes} change${data.changes === 1 ? '' : 's'} highlighted` : 'Not changed in this version'}</span>}
      </div>
      <div className="h-[68vh] overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100">
        {error ? <p className="p-6 text-center text-[13px] text-red-600">{error}</p>
          : !data ? <div className="grid h-full place-items-center"><Spinner className="size-5" /></div>
            : <iframe title={`Preview v${version.code}`} sandbox="allow-same-origin" srcDoc={data.html} className="size-full bg-zinc-100" />}
      </div>
    </Dialog>
  );
}
