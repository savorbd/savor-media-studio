import { DocLang, DocModel, emptyDoc } from './doc';
import { Lang, RETIRED_FIELDS, eachHtml, emptyValues, slotHtml } from './values';

export interface ProjectDocSpec { file: string; title: string; lang: DocLang; kind: 'invitation' | 'press' | 'mc' }

/** The four documents every new project starts with (file names inside the project folder). */
export const PROJECT_DOCS: ProjectDocSpec[] = [
  { file: 'Invitation (Bangla).html', title: 'মিডিয়া ইনভিটেশন', lang: 'bn', kind: 'invitation' },
  { file: 'Invitation (English).html', title: 'Media Invitation', lang: 'en', kind: 'invitation' },
  { file: 'Press Release (Bangla).html', title: 'সংবাদ বিজ্ঞপ্তি', lang: 'bn', kind: 'press' },
  { file: 'Press Release (English).html', title: 'Press Release', lang: 'en', kind: 'press' },
  { file: 'MC Script (English).html', title: 'MC Script', lang: 'en', kind: 'mc' },
];
export const MC_SCRIPT = PROJECT_DOCS[4];

export function docOrder(file: string): number {
  const i = PROJECT_DOCS.findIndex(d => d.file === file);
  return i < 0 ? 100 : i;
}

export function shortDocLabel(file: string): string {
  const known = PROJECT_DOCS.find(d => d.file === file);
  if (known?.kind === 'mc') return 'MC Script';
  if (known) return `${known.kind === 'invitation' ? 'Invitation' : 'Press release'} · ${known.lang === 'bn' ? 'বাংলা' : 'EN'}`;
  if (/mc\s*script/i.test(file)) return file.replace(/\.html$/i, '');
  return file.replace(/\.html$/i, '');
}

/** Text for values that are no longer shared (you type them straight into the page). */
const RETIRED_TEXT: Record<string, Record<Lang, string>> = {
  organizer: { en: 'Savor International Limited', bn: 'সেভার ইন্টারন্যাশনাল লিমিটেড' },
  venue: { en: '[Venue]', bn: '[ভেন্যু]' },
  hall: { en: '[Hall]', bn: '[হল]' },
  contactOrg: { en: 'Savor International Limited', bn: 'সেভার ইন্টারন্যাশনাল লিমিটেড' },
};

/** A linked slot, pre-filled with its placeholder. */
function slot(lang: Lang, key: string, attrs: Record<string, string> = {}): string {
  if (RETIRED_FIELDS.has(key)) return RETIRED_TEXT[key]?.[lang] || ''; // plain text, not shared
  const a = Object.entries(attrs).map(([k, v]) => ` data-${k}="${v}"`).join('');
  return `<span data-field="${key}"${a}>${slotHtml(emptyValues(), key, lang, { fmt: attrs.fmt, part: attrs.part as any, pick: attrs.pick })}</span>`;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A block written once per special guest (wording with {name} and {designation}). */
function eachBlock(lang: Lang, template: string, order: 'forward' | 'reverse', skipHost: boolean): string {
  const t = template.trim().replace(/\n\s*/g, '');
  return `<div data-field="specialGuests" data-each="${attr(t)}" data-order="${order}"${skipHost ? ' data-skip="host"' : ''}>${eachHtml(t, emptyValues(), lang, order, skipHost)}</div>`;
}

const J = 'text-align:justify';

function invitationEn(): string {
  const s = (k: string, a?: Record<string, string>) => slot('en', k, a);
  return `
<p style="text-align:right">Date: ${s('issueDate', { fmt: 'D MMMM, YYYY' })}</p>
<p>To<br>Chief Reporter</p>
<p><strong>Subject: Request to send a journalist to the inauguration ceremony of “${s('edition', { fmt: 'ordinal' })} ${s('shortName')} ${s('year')}”</strong></p>
<p>Dear Sir/Madam,</p>
<p style="${J}">${s('organizer')} is pleased to invite you to the inauguration ceremony of the ${s('edition', { fmt: 'ordinal' })} edition of ${s('exhibitionName')} – ${s('shortName')} ${s('year')}, scheduled to be held on ${s('eventDate', { fmt: 'D MMMM, YYYY' })} at ${s('eventTime', { fmt: 'h:mm A' })} at ${s('hall', { fmt: 'Hall-{nn}' })}, ${s('venue')}.</p>
<p style="${J}">The ceremony will be inaugurated by Chief Guest: ${s('chiefGuest')}. Special Guests: ${s('specialGuests', { sep: 'comma' })} will also be present at the ceremony.</p>
<p style="${J}">We sincerely request your esteemed media house to kindly send a reporter and a photojournalist to cover the event.</p>
<p><strong>Program schedule</strong><br>Inaugural ceremony: “${s('edition', { fmt: 'ordinal' })} ${s('exhibitionName')} – ${s('shortName')} ${s('year')}”<br>Place: ${s('hall', { fmt: 'Hall-{nn}' })}, ${s('venue')}<br>Date: ${s('eventDate', { fmt: 'D MMMM, YYYY' })}<br>Time: ${s('eventTime', { fmt: 'h.mm A' })}</p>
<p>${s('contactName')}<br>${s('contactTitle')}<br>${s('contactOrg')}<br>RSVP: ${s('contactPhone')}</p>`;
}

function invitationBn(): string {
  const s = (k: string, a?: Record<string, string>) => slot('bn', k, a);
  return `
<p style="text-align:right">তারিখঃ ${s('issueDate', { fmt: 'D MMMM, YYYY' })}</p>
<p>বরাবর<br>প্রধান বার্তা সম্পাদক</p>
<p><strong>বিষয়: “${s('edition', { fmt: 'ordinal' })} ${s('shortName')} ${s('year')}” শীর্ষক আন্তর্জাতিক প্রদর্শনীর উদ্বোধনী অনুষ্ঠানে প্রতিবেদক ও ফটোসাংবাদিক পাঠানোর অনুরোধ।</strong></p>
<p>প্রিয় মহোদয়,</p>
<p style="${J}">${s('organizer')}, আগামী ${s('eventDate', { fmt: 'D MMMM, YYYY' })} তারিখে ${s('eventTime', { fmt: 'P h.mm ঘটিকায়' })} ${s('venue')}, ${s('hall', { fmt: 'হল-{nn}' })}-এ “${s('exhibitionName')} – ${s('shortName')} ${s('year')}” এর ${s('edition', { fmt: 'ordinal' })} আসরের উদ্বোধনের আয়োজন করতে যাচ্ছে।</p>
<p style="${J}">অনুষ্ঠানটি উদ্বোধন করবেন প্রধান অতিথি: ${s('chiefGuest')}। বিশেষ অতিথি: ${s('specialGuests', { sep: 'comma' })} উপস্থিত থাকবেন।</p>
<p style="${J}">আপনার সম্মানিত সংবাদমাধ্যমের একজন প্রতিবেদক ও একজন ফটোসাংবাদিক পাঠিয়ে অনুষ্ঠানের সংবাদ প্রচারের জন্য বিনীত অনুরোধ জানাচ্ছি।</p>
<p><strong>অনুষ্ঠানসূচি</strong><br>উদ্বোধনী অনুষ্ঠান: “${s('edition', { fmt: 'ordinal' })} ${s('shortName')} ${s('year')}”<br>স্থান: ${s('hall', { fmt: 'হল-{nn}' })}, ${s('venue')}<br>তারিখ: ${s('eventDate', { fmt: 'D MMMM, YYYY' })}<br>সময়: ${s('eventTime', { fmt: 'P h.mm ঘটিকায়' })}</p>
<p>${s('contactName')}<br>${s('contactTitle')}<br>${s('contactOrg')}<br>মোবাইল: ${s('contactPhone')}</p>`;
}

function pressEn(): string {
  const s = (k: string, a?: Record<string, string>) => slot('en', k, a);
  return `
<p>${s('issueDate', { fmt: 'D MMMM, YYYY' })}</p>
<h1 style="text-align:center">PRESS RELEASE</h1>
<p style="${J}">The inauguration ceremony of “${s('exhibitionName')} – ${s('shortName')} ${s('year')}” was held today, ${s('eventDate', { fmt: 'MMMM D, YYYY' })}, at ${s('venue')}. The event has been organized by ${s('organizer')}.</p>
<p style="${J}">The exhibition was inaugurated by Chief Guest: ${s('chiefGuest', { bold: '1' })}. Special Guests: ${s('specialGuests', { sep: 'comma', bold: '1' })} were also present at the ceremony.</p>
<p style="${J}">The exhibition brings together leading companies from home and abroad, along with investors, technologists and business representatives.</p>
<p style="${J}">The exhibition is open to all visitors from ${s('eventDate', { fmt: 'MMMM D' })} to ${s('endDate', { fmt: 'MMMM D, YYYY' })}, daily from ${s('visitingHours')}.</p>
<p>Message sender<br>${s('contactName')}<br>${s('contactTitle')}<br>${s('contactOrg')}<br>RSVP: ${s('contactPhone')}</p>`;
}

function pressBn(): string {
  const s = (k: string, a?: Record<string, string>) => slot('bn', k, a);
  return `
<p>তারিখঃ ${s('issueDate', { fmt: 'D MMMM, YYYY' })}</p>
<h1 style="text-align:center">সংবাদ বিজ্ঞপ্তি</h1>
<p style="${J}">আজ ${s('eventDate', { fmt: 'D MMMM YYYY' })}, ${s('organizer')}-এর আয়োজনে ${s('venue')}-এ অনুষ্ঠিত হলো “${s('edition', { fmt: 'ordinal' })} ${s('shortName')} ${s('year')}”–এর উদ্বোধনী অনুষ্ঠান।</p>
<p style="${J}">প্রদর্শনীর উদ্বোধন করেন প্রধান অতিথি: ${s('chiefGuest', { bold: '1' })}। বিশেষ অতিথি: ${s('specialGuests', { sep: 'comma', bold: '1' })}।</p>
<p style="${J}">প্রদর্শনীতে দেশি-বিদেশি শীর্ষস্থানীয় প্রতিষ্ঠান, বিনিয়োগকারী, প্রযুক্তিবিদ ও ব্যবসায়ী প্রতিনিধিরা অংশ নিচ্ছেন।</p>
<p style="${J}">প্রদর্শনীটি ${s('eventDate', { fmt: 'D MMMM' })} থেকে ${s('endDate', { fmt: 'D MMMM, YYYY' })} পর্যন্ত প্রতিদিন ${s('visitingHours')} সকল দর্শনার্থীর জন্য উন্মুক্ত থাকবে।</p>
<p>বার্তা প্রেরক<br>${s('contactName')}<br>${s('contactTitle')}<br>${s('contactOrg')}<br>মোবাইল: ${s('contactPhone')}</p>`;
}

/** MC script of the inauguration ceremony (from Savor's BEVMX 2026 script). Speeches: the host's welcome,
 * then the special guests from last to first, then the chief guest. Crests: the special guests in printed order,
 * the host to the chief guest, the chief guest to the host. */
function mcScriptEn(): string {
  const s = (k: string, a?: Record<string, string>) => slot('en', k, a);
  const P = 'text-align:justify;line-height:1.5';
  const MARK = 'text-align:center;font-size:24pt;color:#808080;margin:.4em 0';
  const hostName = s('specialGuests', { pick: 'host', part: 'name' });
  const hostDesig = s('specialGuests', { pick: 'host', part: 'designation' });
  const chiefName = s('chiefGuest', { part: 'name' });
  const chiefDesig = s('chiefGuest', { part: 'designation' });
  const thanks = `<p style="${P}">Thank you Sir for your valuable speech. It was really interesting to hear from you.</p>`;
  return `
<p style="text-align:center"><strong>MC Script of ${s('shortName')} ${s('year')}</strong></p>
<p style="text-align:center;margin-bottom:0"><strong><span style="font-size:20pt;color:#e16c08">Inaugural Ceremony – ${s('shortName')} ${s('year')}</span></strong></p>
<p style="text-align:center;font-size:14pt"><strong>Inaugural Ceremony</strong>: ${s('eventTime', { fmt: 'h:mm A' })} – 11:30 AM</p>
<p style="text-align:center;font-size:14pt">Venue: Expo Village, International Convention City Bashundhara (ICCB)</p>
<p><br></p>
<p style="${P}">Ladies &amp; Gentlemen,</p>
<p style="${P}">Good Morning</p>
<p style="${P}">Today is ${s('eventDate', { fmt: 'D MMMM, YYYY' })}</p>
<p style="${P}">This is......, your Master of the Ceremony for today.</p>
<p><br></p>
<p style="${P}">We have convened here today for a significant purpose - the International Exhibitions titled <strong>“${s('exhibitionName')} (${s('shortName')} ${s('year')})”</strong>. These international exhibitions are organized by <strong>Savor International Limited</strong>.</p>
<p><br></p>
<p style="${P}">The program starts with the welcome speech. I would like to request to come on stage, <strong>${hostName}</strong>, ${hostDesig}.</p>
<p style="${MARK}">[Speech of ${hostName}]</p>
<p style="${P}">Thank you Sir for the welcome speech.</p>
<p><br></p>
${eachBlock('en', `
<p style="${P}">Now I would like to request our Special Guest <strong>{name},</strong> {designation} to present his valuable speech.</p>
<p style="${MARK}">[Speech of {name}]</p>
${thanks}
<p><br></p>`, 'reverse', true)}
<p style="${P}">Now, I would like to request our Honorable Chief Guest <strong>${chiefName},</strong> ${chiefDesig} to deliver his valuable speech.</p>
<p style="${MARK}">[Speech of ${chiefName}]</p>
<p style="${P}">Thank you Sir for your valuable speech. It was really interesting and inspiring to hear from you.</p>
<p><br></p>
<p style="${MARK}">[Inauguration Ceremony]</p>
<p style="${P}">The highly anticipated moment we have all been eagerly awaiting, has arrived. I kindly request all our esteemed guests to join us for the Inaugural Ceremony. As you can see, the ribbon before us symbolizes the commencement of this international exhibition. Our distinguished guests will now officially inaugurate the event by cutting the ribbon.</p>
<p style="${P}"><strong>May I request our distinguished guests to cut the ribbon on the count of five. One… Two… Three… Four… Five!</strong></p>
<p style="${P}">We extend our heartfelt gratitude to each and every one of you for gracing this ceremony with your presence and contributing to its exceptional significance.</p>
<p><br></p>
<p style="${MARK}">[Crest giving ceremony]</p>
<p style="${P}">Honorable Guests, your spontaneous participation has made our program successful today. Please accept gratitude from the bottom of our heart. At this moment we are going to start crest giving ceremony.</p>
<p><br></p>
${eachBlock('en', `
<p style="${P}">Now I would like to request our Special Guest, <strong>{name},</strong> {designation} will receive the crest from our honorable Chief Guest.</p>
<p style="${P}">Thank you sir.</p>
<p><br></p>`, 'forward', true)}
<p style="${P}">I would like to request <strong>${hostName}</strong>, ${hostDesig} to give the crest to our honorable Chief Guest <strong>${chiefName},</strong> ${chiefDesig}.</p>
<p style="${P}">Thank you sir.</p>
<p><br></p>
<p style="${P}">It’s time to thank our Organizer <strong>${hostName}</strong>, ${hostDesig}.</p>
<p style="${P}">Now I would like to request our Chief Guest to present the crest to <strong>${hostName}</strong>, ${hostDesig}.</p>
<p style="${P}">Thank you Sir.</p>
<p><br></p>
<p style="${P}">We would like to extend our heartfelt gratitude to all our guests to witness the historical moment. Please keep us in your prayers for achieving all the success possible in days to come.</p>
<p style="${P}">Good luck and have a wonderful day. This inauguration ceremony will end up with the photo session. I would like to request our respected sponsors to come up on the stage and join in the photo session with our honorable guests.</p>
<p><br></p>
<p style="text-align:center"><strong>Thank you</strong></p>`;
}

/** A new MC script document (Calibri 18 pt like Savor's Word script). */
export function mcScriptDoc(): DocModel {
  return { ...emptyDoc(MC_SCRIPT.title, 'en', mcScriptEn().trim()), font: "Calibri, Carlito, 'Hind Siliguri', sans-serif", fontSize: 18 };
}

export interface ProjectTemplate {
  id: 'standard' | 'blank' | 'bimox' | 'upload';
  name: string;
  description: string;
}

export const TEMPLATES: ProjectTemplate[] = [
  { id: 'standard', name: 'Event invitation & press release', description: 'Bangla and English letters and the MC script, with shared fields for the exhibition, dates, guests and contact.' },
  { id: 'bimox', name: 'BIMOX 2026 sample', description: 'The four real BIMOX 2026 documents. Shared fields are found automatically.' },
  { id: 'blank', name: 'Blank', description: 'Four empty pages: invitation and press release in Bangla and English.' },
  { id: 'upload', name: 'From my files', description: 'Upload Word, HTML or text files. Shared fields are found automatically.' },
];

export function standardDocs(): { spec: ProjectDocSpec; model: DocModel }[] {
  const bodies: Record<string, () => string> = {
    'Invitation (Bangla).html': invitationBn, 'Invitation (English).html': invitationEn,
    'Press Release (Bangla).html': pressBn, 'Press Release (English).html': pressEn,
  };
  return PROJECT_DOCS.map(spec => ({ spec, model: spec.kind === 'mc' ? mcScriptDoc() : emptyDoc(spec.title, spec.lang, bodies[spec.file]().trim()) }));
}

export function blankDocs(): { spec: ProjectDocSpec; model: DocModel }[] {
  return PROJECT_DOCS.filter(s => s.kind !== 'mc').map(spec => ({ spec, model: emptyDoc(spec.title, spec.lang) }));
}
