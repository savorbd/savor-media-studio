// Project-wide shared values (stored once in project.json) and how they are
// written into documents in English and Bangla. Pure functions — no DOM.

export type Lang = 'en' | 'bn';

/** A value in both languages. `bnCustom` = Bangla typed by hand (never auto-overwritten). */
/** `noTranslate` = "Don't translate": the Bangla is the user's own and is never translated automatically. */
export interface Bi { en: string; bn: string; bnCustom?: boolean; noTranslate?: boolean }

export interface Guest {
  id: string;
  prefixes: Bi[];
  name: Bi;
  postfixes: Bi[];
  designation: Bi;
  /** "Don't translate": every Bangla part of this guest is typed by hand. */
  noTranslate?: boolean;
}

export type TextKey = 'exhibitionName' | 'shortName' | 'venue' | 'organizer' | 'visitingHours' | 'contactName' | 'contactTitle' | 'contactOrg';

export interface ProjectValues {
  version: 1;
  text: Partial<Record<TextKey, Bi>>;
  edition: number | null;
  year: number | null;
  hall: number | null;
  eventDate: string | null; // YYYY-MM-DD
  endDate: string | null;
  issueDate: string | null;
  eventTime: string | null; // HH:MM (24h)
  contactPhone: string;
  chiefGuest: Guest | null;
  specialGuests: Guest[];
  /** The special guest who gives the welcome speech in the MC script (default: the last one). */
  hostGuestId?: string | null;
}

export const emptyValues = (): ProjectValues => ({
  version: 1, text: {}, edition: null, year: null, hall: null, eventDate: null, endDate: null, issueDate: null, eventTime: null,
  contactPhone: '', chiefGuest: null, specialGuests: [],
});

export type FieldType = 'text' | 'ordinal' | 'year' | 'hall' | 'date' | 'time' | 'phone' | 'guest' | 'guests';
export type FieldGroup = 'exhibition' | 'venue' | 'chief' | 'special' | 'contact';

export interface FieldDef { key: string; label: string; labelBn: string; type: FieldType; group: FieldGroup }

/** Fields that are no longer shared (organizer, venue, hall, contact organization): their text stays as typed. */
export const RETIRED_FIELDS = new Set(['organizer', 'hall', 'venue', 'contactOrg']);

const ALL_FIELD_DEFS: FieldDef[] = [
  { key: 'edition', label: 'Edition', labelBn: 'আসর', type: 'ordinal', group: 'exhibition' },
  { key: 'exhibitionName', label: 'Exhibition name', labelBn: 'প্রদর্শনীর নাম', type: 'text', group: 'exhibition' },
  { key: 'shortName', label: 'Short name', labelBn: 'সংক্ষিপ্ত নাম', type: 'text', group: 'exhibition' },
  { key: 'year', label: 'Year', labelBn: 'সাল', type: 'year', group: 'exhibition' },
  { key: 'organizer', label: 'Organizer', labelBn: 'আয়োজক', type: 'text', group: 'exhibition' },
  { key: 'hall', label: 'Hall number', labelBn: 'হল নম্বর', type: 'hall', group: 'venue' },
  { key: 'venue', label: 'Venue', labelBn: 'ভেন্যু', type: 'text', group: 'venue' },
  { key: 'eventDate', label: 'Event date', labelBn: 'অনুষ্ঠানের তারিখ', type: 'date', group: 'venue' },
  { key: 'eventTime', label: 'Inauguration time', labelBn: 'উদ্বোধনের সময়', type: 'time', group: 'venue' },
  { key: 'endDate', label: 'Last day', labelBn: 'শেষ দিন', type: 'date', group: 'venue' },
  { key: 'issueDate', label: 'Letter date', labelBn: 'চিঠির তারিখ', type: 'date', group: 'venue' },
  { key: 'visitingHours', label: 'Visiting hours', labelBn: 'দর্শনার্থীর সময়', type: 'text', group: 'venue' },
  { key: 'chiefGuest', label: 'Chief guest', labelBn: 'প্রধান অতিথি', type: 'guest', group: 'chief' },
  { key: 'specialGuests', label: 'Special guests', labelBn: 'বিশেষ অতিথি', type: 'guests', group: 'special' },
  { key: 'contactName', label: 'Contact name', labelBn: 'যোগাযোগকারীর নাম', type: 'text', group: 'contact' },
  { key: 'contactTitle', label: 'Contact title', labelBn: 'পদবি', type: 'text', group: 'contact' },
  { key: 'contactOrg', label: 'Contact organization', labelBn: 'প্রতিষ্ঠান', type: 'text', group: 'contact' },
  { key: 'contactPhone', label: 'Phone', labelBn: 'ফোন', type: 'phone', group: 'contact' },
];
export const FIELD_DEFS: FieldDef[] = ALL_FIELD_DEFS.filter(f => !RETIRED_FIELDS.has(f.key));
export const FIELD = new Map(FIELD_DEFS.map(f => [f.key, f]));

/* ---------- Numbers, digits ---------- */
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
export const toBnDigits = (s: string) => s.replace(/[0-9]/g, d => BN_DIGITS[+d]);
export const toEnDigits = (s: string) => s.replace(/[০-৯]/g, d => String(BN_DIGITS.indexOf(d)));

export function ordinal(n: number, lang: Lang): string {
  if (lang === 'bn') {
    const special: Record<number, string> = { 1: 'ম', 2: 'য়', 3: 'য়', 4: 'র্থ', 5: 'ম', 6: 'ষ্ঠ', 7: 'ম', 8: 'ম', 9: 'ম', 10: 'ম' };
    return toBnDigits(String(n)) + (special[n] || 'তম');
  }
  const r100 = n % 100, r10 = n % 10;
  const suf = r100 >= 11 && r100 <= 13 ? 'th' : r10 === 1 ? 'st' : r10 === 2 ? 'nd' : r10 === 3 ? 'rd' : 'th';
  return n + suf;
}

/* ---------- Dates ---------- */
export const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const BN_MONTHS = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const BN_DAYS = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];

/** Format tokens: D, DD, MMMM, MMM, YYYY, dddd. Default "D MMMM, YYYY". */
export function formatDate(iso: string | null, lang: Lang, fmt = 'D MMMM, YYYY'): string {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const day = new Date(Date.UTC(y, mo, d)).getUTCDay();
  const out = fmt.replace(/dddd|YYYY|MMMM|MMM|DD|D/g, t => {
    switch (t) {
      case 'dddd': return lang === 'bn' ? BN_DAYS[day] : EN_DAYS[day];
      case 'YYYY': return String(y);
      case 'MMMM': return lang === 'bn' ? BN_MONTHS[mo] : EN_MONTHS[mo];
      case 'MMM': return lang === 'bn' ? BN_MONTHS[mo] : EN_MONTHS[mo].slice(0, 3);
      case 'DD': return String(d).padStart(2, '0');
      default: return String(d);
    }
  });
  return lang === 'bn' ? toBnDigits(out) : out;
}

/* ---------- Time ---------- */
/** EN formats: "h:mm A", "h.mm A". BN: "P h.mm ঘটিকায়", "P h:mmটায়", "P hটায়". */
export function formatTime(hhmm: string | null, lang: Lang, fmt?: string): string {
  const m = hhmm?.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const H = +m[1], M = m[2];
  const h = ((H + 11) % 12) + 1;
  if (lang === 'bn') {
    const period = H < 4 ? 'রাত' : H < 12 ? 'সকাল' : H < 15 ? 'দুপুর' : H < 18 ? 'বিকাল' : H < 20 ? 'সন্ধ্যা' : 'রাত';
    const f = fmt || 'P h.mm ঘটিকায়';
    return toBnDigits(f.replace('P', period).replace('mm', M).replace('h', String(h)));
  }
  const f = fmt || 'h:mm A';
  return f.replace('mm', M).replace('h', String(h)).replace('A', H < 12 ? 'AM' : 'PM');
}

/* ---------- Hall ---------- */
/** fmt like "Hall-{nn}", "Hall {n}", "হল-{nn}". */
export function formatHall(n: number | null, lang: Lang, fmt?: string): string {
  if (n == null) return '';
  const f = fmt || (lang === 'bn' ? 'হল-{nn}' : 'Hall-{nn}');
  const out = f.replace('{nn}', String(n).padStart(2, '0')).replace('{n}', String(n));
  return lang === 'bn' ? toBnDigits(out) : out;
}

/* ---------- Guests ---------- */
export type GuestSep = 'comma' | 'period' | 'and' | 'lines';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pick = (b: Bi | undefined, lang: Lang) => (b ? (lang === 'bn' ? b.bn || '' : b.en || '') : '');

export function guestText(g: Guest, lang: Lang): string {
  const pre = g.prefixes.map(p => pick(p, lang)).filter(Boolean).join(' ');
  const parts = [[pre, pick(g.name, lang)].filter(Boolean).join(' '), ...g.postfixes.map(p => pick(p, lang)).filter(Boolean), pick(g.designation, lang)].filter(Boolean);
  return parts.join(', ');
}

export function guestHtml(g: Guest, lang: Lang, bold = false): string {
  const pre = g.prefixes.map(p => pick(p, lang)).filter(Boolean).join(' ');
  const name = esc(pick(g.name, lang));
  const head = [esc(pre), bold && name ? `<strong>${name}</strong>` : name].filter(Boolean).join(' ');
  return [head, ...g.postfixes.map(p => esc(pick(p, lang))).filter(Boolean), esc(pick(g.designation, lang))].filter(Boolean).join(', ');
}

export function guestsHtml(list: Guest[], lang: Lang, sep: GuestSep = 'comma', bold = false, startIndex = 1): string {
  const items = list.map((g, i) => `<span data-guest="${i + startIndex}">${guestHtml(g, lang, bold)}</span>`);
  if (sep === 'lines') return items.join('<br>');
  if (sep === 'period') return items.join(lang === 'bn' ? '। ' : '. ');
  if (sep === 'and' && items.length > 1) return items.slice(0, -1).join(', ') + (lang === 'bn' ? ' এবং ' : ' and ') + items[items.length - 1];
  return items.join(', ');
}

/* ---------- Parts of one guest, the host, and per-guest blocks (MC script) ---------- */
export type GuestPart = 'name' | 'designation' | 'full';
export type EachOrder = 'forward' | 'reverse';

/** Title + name (+ postfixes such as MP) — "Mr. Faizul Alam"; or the designation alone. */
export function guestPartHtml(g: Guest, lang: Lang, part: GuestPart = 'full', bold = false): string {
  if (part === 'full') return guestHtml(g, lang, bold);
  if (part === 'designation') return esc(pick(g.designation, lang));
  const pre = g.prefixes.map(p => pick(p, lang)).filter(Boolean).join(' ');
  const name = esc(pick(g.name, lang));
  const head = [esc(pre), bold && name ? `<strong>${name}</strong>` : name].filter(Boolean).join(' ');
  return [head, ...g.postfixes.map(p => esc(pick(p, lang))).filter(Boolean)].filter(Boolean).join(', ');
}

/** The welcome-speech guest: the one picked as host, else the last special guest. */
export function hostIndex(v: ProjectValues): number {
  const i = v.hostGuestId ? v.specialGuests.findIndex(g => g.id === v.hostGuestId) : -1;
  return i >= 0 ? i : v.specialGuests.length - 1;
}

/** Special guests for a per-guest block, with their printed numbers (1-based). */
export function eachGuests(v: ProjectValues, order: EachOrder = 'forward', skipHost = false): { g: Guest; n: number }[] {
  const host = hostIndex(v);
  const list = v.specialGuests.map((g, i) => ({ g, n: i + 1 })).filter(x => !(skipHost && x.n - 1 === host));
  return order === 'reverse' ? list.reverse() : list;
}

const TOKEN = /\{(name|designation|full)\}/g;

/** One copy of a per-guest block's wording for each guest. Tokens: {name}, {designation}, {full}. */
export function eachHtml(template: string, v: ProjectValues, lang: Lang, order: EachOrder, skipHost: boolean, locked = false): string {
  const ce = locked ? ' contenteditable="false"' : '';
  const list = eachGuests(v, order, skipHost);
  if (!list.length) {
    const ph = esc(placeholder('specialGuests', lang));
    return `<div data-rep="0">${template.replace(TOKEN, () => `<span data-tok="name"${ce}>${ph}</span>`)}</div>`;
  }
  // The first copy stays editable: changing its wording changes every copy.
  return list.map(({ g, n }, i) => `<div data-rep="${i}"${i ? ce : ''}>${template.replace(TOKEN, (_m, t: GuestPart) => `<span data-tok="${t}" data-gref="${n}"${ce}>${guestPartHtml(g, lang, t)}</span>`)}</div>`).join('');
}

/* ---------- Placeholders ---------- */
export function placeholder(key: string, lang: Lang): string {
  const def = FIELD.get(key);
  return `[${def ? (lang === 'bn' ? def.labelBn : def.label) : key}]`;
}

/** Plain text for a scalar field in one language ('' when empty). */
export function scalarText(values: ProjectValues, key: string, lang: Lang, fmt?: string): string {
  const def = FIELD.get(key);
  if (!def) return '';
  switch (def.type) {
    case 'text': return pick(values.text[key as TextKey], lang);
    case 'ordinal': return values.edition ? ordinal(values.edition, lang) : '';
    case 'year': return values.year ? (lang === 'bn' ? toBnDigits(String(values.year)) : String(values.year)) : '';
    case 'hall': return formatHall(values.hall, lang, fmt);
    case 'date': return formatDate((values as any)[key], lang, fmt || undefined);
    case 'time': return formatTime(values.eventTime, lang, fmt || undefined);
    case 'phone': return values.contactPhone || '';
    default: return '';
  }
}

/** HTML for any field slot. */
export function slotHtml(values: ProjectValues, key: string, lang: Lang, opts: { fmt?: string; sep?: GuestSep; bold?: boolean; part?: GuestPart; pick?: string } = {}): string {
  const def = FIELD.get(key);
  if (!def) return '';
  if (def.type === 'guest') return values.chiefGuest ? guestPartHtml(values.chiefGuest, lang, opts.part, opts.bold) : esc(placeholder(key, lang));
  if (def.type === 'guests' && opts.pick === 'host') {
    const h = values.specialGuests[hostIndex(values)];
    return h ? guestPartHtml(h, lang, opts.part, opts.bold) : esc(lang === 'bn' ? '[স্বাগত বক্তা]' : '[Host]');
  }
  if (def.type === 'guests') return values.specialGuests.length ? guestsHtml(values.specialGuests, lang, opts.sep, opts.bold) : esc(placeholder(key, lang));
  const t = scalarText(values, key, lang, opts.fmt);
  return esc(t || placeholder(key, lang));
}

/* ---------- Offline helpers for titles ---------- */
const PREFIX_BN: [string, string][] = [
  ['His Excellency', 'মাননীয়'], ['Her Excellency', 'মাননীয়'],
  ['Lieutenant General', 'লেফটেন্যান্ট জেনারেল'], ['Lt Gen', 'লেফটেন্যান্ট জেনারেল'], ['Major General', 'মেজর জেনারেল'], ['Maj Gen', 'মেজর জেনারেল'],
  ['Brigadier General', 'ব্রিগেডিয়ার জেনারেল'], ['Brig Gen', 'ব্রিগেডিয়ার জেনারেল'], ['General', 'জেনারেল'],
  ['Vice Admiral', 'ভাইস অ্যাডমিরাল'], ['Rear Admiral', 'রিয়ার অ্যাডমিরাল'], ['Admiral', 'অ্যাডমিরাল'], ['Commodore', 'কমোডোর'],
  ['Air Chief Marshal', 'এয়ার চিফ মার্শাল'], ['Air Vice Marshal', 'এয়ার ভাইস মার্শাল'], ['Air Marshal', 'এয়ার মার্শাল'], ['Air Commodore', 'এয়ার কমোডোর'],
  ['Group Captain', 'গ্রুপ ক্যাপ্টেন'], ['Captain', 'ক্যাপ্টেন'], ['Commander', 'কমান্ডার'], ['Lieutenant Colonel', 'লেফটেন্যান্ট কর্নেল'], ['Lt Col', 'লেফটেন্যান্ট কর্নেল'],
  ['Colonel', 'কর্নেল'], ['Major', 'মেজর'], ['Barrister', 'ব্যারিস্টার'], ['Advocate', 'অ্যাডভোকেট'], ['Justice', 'বিচারপতি'], ['Alhaj', 'আলহাজ্ব'],
  ['Professor', 'অধ্যাপক'], ['Prof.', 'অধ্যাপক'], ['Engr.', 'প্রকৌশলী'], ['Engineer', 'প্রকৌশলী'], ['Dr.', 'ড.'],
  ['Mr.', 'জনাব'], ['Mrs.', 'বেগম'], ['Ms.', 'জনাবা'], ['Miss', 'জনাবা'], ['H.E.', 'মাননীয়'],
];
export const EN_PREFIXES = PREFIX_BN.map(p => p[0]);
// 'মাননীয়' (Hon'ble) usually starts a designation, so it never starts a guest.
export const BN_PREFIXES = Array.from(new Set([...PREFIX_BN.map(p => p[1]), 'ডঃ', 'ডা.', 'প্রফেসর', 'ইঞ্জিনিয়ার', 'এডভোকেট', 'বেগম', 'জনাব', 'জনাবা'])).filter(p => p !== 'মাননীয়');

export function prefixToBn(en: string): string {
  const hit = PREFIX_BN.find(([e]) => e.toLowerCase() === en.trim().toLowerCase());
  return hit ? hit[1] : '';
}

const LETTER_BN: Record<string, string> = {
  A: 'এ', B: 'বি', C: 'সি', D: 'ডি', E: 'ই', F: 'এফ', G: 'জি', H: 'এইচ', I: 'আই', J: 'জে', K: 'কে', L: 'এল', M: 'এম',
  N: 'এন', O: 'ও', P: 'পি', Q: 'কিউ', R: 'আর', S: 'এস', T: 'টি', U: 'ইউ', V: 'ভি', W: 'ডব্লিউ', X: 'এক্স', Y: 'ওয়াই', Z: 'জেড',
};
/** NBP → এনবিপি, ndc → এনডিসি, (ND) → (এনডি), PhD → পিএইচডি */
export function acronymToBn(en: string): string {
  return en.replace(/[A-Za-z]/g, ch => LETTER_BN[ch.toUpperCase()] || ch);
}
export const BN_LETTER_NAMES = Object.values(LETTER_BN).sort((a, b) => b.length - a.length);
/** True when a Bangla token is spelled out English letters (এনবিপি, (এনডি)). */
export function isBnAcronym(token: string): boolean {
  let t = token.replace(/[()]/g, '').trim();
  if (!t || /\s/.test(t)) return false;
  let count = 0;
  while (t) {
    const hit = BN_LETTER_NAMES.find(l => t.startsWith(l));
    if (!hit) return false;
    t = t.slice(hit.length); count++;
  }
  return count >= 2;
}

let idCounter = 0;
export const newId = () => `g${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export function emptyGuest(): Guest {
  return { id: newId(), prefixes: [], name: { en: '', bn: '' }, postfixes: [], designation: { en: '', bn: '' } };
}

/** Parse a stored project.json safely. */
export function parseValues(json: string | null | undefined): ProjectValues {
  try {
    const v = JSON.parse(json || '');
    if (v && v.version === 1) return { ...emptyValues(), ...v, text: v.text || {}, specialGuests: Array.isArray(v.specialGuests) ? v.specialGuests : [] };
  } catch {}
  return emptyValues();
}

/* ---------- Colours: every value gets its own, as distinct as possible ---------- */
// Red is reserved for the selected value.
export const VALUE_COLORS = [
  '#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#ca8a04', '#db2777', '#4d7c0f', '#0d9488', '#7c3aed',
  '#b45309', '#1d4ed8', '#65a30d', '#c026d3', '#0369a1', '#a16207', '#047857', '#6d28d9', '#be185d', '#0e7490',
  '#854d0e', '#3f6212', '#4338ca', '#15803d', '#9d174d', '#57534e', '#0f766e', '#7e22ce', '#c2410c', '#1e40af',
];

const KEY_ORDER = FIELD_DEFS.map(f => f.key).filter(k => k !== 'specialGuests');

/** Colour for a field key, or "specialGuests:N" for the Nth special guest. */
export function colorFor(key: string): string {
  if (key.startsWith('specialGuests:')) {
    const n = +key.split(':')[1] || 1;
    return VALUE_COLORS[(KEY_ORDER.length + n - 1) % VALUE_COLORS.length];
  }
  const i = KEY_ORDER.indexOf(key);
  return VALUE_COLORS[(i < 0 ? 0 : i) % VALUE_COLORS.length];
}
