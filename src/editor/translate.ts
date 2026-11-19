// Gemini translation through the WordPress plugin (key stays on the server).

import { getStudioConfig, studioApi } from '../utils/studioServer';
import { sanitizeEditorHtml } from './sanitize';

const PASS_KEY = 'savor-studio-gemini-passcode';

export function geminiAvailable(): boolean {
  return !!getStudioConfig()?.gemini;
}

/** AI providers with a key on the server (Gemini, Claude, ChatGPT, OpenRouter). */
export function aiProviders(): { id: string; label: string }[] {
  const c = getStudioConfig();
  if (c?.ai?.providers) return c.ai.providers;
  return c?.gemini ? [{ id: 'gemini', label: 'Gemini' }] : [];
}
export function defaultProvider(): string {
  return getStudioConfig()?.ai?.default || aiProviders()[0]?.id || '';
}
export function passcodeRequired(): boolean {
  return !!getStudioConfig()?.geminiPasscode;
}
export function getPasscode(): string {
  try { return localStorage.getItem(PASS_KEY) || ''; } catch { return ''; }
}
export function setPasscode(value: string) {
  try { localStorage.setItem(PASS_KEY, value); } catch {}
}

/** Translate plain field values (English → Bangla). */
export async function translateFields(fields: { id: string; text: string }[], provider?: string): Promise<Record<string, string>> {
  if (!fields.length) return {};
  const res = await studioApi.translate(fields, getPasscode() || undefined, 'fields', provider);
  return Object.fromEntries(res.translations.map(t => [t.id, t.text]));
}

const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,caption,figcaption,div';
const LATIN = /[A-Za-z]/;

/** Translate HTML fragments, keeping their tags. Returns sanitized HTML per id. */
async function translateHtmlItems(items: { id: string; text: string }[], onProgress?: (done: number, total: number) => void): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const batches: { id: string; text: string }[][] = [];
  let batch: { id: string; text: string }[] = [], size = 0;
  for (const item of items) {
    if (batch.length && (batch.length >= 30 || size + item.text.length > 9000)) { batches.push(batch); batch = []; size = 0; }
    batch.push(item); size += item.text.length;
  }
  if (batch.length) batches.push(batch);
  let done = 0;
  onProgress?.(0, items.length);
  for (const b of batches) {
    const res = await studioApi.translate(b, getPasscode() || undefined, 'html');
    for (const t of res.translations) out[t.id] = sanitizeEditorHtml(t.text);
    done += b.length;
    onProgress?.(done, items.length);
  }
  return out;
}

/** Translate a whole document body into Bangla, block by block. */
export async function translateBody(body: string, onProgress?: (done: number, total: number) => void): Promise<string> {
  const t = document.createElement('template');
  t.innerHTML = body;
  const blocks = Array.from(t.content.querySelectorAll<HTMLElement>(BLOCKS))
    .filter(el => !el.querySelector(BLOCKS) && LATIN.test(el.textContent || ''));
  const items = blocks.map((el, i) => ({ id: 'b' + i, text: el.innerHTML }));
  if (!items.length) return body;
  const result = await translateHtmlItems(items, onProgress);
  blocks.forEach((el, i) => { const html = result['b' + i]; if (html && html.trim()) el.innerHTML = html; });
  return t.innerHTML;
}

/** Translate one HTML fragment (a selection). */
export async function translateFragment(html: string): Promise<string> {
  const result = await translateHtmlItems([{ id: 's0', text: html }]);
  return result.s0 || html;
}
