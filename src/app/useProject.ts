// All state for one open project: its documents, the shared values, autosave
// and how value changes flow into every document.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Store } from '../editor/store';
import { DocModel, parseDoc, serializeDoc } from '../editor/doc';
import { docOrder } from '../editor/templates';
import { ProjectValues, emptyValues, parseValues } from '../editor/values';
import { applyValuesToBody, applyValuesToRoot, cleanEditorHtml, slotUsage } from '../editor/bindings';
import { StudioError } from '../utils/studioServer';

export type Status = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';
export interface PDoc { file: string; model: DocModel; etag: string | null; dirty: boolean; status: Status; error?: string; savedAt?: number; /** Bumped when the file was changed elsewhere and reloaded. */ rev?: number }

/** The document currently open in the visual editor (its DOM is the live copy). */
export interface LiveDoc { file: string; root: () => HTMLElement | null; getBody: () => string }

const VALUES_FILE = 'project.json';

export function useProject(store: Store, project: string) {
  const [docs, setDocs] = useState<PDoc[] | null>(null);
  const [values, setValuesState] = useState<ProjectValues>(emptyValues);
  const [hasValuesFile, setHasValuesFile] = useState(true);
  const [valuesStatus, setValuesStatus] = useState<Status>('saved');
  const [loadError, setLoadError] = useState('');
  const [changedKeys, setChangedKeys] = useState<{ keys: string[]; n: number }>({ keys: [], n: 0 });
  const docsRef = useRef<PDoc[]>([]);
  docsRef.current = docs || [];
  const valuesRef = useRef(values);
  const valuesEtag = useRef<string | null>(null);
  const valuesDirty = useRef(false);
  /** Documents open in editors right now (canvas pages or the single-page editor). */
  const live = useRef<Map<string, LiveDoc>>(new Map());
  const timers = useRef<Record<string, number>>({});
  const valuesTimer = useRef<number | undefined>(undefined);
  const history = useRef<{ past: ProjectValues[]; future: ProjectValues[]; lastPush: number }>({ past: [], future: [], lastPush: 0 });
  const [historyTick, setHistoryTick] = useState(0);

  const pathOf = (f: string) => `${project}/${f}`;
  /** Server modification time of each file as we last saw or saved it (for live sync). */
  const known = useRef<Record<string, number>>({});
  const [remote, setRemote] = useState<{ n: number; files: string[] }>({ n: 0, files: [] });
  /** Bumps after every successful save or remote change (the version history refreshes on it). */
  const [savedTick, setSavedTick] = useState(0);
  const syncRef = useRef<(force?: boolean) => Promise<void>>(async () => {});

  /* ---------- Load ---------- */
  const load = useCallback(async () => {
    setLoadError('');
    try {
      const items = await store.list();
      if (!items.some(i => i.type === 'folder' && i.path === project)) throw new StudioError('This project no longer exists.', 404);
      const inProject = items.filter(i => i.type === 'file' && i.path.startsWith(project + '/') && !i.path.slice(project.length + 1).includes('/')).map(i => i.path.slice(project.length + 1));
      const files = inProject.filter(f => /\.html$/i.test(f));
      const loaded = await Promise.all(files.map(async f => {
        const r = await store.read(pathOf(f));
        known.current[f] = r.modified;
        return { file: f, model: parseDoc(r.content, f.replace(/\.html$/i, '')), etag: r.etag, dirty: false, status: 'saved' as Status, savedAt: r.modified * 1000 };
      }));
      loaded.sort((a, b) => docOrder(a.file) - docOrder(b.file) || a.file.localeCompare(b.file));
      if (inProject.includes(VALUES_FILE)) {
        const r = await store.read(pathOf(VALUES_FILE));
        const v = parseValues(r.content);
        known.current[VALUES_FILE] = r.modified;
        valuesEtag.current = r.etag;
        valuesRef.current = v;
        setValuesState(v);
        setHasValuesFile(true);
      } else {
        valuesEtag.current = null;
        valuesRef.current = emptyValues();
        setValuesState(valuesRef.current);
        setHasValuesFile(false);
      }
      setDocs(loaded);
    } catch (e: any) { setLoadError(e?.message || 'Could not open this project.'); setDocs([]); }
  }, [project, store]);
  useEffect(() => { void load(); }, [load]);

  /* ---------- Documents ---------- */
  const patch = (f: string, fn: (d: PDoc) => PDoc) => setDocs(prev => prev && prev.map(d => (d.file === f ? fn(d) : d)));
  const markDirty = (d: PDoc, model: DocModel): PDoc => (model === d.model ? d : { ...d, model, dirty: true, status: d.status === 'conflict' ? 'conflict' : 'pending' });
  const updateModel = useCallback((f: string, fn: (m: DocModel) => DocModel) => patch(f, d => markDirty(d, fn(d.model))), []);

  const save = useCallback(async (f: string, overwrite = false): Promise<boolean> => {
    const d = docsRef.current.find(x => x.file === f);
    if (!d || (!d.dirty && !overwrite) || d.status === 'saving' || (d.status === 'conflict' && !overwrite)) return !d || !d.dirty;
    const model = d.model;
    patch(f, x => ({ ...x, dirty: false, status: 'saving' }));
    try {
      const r = await store.save(pathOf(f), serializeDoc({ ...model, body: cleanEditorHtml(model.body) }), overwrite ? null : d.etag);
      known.current[f] = r.modified;
      patch(f, x => ({ ...x, etag: r.etag, savedAt: Date.now(), status: x.dirty ? 'pending' : 'saved', error: undefined }));
      setSavedTick(t => t + 1);
      return true;
    } catch (e: any) {
      const conflict = e instanceof StudioError && e.status === 409 && e.code === 'sms_conflict';
      patch(f, x => ({ ...x, dirty: true, status: conflict ? 'conflict' : 'error', error: e?.message }));
      return false;
    }
  }, [project, store]);

  useEffect(() => {
    for (const d of docs || []) {
      if (d.dirty && d.status === 'pending') {
        window.clearTimeout(timers.current[d.file]);
        timers.current[d.file] = window.setTimeout(() => void save(d.file), 1000);
      }
    }
  }, [docs, save]);

  /* ---------- Shared values ---------- */
  const saveValues = useCallback(async (): Promise<boolean> => {
    if (!valuesDirty.current) return true;
    valuesDirty.current = false;
    setValuesStatus('saving');
    try {
      const r = await store.save(pathOf(VALUES_FILE), JSON.stringify(valuesRef.current, null, 1), valuesEtag.current, valuesEtag.current ? 'save' : 'save');
      valuesEtag.current = r.etag;
      known.current[VALUES_FILE] = r.modified;
      setHasValuesFile(true);
      setValuesStatus(valuesDirty.current ? 'pending' : 'saved');
      setSavedTick(t => t + 1);
      return true;
    } catch (e: any) {
      valuesDirty.current = true;
      // Someone else saved the values: take theirs as the base next time rather than looping.
      if (e instanceof StudioError && e.status === 409) { valuesEtag.current = null; }
      setValuesStatus('error');
      return false;
    }
  }, [project, store]);

  const scheduleValuesSave = () => {
    valuesDirty.current = true;
    setValuesStatus('pending');
    window.clearTimeout(valuesTimer.current);
    valuesTimer.current = window.setTimeout(() => void saveValues(), 900);
  };

  /** Push values into every document (live editor DOM included). The slot being typed in is left alone. */
  const applyEverywhere = (next: ProjectValues) => {
    setDocs(prev => prev && prev.map(d => {
      const ld = live.current.get(d.file);
      const root = ld?.root();
      if (ld && root) {
        const sel = root.ownerDocument.getSelection();
        const anchor = sel?.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode as Element : sel.anchorNode.parentElement) : null;
        const focused = root.ownerDocument.hasFocus() && anchor && root.contains(anchor) ? anchor.closest('[data-field]') : null;
        if (applyValuesToRoot(root, d.model.lang, next, { lockStructured: true, skip: focused })) {
          return markDirty(d, { ...d.model, body: cleanEditorHtml(ld.getBody()) });
        }
        return d;
      }
      const body = applyValuesToBody(d.model.body, d.model.lang, next);
      return body === d.model.body ? d : markDirty(d, { ...d.model, body });
    }));
  };

  /** Re-write a live document's slots in full (e.g. after the cursor leaves a slot). */
  const reapply = (file: string) => {
    const ld = live.current.get(file);
    const root = ld?.root();
    const d = docsRef.current.find(x => x.file === file);
    if (!ld || !root || !d) return;
    if (applyValuesToRoot(root, d.model.lang, valuesRef.current, { lockStructured: true })) {
      const body = cleanEditorHtml(ld.getBody());
      patch(file, x => markDirty(x, { ...x.model, body }));
    }
  };

  const commitValues = (next: ProjectValues, keys: string[], recordHistory = true) => {
    const prev = valuesRef.current;
    if (recordHistory) {
      const h = history.current;
      const now = Date.now();
      if (now - h.lastPush > 800) { h.past.push(prev); if (h.past.length > 80) h.past.shift(); }
      h.lastPush = now;
      h.future = [];
      setHistoryTick(t => t + 1);
    }
    valuesRef.current = next;
    setValuesState(next);
    setChangedKeys(c => ({ keys, n: c.n + 1 }));
    applyEverywhere(next);
    scheduleValuesSave();
  };

  /** Change shared values. `keys` names what changed (for the flash highlight). */
  const setValues = useCallback((fn: (v: ProjectValues) => ProjectValues, keys: string[] = []) => {
    const next = fn(valuesRef.current);
    if (next === valuesRef.current) return;
    commitValues(next, keys);
  }, []);

  const undo = () => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(valuesRef.current);
    h.lastPush = 0;
    commitValues(prev, [], false);
    setHistoryTick(t => t + 1);
  };
  const redo = () => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(valuesRef.current);
    h.lastPush = 0;
    commitValues(next, [], false);
    setHistoryTick(t => t + 1);
  };

  /** Replace values and document bodies at once (after detection). */
  const replaceAll = (next: ProjectValues, bodies: Record<string, string>) => {
    history.current.past.push(valuesRef.current);
    valuesRef.current = next;
    setValuesState(next);
    setDocs(prev => prev && prev.map(d => {
      const body = bodies[d.file] !== undefined ? applyValuesToBody(bodies[d.file], d.model.lang, next) : applyValuesToBody(d.model.body, d.model.lang, next);
      return body === d.model.body ? d : markDirty(d, { ...d.model, body });
    }));
    scheduleValuesSave();
  };

  /* ---------- Derived ---------- */
  const usage = useMemo(() => {
    const u: Record<string, { count: number; overrides: number; docs: string[] }> = {};
    for (const d of docs || []) {
      for (const [k, v] of Object.entries(slotUsage(d.model.body))) {
        const e = (u[k] ||= { count: 0, overrides: 0, docs: [] });
        e.count += v.count; e.overrides += v.overrides; e.docs.push(d.file);
      }
    }
    return u;
  }, [docs]);

  const all = docs || [];
  const status: Status = all.some(d => d.status === 'conflict') ? 'conflict'
    : all.some(d => d.status === 'error') || valuesStatus === 'error' ? 'error'
      : all.some(d => d.status === 'saving') || valuesStatus === 'saving' ? 'saving'
        : all.some(d => d.status === 'pending') || valuesStatus === 'pending' ? 'pending' : 'saved';
  const lastSaved = Math.max(0, ...all.map(d => d.savedAt || 0));

  const saveAll = async () => {
    for (const [f, ld] of live.current) {
      const body = cleanEditorHtml(ld.getBody());
      patch(f, d => (d.model.body === body ? d : markDirty(d, { ...d.model, body })));
    }
    await new Promise(r => setTimeout(r, 0));
    const results = await Promise.all([...docsRef.current.filter(d => d.dirty).map(d => save(d.file)), saveValues()]);
    return results.every(Boolean);
  };

  /* ---------- Live sync: pick up changes made elsewhere (AI connector, another browser) ---------- */
  useEffect(() => {
    if (store.kind !== 'server') return;
    let busy = false;
    const tick = async (force = false): Promise<void> => {
      if (busy && force) { await new Promise(r => setTimeout(r, 250)); return tick(true); }
      if (busy || (!force && document.visibilityState !== 'visible') || !docsRef.current.length && !known.current[VALUES_FILE]) return;
      busy = true;
      const updated: string[] = [];
      try {
        const items = await store.list();
        const inProject = items.filter(i => i.type === 'file' && i.path.startsWith(project + '/') && !i.path.slice(project.length + 1).includes('/'));
        for (const it of inProject) {
          const f = it.path.slice(project.length + 1);
          const was = known.current[f];
          if (!force && was !== undefined && it.modified <= was) continue;
          if (f === VALUES_FILE) {
            if (valuesDirty.current) continue;
            const r = await store.read(it.path);
            known.current[f] = r.modified;
            valuesEtag.current = r.etag;
            const v = parseValues(r.content);
            if (JSON.stringify(v) === JSON.stringify(valuesRef.current)) continue;
            valuesRef.current = v;
            setValuesState(v);
            setHasValuesFile(true);
            updated.push('shared values');
            continue;
          }
          if (!/\.html$/i.test(f)) continue;
          const d = docsRef.current.find(x => x.file === f);
          if (d && (d.dirty || d.status !== 'saved')) continue; // your own edits win; saving will flag the conflict
          const r = await store.read(it.path);
          known.current[f] = r.modified;
          if (d && r.etag === d.etag) continue;
          const model = parseDoc(r.content, f.replace(/\.html$/i, ''));
          if (d) patch(f, x => ({ ...x, model, etag: r.etag, rev: (x.rev || 0) + 1, savedAt: r.modified * 1000 }));
          else setDocs(prev => prev && [...prev, { file: f, model, etag: r.etag, dirty: false, status: 'saved' as Status, savedAt: r.modified * 1000 }]
            .sort((a, b) => docOrder(a.file) - docOrder(b.file) || a.file.localeCompare(b.file)));
          updated.push(f);
        }
        // Documents removed or renamed elsewhere.
        const present = new Set(inProject.map(i => i.path.slice(project.length + 1)));
        const gone = docsRef.current.filter(d => !present.has(d.file) && !d.dirty && known.current[d.file] !== undefined).map(d => d.file);
        if (gone.length) {
          gone.forEach(f => { delete known.current[f]; });
          setDocs(prev => prev && prev.filter(d => !gone.includes(d.file)));
          updated.push(...gone);
        }
      } catch { /* offline for a moment: try again next time */ } finally { busy = false; }
      if (updated.length) { setRemote(r => ({ n: r.n + 1, files: updated })); setSavedTick(t => t + 1); }
    };
    syncRef.current = tick;
    const id = window.setInterval(() => void tick(), 4000);
    return () => window.clearInterval(id);
  }, [project, store]);

  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (valuesDirty.current || docsRef.current.some(d => d.dirty || d.status === 'saving')) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, []);

  return {
    docs, setDocs, docsRef, values, valuesRef, setValues, replaceAll, reapply, hasValuesFile, loadError, load,
    updateModel, patch, save, saveAll, saveValues, status, lastSaved, usage, live, changedKeys,
    remote, savedTick, syncNow: (force = true) => syncRef.current(force), undo, redo, canUndo: history.current.past.length > 0, canRedo: history.current.future.length > 0, historyTick, pathOf,
  };
}

export type ProjectState = ReturnType<typeof useProject>;
