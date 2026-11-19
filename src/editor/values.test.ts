import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGuest, splitGuestList } from './guestParse';
import { acronymToBn, formatDate, formatHall, formatTime, guestText, isBnAcronym, ordinal } from './values';

test('Bangla and English formatting', () => {
  assert.equal(ordinal(8, 'en'), '8th');
  assert.equal(ordinal(8, 'bn'), '৮ম');
  assert.equal(ordinal(2, 'bn'), '২য়');
  assert.equal(ordinal(11, 'en'), '11th');
  assert.equal(formatDate('2026-10-15', 'en', 'D MMMM, YYYY'), '15 October, 2026');
  assert.equal(formatDate('2026-10-15', 'en', 'MMMM D, YYYY'), 'October 15, 2026');
  assert.equal(formatDate('2026-10-15', 'bn', 'D MMMM, YYYY'), '১৫ অক্টোবর, ২০২৬');
  assert.equal(formatTime('10:30', 'en', 'h.mm A'), '10.30 AM');
  assert.equal(formatTime('10:30', 'bn', 'P h.mm ঘটিকায়'), 'সকাল ১০.৩০ ঘটিকায়');
  assert.equal(formatTime('15:00', 'bn'), 'বিকাল ৩.০০ ঘটিকায়');
  assert.equal(formatHall(4, 'en', 'Hall-{nn}'), 'Hall-04');
  assert.equal(formatHall(4, 'bn', 'হল {n}'), 'হল ৪');
  assert.equal(acronymToBn('NBP'), 'এনবিপি');
  assert.equal(acronymToBn('(ND)'), '(এনডি)');
  assert.ok(isBnAcronym('এএফডব্লিউসি'));
  assert.ok(!isBnAcronym('উপাচার্য'));
});

test('guest lists split into guests with prefixes and postfixes', () => {
  const en = 'Mr. Joris van Bommel, The Ambassador, Embassy of the Netherlands, Dhaka. Rear Admiral Dr. Khandakar Akhter Hossain, NBP, NUP, ndc, psc, PhD, Vice-Chancellor, Bangladesh Maritime University, Commodore Md. Shafiul Bari, (ND), OSP, ndc, psc, BN, Director General, Department of Shipping';
  const ranges = splitGuestList(en, 'en');
  assert.equal(ranges.length, 3);
  const g = parseGuest(en.slice(ranges[1].start, ranges[1].end), 'en');
  assert.deepEqual(g.prefixes, ['Rear Admiral', 'Dr.']);
  assert.equal(g.name, 'Khandakar Akhter Hossain');
  assert.deepEqual(g.postfixes, ['NBP', 'NUP', 'ndc', 'psc', 'PhD']);
  assert.equal(g.designation, 'Vice-Chancellor, Bangladesh Maritime University');
  const bn = 'জনাব মোঃ সলিমুজ্জামান মোল্লা, মাননীয় সংসদ সদস্য, গোপালগঞ্জ-১, রিয়ার অ্যাডমিরাল মোঃ মঈনুল হাসান, এনবিপি, বিএসপি, মহাপরিচালক, বাংলাদেশ কোস্ট গার্ড';
  const br = splitGuestList(bn, 'bn');
  assert.equal(br.length, 2);
  const b = parseGuest(bn.slice(br[1].start, br[1].end), 'bn');
  assert.deepEqual(b.postfixes, ['এনবিপি', 'বিএসপি']);
  assert.equal(b.designation, 'মহাপরিচালক, বাংলাদেশ কোস্ট গার্ড');
  assert.equal(guestText({ id: 'x', prefixes: [{ en: 'Mr.', bn: 'জনাব' }], name: { en: 'A B', bn: 'এ বি' }, postfixes: [{ en: 'ndc', bn: 'এনডিসি' }], designation: { en: 'Chairman', bn: 'চেয়ারম্যান' } }, 'bn'), 'জনাব এ বি, এনডিসি, চেয়ারম্যান');
});

test('MC script: host, guest parts and per-guest blocks', async () => {
  const { eachHtml, hostIndex, guestPartHtml, emptyValues } = await import('./values');
  const g = (id: string, name: string, des: string) => ({ id, prefixes: [{ en: 'Mr.', bn: 'জনাব' }], name: { en: name, bn: name }, postfixes: [], designation: { en: des, bn: des } });
  const v = { ...emptyValues(), specialGuests: [g('a', 'Khorshed Alam', 'President'), g('b', 'Li Xiao', 'Director'), g('c', 'Faizul Alam', 'MD')] };
  assert.equal(hostIndex(v), 2); // the last guest by default
  assert.equal(hostIndex({ ...v, hostGuestId: 'a' }), 0);
  assert.equal(guestPartHtml(v.specialGuests[1], 'en', 'name'), 'Mr. Li Xiao');
  const html = eachHtml('<p>{name}: {designation}</p>', v, 'en', 'reverse', true);
  assert.match(html, /data-rep="0"><p><span data-tok="name" data-gref="2">Mr\. Li Xiao<\/span>: <span data-tok="designation" data-gref="2">Director<\/span><\/p><\/div><div data-rep="1"><p><span data-tok="name" data-gref="1">Mr\. Khorshed Alam/);
  assert.doesNotMatch(html, /Faizul/);
});
