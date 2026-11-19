<?php
/**
 * Shared values (project.json) and how they are written into documents.
 * A PHP port of the app's src/editor/values.ts and bindings.ts, so a value
 * changed on the server reads exactly like one changed in the studio.
 */

if (!defined('ABSPATH')) {
	exit;
}

class SMS_Values {
	/** key => [label, Bangla label, type, group] — same order as the app. */
	const FIELDS = array(
		'edition'        => array('Edition', 'আসর', 'ordinal', 'exhibition'),
		'exhibitionName' => array('Exhibition name', 'প্রদর্শনীর নাম', 'text', 'exhibition'),
		'shortName'      => array('Short name', 'সংক্ষিপ্ত নাম', 'text', 'exhibition'),
		'year'           => array('Year', 'সাল', 'year', 'exhibition'),
		'eventDate'      => array('Event date', 'অনুষ্ঠানের তারিখ', 'date', 'venue'),
		'eventTime'      => array('Inauguration time', 'উদ্বোধনের সময়', 'time', 'venue'),
		'endDate'        => array('Last day', 'শেষ দিন', 'date', 'venue'),
		'issueDate'      => array('Letter date', 'চিঠির তারিখ', 'date', 'venue'),
		'visitingHours'  => array('Visiting hours', 'দর্শনার্থীর সময়', 'text', 'venue'),
		'chiefGuest'     => array('Chief guest', 'প্রধান অতিথি', 'guest', 'chief'),
		'specialGuests'  => array('Special guests', 'বিশেষ অতিথি', 'guests', 'special'),
		'contactName'    => array('Contact name', 'যোগাযোগকারীর নাম', 'text', 'contact'),
		'contactTitle'   => array('Contact title', 'পদবি', 'text', 'contact'),
		'contactPhone'   => array('Phone', 'ফোন', 'phone', 'contact'),
	);
	/** No longer shared: their links become plain text. */
	const RETIRED = array('organizer', 'hall', 'venue', 'contactOrg');
	const TEXT_KEYS = array('exhibitionName', 'shortName', 'visitingHours', 'contactName', 'contactTitle');

	const EN_MONTHS = array('January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December');
	const BN_MONTHS = array('জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর');
	const EN_DAYS   = array('Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday');
	const BN_DAYS   = array('রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার');

	public static function empty_values() {
		return array(
			'version' => 1, 'text' => new stdClass(), 'edition' => null, 'year' => null, 'hall' => null,
			'eventDate' => null, 'endDate' => null, 'issueDate' => null, 'eventTime' => null,
			'contactPhone' => '', 'chiefGuest' => null, 'specialGuests' => array(),
		);
	}

	/** project.json → array (text as array). */
	public static function parse($json) {
		$v = json_decode((string) $json, true);
		$out = self::empty_values();
		$out['text'] = array();
		if (is_array($v) && 1 === ($v['version'] ?? null)) {
			$out = array_merge($out, $v);
			$out['text'] = is_array($v['text'] ?? null) ? $v['text'] : array();
			$out['specialGuests'] = is_array($v['specialGuests'] ?? null) ? array_values($v['specialGuests']) : array();
		}
		return $out;
	}

	public static function to_json($values) {
		$v = $values;
		$v['text'] = empty($v['text']) ? new stdClass() : $v['text'];
		return wp_json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
	}

	/* ---------- Formatting ---------- */

	public static function bn_digits($s) {
		return strtr((string) $s, array('0' => '০', '1' => '১', '2' => '২', '3' => '৩', '4' => '৪', '5' => '৫', '6' => '৬', '7' => '৭', '8' => '৮', '9' => '৯'));
	}

	public static function ordinal($n, $lang) {
		$n = (int) $n;
		if ('bn' === $lang) {
			$special = array(1 => 'ম', 2 => 'য়', 3 => 'য়', 4 => 'র্থ', 5 => 'ম', 6 => 'ষ্ঠ', 7 => 'ম', 8 => 'ম', 9 => 'ম', 10 => 'ম');
			return self::bn_digits((string) $n) . ($special[$n] ?? 'তম');
		}
		$r100 = $n % 100;
		$r10  = $n % 10;
		$suf  = ($r100 >= 11 && $r100 <= 13) ? 'th' : (1 === $r10 ? 'st' : (2 === $r10 ? 'nd' : (3 === $r10 ? 'rd' : 'th')));
		return $n . $suf;
	}

	public static function format_date($iso, $lang, $fmt = null) {
		if (!$iso || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', (string) $iso, $m)) {
			return '';
		}
		$fmt = $fmt ? $fmt : 'D MMMM, YYYY';
		$y   = (int) $m[1];
		$mo  = (int) $m[2] - 1;
		$d   = (int) $m[3];
		$day = (int) gmdate('w', gmmktime(0, 0, 0, $mo + 1, $d, $y));
		$out = preg_replace_callback('/dddd|YYYY|MMMM|MMM|DD|D/', function ($t) use ($lang, $y, $mo, $d, $day) {
			switch ($t[0]) {
				case 'dddd': return 'bn' === $lang ? self::BN_DAYS[$day] : self::EN_DAYS[$day];
				case 'YYYY': return (string) $y;
				case 'MMMM': return 'bn' === $lang ? self::BN_MONTHS[$mo] : self::EN_MONTHS[$mo];
				case 'MMM': return 'bn' === $lang ? self::BN_MONTHS[$mo] : substr(self::EN_MONTHS[$mo], 0, 3);
				case 'DD': return str_pad((string) $d, 2, '0', STR_PAD_LEFT);
				default: return (string) $d;
			}
		}, $fmt);
		return 'bn' === $lang ? self::bn_digits($out) : $out;
	}

	private static function replace_first($search, $replace, $subject) {
		$pos = strpos($subject, $search);
		return false === $pos ? $subject : substr_replace($subject, $replace, $pos, strlen($search));
	}

	public static function format_time($hhmm, $lang, $fmt = null) {
		if (!$hhmm || !preg_match('/^(\d{1,2}):(\d{2})$/', (string) $hhmm, $m)) {
			return '';
		}
		$H  = (int) $m[1];
		$M  = $m[2];
		$h  = (($H + 11) % 12) + 1;
		if ('bn' === $lang) {
			$period = $H < 4 ? 'রাত' : ($H < 12 ? 'সকাল' : ($H < 15 ? 'দুপুর' : ($H < 18 ? 'বিকাল' : ($H < 20 ? 'সন্ধ্যা' : 'রাত'))));
			$f = $fmt ? $fmt : 'P h.mm ঘটিকায়';
			$f = self::replace_first('P', $period, $f);
			$f = self::replace_first('mm', $M, $f);
			$f = self::replace_first('h', (string) $h, $f);
			return self::bn_digits($f);
		}
		$f = $fmt ? $fmt : 'h:mm A';
		$f = self::replace_first('mm', $M, $f);
		$f = self::replace_first('h', (string) $h, $f);
		return self::replace_first('A', $H < 12 ? 'AM' : 'PM', $f);
	}

	public static function esc($s) {
		return str_replace(array('&', '<', '>'), array('&amp;', '&lt;', '&gt;'), (string) $s);
	}

	private static function pick($b, $lang) {
		if (!is_array($b)) {
			return '';
		}
		return (string) ('bn' === $lang ? ($b['bn'] ?? '') : ($b['en'] ?? ''));
	}

	public static function guest_text($g, $lang) {
		if (!is_array($g)) {
			return '';
		}
		$pre   = implode(' ', array_filter(array_map(function ($p) use ($lang) { return self::pick($p, $lang); }, (array) ($g['prefixes'] ?? array())), 'strlen'));
		$head  = implode(' ', array_filter(array($pre, self::pick($g['name'] ?? null, $lang)), 'strlen'));
		$parts = array_merge(array($head), array_map(function ($p) use ($lang) { return self::pick($p, $lang); }, (array) ($g['postfixes'] ?? array())), array(self::pick($g['designation'] ?? null, $lang)));
		return implode(', ', array_filter($parts, 'strlen'));
	}

	public static function guest_html($g, $lang, $bold = false) {
		$pre  = implode(' ', array_filter(array_map(function ($p) use ($lang) { return self::pick($p, $lang); }, (array) ($g['prefixes'] ?? array())), 'strlen'));
		$name = self::esc(self::pick($g['name'] ?? null, $lang));
		$head = implode(' ', array_filter(array(self::esc($pre), ($bold && '' !== $name) ? '<strong>' . $name . '</strong>' : $name), 'strlen'));
		$post = array_filter(array_map(function ($p) use ($lang) { return self::esc(self::pick($p, $lang)); }, (array) ($g['postfixes'] ?? array())), 'strlen');
		return implode(', ', array_filter(array_merge(array($head), $post, array(self::esc(self::pick($g['designation'] ?? null, $lang)))), 'strlen'));
	}

	/** Title + name (+ postfixes) — "Mr. Faizul Alam"; or the designation alone; or everything. */
	public static function is_female($g) {
		foreach ((array) ($g['prefixes'] ?? array()) as $p) {
			foreach (array('en', 'bn') as $l) {
				if (preg_match('/^(ms\.?|mrs\.?|miss|madam|madame|begum|lady|dame|বেগম|জনাবা|মিসেস|মিস)$/iu', trim((string) ($p[$l] ?? '')))) {
					return true;
				}
			}
		}
		return false;
	}

	public static function guest_part_html($g, $lang, $part = 'full', $bold = false) {
		if ('his' === $part) {
			return self::is_female($g) ? 'her' : 'his';
		}
		if ('Sir' === $part) {
			return self::is_female($g) ? 'Madam' : 'Sir';
		}
		if ('sir' === $part) {
			return self::is_female($g) ? 'madam' : 'sir';
		}
		if ('designation' === $part) {
			return self::esc(self::pick($g['designation'] ?? null, $lang));
		}
		if ('name' !== $part) {
			return self::guest_html($g, $lang, $bold);
		}
		$pre  = implode(' ', array_filter(array_map(function ($p) use ($lang) { return self::pick($p, $lang); }, (array) ($g['prefixes'] ?? array())), 'strlen'));
		$name = self::esc(self::pick($g['name'] ?? null, $lang));
		$head = implode(' ', array_filter(array(self::esc($pre), ($bold && '' !== $name) ? '<strong>' . $name . '</strong>' : $name), 'strlen'));
		$post = array_filter(array_map(function ($p) use ($lang) { return self::esc(self::pick($p, $lang)); }, (array) ($g['postfixes'] ?? array())), 'strlen');
		return implode(', ', array_filter(array_merge(array($head), $post), 'strlen'));
	}

	/** The welcome-speech guest of the MC script: the one picked as host, else the last special guest. */
	public static function host_index($values) {
		$list = array_values((array) ($values['specialGuests'] ?? array()));
		$id   = (string) ($values['hostGuestId'] ?? '');
		foreach ($list as $i => $g) {
			if ('' !== $id && ($g['id'] ?? '') === $id) {
				return $i;
			}
		}
		return count($list) - 1;
	}

	/** One copy of a per-guest block's wording for each guest (tokens {name}, {designation}, {full}). */
	public static function each_html($template, $values, $lang, $order = 'forward', $skip_host = false) {
		$list = array();
		$host = self::host_index($values);
		foreach (array_values((array) ($values['specialGuests'] ?? array())) as $i => $g) {
			if (!($skip_host && $i === $host)) {
				$list[] = array($g, $i + 1);
			}
		}
		if ('reverse' === $order) {
			$list = array_reverse($list);
		}
		if (!$list) {
			$ph = self::esc(self::placeholder('specialGuests', $lang));
			return '<div data-rep="0">' . preg_replace_callback('/\{(name|designation|full|his|Sir|sir)\}/', function ($m) use ($ph) {
				return '<span data-tok="' . $m[1] . '">' . (in_array($m[1], array('his', 'Sir', 'sir'), true) ? $m[1] : $ph) . '</span>';
			}, (string) $template) . '</div>';
		}
		$out = '';
		foreach ($list as $k => $item) {
			list($g, $n) = $item;
			$out .= '<div data-rep="' . $k . '">' . preg_replace_callback('/\{(name|designation|full|his|Sir|sir)\}/', function ($m) use ($g, $n, $lang) {
				$ref = in_array($m[1], array('his', 'Sir', 'sir'), true) ? '' : ' data-gref="' . $n . '"';
				return '<span data-tok="' . $m[1] . '"' . $ref . '>' . self::guest_part_html($g, $lang, $m[1]) . '</span>';
			}, (string) $template) . '</div>';
		}
		return $out;
	}

	public static function guests_html($list, $lang, $sep = 'comma', $bold = false) {
		$items = array();
		foreach (array_values($list) as $i => $g) {
			$items[] = '<span data-guest="' . ($i + 1) . '">' . self::guest_html($g, $lang, $bold) . '</span>';
		}
		if ('lines' === $sep) {
			return implode('<br>', $items);
		}
		if ('period' === $sep) {
			return implode('bn' === $lang ? '। ' : '. ', $items);
		}
		if ('and' === $sep && count($items) > 1) {
			$last = array_pop($items);
			return implode(', ', $items) . ('bn' === $lang ? ' এবং ' : ' and ') . $last;
		}
		return implode(', ', $items);
	}

	public static function placeholder($key, $lang) {
		$def = self::FIELDS[$key] ?? null;
		return '[' . ($def ? ('bn' === $lang ? $def[1] : $def[0]) : $key) . ']';
	}

	public static function scalar_text($values, $key, $lang, $fmt = null) {
		$def = self::FIELDS[$key] ?? null;
		if (!$def) {
			return '';
		}
		switch ($def[2]) {
			case 'text': return self::pick($values['text'][$key] ?? null, $lang);
			case 'ordinal': return !empty($values['edition']) ? self::ordinal($values['edition'], $lang) : '';
			case 'year': return !empty($values['year']) ? ('bn' === $lang ? self::bn_digits((string) $values['year']) : (string) $values['year']) : '';
			case 'date': return self::format_date($values[$key] ?? null, $lang, $fmt);
			case 'time': return self::format_time($values['eventTime'] ?? null, $lang, $fmt);
			case 'phone': return (string) ($values['contactPhone'] ?? '');
		}
		return '';
	}

	public static function slot_html($values, $key, $lang, $fmt = null, $sep = null, $bold = false, $part = null, $pick = null) {
		$def = self::FIELDS[$key] ?? null;
		if (!$def) {
			return '';
		}
		$word = in_array($part, array('his', 'Sir', 'sir'), true) ? $part : null;
		if ($word && (('guest' === $def[2] && empty($values['chiefGuest'])) || ('host' === $pick && empty($values['specialGuests'])))) {
			return $word;
		}
		if ('guest' === $def[2]) {
			return !empty($values['chiefGuest']) ? self::guest_part_html($values['chiefGuest'], $lang, $part ? $part : 'full', $bold) : self::esc(self::placeholder($key, $lang));
		}
		if ('guests' === $def[2] && 'host' === $pick) {
			$list = array_values((array) ($values['specialGuests'] ?? array()));
			$h    = $list[self::host_index($values)] ?? null;
			return $h ? self::guest_part_html($h, $lang, $part ? $part : 'full', $bold) : self::esc('bn' === $lang ? '[স্বাগত বক্তা]' : '[Host]');
		}
		if ('guests' === $def[2]) {
			return !empty($values['specialGuests']) ? self::guests_html($values['specialGuests'], $lang, $sep ? $sep : 'comma', $bold) : self::esc(self::placeholder($key, $lang));
		}
		$t = self::scalar_text($values, $key, $lang, $fmt);
		return self::esc('' !== $t ? $t : self::placeholder($key, $lang));
	}

	private static function norm($s) {
		return trim(preg_replace('/\s+/u', ' ', str_replace("\xC2\xA0", ' ', (string) $s)));
	}

	/**
	 * Write the shared values into every linked slot of a document body.
	 * Returns array(body, changed).
	 */
	public static function apply_to_body($body, $lang, $values) {
		if (false === strpos($body, 'data-field')) {
			return array($body, false);
		}
		list($dom, $root) = SMS_Doc::load_fragment($body);
		$xp      = new DOMXPath($dom);
		$changed = false;
		foreach (iterator_to_array($xp->query('.//*[@data-field]', $root)) as $el) {
			if (in_array($el->getAttribute('data-field'), self::RETIRED, true)) {
				while ($el->firstChild) {
					$el->parentNode->insertBefore($el->firstChild, $el);
				}
				$el->parentNode->removeChild($el);
				$changed = true;
			}
		}
		foreach (iterator_to_array($xp->query('.//*[@data-field]', $root)) as $el) {
			$key = $el->getAttribute('data-field');
			$def = self::FIELDS[$key] ?? null;
			if (!$def || $el->hasAttribute('data-override')) {
				continue;
			}
			if ($el->hasAttribute('data-each')) {
				$html = self::each_html($el->getAttribute('data-each'), $values, $lang, 'reverse' === $el->getAttribute('data-order') ? 'reverse' : 'forward', 'host' === $el->getAttribute('data-skip'));
				if (SMS_Doc::inner_html($dom, $el) !== $html) {
					SMS_Doc::set_inner_html($dom, $el, $html);
					$changed = true;
				}
				continue;
			}
			$html = self::slot_html($values, $key, $lang, $el->getAttribute('data-fmt') ?: null, $el->getAttribute('data-sep') ?: null, '1' === $el->getAttribute('data-bold'), $el->getAttribute('data-part') ?: null, $el->getAttribute('data-pick') ?: null);
			if ('text' === $def[2] || 'phone' === $def[2]) {
				$want = html_entity_decode(wp_strip_all_tags($html), ENT_QUOTES, 'UTF-8');
				if (self::norm($el->textContent) === self::norm($want)) {
					continue;
				}
			} elseif (SMS_Doc::inner_html($dom, $el) === $html) {
				continue;
			}
			SMS_Doc::set_inner_html($dom, $el, $html);
			$changed = true;
		}
		return $changed ? array(SMS_Doc::inner_html($dom, $root), true) : array($body, false);
	}

	/** How often each field appears in a body. */
	public static function usage($body) {
		$out = array();
		if (preg_match_all('/<(?:span|div)\b[^>]*\bdata-field="([^"]+)"[^>]*>/', (string) $body, $m, PREG_SET_ORDER)) {
			foreach ($m as $hit) {
				$k = $hit[1];
				if (!isset($out[$k])) {
					$out[$k] = array('count' => 0, 'own_text' => 0);
				}
				$out[$k]['count']++;
				if (preg_match('/\bdata-override="1"/', $hit[0])) {
					$out[$k]['own_text']++;
				}
			}
		}
		return $out;
	}

	public static function new_id() {
		return 'g' . base_convert((string) (int) (microtime(true) * 1000), 10, 36) . wp_generate_password(4, false, false);
	}
}
