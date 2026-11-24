import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Eye, GitCompareArrows, LayoutGrid, Minus, Plus, RotateCcw, SlidersHorizontal, Tag, X } from 'lucide-react';
import { HistoryInfo, ProjectVersion, RenderResult, TrackHead, TrackVersion, studioApi } from '../utils/studioServer';
import { Button, Spinner, cn, relativeTime } from '../ui/ui';
import {
  AnyVersion, HistoryScope, PreviewTarget, SOURCE, ValuesCard, fullTime, isProjectVersion, projectPreview, renderVersion, trackChip, trackName,
  trackPreview, vcode, vnum, withPreviewCss,
} from './HistoryPanel';

const A4_W = 794;
const HEADER_H = 96;
const ROW_HEAD_W = 132;
const THUMB_CSS = '<style>html{background:#fff!important;overflow:hidden}body.sv-doc{margin:0 auto!important;box-shadow:none!important}</style>';

/** A page at a version, scaled down, scrolled to its first change. Loaded only while near the screen. */
function DocThumb({ project, track, k, against, width, height }: { project: string; track: string; k: number; against?: number; width: number; height: number }) {
  const [r, setR] = useState<RenderResult | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { let live = true; renderVersion(project, track, k, against).then(x => live && setR(x)).catch(() => live && setErr(true)); return () => { live = false; }; }, [project, track, k, against]);
  const scale = width / A4_W;
  const onLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
    try {
      const d = e.currentTarget.contentDocument;
      const first = d?.querySelector('[data-sv-diff]') as HTMLElement | null;
      if (d && first) d.scrollingElement!.scrollTop = Math.max(0, first.getBoundingClientRect().top + d.scrollingElement!.scrollTop - 120);
    } catch { /* not reachable: leave at top */ }
  };
  return (
    <div className="relative overflow-hidden bg-white" style={{ width, height }}>
      {err ? <p className="p-2 text-[11px] text-red-600">Could not load</p>
        : !r ? <div className="grid size-full place-items-center"><Spinner /></div>
          : r.deleted && !r.html ? <p className="grid size-full place-items-center text-[12px] text-zinc-400">Deleted</p>
            : <iframe title={`v${vcode(k)}`} sandbox="allow-same-origin" srcDoc={withPreviewCss(r.html || '', THUMB_CSS)} onLoad={onLoad} tabIndex={-1}
              className="pointer-events-none origin-top-left border-0" style={{ width: A4_W, height: height / scale, transform: `scale(${scale})` }} />}
      {r && r.changes > 0 && <span className="absolute bottom-1 right-1 rounded-full bg-zinc-900/75 px-1.5 text-[10px] font-medium text-white">{r.changes} change{r.changes === 1 ? '' : 's'}</span>}
    </div>
  );
}

function ValuesThumb({ project, k, against, width, height }: { project: string; k: number; against?: number; width: number; height: number }) {
  const [r, setR] = useState<RenderResult | null>(null);
  useEffect(() => { let live = true; renderVersion(project, 'values', k, against).then(x => live && setR(x)).catch(() => {}); return () => { live = false; }; }, [project, k, against]);
  return (
    <div className="overflow-hidden bg-white p-1.5" style={{ width, height }}>
      {!r ? <div className="grid size-full place-items-center"><Spinner /></div> : <div style={{ zoom: Math.max(0.6, Math.min(1.2, width / 240)) }}><ValuesCard r={r} dense /></div>}
    </div>
  );
}

type Col = { n: number; v: AnyVersion; x: number };
type Row = { track: TrackHead; y: number; h: number };

export function HistoryCanvas({ project, info, scope, onScope, onPreview, onRestore, onClose, tick }: {
  project: string;
  info: HistoryInfo | null;
  scope: HistoryScope;
  onScope: (s: HistoryScope) => void;
  onPreview: (t: PreviewTarget) => void;
  onRestore: (scope: HistoryScope, v: AnyVersion) => void;
  onClose: () => void;
  tick: number;
}) {
  const [versions, setVersions] = useState<AnyVersion[] | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pick, setPick] = useState<number[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, w: 1200, h: 800 });
  const isTrack = scope !== 'project';
  const tracks = info?.tracks || [];
  const track = isTrack ? tracks.find(t => t.track === scope) : undefined;
  const scopeKey = isTrack ? scope : '';

  // Load the whole timeline (pages of 1000), oldest first.
  useEffect(() => {
    let live = true;
    (async () => {
      let all: AnyVersion[] = [];
      let before = 0;
      for (;;) {
        const r = await studioApi.history<AnyVersion>(project, scopeKey, before, 1000);
        all = all.concat(r.versions);
        if (!r.more || !r.versions.length) break;
        before = vnum(r.versions[r.versions.length - 1]);
      }
      if (live) setVersions(all.reverse());
    })().catch(() => live && setVersions([]));
    return () => { live = false; };
  }, [project, scopeKey, tick]);
  useEffect(() => setPick([]), [scopeKey]);

  /* Layout */
  const colW = Math.round((isTrack ? 330 : 230) * zoom);
  const docH = Math.round(colW * 1.32);
  const valH = Math.round((isTrack ? 360 : 210) * zoom);
  const gap = 12;
  const rows: Row[] = useMemo(() => {
    const list = isTrack ? (track ? [track] : []) : tracks;
    let y = HEADER_H;
    return list.map(t => { const h = (t.kind === 'values' ? valH : docH) + gap; const r = { track: t, y, h }; y += h; return r; });
  }, [isTrack, track, tracks, valH, docH]);
  const cols: Col[] = useMemo(() => (versions || []).map((v, i) => ({ n: vnum(v), v, x: ROW_HEAD_W + i * (colW + gap) })), [versions, colW]);
  const totalW = ROW_HEAD_W + cols.length * (colW + gap) + 40;
  const totalH = (rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : HEADER_H) + 24;

  const measure = useCallback(() => {
    const el = scroller.current;
    if (el) setView({ x: el.scrollLeft, y: el.scrollTop, w: el.clientWidth, h: el.clientHeight });
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  // Start at the newest versions (right end).
  const first = useRef(true);
  useLayoutEffect(() => { if (versions && first.current && scroller.current) { scroller.current.scrollLeft = scroller.current.scrollWidth; first.current = false; measure(); } }, [versions]);
  useEffect(() => { first.current = true; }, [scopeKey]);

  const raf = useRef(0);
  const onScroll = () => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(measure); };

  // Only what is near the screen is drawn.
  const margin = colW;
  const visCols = cols.filter(c => c.x + colW >= view.x - margin && c.x <= view.x + view.w + margin);
  const visRows = rows.filter(r => r.y + r.h >= view.y - 200 && r.y <= view.y + view.h + 200);

  /* Zoom: buttons, Ctrl+wheel */
  const setZ = (z: number) => setZoom(Math.round(Math.min(2, Math.max(0.5, z)) * 100) / 100);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(z => Math.round(Math.min(2, Math.max(0.5, z * (e.deltaY < 0 ? 1.1 : 0.9))) * 100) / 100); } };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* Drag to move the canvas */
  const drag = useRef<{ x: number; y: number; sx: number; sy: number; moved: boolean } | null>(null);
  const moved = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button,input,a')) return;
    const el = scroller.current!;
    drag.current = { x: e.clientX, y: e.clientY, sx: el.scrollLeft, sy: el.scrollTop, moved: false };
    moved.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) { d.moved = true; moved.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }
    if (d.moved) { scroller.current!.scrollLeft = d.sx - dx; scroller.current!.scrollTop = d.sy - dy; }
  };
  const onPointerUp = () => { drag.current = null; window.setTimeout(() => { moved.current = false; }, 0); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role=dialog]')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* Actions */
  const prevOf = (i: number) => (i > 0 ? cols[i - 1]?.n ?? null : null);
  const previewVersion = (v: AnyVersion, i: number, initial?: string) => {
    if (isProjectVersion(v)) onPreview(projectPreview(v, tracks, { initial, onRestore: () => onRestore('project', v) }));
    else if (track) onPreview(trackPreview(v, track, prevOf(i), () => onRestore(scope, v)));
  };
  const effective = isTrack ? track?.effective : info?.head.effective;
  const togglePick = (n: number) => setPick(p => (p.includes(n) ? p.filter(x => x !== n) : [...p.slice(-1), n]));
  const compare = async () => {
    const [a, b] = [...pick].sort((x, y) => x - y);
    const r = await studioApi.historyCompare(project, a, b, scopeKey);
    const va = cols.find(c => c.n === a)?.v, vb = cols.find(c => c.n === b)?.v;
    const label = isTrack && track ? trackName(track) : 'Project';
    const tabs = isTrack && track
      ? [{ track: track.track, label: trackChip(track), k: b, against: a, changed: true }]
      : r.changes.filter(c => c.to != null).map(c => ({ track: c.track, label: trackChip({ kind: c.kind, label: c.label }), k: c.to as number, against: c.from ?? 0, changed: true }));
    onPreview({
      title: <span className="flex items-center gap-2">{label}: v{vcode(a)} <GitCompareArrows className="size-4 text-zinc-400" /> v{vcode(b)}</span>,
      subtitle: [va?.tag && `v${va.code}: ${va.tag}`, vb?.tag && `v${vb.code}: ${vb.tag}`].filter(Boolean).join(' · ') || undefined,
      tabs, changes: r.changes,
    });
  };

  const timelines: { id: HistoryScope; label: string }[] = [{ id: 'project', label: 'Project' }, ...tracks.map(t => ({ id: t.track, label: trackChip(t) }))];

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-zinc-100">
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-zinc-200 bg-white px-2">
        <LayoutGrid className="size-4 text-indigo-600" />
        <h2 className="text-[13px] font-semibold text-zinc-900">History canvas</h2>
        <span className="text-[12px] text-zinc-400">{project}</span>
        <div role="tablist" aria-label="Timeline" className="no-scrollbar ml-2 flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-zinc-100 p-0.5">
          {timelines.map(t => (
            <button key={t.id} role="tab" aria-selected={scope === t.id} onClick={() => onScope(t.id)}
              className={cn('flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium', scope === t.id ? 'bg-white text-indigo-700 shadow-soft' : 'text-zinc-500 hover:text-zinc-800')}>
              {t.id === 'values' && <SlidersHorizontal className="size-3" />}{t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {pick.length === 2 ? (
            <Button size="sm" variant="primary" className="h-7" onClick={() => void compare()}><GitCompareArrows className="size-3.5" />Compare v{vcode(Math.min(...pick))} ↔ v{vcode(Math.max(...pick))}</Button>
          ) : <span className="hidden text-[12px] text-zinc-400 md:inline">{pick.length ? 'Tick one more version to compare' : 'Tick two versions to compare · drag to move · Ctrl+scroll to zoom'}</span>}
          <div className="ml-1 flex h-7 items-center rounded-lg bg-zinc-100 p-0.5">
            <button aria-label="Zoom out" onClick={() => setZ(zoom - 0.1)} className="grid size-6 place-items-center rounded-md text-zinc-600 hover:bg-white"><Minus className="size-3.5" /></button>
            <button onClick={() => setZ(1)} className="h-6 w-11 rounded-md text-[12px] tabular-nums text-zinc-700 hover:bg-white" title="Reset zoom">{Math.round(zoom * 100)}%</button>
            <button aria-label="Zoom in" onClick={() => setZ(zoom + 0.1)} className="grid size-6 place-items-center rounded-md text-zinc-600 hover:bg-white"><Plus className="size-3.5" /></button>
          </div>
          <Button size="icon-sm" variant="ghost" aria-label="Close canvas" onClick={onClose}><X className="size-4" /></Button>
        </div>
      </header>

      <div ref={scroller} onScroll={onScroll} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        className="sv-scroll relative min-h-0 flex-1 cursor-grab overflow-auto active:cursor-grabbing">
        {versions === null ? <div className="grid h-full place-items-center"><Spinner className="size-6" /></div>
          : !versions.length ? <p className="mt-24 text-center text-[13px] text-zinc-500">No versions yet.</p> : (
            <div className="relative" style={{ width: totalW, height: totalH }}>
              {/* Version headers (stick to the top) */}
              <div className="sticky top-0 z-20 border-b border-zinc-200 bg-zinc-100/95 backdrop-blur" style={{ width: totalW, height: HEADER_H }}>
                {visCols.map(c => {
                  const i = cols.indexOf(c);
                  const v = c.v;
                  const now = effective === c.n;
                  const src = SOURCE[v.source] || SOURCE.studio;
                  return (
                    <div key={c.n} className={cn('absolute top-2 flex flex-col rounded-lg border bg-white px-2 py-1.5 shadow-soft', now ? 'border-indigo-300 ring-2 ring-indigo-100' : 'border-zinc-200', pick.includes(c.n) && 'ring-2 ring-indigo-400')}
                      style={{ left: c.x, width: colW, height: HEADER_H - 16 }}>
                      <div className="flex items-center gap-1">
                        <input type="checkbox" aria-label={`Compare v${v.code}`} checked={pick.includes(c.n)} onChange={() => togglePick(c.n)} className="size-3.5 accent-indigo-600" />
                        <span className={cn('rounded px-1 font-mono text-[12px] font-semibold', now ? 'bg-indigo-600 text-white' : 'bg-zinc-100 text-zinc-800')}>v{v.code}</span>
                        {!isProjectVersion(v) && <span className="font-mono text-[10.5px] text-zinc-400">p{(v as TrackVersion).project_code}</span>}
                        {v.tag && <span className="flex min-w-0 items-center gap-0.5 truncate rounded-full bg-amber-100 px-1.5 text-[11px] font-medium text-amber-800"><Tag className="size-2.5 shrink-0" /><span className="truncate">{v.tag}</span></span>}
                        <span className="ml-auto flex shrink-0 items-center">
                          <button title="Preview" onClick={() => previewVersion(v, i)} className="grid size-5 place-items-center rounded text-zinc-500 hover:bg-zinc-100"><Eye className="size-3.5" /></button>
                          <button title={`Restore ${isTrack && track ? trackChip(track) : 'project'} to v${v.code}`} onClick={() => onRestore(scope, v)} className="grid size-5 place-items-center rounded text-zinc-500 hover:bg-zinc-100"><RotateCcw className="size-3.5" /></button>
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-zinc-400" title={fullTime(v.time)}>
                        {src.icon}{v.author && <span className="truncate text-zinc-500">{v.author}</span>}<span className="ml-auto shrink-0">{relativeTime(Date.parse(v.end) / 1000)}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-zinc-600">{v.desc || <span className="text-zinc-300">No description</span>}</p>
                    </div>
                  );
                })}
              </div>

              {/* Timeline names (stick to the left) */}
              <div className="pointer-events-none sticky left-0 z-10" style={{ width: ROW_HEAD_W, height: totalH - HEADER_H, marginTop: 0 }}>
                {rows.map(r => (
                  <div key={r.track.track} className="pointer-events-auto absolute left-0 flex flex-col justify-center border-r border-zinc-200 bg-zinc-100/95 px-2 backdrop-blur" style={{ top: r.y - HEADER_H, height: r.h - gap, width: ROW_HEAD_W - 8 }}>
                    <button onClick={() => onScope(r.track.track)} className="text-left text-[12px] font-semibold leading-tight text-zinc-800 hover:text-indigo-700" title="Open this timeline">
                      {r.track.kind === 'values' && <SlidersHorizontal className="mr-1 inline size-3 text-violet-600" />}{trackName(r.track)}
                    </button>
                    <span className="mt-0.5 font-mono text-[11px] text-zinc-400">v{r.track.effective_code || '—'}{r.track.deleted ? ' · deleted' : ''}</span>
                  </div>
                ))}
              </div>

              {/* Cells */}
              {visRows.map(r => visCols.map(c => {
                const i = cols.indexOf(c);
                const v = c.v;
                const t = r.track;
                let k: number | undefined, against: number | undefined, changed: boolean, op = 'changed';
                if (isProjectVersion(v)) {
                  const m = v.changes.find(x => x.track === t.track);
                  k = v.heads[t.track];
                  changed = !!m;
                  if (m) { against = m.from ?? 0; op = m.op; if (m.op === 'deleted') k = m.to; }
                } else { k = v.k; changed = true; op = v.op; against = prevOf(i) ?? 0; }
                if (k == null) return null;
                const w = colW, h = r.h - gap;
                const open = () => { if (!moved.current) previewVersion(v, i, t.track); };
                if (!changed) {
                  return (
                    <button key={`${t.track}:${c.n}`} onClick={open} title={`${trackName(t)} unchanged (v${vcode(k)})`}
                      className="absolute flex items-center justify-center rounded-lg border border-dashed border-zinc-300/80 text-[11px] text-zinc-400 hover:border-zinc-400 hover:bg-white/60"
                      style={{ left: c.x, top: r.y, width: w, height: h }}>
                      <span className="rounded bg-zinc-200/70 px-1.5 font-mono">v{vcode(k)}</span><span className="ml-1">same</span>
                    </button>
                  );
                }
                return (
                  <div key={`${t.track}:${c.n}`} onClick={open} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') open(); }}
                    className={cn('absolute overflow-hidden rounded-lg border bg-white shadow-soft transition-shadow hover:shadow-pop', op === 'created' ? 'border-emerald-300' : op === 'deleted' ? 'border-red-300' : t.kind === 'values' ? 'border-violet-300' : 'border-amber-300')}
                    style={{ left: c.x, top: r.y, width: w, height: h }}>
                    <span className={cn('absolute left-1 top-1 z-10 rounded px-1 font-mono text-[10.5px] font-semibold shadow-soft', op === 'created' ? 'bg-emerald-600 text-white' : op === 'deleted' ? 'bg-red-600 text-white' : 'bg-zinc-900/80 text-white')}>
                      {op === 'created' ? '+ ' : op === 'deleted' ? '− ' : ''}v{vcode(k)}
                    </span>
                    {t.kind === 'values'
                      ? <ValuesThumb project={project} k={k} against={against} width={w - 2} height={h - 2} />
                      : <DocThumb project={project} track={t.track} k={k} against={against} width={w - 2} height={h - 2} />}
                  </div>
                );
              }))}
            </div>
          )}
      </div>
    </div>
  );
}
