<?php
/**
 * Project version history.
 *
 * One counter per project: every save that changes a document or the shared
 * values belongs to a version. Saves from the same source that follow each
 * other within a minute are grouped into one version; "Save version" (or a
 * restore) closes it. Version n is shown as n/10 with one decimal (0.1, 0.9,
 * 1.0, 1.1 …). Each version remembers, per file, the content before and after
 * (stored once by hash), so any version can be compared, previewed, restored,
 * and any single change can be undone. History is kept forever.
 *
 * Storage: <root>/history/<md5(lowercase project)>/log.json + blobs/.
 */

if (!defined('ABSPATH')) {
	exit;
}

class SMS_History {
	const GROUP_GAP = 60;   // A pause longer than this starts a new version.
	const GROUP_MAX = 900;  // A version never stays open longer than this.
	const SOURCES   = array('studio', 'mcp', 'restore', 'import');

	private static $source = 'studio';
	/** Forced grouping for restores/undos: array('project', 'n', 'meta'). */
	private static $ctx = null;
	private static $migrating = false;

	public static function set_source($s) {
		self::$source = in_array($s, self::SOURCES, true) ? $s : 'studio';
	}

	public static function code($n) {
		return number_format(((int) $n) / 10, 1, '.', '');
	}

	/* ---------- Files ---------- */

	private static function dir($project) {
		return SMS_Storage::instance()->root_dir() . '/history/' . md5(strtolower($project));
	}

	private static function lock($project) {
		$dir = self::dir($project);
		if (!is_dir($dir . '/blobs')) {
			wp_mkdir_p($dir . '/blobs');
		}
		$h = @fopen($dir . '/.lock', 'c');
		if ($h) {
			flock($h, LOCK_EX);
		}
		return $h;
	}

	private static function unlock($h) {
		if ($h) {
			flock($h, LOCK_UN);
			fclose($h);
		}
	}

	private static function put_blob($project, $content) {
		if (null === $content) {
			return null;
		}
		$hash = md5($content);
		$base = self::dir($project) . '/blobs/' . $hash;
		if (!is_file($base . '.z') && !is_file($base . '.raw')) {
			if (!is_dir(dirname($base))) {
				wp_mkdir_p(dirname($base));
			}
			if (function_exists('gzcompress')) {
				file_put_contents($base . '.z', gzcompress($content, 6), LOCK_EX);
			} else {
				file_put_contents($base . '.raw', $content, LOCK_EX);
			}
		}
		return $hash;
	}

	public static function get_blob($project, $hash) {
		if (null === $hash || !preg_match('/^[a-f0-9]{32}$/', (string) $hash)) {
			return null;
		}
		$base = self::dir($project) . '/blobs/' . $hash;
		if (is_file($base . '.z')) {
			$c = @gzuncompress((string) file_get_contents($base . '.z'));
			return false === $c ? null : $c;
		}
		return is_file($base . '.raw') ? (string) file_get_contents($base . '.raw') : null;
	}

	private static function load($project, $override = array()) {
		$file = self::dir($project) . '/log.json';
		if (is_file($file)) {
			$log = json_decode((string) file_get_contents($file), true);
			if (is_array($log) && isset($log['versions'])) {
				return $log;
			}
		}
		return self::migrate($project, $override);
	}

	private static function save($project, $log) {
		$file = self::dir($project) . '/log.json';
		$tmp  = $file . '.tmp-' . wp_generate_password(6, false);
		file_put_contents($tmp, wp_json_encode($log, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
		@rename($tmp, $file);
	}

	private static function split_rel($rel) {
		if (1 !== substr_count($rel, '/')) {
			return null;
		}
		list($project, $file) = explode('/', $rel, 2);
		if (!preg_match('/\.html$/i', $file) && SMS_Project::VALUES_FILE !== $file) {
			return null;
		}
		return array($project, $file);
	}

	/** Current files of a project: name => content. */
	private static function current_files($project) {
		$dir = SMS_Storage::instance()->files_dir() . '/' . $project;
		$out = array();
		foreach ((array) @scandir($dir) as $f) {
			if (is_file($dir . '/' . $f) && (preg_match('/\.html$/i', $f) || SMS_Project::VALUES_FILE === $f)) {
				$out[$f] = (string) file_get_contents($dir . '/' . $f);
			}
		}
		return $out;
	}

	/** First use: bring in the older per-document snapshots so nothing is lost. */
	private static function migrate($project, $override) {
		$log = array('version' => 1, 'project' => $project, 'next' => 1, 'versions' => array());
		if (self::$migrating) {
			return $log;
		}
		self::$migrating = true;
		$current = array_merge(self::current_files($project), $override);
		$current = array_filter($current, function ($c) { return null !== $c; });
		$store   = SMS_Storage::instance();
		$snaps   = array();
		foreach (array_keys($current) as $f) {
			foreach (array_reverse($store->versions($project . '/' . $f)) as $v) {
				$r = $store->read_version($project . '/' . $f, $v['id']);
				if (!is_wp_error($r)) {
					$t = strtotime(preg_replace('/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/', '$1-$2-$3 $4:$5:$6 UTC', $v['id']));
					$snaps[$f][] = array((int) $t, $r['content']);
				}
			}
		}
		if ($snaps) {
			$times = array();
			foreach ($snaps as $list) {
				$times[] = $list[0][0];
			}
			$state = array();
			$first = array('files' => array());
			foreach ($current as $f => $c) {
				$state[$f]             = isset($snaps[$f]) ? $snaps[$f][0][1] : $c;
				$first['files'][$f]    = array('before' => null, 'after' => self::put_blob($project, $state[$f]));
			}
			$log['versions'][] = self::new_version($log, 'import', min($times), array('desc' => 'Earliest saved state'), $first['files']);
			$events = array();
			foreach ($snaps as $f => $list) {
				foreach (array_slice($list, 1) as $s) {
					$events[] = array($s[0], $f, $s[1]);
				}
			}
			usort($events, function ($a, $b) { return $a[0] - $b[0]; });
			$group = null;
			foreach ($events as $e) {
				if (!$group || $e[0] - $group['end'] > self::GROUP_GAP || isset($group['files'][$e[1]])) {
					if ($group && $group['files']) {
						$log['versions'][] = self::new_version($log, 'import', $group['time'], array('end' => $group['end']), $group['files']);
					}
					$group = array('time' => $e[0], 'end' => $e[0], 'files' => array());
				}
				if ($state[$e[1]] !== $e[2]) {
					$group['files'][$e[1]] = array('before' => self::put_blob($project, $state[$e[1]]), 'after' => self::put_blob($project, $e[2]));
					$state[$e[1]]          = $e[2];
				}
				$group['end'] = $e[0];
			}
			if ($group && $group['files']) {
				$log['versions'][] = self::new_version($log, 'import', $group['time'], array('end' => $group['end']), $group['files']);
			}
			$last = array();
			foreach ($current as $f => $c) {
				if ($state[$f] !== $c) {
					$last[$f] = array('before' => self::put_blob($project, $state[$f]), 'after' => self::put_blob($project, $c));
				}
			}
			if ($last) {
				$log['versions'][] = self::new_version($log, 'import', time(), array('desc' => 'Latest state before version history'), $last);
			}
		}
		self::$migrating = false;
		return $log;
	}

	private static function new_version(&$log, $source, $time, $meta = array(), $files = array()) {
		$v = array_merge(array(
			'n'      => (int) $log['next'],
			'time'   => (int) $time,
			'end'    => (int) $time,
			'source' => $source,
			'tag'    => '',
			'desc'   => '',
			'sealed' => 'import' === $source,
			'files'  => $files ? $files : new stdClass(),
		), $meta);
		$log['next'] = (int) $log['next'] + 1;
		return $v;
	}

	/* ---------- Recording (called by storage on every change) ---------- */

	public static function record($rel, $before, $after) {
		if ($before === $after) {
			return;
		}
		$parts = self::split_rel($rel);
		if (!$parts) {
			return;
		}
		list($project, $file) = $parts;
		try {
			$h   = self::lock($project);
			$log = self::load($project, array($file => $before));
			$now = time();
			$idx = null;
			$ctx = self::$ctx && 0 === strcasecmp(self::$ctx['project'], $project) ? self::$ctx : null;
			$cnt = count($log['versions']);
			if ($ctx) {
				if (null !== $ctx['n']) {
					foreach ($log['versions'] as $i => $v) {
						if ($v['n'] === $ctx['n']) {
							$idx = $i;
						}
					}
				}
			} elseif ($cnt) {
				$last = $log['versions'][$cnt - 1];
				if (empty($last['sealed']) && $last['source'] === self::$source && $now - $last['end'] <= self::GROUP_GAP && $now - $last['time'] <= self::GROUP_MAX) {
					$idx = $cnt - 1;
				}
			}
			$amend = false;
			if (null === $idx && !$ctx && $cnt && self::slots_only($file, $before, $after)) {
				// Only shared-value text was re-filled (e.g. the studio re-rendering a slot): no new version for that.
				$idx   = $cnt - 1;
				$amend = true;
			}
			if (null === $idx) {
				foreach ($log['versions'] as $i => $v) {
					$log['versions'][$i]['sealed'] = true;
				}
				$log['versions'][] = self::new_version($log, $ctx ? 'restore' : self::$source, $now, $ctx ? $ctx['meta'] : array());
				$idx = count($log['versions']) - 1;
				if ($ctx) {
					self::$ctx['n'] = $log['versions'][$idx]['n'];
				}
			}
			$v     = &$log['versions'][$idx];
			$files = (array) $v['files'];
			$stale = null;
			if (isset($files[$file])) {
				$stale                 = $files[$file]['after'];
				$files[$file]['after'] = self::put_blob($project, $after);
			} else {
				$files[$file] = array('before' => self::put_blob($project, $before), 'after' => self::put_blob($project, $after));
			}
			if ($files[$file]['before'] === $files[$file]['after']) {
				unset($files[$file]);
			}
			$v['files'] = $files ? $files : new stdClass();
			if (!$amend) {
				$v['end'] = $now;
			}
			if (!$files) {
				$n = $v['n'];
				unset($v);
				array_splice($log['versions'], $idx, 1);
				if ($n === $log['next'] - 1) {
					$log['next'] = $n;
				}
				if ($ctx) {
					self::$ctx['n'] = null;
				}
			}
			unset($v);
			// Autosaves inside one version replace its "after": drop the in-between copy.
			if (null !== $stale && !self::referenced($log, $stale)) {
				@unlink(self::dir($project) . '/blobs/' . $stale . '.z');
				@unlink(self::dir($project) . '/blobs/' . $stale . '.raw');
			}
			self::save($project, $log);
			self::unlock($h);
		} catch (Throwable $e) {
			// History must never stop a save.
			if (!empty($h)) {
				self::unlock($h);
			}
		}
	}

	/** True when two versions of a document differ only in the text of shared-value slots. */
	private static function slots_only($file, $before, $after) {
		if (null === $before || null === $after || !preg_match('/\.html$/i', $file)) {
			return false;
		}
		$mb = SMS_Doc::parse($before, 'x');
		$ma = SMS_Doc::parse($after, 'x');
		foreach (array('title', 'lang', 'margins', 'font', 'fontSize') as $k) {
			if (wp_json_encode($mb[$k]) !== wp_json_encode($ma[$k])) {
				return false;
			}
		}
		$kb = array_map(function ($b) { return $b['key']; }, self::blocks($mb['body']));
		$ka = array_map(function ($b) { return $b['key']; }, self::blocks($ma['body']));
		return $kb === $ka;
	}

	private static function referenced($log, $hash) {
		foreach ($log['versions'] as $v) {
			foreach ((array) $v['files'] as $e) {
				if ($e['before'] === $hash || $e['after'] === $hash) {
					return true;
				}
			}
		}
		return false;
	}

	public static function project_renamed($from, $to) {
		$a = self::dir($from);
		$b = self::dir($to);
		if ($a !== $b && is_dir($a) && !file_exists($b)) {
			@rename($a, $b);
		}
	}

	public static function project_trashed($project) {
		$a = self::dir($project);
		if (is_dir($a)) {
			@rename($a, $a . '-trashed-' . time());
		}
	}

	/* ---------- Reading ---------- */

	private static function summary($v, $detail = false) {
		$files = array();
		foreach ((array) $v['files'] as $f => $e) {
			$files[] = array('file' => $f, 'op' => null === $e['before'] ? 'created' : (null === $e['after'] ? 'deleted' : 'changed'));
		}
		usort($files, function ($a, $b) { return SMS_Project::order($a['file'], $b['file']); });
		$out = array(
			'n'      => $v['n'],
			'code'   => self::code($v['n']),
			'time'   => gmdate('c', $v['time']),
			'end'    => gmdate('c', $v['end']),
			'source' => $v['source'],
			'tag'    => (string) $v['tag'],
			'desc'   => (string) $v['desc'],
			'open'   => empty($v['sealed']),
			'files'  => $files,
		);
		foreach (array('restored_from', 'undo_of') as $k) {
			if (isset($v[$k])) {
				$out[$k]          = $v[$k];
				$out[$k . '_code'] = self::code($v[$k]);
			}
		}
		if (!empty($v['step'])) {
			$out['step'] = true;
		}
		return $out;
	}

	private static function effective($log) {
		$vs = $log['versions'];
		if (!$vs) {
			return 0;
		}
		$last = end($vs);
		return !empty($last['step']) ? (int) $last['restored_from'] : (int) $last['n'];
	}

	private static function head($log) {
		$e     = self::effective($log);
		$back  = false;
		$fwd   = false;
		foreach ($log['versions'] as $v) {
			if (empty($v['step'])) {
				$back = $back || $v['n'] < $e;
				$fwd  = $fwd || $v['n'] > $e;
			}
		}
		$vs   = $log['versions'];
		$last = $vs ? end($vs) : null;
		return array(
			'n'              => $last ? $last['n'] : 0,
			'code'           => $last ? self::code($last['n']) : '',
			'effective'      => $e,
			'effective_code' => $e ? self::code($e) : '',
			'can_back'       => $back,
			'can_forward'    => $fwd,
			'count'          => count($vs),
		);
	}

	public static function get_log($project) {
		$h   = self::lock($project);
		$log = self::load($project);
		if (!is_file(self::dir($project) . '/log.json')) {
			self::save($project, $log);
		}
		self::unlock($h);
		return $log;
	}

	public static function listing($project, $limit = 100, $before = 0) {
		$log  = self::get_log($project);
		$all  = array_reverse($log['versions']);
		if ($before > 0) {
			$all = array_values(array_filter($all, function ($v) use ($before) { return $v['n'] < $before; }));
		}
		$page = array_slice($all, 0, max(1, min(500, (int) $limit)));
		return array(
			'project'  => $project,
			'head'     => self::head($log),
			'versions' => array_map(array(__CLASS__, 'summary'), $page),
			'more'     => count($all) > count($page),
		);
	}

	private static function find($log, $n) {
		foreach ($log['versions'] as $v) {
			if ((int) $v['n'] === (int) $n) {
				return $v;
			}
		}
		return null;
	}

	private static function not_found($n) {
		return new WP_Error('sms_no_version', 'Version ' . self::code($n) . ' not found.', array('status' => 404));
	}

	/** Content of a file right after version n (null if it did not exist). */
	private static function state_at($project, $log, $file, $n) {
		$hash  = false;
		$later = false;
		foreach ($log['versions'] as $v) {
			$e = ((array) $v['files'])[$file] ?? null;
			if (!$e) {
				continue;
			}
			if ($v['n'] <= $n) {
				$hash = $e['after'];
			} elseif (false === $later) {
				$later = $e['before'];
			}
		}
		if (false !== $hash) {
			return self::get_blob($project, $hash);
		}
		if (false !== $later) {
			return self::get_blob($project, $later);
		}
		$cur = self::current_files($project);
		return $cur[$file] ?? null;
	}

	/* ---------- Comparing ---------- */

	/** Top-level blocks of a body: html (as saved), key (shared-value text blanked) and visible text. */
	public static function blocks($body) {
		list($dom, $root) = SMS_Doc::load_fragment((string) $body);
		$out = array();
		if (!$root) {
			return $out;
		}
		foreach ($root->childNodes as $node) {
			if (XML_TEXT_NODE === $node->nodeType && '' === trim($node->textContent)) {
				continue;
			}
			if (XML_COMMENT_NODE === $node->nodeType) {
				continue;
			}
			$html  = $dom->saveHTML($node);
			$clone = $node->cloneNode(true);
			if (XML_ELEMENT_NODE === $clone->nodeType) {
				$list = array();
				if ($clone->hasAttribute('data-field')) {
					$list[] = $clone;
				}
				foreach ($clone->getElementsByTagName('*') as $el) {
					if ($el->hasAttribute('data-field')) {
						$list[] = $el;
					}
				}
				foreach ($list as $el) {
					if ('1' === $el->getAttribute('data-override')) {
						continue;
					}
					while ($el->firstChild) {
						$el->removeChild($el->firstChild);
					}
				}
			}
			$key   = preg_replace('/\s+/u', ' ', trim($dom->saveHTML($clone)));
			$out[] = array('html' => $html, 'key' => $key, 'text' => SMS_Doc::text($html));
		}
		return $out;
	}

	/** Changed runs between two block lists (LCS on keys). */
	public static function block_hunks($b, $a) {
		$n = count($b);
		$m = count($a);
		$pre = 0;
		while ($pre < $n && $pre < $m && $b[$pre]['key'] === $a[$pre]['key']) {
			$pre++;
		}
		$suf = 0;
		while ($suf < $n - $pre && $suf < $m - $pre && $b[$n - 1 - $suf]['key'] === $a[$m - 1 - $suf]['key']) {
			$suf++;
		}
		$bs = array_slice($b, $pre, $n - $pre - $suf);
		$as = array_slice($a, $pre, $m - $pre - $suf);
		$N  = count($bs);
		$M  = count($as);
		$L  = array_fill(0, $N + 1, array_fill(0, $M + 1, 0));
		for ($i = $N - 1; $i >= 0; $i--) {
			for ($j = $M - 1; $j >= 0; $j--) {
				$L[$i][$j] = $bs[$i]['key'] === $as[$j]['key'] ? $L[$i + 1][$j + 1] + 1 : max($L[$i + 1][$j], $L[$i][$j + 1]);
			}
		}
		$hunks = array();
		$cur   = null;
		$i     = 0;
		$j     = 0;
		$flush = function () use (&$cur, &$hunks) {
			if ($cur) {
				$hunks[] = $cur;
				$cur     = null;
			}
		};
		while ($i < $N || $j < $M) {
			if ($i < $N && $j < $M && $bs[$i]['key'] === $as[$j]['key']) {
				$flush();
				$i++;
				$j++;
				continue;
			}
			if (!$cur) {
				$cur = array('at' => $pre + $j, 'before' => array(), 'after' => array());
			}
			if ($j < $M && ($i >= $N || $L[$i][$j + 1] >= $L[$i + 1][$j])) {
				$cur['after'][] = $as[$j];
				$j++;
			} else {
				$cur['before'][] = $b[$pre + $i];
				$i++;
			}
		}
		$flush();
		foreach ($hunks as &$h) {
			$end       = $h['at'] + count($h['after']);
			$h['prev'] = $h['at'] > 0 ? $a[$h['at'] - 1]['key'] : null;
			$h['next'] = $end < $m ? $a[$end]['key'] : null;
		}
		return $hunks;
	}

	private static function setting_text($model, $k) {
		switch ($k) {
			case 'margins':
				$m = $model['margins'];
				return SMS_Doc::num($m['top']) . ' / ' . SMS_Doc::num($m['right']) . ' / ' . SMS_Doc::num($m['bottom']) . ' / ' . SMS_Doc::num($m['left']) . ' in';
			case 'font':
				$name = array_search($model['font'], SMS_Doc::FONTS, true);
				return false !== $name ? $name : trim(explode(',', $model['font'])[0], " '\"");
			case 'fontSize':
				return SMS_Doc::num($model['fontSize']) . ' pt';
			case 'lang':
				return 'bn' === $model['lang'] ? 'Bangla' : 'English';
			default:
				return (string) $model[$k];
		}
	}

	private static function guest_name($g) {
		return $g ? SMS_Values::guest_text($g, 'en') : '';
	}

	private static function value_text($v, $k) {
		$en = SMS_Values::scalar_text($v, $k, 'en');
		$bn = SMS_Values::scalar_text($v, $k, 'bn');
		return trim($en . ('' !== $bn && $bn !== $en ? ' · ' . $bn : ''));
	}

	private static function raw_value($v, $k) {
		return in_array($k, SMS_Values::TEXT_KEYS, true) ? ($v['text'][$k] ?? null) : ($v[$k] ?? null);
	}

	/** Shared-value changes, one per value (guests one per guest). */
	public static function value_hunks($bjson, $ajson) {
		$b   = SMS_Values::parse((string) $bjson);
		$a   = SMS_Values::parse((string) $ajson);
		$out = array();
		foreach (SMS_Values::FIELDS as $k => $def) {
			if ('guest' === $def[2] || 'guests' === $def[2]) {
				continue;
			}
			if (wp_json_encode(self::raw_value($b, $k)) !== wp_json_encode(self::raw_value($a, $k))) {
				$out[] = array('kind' => 'value', 'key' => $k, 'label' => $def[0], 'before' => self::value_text($b, $k), 'after' => self::value_text($a, $k));
			}
		}
		if (wp_json_encode($b['chiefGuest']) !== wp_json_encode($a['chiefGuest'])) {
			$out[] = array('kind' => 'value', 'key' => 'chiefGuest', 'label' => 'Chief guest', 'before' => self::guest_name($b['chiefGuest']), 'after' => self::guest_name($a['chiefGuest']));
		}
		$bi = array();
		foreach ($b['specialGuests'] as $i => $g) {
			$bi[$g['id'] ?? ('#' . $i)] = array($i, $g);
		}
		$ai = array();
		foreach ($a['specialGuests'] as $i => $g) {
			$ai[$g['id'] ?? ('#' . $i)] = array($i, $g);
		}
		foreach ($bi as $id => $x) {
			if (!isset($ai[$id])) {
				$out[] = array('kind' => 'value', 'key' => 'guest:' . $id, 'op' => 'removed', 'label' => 'Special guest ' . ($x[0] + 1) . ' removed', 'before' => self::guest_name($x[1]), 'after' => '');
			} elseif (wp_json_encode($x[1]) !== wp_json_encode($ai[$id][1])) {
				$out[] = array('kind' => 'value', 'key' => 'guest:' . $id, 'op' => 'changed', 'label' => 'Special guest ' . ($ai[$id][0] + 1), 'before' => self::guest_name($x[1]), 'after' => self::guest_name($ai[$id][1]));
			}
		}
		foreach ($ai as $id => $x) {
			if (!isset($bi[$id])) {
				$out[] = array('kind' => 'value', 'key' => 'guest:' . $id, 'op' => 'added', 'label' => 'Special guest ' . ($x[0] + 1) . ' added', 'before' => '', 'after' => self::guest_name($x[1]));
			}
		}
		$common_b = array_values(array_filter(array_keys($bi), function ($id) use ($ai) { return isset($ai[$id]); }));
		$common_a = array_values(array_filter(array_keys($ai), function ($id) use ($bi) { return isset($bi[$id]); }));
		if ($common_b !== $common_a) {
			$names = function ($ids, $map) {
				return implode(', ', array_map(function ($id) use ($map) { return self::guest_name($map[$id][1]); }, $ids));
			};
			$out[] = array('kind' => 'value', 'key' => 'guestOrder', 'label' => 'Special guest order', 'before' => $names($common_b, $bi), 'after' => $names($common_a, $ai));
		}
		if (($b['hostGuestId'] ?? null) !== ($a['hostGuestId'] ?? null)) {
			$host = function ($v) {
				$i = $v['specialGuests'] ? SMS_Values::host_index($v) : -1;
				return $i >= 0 ? self::guest_name($v['specialGuests'][$i]) : '';
			};
			$out[] = array('kind' => 'value', 'key' => 'host', 'label' => 'Host (welcome speech)', 'before' => $host($b), 'after' => $host($a));
		}
		return $out;
	}

	/** Every change in one file of one version. */
	private static function file_changes($project, $file, $e) {
		$before = self::get_blob($project, $e['before']);
		$after  = self::get_blob($project, $e['after']);
		$out    = array('file' => $file, 'op' => null === $e['before'] ? 'created' : (null === $e['after'] ? 'deleted' : 'changed'), 'hunks' => array());
		if (SMS_Project::VALUES_FILE === $file) {
			$out['hunks'] = self::value_hunks($before ?? '{"version":1}', $after ?? '{"version":1}');
		} elseif ('changed' !== $out['op']) {
			$model          = SMS_Doc::parse((string) ($after ?? $before), preg_replace('/\.html$/i', '', $file));
			$out['hunks'][] = array('kind' => 'file', 'op' => $out['op'], 'label' => 'created' === $out['op'] ? 'Document added' : 'Document deleted', 'text' => mb_substr(SMS_Doc::text($model['body']), 0, 400));
		} else {
			$mb = SMS_Doc::parse((string) $before, 'x');
			$ma = SMS_Doc::parse((string) $after, 'x');
			$labels = array('title' => 'Title', 'lang' => 'Language', 'margins' => 'Margins', 'font' => 'Font', 'fontSize' => 'Font size');
			foreach ($labels as $k => $label) {
				if (wp_json_encode($mb[$k]) !== wp_json_encode($ma[$k])) {
					$out['hunks'][] = array('kind' => 'setting', 'key' => $k, 'label' => $label, 'before' => self::setting_text($mb, $k), 'after' => self::setting_text($ma, $k));
				}
			}
			foreach (self::block_hunks(self::blocks($mb['body']), self::blocks($ma['body'])) as $h) {
				$out['hunks'][] = array(
					'kind'   => 'body',
					'at'     => $h['at'],
					'label'  => !$h['before'] ? 'Added' : (!$h['after'] ? 'Removed' : 'Changed'),
					'before' => implode("\n", array_map(function ($x) { return $x['text']; }, $h['before'])),
					'after'  => implode("\n", array_map(function ($x) { return $x['text']; }, $h['after'])),
				);
			}
			if (!$out['hunks']) {
				$out['values_only'] = true;
			}
		}
		foreach ($out['hunks'] as $i => &$h) {
			$h['id'] = $file . '#' . $i;
		}
		return $out;
	}

	public static function version_detail($project, $n) {
		$log = self::get_log($project);
		$v   = self::find($log, $n);
		if (!$v) {
			return self::not_found($n);
		}
		$files = array();
		foreach ((array) $v['files'] as $f => $e) {
			$files[] = self::file_changes($project, $f, $e);
		}
		usort($files, function ($a, $b) { return SMS_Project::order($a['file'], $b['file']); });
		return array('version' => self::summary($v), 'changes' => $files, 'head' => self::head($log));
	}

	/** A document as it was right after version n, with that version's changes marked. */
	public static function preview($project, $n, $file) {
		$log = self::get_log($project);
		$v   = self::find($log, $n);
		if (!$v) {
			return self::not_found($n);
		}
		$after = self::state_at($project, $log, $file, $n);
		if (null === $after) {
			$e = ((array) $v['files'])[$file] ?? null;
			$before = $e ? self::get_blob($project, $e['before']) : null;
			if (null === $before) {
				return new WP_Error('sms_not_found', 'This document did not exist in version ' . self::code($n) . '.', array('status' => 404));
			}
			$model = SMS_Doc::parse($before, preg_replace('/\.html$/i', '', $file));
			$model['body'] = '<div data-sv-diff="del">' . $model['body'] . '</div>';
			return array('file' => $file, 'n' => $n, 'code' => self::code($n), 'html' => SMS_Doc::serialize($model), 'deleted' => true, 'changes' => 1);
		}
		$model = SMS_Doc::parse($after, preg_replace('/\.html$/i', '', $file));
		$e     = ((array) $v['files'])[$file] ?? null;
		$count = 0;
		if ($e && null !== $e['before'] && null !== $e['after']) {
			$mb    = SMS_Doc::parse((string) self::get_blob($project, $e['before']), 'x');
			$ab    = self::blocks($model['body']);
			$hunks = self::block_hunks(self::blocks($mb['body']), $ab);
			$count = count($hunks);
			$parts = array();
			$byat  = array();
			foreach ($hunks as $h) {
				$byat[$h['at']] = $h;
			}
			$skip = 0;
			foreach ($ab as $i => $blk) {
				if (isset($byat[$i])) {
					foreach ($byat[$i]['before'] as $old) {
						$parts[] = '<div data-sv-diff="del">' . $old['html'] . '</div>';
					}
					$skip = count($byat[$i]['after']);
					$kind = $byat[$i]['before'] ? 'chg' : 'add';
				}
				$parts[] = $skip > 0 ? '<div data-sv-diff="' . $kind . '">' . $blk['html'] . '</div>' : $blk['html'];
				$skip    = max(0, $skip - 1);
			}
			$tail = count($ab);
			if (isset($byat[$tail])) {
				foreach ($byat[$tail]['before'] as $old) {
					$parts[] = '<div data-sv-diff="del">' . $old['html'] . '</div>';
				}
			}
			$model['body'] = implode('', $parts);
		} elseif ($e && null === $e['before']) {
			$model['body'] = '<div data-sv-diff="add">' . $model['body'] . '</div>';
			$count         = 1;
		}
		return array('file' => $file, 'n' => $n, 'code' => self::code($n), 'html' => SMS_Doc::serialize($model), 'changes' => $count);
	}

	/* ---------- Naming ---------- */

	private static function clean_text($s, $max) {
		$s = trim(preg_replace('/\s+/u', ' ', wp_strip_all_tags((string) $s)));
		return mb_substr($s, 0, $max);
	}

	/** Close the open version (Save version / Ctrl+S), optionally naming it. */
	public static function commit($project, $tag = null, $desc = null) {
		$h   = self::lock($project);
		$log = self::load($project);
		$cnt = count($log['versions']);
		if (!$cnt) {
			self::unlock($h);
			return new WP_Error('sms_no_changes', 'Nothing has changed yet, so there is no version to save.', array('status' => 409));
		}
		$i       = $cnt - 1;
		$was     = empty($log['versions'][$i]['sealed']);
		$log['versions'][$i]['sealed'] = true;
		if (null !== $tag && '' !== trim((string) $tag)) {
			$log['versions'][$i]['tag'] = self::clean_text($tag, 40);
		}
		if (null !== $desc && '' !== trim((string) $desc)) {
			$log['versions'][$i]['desc'] = self::clean_text($desc, 500);
		}
		self::save($project, $log);
		self::unlock($h);
		return array('version' => self::summary($log['versions'][$i]), 'new_changes' => $was, 'head' => self::head($log));
	}

	public static function set_info($project, $n, $tag = null, $desc = null) {
		$h   = self::lock($project);
		$log = self::load($project);
		foreach ($log['versions'] as $i => $v) {
			if ((int) $v['n'] === (int) $n) {
				if (null !== $tag) {
					$log['versions'][$i]['tag'] = self::clean_text($tag, 40);
				}
				if (null !== $desc) {
					$log['versions'][$i]['desc'] = self::clean_text($desc, 500);
				}
				self::save($project, $log);
				self::unlock($h);
				return array('version' => self::summary($log['versions'][$i]));
			}
		}
		self::unlock($h);
		return self::not_found($n);
	}

	/* ---------- Restoring ---------- */

	private static function begin($project, $meta, $reuse = null) {
		self::$ctx = array('project' => $project, 'n' => $reuse, 'meta' => $meta);
	}

	private static function finish($project) {
		$n         = self::$ctx ? self::$ctx['n'] : null;
		self::$ctx = null;
		$h         = self::lock($project);
		$log       = self::load($project);
		foreach ($log['versions'] as $i => $v) {
			$log['versions'][$i]['sealed'] = true;
		}
		self::save($project, $log);
		self::unlock($h);
		return array($n, $log);
	}

	/** Re-fill shared-value slots so restored text keeps today's names and dates. */
	private static function with_current_values($project, $file, $content) {
		$model = SMS_Doc::parse($content, preg_replace('/\.html$/i', '', $file));
		list($body) = SMS_Values::apply_to_body($model['body'], $model['lang'], SMS_Project::values($project));
		$model['body'] = $body;
		return SMS_Doc::serialize($model);
	}

	/** What restoring version n would write: file => new content. */
	private static function restore_plan($project, $log, $n, $files) {
		$current = self::current_files($project);
		$known   = array_keys($current);
		foreach ($log['versions'] as $v) {
			$known = array_merge($known, array_keys((array) $v['files']));
		}
		$plan = array();
		foreach (array_unique($known) as $f) {
			if (!preg_match('/\.html$/i', $f) || ($files && !in_array($f, $files, true))) {
				continue;
			}
			$target = self::state_at($project, $log, $f, $n);
			if (null === $target) {
				continue;
			}
			$new = self::with_current_values($project, $f, $target);
			if (!isset($current[$f]) || $current[$f] !== $new) {
				$plan[$f] = $new;
			}
		}
		return $plan;
	}

	private static function apply_plan($project, $plan) {
		$store = SMS_Storage::instance();
		$done  = array();
		foreach ($plan as $f => $content) {
			$r = $store->write($project . '/' . $f, $content);
			if (is_wp_error($r)) {
				return $r;
			}
			$done[] = $f;
		}
		return $done;
	}

	/** Bring documents back to how they were right after version n (shared values stay as they are). */
	public static function restore($project, $n, $files = array()) {
		$log = self::get_log($project);
		if (!self::find($log, $n)) {
			return self::not_found($n);
		}
		$plan = self::restore_plan($project, $log, (int) $n, (array) $files);
		if (!$plan) {
			return array('restored_to' => self::code($n), 'changed' => array(), 'version' => null, 'message' => 'The documents already match version ' . self::code($n) . '.', 'head' => self::head($log));
		}
		$desc = 'Restored ' . ($files ? implode(', ', array_map(function ($f) { return preg_replace('/\.html$/i', '', $f); }, $files)) . ' ' : '') . 'to v' . self::code($n);
		self::begin($project, array('restored_from' => (int) $n, 'desc' => $desc));
		$done = self::apply_plan($project, $plan);
		list($vn, $log) = self::finish($project);
		if (is_wp_error($done)) {
			return $done;
		}
		$v = $vn ? self::find($log, $vn) : null;
		return array('restored_to' => self::code($n), 'changed' => $done, 'version' => $v ? self::summary($v) : null, 'head' => self::head($log));
	}

	/** ◀ / ▶: step to the previous or next version. Steps in a row share one version. */
	public static function step($project, $dir) {
		$log   = self::get_log($project);
		$e     = self::effective($log);
		$real  = array();
		foreach ($log['versions'] as $v) {
			if (empty($v['step'])) {
				$real[] = (int) $v['n'];
			}
		}
		$cands = 'back' === $dir
			? array_reverse(array_values(array_filter($real, function ($n) use ($e) { return $n < $e; })))
			: array_values(array_filter($real, function ($n) use ($e) { return $n > $e; }));
		if (!$cands) {
			return new WP_Error('sms_no_step', 'back' === $dir ? 'This is the earliest version.' : 'This is the latest version.', array('status' => 409));
		}
		$vs    = $log['versions'];
		$last  = end($vs);
		$reuse = !empty($last['step']) ? (int) $last['n'] : null;
		$top   = max($real);
		foreach ($cands as $t) {
			$plan = self::restore_plan($project, $log, $t, array());
			if (!$plan) {
				continue;
			}
			$meta = array('restored_from' => $t, 'step' => true, 'desc' => 'Went ' . ('back' === $dir ? 'back' : 'forward') . ' to v' . self::code($t));
			self::begin($project, $meta, $reuse);
			$done = self::apply_plan($project, $plan);
			// Update the reused step version's target.
			$h   = self::lock($project);
			$log = self::load($project);
			$n   = self::$ctx['n'];
			foreach ($log['versions'] as $i => $v) {
				if (null !== $n && $v['n'] === $n) {
					$log['versions'][$i] = array_merge($log['versions'][$i], $meta);
				}
			}
			self::save($project, $log);
			self::unlock($h);
			list($vn, $log) = self::finish($project);
			if (is_wp_error($done)) {
				return $done;
			}
			$v = $vn ? self::find($log, $vn) : null;
			return array('now_at' => self::code($vn ? $t : $top), 'changed' => $done, 'version' => $v ? self::summary($v) : null, 'head' => self::head($log));
		}
		return new WP_Error('sms_no_step', 'back' === $dir ? 'No earlier version has different documents.' : 'No later version has different documents.', array('status' => 409));
	}

	/* ---------- Undoing one change ---------- */

	public static function undo($project, $n, $hunk_id) {
		$log = self::get_log($project);
		$v   = self::find($log, $n);
		if (!$v) {
			return self::not_found($n);
		}
		$file = (string) preg_replace('/#\d+$/', '', (string) $hunk_id);
		$e    = ((array) $v['files'])[$file] ?? null;
		if (!$e) {
			return new WP_Error('sms_no_change', 'That change was not found in version ' . self::code($n) . '.', array('status' => 404));
		}
		$changes = self::file_changes($project, $file, $e);
		$hunk    = null;
		foreach ($changes['hunks'] as $x) {
			if ($x['id'] === $hunk_id) {
				$hunk = $x;
			}
		}
		if (!$hunk) {
			return new WP_Error('sms_no_change', 'That change was not found in version ' . self::code($n) . '.', array('status' => 404));
		}
		$meta = array('undo_of' => (int) $n, 'desc' => 'Undid "' . $hunk['label'] . '" from v' . self::code($n) . ('value' === $hunk['kind'] ? ' (all documents)' : ''));
		self::begin($project, $meta);
		$r = self::undo_apply($project, $file, $e, $hunk);
		list($vn, $log) = self::finish($project);
		if (is_wp_error($r)) {
			return $r;
		}
		$nv = $vn ? self::find($log, $vn) : null;
		return array('undone' => $hunk['label'], 'changed' => $r, 'version' => $nv ? self::summary($nv) : null, 'head' => self::head($log), 'message' => $nv ? null : 'Nothing to undo: the documents already look like this.');
	}

	private static function undo_apply($project, $file, $e, $hunk) {
		$store = SMS_Storage::instance();
		if ('value' === $hunk['kind']) {
			return self::undo_value($project, (string) self::get_blob($project, $e['before']), (string) self::get_blob($project, $e['after']), $hunk);
		}
		if ('file' === $hunk['kind']) {
			if ('created' === $hunk['op']) {
				$r = $store->trash($project . '/' . $file);
			} else {
				$r = $store->write($project . '/' . $file, self::with_current_values($project, $file, (string) self::get_blob($project, $e['before'])), null, 'create');
			}
			return is_wp_error($r) ? $r : array($file);
		}
		$cur = $store->read($project . '/' . $file);
		if (is_wp_error($cur)) {
			return new WP_Error('sms_no_doc', 'This document no longer exists; restore the version instead.', array('status' => 409));
		}
		$model = SMS_Doc::parse($cur['content'], preg_replace('/\.html$/i', '', $file));
		$mb    = SMS_Doc::parse((string) self::get_blob($project, $e['before']), 'x');
		if ('setting' === $hunk['kind']) {
			$model[$hunk['key']] = $mb[$hunk['key']];
		} else {
			$ma = SMS_Doc::parse((string) self::get_blob($project, $e['after']), 'x');
			$h  = null;
			foreach (self::block_hunks(self::blocks($mb['body']), self::blocks($ma['body'])) as $x) {
				if ($x['at'] === $hunk['at']) {
					$h = $x;
				}
			}
			if (!$h) {
				return new WP_Error('sms_no_change', 'That change was not found.', array('status' => 404));
			}
			$blocks = self::blocks($model['body']);
			$keys   = array_map(function ($b) { return $b['key']; }, $blocks);
			$after  = array_map(function ($b) { return $b['key']; }, $h['after']);
			$pos    = null;
			if ($after) {
				$best = PHP_INT_MAX;
				for ($i = 0; $i + count($after) <= count($keys); $i++) {
					if (array_slice($keys, $i, count($after)) === $after && abs($i - $h['at']) < $best) {
						$best = abs($i - $h['at']);
						$pos  = $i;
					}
				}
			} else {
				$cands = array();
				foreach ($keys as $i => $k) {
					if (null !== $h['prev'] && $k === $h['prev']) {
						$cands[] = $i + 1;
					}
					if (null !== $h['next'] && $k === $h['next']) {
						$cands[] = $i;
					}
				}
				if (null === $h['prev']) {
					$cands[] = 0;
				}
				if (null === $h['next']) {
					$cands[] = count($keys);
				}
				$best = PHP_INT_MAX;
				foreach ($cands as $c) {
					if (abs($c - $h['at']) < $best) {
						$best = abs($c - $h['at']);
						$pos  = $c;
					}
				}
			}
			if (null === $pos) {
				return new WP_Error('sms_conflict', 'This part of the document was changed again later, so it can\'t be undone on its own. Restore the version or edit it by hand.', array('status' => 409));
			}
			$html = array_map(function ($b) { return $b['html']; }, $blocks);
			array_splice($html, $pos, count($after), array_map(function ($b) { return $b['html']; }, $h['before']));
			$model['body'] = implode('', $html);
		}
		$r = SMS_Project::write_doc($project, $file, $model);
		return is_wp_error($r) ? $r : array($file);
	}

	private static function undo_value($project, $bjson, $ajson, $hunk) {
		$cur = SMS_Project::values($project);
		$b   = SMS_Values::parse($bjson);
		$a   = SMS_Values::parse($ajson);
		$k   = $hunk['key'];
		$gid = function ($g, $i) { return $g['id'] ?? ('#' . $i); };
		if ('chiefGuest' === $k) {
			$cur['chiefGuest'] = $b['chiefGuest'];
		} elseif ('host' === $k) {
			$cur['hostGuestId'] = $b['hostGuestId'] ?? null;
		} elseif ('guestOrder' === $k) {
			$order = array();
			foreach ($b['specialGuests'] as $i => $g) {
				$order[$gid($g, $i)] = $i;
			}
			$list = $cur['specialGuests'];
			usort($list, function ($x, $y) use ($order) {
				return ($order[$x['id'] ?? ''] ?? 9999) - ($order[$y['id'] ?? ''] ?? 9999);
			});
			$cur['specialGuests'] = $list;
		} elseif (0 === strpos($k, 'guest:')) {
			$id  = substr($k, 6);
			$old = null;
			$idx = 0;
			foreach ($b['specialGuests'] as $i => $g) {
				if ($gid($g, $i) === $id) {
					$old = $g;
					$idx = $i;
				}
			}
			$list = array();
			$have = false;
			foreach ($cur['specialGuests'] as $i => $g) {
				if ($gid($g, $i) === $id) {
					$have = true;
					if ('added' !== ($hunk['op'] ?? '')) {
						$list[] = $old;
					}
				} else {
					$list[] = $g;
				}
			}
			if ('removed' === ($hunk['op'] ?? '') && !$have && $old) {
				array_splice($list, min($idx, count($list)), 0, array($old));
			}
			if ('changed' === ($hunk['op'] ?? '') && !$have) {
				return new WP_Error('sms_conflict', 'That guest has been removed since, so the change can\'t be undone.', array('status' => 409));
			}
			$cur['specialGuests'] = array_values(array_filter($list));
		} elseif (isset(SMS_Values::FIELDS[$k])) {
			if (in_array($k, SMS_Values::TEXT_KEYS, true)) {
				if (isset($b['text'][$k])) {
					$cur['text'][$k] = $b['text'][$k];
				} else {
					unset($cur['text'][$k]);
				}
			} else {
				$cur[$k] = $b[$k] ?? null;
			}
		} else {
			return new WP_Error('sms_no_change', 'Unknown change.', array('status' => 400));
		}
		unset($a);
		$changed = SMS_Project::save_values($project, $cur);
		return is_wp_error($changed) ? $changed : array_merge(array(SMS_Project::VALUES_FILE), $changed);
	}
}
