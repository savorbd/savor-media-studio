<?php
/**
 * Version history.
 *
 * Every document is a track, and the shared values are one more track. Each
 * track has its own versions (Invitation (English) v0.4, Shared values v0.2).
 * Every change anywhere in the project makes a project version: a snapshot
 * that records which version every track was at, so the whole project can be
 * rebuilt as it was. Shared values are one set for the whole project: a
 * document is always shown with the shared values of the same moment.
 *
 * Saves from the same source within a minute of each other are one version;
 * "Save version" (Ctrl+S) closes it. Codes are n/10 with one decimal
 * (0.1 … 0.9, 1.0, 1.1 …). Restoring and stepping never rewrite history: they
 * make new versions. History is kept forever.
 *
 * Storage: <root>/history/<md5(lowercase project)>/log.json + blobs/ (each
 * distinct content stored once, compressed).
 */

if (!defined('ABSPATH')) {
	exit;
}

class SMS_History {
	const GROUP_GAP = 60;   // A pause longer than this starts a new version.
	const GROUP_MAX = 900;  // A version never stays open longer than this.
	const SOURCES   = array('studio', 'mcp', 'restore', 'import');
	const VALUES    = 'values';
	const EMPTY_VALUES = '{"version":1}';

	private static $source = 'studio';
	private static $author = '';
	/** Restores and steps: array('project', 'n', 'meta' (project version), 'tmeta' (track versions), 'track'). */
	private static $ctx = null;
	private static $migrating = false;

	public static function set_source($s) {
		self::$source = in_array($s, self::SOURCES, true) ? $s : 'studio';
	}

	public static function set_author($name) {
		self::$author = self::clean_text($name, 60);
	}

	public static function code($n) {
		return number_format(((int) $n) / 10, 1, '.', '');
	}

	private static function clean_text($s, $max) {
		$s = trim(preg_replace('/\s+/u', ' ', wp_strip_all_tags((string) $s)));
		return mb_substr($s, 0, $max);
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

	private static function drop_blob($project, $log, $hash) {
		if (null === $hash) {
			return;
		}
		foreach ($log['tv'] as $list) {
			foreach ($list as $tv) {
				if ($tv['hash'] === $hash) {
					return;
				}
			}
		}
		@unlink(self::dir($project) . '/blobs/' . $hash . '.z');
		@unlink(self::dir($project) . '/blobs/' . $hash . '.raw');
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

	/* ---------- The log ---------- */

	private static function empty_log($project) {
		return array('version' => 2, 'project' => $project, 'next' => 1, 'seq' => 1, 'tracks' => array(), 'files' => array(), 'tv' => array(), 'versions' => array());
	}

	private static function load($project, $override = array()) {
		$file = self::dir($project) . '/log.json';
		if (is_file($file)) {
			$log = json_decode((string) file_get_contents($file), true);
			if (is_array($log) && 2 === ($log['version'] ?? 0)) {
				foreach (array('tracks', 'files', 'tv') as $k) {
					$log[$k] = (array) $log[$k];
				}
				return $log;
			}
			if (is_array($log) && isset($log['versions'])) {
				return self::replay($project, $log['versions'], self::current_with($project, $override));
			}
		}
		if (self::$migrating) {
			return self::empty_log($project);
		}
		self::$migrating = true;
		$current = self::current_with($project, $override);
		$log     = self::replay($project, self::legacy_versions($project, $current), $current);
		self::$migrating = false;
		return $log;
	}

	private static function current_with($project, $override) {
		$current = array_merge(self::current_files($project), $override);
		return array_filter($current, function ($c) { return null !== $c; });
	}

	/** The older per-document snapshots (before version history), as before/after changes. */
	private static function legacy_versions($project, $current) {
		$store = SMS_Storage::instance();
		$snaps = array();
		foreach (array_keys($current) as $f) {
			foreach (array_reverse($store->versions($project . '/' . $f)) as $v) {
				$r = $store->read_version($project . '/' . $f, $v['id']);
				if (!is_wp_error($r)) {
					$t = strtotime(preg_replace('/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/', '$1-$2-$3 $4:$5:$6 UTC', $v['id']));
					$snaps[$f][] = array((int) $t, $r['content']);
				}
			}
		}
		if (!$snaps) {
			return array();
		}
		$out    = array();
		$state  = array();
		$events = array();
		$first  = array('time' => PHP_INT_MAX, 'end' => 0, 'source' => 'import', 'desc' => 'Earliest saved state', 'files' => array());
		foreach ($snaps as $f => $list) {
			$state[$f]          = $list[0][1];
			$first['files'][$f] = array('before' => null, 'after' => self::put_blob($project, $list[0][1]));
			$first['time']      = min($first['time'], $list[0][0]);
			foreach (array_slice($list, 1) as $s) {
				$events[] = array($s[0], $f, $s[1]);
			}
		}
		foreach ($current as $f => $c) {
			if (!isset($snaps[$f])) {
				$state[$f]          = $c;
				$first['files'][$f] = array('before' => null, 'after' => self::put_blob($project, $c));
			}
		}
		$first['end'] = $first['time'];
		$out[]        = $first;
		usort($events, function ($a, $b) { return $a[0] - $b[0]; });
		$group = null;
		foreach ($events as $e) {
			if (!$group || $e[0] - $group['end'] > self::GROUP_GAP || isset($group['files'][$e[1]])) {
				if ($group && $group['files']) {
					$out[] = $group;
				}
				$group = array('time' => $e[0], 'end' => $e[0], 'source' => 'import', 'desc' => '', 'files' => array());
			}
			if ($state[$e[1]] !== $e[2]) {
				$group['files'][$e[1]] = array('before' => self::put_blob($project, $state[$e[1]]), 'after' => self::put_blob($project, $e[2]));
				$state[$e[1]]          = $e[2];
			}
			$group['end'] = $e[0];
		}
		if ($group && $group['files']) {
			$out[] = $group;
		}
		$last = array('time' => time(), 'end' => time(), 'source' => 'import', 'desc' => 'Latest state before version history', 'files' => array());
		foreach ($state as $f => $c) {
			if (isset($current[$f]) && $current[$f] !== $c) {
				$last['files'][$f] = array('before' => self::put_blob($project, $c), 'after' => self::put_blob($project, $current[$f]));
			}
		}
		if ($last['files']) {
			$out[] = $last;
		}
		return $out;
	}

	/** Build a log from a list of before/after changes (older history formats). */
	private static function replay($project, $old, $current) {
		$log   = self::empty_log($project);
		$first = array();
		foreach ($old as $v) {
			foreach ((array) $v['files'] as $f => $e) {
				if (!array_key_exists($f, $first)) {
					$first[$f] = $e['before'];
				}
			}
		}
		foreach ($current as $f => $c) {
			if (!array_key_exists($f, $first)) {
				$first[$f] = self::put_blob($project, $c);
			}
		}
		$base = array_filter($first, function ($h) { return null !== $h; });
		if ($base) {
			$t   = $old ? (int) $old[0]['time'] : time();
			$idx = self::new_pv($log, 'import', $t, array('desc' => 'Starting point'));
			foreach ($base as $f => $h) {
				self::touch($log, $idx, self::track_for($log, $f), $h, $f);
			}
			self::close_pv($log, $idx);
		}
		foreach ($old as $v) {
			$idx = self::new_pv($log, in_array($v['source'] ?? '', self::SOURCES, true) ? $v['source'] : 'import', (int) $v['time'], array(
				'end' => (int) ($v['end'] ?? $v['time']), 'tag' => (string) ($v['tag'] ?? ''), 'desc' => (string) ($v['desc'] ?? ''),
			));
			foreach ((array) $v['files'] as $f => $e) {
				if (preg_match('/\.html$/i', $f) && self::slots_only($f, self::get_blob($project, $e['before']), self::get_blob($project, $e['after']))) {
					continue;
				}
				self::touch($log, $idx, self::track_for($log, $f), $e['after'], $f);
			}
			self::close_pv($log, $idx);
		}
		return $log;
	}

	private static function track_for(&$log, $file) {
		if (SMS_Project::VALUES_FILE === $file) {
			if (!isset($log['tracks'][self::VALUES])) {
				$log['tracks'][self::VALUES] = array('id' => self::VALUES, 'kind' => 'values', 'file' => $file, 'next' => 1, 'deleted' => false);
			}
			return self::VALUES;
		}
		if (isset($log['files'][$file])) {
			return $log['files'][$file];
		}
		$tid                  = 'd' . (int) $log['seq'];
		$log['seq']           = (int) $log['seq'] + 1;
		$log['tracks'][$tid]  = array('id' => $tid, 'kind' => 'doc', 'file' => $file, 'next' => 1, 'deleted' => false);
		$log['files'][$file]  = $tid;
		return $tid;
	}

	/** Start a project version; returns its index. Heads carry over from the version before. */
	private static function new_pv(&$log, $source, $time, $meta = array()) {
		$cnt   = count($log['versions']);
		$heads = $cnt ? (array) $log['versions'][$cnt - 1]['heads'] : array();
		foreach ($log['versions'] as $i => $v) {
			$log['versions'][$i]['sealed'] = true;
		}
		$log['versions'][] = array_merge(array(
			'n'       => (int) $log['next'],
			'time'    => (int) $time,
			'end'     => (int) $time,
			'source'  => $source,
			'author'  => self::$author,
			'tag'     => '',
			'desc'    => '',
			'sealed'  => false,
			'changes' => array(),
			'heads'   => $heads,
		), $meta);
		$log['next'] = (int) $log['next'] + 1;
		return $cnt;
	}

	/** Drop a project version that ended up changing nothing; seal it otherwise (history replay). */
	private static function close_pv(&$log, $idx, $seal = true) {
		if (!$log['versions'][$idx]['changes']) {
			$n = $log['versions'][$idx]['n'];
			array_splice($log['versions'], $idx, 1);
			if ($n === $log['next'] - 1) {
				$log['next'] = $n;
			}
			return false;
		}
		if ($seal) {
			$log['versions'][$idx]['sealed'] = true;
		}
		return true;
	}

	private static function tv_index($log, $tid, $k) {
		foreach ((array) ($log['tv'][$tid] ?? array()) as $i => $tv) {
			if ((int) $tv['k'] === (int) $k) {
				return $i;
			}
		}
		return null;
	}

	private static function tv($log, $tid, $k) {
		$i = null === $k ? null : self::tv_index($log, $tid, $k);
		return null === $i ? null : $log['tv'][$tid][$i];
	}

	/** Track name/deleted state and the file map follow the track's latest version. */
	private static function sync_track(&$log, $tid) {
		$list = (array) ($log['tv'][$tid] ?? array());
		$last = $list ? end($list) : null;
		foreach ($log['files'] as $f => $t) {
			if ($t === $tid) {
				unset($log['files'][$f]);
			}
		}
		if ($last && null !== $last['hash']) {
			$log['tracks'][$tid]['file']    = $last['name'];
			$log['tracks'][$tid]['deleted'] = false;
			if (self::VALUES !== $tid) {
				$log['files'][$last['name']] = $tid;
			}
		} else {
			$log['tracks'][$tid]['deleted'] = true;
			if (!$last && self::VALUES !== $tid) {
				// Never had a version: forget it.
				unset($log['tracks'][$tid]);
			}
		}
	}

	/**
	 * Record a track's new content in project version $idx: a new track version,
	 * or the same one again when this project version already changed the track.
	 * Returns a blob hash that may no longer be needed.
	 */
	private static function touch(&$log, $idx, $tid, $hash, $name, $tmeta = array()) {
		$v     = &$log['versions'][$idx];
		$stale = null;
		if (!isset($log['tv'][$tid])) {
			$log['tv'][$tid] = array();
		}
		$list = &$log['tv'][$tid];
		$ch   = $v['changes'][$tid] ?? null;
		if ($ch) {
			$i     = self::tv_index($log, $tid, $ch['to']);
			$stale = $list[$i]['hash'];
			$list[$i]['hash'] = $hash;
			$list[$i]['name'] = $name;
			$list[$i]['end']  = $v['end'];
			$list[$i]         = array_merge($list[$i], $tmeta);
			$prev             = null === $ch['from'] ? null : self::tv($log, $tid, $ch['from']);
			if (($prev ? array($prev['hash'], $prev['name']) : array(null, $name)) === array($hash, $name) || (!$prev && null === $hash)) {
				array_splice($list, $i, 1);
				if ((int) $ch['to'] === (int) $log['tracks'][$tid]['next'] - 1) {
					$log['tracks'][$tid]['next'] = (int) $ch['to'];
				}
				unset($v['changes'][$tid]);
				if (null === $ch['from']) {
					unset($v['heads'][$tid]);
				} else {
					$v['heads'][$tid] = $ch['from'];
				}
			}
		} else {
			$last = $list ? end($list) : null;
			if ($last && $last['hash'] === $hash && $last['name'] === $name) {
				return null;
			}
			if (!$last && null === $hash) {
				return null;
			}
			$k      = (int) $log['tracks'][$tid]['next'];
			$list[] = array_merge(array(
				'k' => $k, 'hash' => $hash, 'name' => $name, 'time' => $v['end'], 'end' => $v['end'],
				'source' => $v['source'], 'author' => $v['author'], 'tag' => '', 'desc' => '', 'project' => $v['n'],
			), $tmeta);
			$log['tracks'][$tid]['next'] = $k + 1;
			$v['changes'][$tid]          = array('from' => $last ? (int) $last['k'] : null, 'to' => $k);
			$v['heads'][$tid]            = $k;
		}
		unset($v, $list);
		self::sync_track($log, $tid);
		return $stale;
	}

	/** The project version that a change made now belongs to (opened if needed). */
	private static function target_index(&$log, $project) {
		$now = time();
		$cnt = count($log['versions']);
		$ctx = self::$ctx && 0 === strcasecmp(self::$ctx['project'], $project) ? self::$ctx : null;
		if ($ctx) {
			if (null !== $ctx['n']) {
				foreach ($log['versions'] as $i => $v) {
					if ($v['n'] === $ctx['n']) {
						$log['versions'][$i]        = array_merge($log['versions'][$i], $ctx['meta']);
						$log['versions'][$i]['end'] = $now;
						return $i;
					}
				}
			}
			$idx            = self::new_pv($log, 'restore', $now, $ctx['meta']);
			self::$ctx['n'] = $log['versions'][$idx]['n'];
			return $idx;
		}
		if ($cnt) {
			$last = $log['versions'][$cnt - 1];
			if (empty($last['sealed']) && $last['source'] === self::$source && $now - $last['end'] <= self::GROUP_GAP && $now - $last['time'] <= self::GROUP_MAX) {
				$log['versions'][$cnt - 1]['end'] = $now;
				if ('' === $last['author'] && '' !== self::$author) {
					$log['versions'][$cnt - 1]['author'] = self::$author;
				}
				return $cnt - 1;
			}
		}
		return self::new_pv($log, self::$source, $now);
	}

	private static function after_change(&$log, $project, $idx, $stale) {
		if (!$log['versions'][$idx]['changes']) {
			$n = $log['versions'][$idx]['n'];
			array_splice($log['versions'], $idx, 1);
			if ($n === $log['next'] - 1) {
				$log['next'] = $n;
			}
			if (self::$ctx && self::$ctx['n'] === $n) {
				self::$ctx['n'] = null;
			}
		}
		if (null !== $stale) {
			self::drop_blob($project, $log, $stale);
		}
		self::save($project, $log);
	}

	private static function ctx_tmeta($tid) {
		if (!self::$ctx) {
			return array();
		}
		return null === self::$ctx['track'] || self::$ctx['track'] === $tid ? self::$ctx['tmeta'] : array();
	}

	/* ---------- Recording (storage calls these on every change) ---------- */

	public static function record($rel, $before, $after) {
		if ($before === $after) {
			return;
		}
		$parts = self::split_rel($rel);
		if (!$parts) {
			return;
		}
		list($project, $file) = $parts;
		// Only shared-value text was filled in again: the values track already has that change.
		if (self::slots_only($file, $before, $after)) {
			return;
		}
		$h = null;
		try {
			$h   = self::lock($project);
			$log = self::load($project, array($file => $before));
			if (null === $after && SMS_Project::VALUES_FILE !== $file && !isset($log['files'][$file])) {
				self::unlock($h);
				return;
			}
			$tid   = self::track_for($log, $file);
			$idx   = self::target_index($log, $project);
			$stale = self::touch($log, $idx, $tid, self::put_blob($project, $after), $file, self::ctx_tmeta($tid));
			self::after_change($log, $project, $idx, $stale);
		} catch (Throwable $e) {
			// History must never stop a save.
			unset($e);
		}
		self::unlock($h);
	}

	/** A document renamed inside its project keeps its own history. */
	public static function renamed($from_rel, $to_rel, $content) {
		$a = self::split_rel($from_rel);
		$b = self::split_rel($to_rel);
		if (!$a || !$b || $a[0] !== $b[0]) {
			self::record($from_rel, $content, null);
			self::record($to_rel, null, $content);
			return;
		}
		$h = null;
		try {
			$h   = self::lock($a[0]);
			$log = self::load($a[0], array($a[1] => $content));
			$tid = $log['files'][$a[1]] ?? null;
			if (!$tid) {
				self::unlock($h);
				self::record($to_rel, null, $content);
				return;
			}
			$idx   = self::target_index($log, $a[0]);
			$stale = self::touch($log, $idx, $tid, self::put_blob($a[0], $content), $b[1], self::ctx_tmeta($tid));
			self::after_change($log, $a[0], $idx, $stale);
		} catch (Throwable $e) {
			unset($e);
		}
		self::unlock($h);
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

	/* ---------- Reading ---------- */

	public static function get_log($project) {
		$h   = self::lock($project);
		$log = self::load($project);
		if (!is_file(self::dir($project) . '/log.json') || 2 !== (json_decode((string) @file_get_contents(self::dir($project) . '/log.json'), true)['version'] ?? 0)) {
			self::save($project, $log);
		}
		self::unlock($h);
		return $log;
	}

	private static function pv($log, $n) {
		foreach ($log['versions'] as $v) {
			if ((int) $v['n'] === (int) $n) {
				return $v;
			}
		}
		return null;
	}

	private static function not_found($what) {
		return new WP_Error('sms_no_version', $what . ' not found.', array('status' => 404));
	}

	private static function heads_at($log, $n) {
		if ($n <= 0) {
			return array();
		}
		$v = self::pv($log, $n);
		return $v ? (array) $v['heads'] : array();
	}

	/** Shared values (JSON) right after project version n. */
	private static function values_at($project, $log, $n) {
		$k  = self::heads_at($log, $n)[self::VALUES] ?? null;
		$tv = self::tv($log, self::VALUES, $k);
		$c  = $tv ? self::get_blob($project, $tv['hash']) : null;
		return null !== $c ? $c : self::EMPTY_VALUES;
	}

	public static function track_label($log, $tid) {
		if (self::VALUES === $tid) {
			return 'Shared values';
		}
		return preg_replace('/\.html$/i', '', (string) ($log['tracks'][$tid]['file'] ?? $tid));
	}

	private static function ordered_tracks($log, $tids) {
		$tids = array_values(array_unique($tids));
		usort($tids, function ($a, $b) use ($log) {
			if (self::VALUES === $a || self::VALUES === $b) {
				return self::VALUES === $a ? -1 : (self::VALUES === $b ? 1 : 0);
			}
			return SMS_Project::order($log['tracks'][$a]['file'] ?? '', $log['tracks'][$b]['file'] ?? '');
		});
		return $tids;
	}

	private static function change_op($log, $tid, $from, $to) {
		$a = self::tv($log, $tid, $from);
		$b = self::tv($log, $tid, $to);
		if (!$a || null === $a['hash']) {
			return $b && null !== $b['hash'] ? 'created' : 'deleted';
		}
		if (!$b || null === $b['hash']) {
			return 'deleted';
		}
		return $a['name'] !== $b['name'] && $a['hash'] === $b['hash'] ? 'renamed' : 'changed';
	}

	private static function pv_summary($log, $v) {
		$changes = array();
		foreach (self::ordered_tracks($log, array_keys((array) $v['changes'])) as $tid) {
			$c         = $v['changes'][$tid];
			$tv        = self::tv($log, $tid, $c['to']);
			$changes[] = array(
				'track' => $tid, 'kind' => self::VALUES === $tid ? 'values' : 'doc',
				'label' => self::VALUES === $tid ? 'Shared values' : preg_replace('/\.html$/i', '', (string) ($tv['name'] ?? '')),
				'file'  => self::VALUES === $tid ? SMS_Project::VALUES_FILE : (string) ($tv['name'] ?? ''),
				'from'  => $c['from'], 'to' => $c['to'],
				'from_code' => null === $c['from'] ? null : self::code($c['from']), 'to_code' => self::code($c['to']),
				'op'    => self::change_op($log, $tid, $c['from'], $c['to']),
			);
		}
		$heads = array();
		foreach ((array) $v['heads'] as $tid => $k) {
			$heads[$tid] = (int) $k;
		}
		$out = array(
			'n' => $v['n'], 'code' => self::code($v['n']), 'time' => gmdate('c', $v['time']), 'end' => gmdate('c', $v['end']),
			'source' => $v['source'], 'author' => (string) $v['author'], 'tag' => (string) $v['tag'], 'desc' => (string) $v['desc'],
			'open' => empty($v['sealed']) && time() - (int) $v['end'] <= self::GROUP_GAP, 'changes' => $changes, 'heads' => $heads ? $heads : new stdClass(),
		);
		foreach (array('restored_from', 'step_track') as $k) {
			if (isset($v[$k])) {
				$out[$k] = $v[$k];
			}
		}
		if (isset($v['restored_from']) && empty($v['step_track'])) {
			$out['restored_from_code'] = self::code($v['restored_from']);
		}
		if (!empty($v['step'])) {
			$out['step'] = true;
		}
		return $out;
	}

	private static function tv_summary($log, $tid, $tv, $prev = null) {
		$out = array(
			'track' => $tid, 'k' => $tv['k'], 'code' => self::code($tv['k']), 'label' => self::VALUES === $tid ? 'Shared values' : preg_replace('/\.html$/i', '', (string) $tv['name']),
			'name' => $tv['name'], 'time' => gmdate('c', $tv['time']), 'end' => gmdate('c', $tv['end']), 'source' => $tv['source'],
			'author' => (string) $tv['author'], 'tag' => (string) $tv['tag'], 'desc' => (string) $tv['desc'],
			'project' => $tv['project'], 'project_code' => self::code($tv['project']),
			'op' => self::change_op($log, $tid, $prev ? $prev['k'] : null, $tv['k']),
		);
		if (isset($tv['restored_from'])) {
			$out['restored_from']      = $tv['restored_from'];
			$out['restored_from_code'] = self::code($tv['restored_from']);
		}
		if (!empty($tv['step'])) {
			$out['step'] = true;
		}
		return $out;
	}

	/** The version the project (or a track) matches now, and whether ◀ ▶ can move. */
	private static function project_head($log) {
		$vs   = $log['versions'];
		$last = $vs ? end($vs) : null;
		$e    = !$last ? 0 : (!empty($last['step']) && empty($last['step_track']) ? (int) $last['restored_from'] : (int) $last['n']);
		$back = $fwd = false;
		foreach ($vs as $v) {
			if (empty($v['step']) || !empty($v['step_track'])) {
				$back = $back || $v['n'] < $e;
				$fwd  = $fwd || $v['n'] > $e;
			}
		}
		return array(
			'n' => $last ? $last['n'] : 0, 'code' => $last ? self::code($last['n']) : '', 'effective' => $e, 'effective_code' => $e ? self::code($e) : '',
			'can_back' => $back, 'can_forward' => $fwd, 'count' => count($vs), 'open' => $last && empty($last['sealed']),
		);
	}

	private static function track_effective($log, $tid) {
		$list = (array) ($log['tv'][$tid] ?? array());
		$last = $list ? end($list) : null;
		return !$last ? 0 : (!empty($last['step']) ? (int) $last['restored_from'] : (int) $last['k']);
	}

	private static function track_head($log, $tid) {
		$list = (array) ($log['tv'][$tid] ?? array());
		$last = $list ? end($list) : null;
		$e    = self::track_effective($log, $tid);
		$back = $fwd = false;
		foreach ($list as $tv) {
			if (empty($tv['step'])) {
				$back = $back || $tv['k'] < $e;
				$fwd  = $fwd || $tv['k'] > $e;
			}
		}
		return array(
			'track' => $tid, 'kind' => self::VALUES === $tid ? 'values' : 'doc', 'label' => self::track_label($log, $tid),
			'file' => self::VALUES === $tid ? SMS_Project::VALUES_FILE : (string) $log['tracks'][$tid]['file'], 'deleted' => !empty($log['tracks'][$tid]['deleted']),
			'k' => $last ? $last['k'] : 0, 'code' => $last ? self::code($last['k']) : '', 'effective' => $e, 'effective_code' => $e ? self::code($e) : '',
			'can_back' => $back, 'can_forward' => $fwd, 'count' => count($list),
		);
	}

	private static function heads_info($log) {
		$tracks = array();
		foreach (self::ordered_tracks($log, array_keys($log['tracks'])) as $tid) {
			$tracks[] = self::track_head($log, $tid);
		}
		return array('head' => self::project_head($log), 'tracks' => $tracks);
	}

	/** Resolve a track given as id, file name, label or "values". */
	public static function find_track($log, $track) {
		$t = trim((string) $track);
		if ('' === $t) {
			return null;
		}
		if (in_array(strtolower($t), array('values', 'shared values', 'project.json'), true)) {
			return isset($log['tracks'][self::VALUES]) ? self::VALUES : null;
		}
		if (isset($log['tracks'][$t])) {
			return $t;
		}
		foreach (array($t, $t . '.html') as $f) {
			if (isset($log['files'][$f])) {
				return $log['files'][$f];
			}
		}
		foreach ($log['tracks'] as $tid => $tr) {
			if (0 === strcasecmp($tr['file'], $t) || 0 === strcasecmp(preg_replace('/\.html$/i', '', $tr['file']), $t)) {
				return $tid;
			}
		}
		return null;
	}

	private static function no_track($track) {
		return new WP_Error('sms_no_track', 'No history for "' . $track . '". Give a document file name or "values".', array('status' => 404));
	}

	public static function listing($project, $track = '', $limit = 100, $before = 0) {
		$log  = self::get_log($project);
		$out  = array('project' => $project) + self::heads_info($log);
		$lim  = max(1, min(1000, (int) $limit));
		if ('' !== (string) $track) {
			$tid = self::find_track($log, $track);
			if (!$tid) {
				return self::no_track($track);
			}
			$list = (array) ($log['tv'][$tid] ?? array());
			$rows = array();
			foreach ($list as $i => $tv) {
				$rows[] = self::tv_summary($log, $tid, $tv, $i > 0 ? $list[$i - 1] : null);
			}
			$rows = array_reverse($rows);
			if ($before > 0) {
				$rows = array_values(array_filter($rows, function ($r) use ($before) { return $r['k'] < $before; }));
			}
			$out['track']    = self::track_head($log, $tid);
			$out['versions'] = array_slice($rows, 0, $lim);
			$out['more']     = count($rows) > $lim;
			return $out;
		}
		$all = array_reverse($log['versions']);
		if ($before > 0) {
			$all = array_values(array_filter($all, function ($v) use ($before) { return $v['n'] < $before; }));
		}
		$page            = array_slice($all, 0, $lim);
		$out['versions'] = array_map(function ($v) use ($log) { return self::pv_summary($log, $v); }, $page);
		$out['more']     = count($all) > count($page);
		return $out;
	}

	/* ---------- Comparing ---------- */

	private static function filled($content, $values_json, $file) {
		$model = SMS_Doc::parse((string) $content, preg_replace('/\.html$/i', '', $file));
		list($body) = SMS_Values::apply_to_body($model['body'], $model['lang'], SMS_Values::parse($values_json));
		$model['body'] = $body;
		return $model;
	}

	/** Changes from version ka to kb of one track; each side shown with its own shared values. */
	private static function track_changes($project, $log, $tid, $ka, $kb, $va, $vb) {
		$a   = self::tv($log, $tid, $ka);
		$b   = self::tv($log, $tid, $kb);
		$ca  = $a ? self::get_blob($project, $a['hash']) : null;
		$cb  = $b ? self::get_blob($project, $b['hash']) : null;
		$out = array(
			'track' => $tid, 'kind' => self::VALUES === $tid ? 'values' : 'doc', 'label' => self::VALUES === $tid ? 'Shared values' : preg_replace('/\.html$/i', '', (string) (($b ?: $a)['name'] ?? '')),
			'from' => $ka, 'to' => $kb, 'from_code' => $ka ? self::code($ka) : null, 'to_code' => $kb ? self::code($kb) : null, 'hunks' => array(),
		);
		if (self::VALUES === $tid) {
			$out['op']    = 'changed';
			$out['hunks'] = self::value_hunks($ca ?? self::EMPTY_VALUES, $cb ?? self::EMPTY_VALUES);
		} elseif (null === $ca || null === $cb) {
			$out['op']      = null === $ca ? 'created' : 'deleted';
			$m              = self::filled($cb ?? $ca, null === $cb ? $va : $vb, ($b ?: $a)['name']);
			$out['hunks'][] = array('kind' => 'file', 'op' => $out['op'], 'label' => null === $ca ? 'Document added' : 'Document deleted', 'text' => mb_substr(SMS_Doc::text($m['body']), 0, 400));
		} else {
			$out['op'] = 'changed';
			if ($a['name'] !== $b['name']) {
				$out['op']      = $ca === $cb ? 'renamed' : 'changed';
				$out['hunks'][] = array('kind' => 'setting', 'key' => 'name', 'label' => 'File name', 'before' => preg_replace('/\.html$/i', '', $a['name']), 'after' => preg_replace('/\.html$/i', '', $b['name']));
			}
			$mb = self::filled($ca, $va, $a['name']);
			$ma = self::filled($cb, $vb, $b['name']);
			foreach (array('title' => 'Title', 'lang' => 'Language', 'margins' => 'Margins', 'font' => 'Font', 'fontSize' => 'Font size') as $k => $label) {
				if (wp_json_encode($mb[$k]) !== wp_json_encode($ma[$k])) {
					$out['hunks'][] = array('kind' => 'setting', 'key' => $k, 'label' => $label, 'before' => self::setting_text($mb, $k), 'after' => self::setting_text($ma, $k));
				}
			}
			foreach (self::block_hunks(self::blocks($mb['body']), self::blocks($ma['body'])) as $h) {
				$out['hunks'][] = array(
					'kind'   => 'body',
					'label'  => !$h['before'] ? 'Added' : (!$h['after'] ? 'Removed' : 'Changed'),
					'before' => implode("\n", array_map(function ($x) { return $x['text']; }, $h['before'])),
					'after'  => implode("\n", array_map(function ($x) { return $x['text']; }, $h['after'])),
				);
			}
		}
		foreach ($out['hunks'] as $i => &$h) {
			$h['id'] = $tid . '#' . $i;
		}
		return $out;
	}

	/** What a project version changed, or what a track version changed. */
	public static function detail($project, $n, $track = '') {
		$log = self::get_log($project);
		if ('' !== (string) $track) {
			$tid = self::find_track($log, $track);
			if (!$tid) {
				return self::no_track($track);
			}
			$i = self::tv_index($log, $tid, $n);
			if (null === $i) {
				return self::not_found(self::track_label($log, $tid) . ' v' . self::code($n));
			}
			$tv   = $log['tv'][$tid][$i];
			$prev = $i > 0 ? $log['tv'][$tid][$i - 1] : null;
			$ch   = self::track_changes($project, $log, $tid, $prev ? $prev['k'] : null, $tv['k'], $prev ? self::values_at($project, $log, $prev['project']) : self::EMPTY_VALUES, self::values_at($project, $log, $tv['project']));
			return array('version' => self::tv_summary($log, $tid, $tv, $prev), 'changes' => array($ch)) + self::heads_info($log);
		}
		$v = self::pv($log, $n);
		if (!$v) {
			return self::not_found('Project version ' . self::code($n));
		}
		$va      = self::values_at($project, $log, $n - 1 > 0 ? self::prev_n($log, $n) : 0);
		$vb      = self::values_at($project, $log, $n);
		$changes = array();
		foreach (self::ordered_tracks($log, array_keys((array) $v['changes'])) as $tid) {
			$c         = $v['changes'][$tid];
			$changes[] = self::track_changes($project, $log, $tid, $c['from'], $c['to'], $va, $vb);
		}
		return array('version' => self::pv_summary($log, $v), 'changes' => $changes) + self::heads_info($log);
	}

	private static function prev_n($log, $n) {
		$p = 0;
		foreach ($log['versions'] as $v) {
			if ($v['n'] < $n) {
				$p = $v['n'];
			}
		}
		return $p;
	}

	/** Differences between any two versions (a → b): of the project, or of one track. */
	public static function compare($project, $a, $b, $track = '') {
		$log = self::get_log($project);
		if ('' !== (string) $track) {
			$tid = self::find_track($log, $track);
			if (!$tid) {
				return self::no_track($track);
			}
			$ta = self::tv($log, $tid, $a);
			$tb = self::tv($log, $tid, $b);
			if (!$ta || !$tb) {
				return self::not_found(self::track_label($log, $tid) . ' v' . self::code($ta ? $b : $a));
			}
			$ch = self::track_changes($project, $log, $tid, $a, $b, self::values_at($project, $log, $ta['project']), self::values_at($project, $log, $tb['project']));
			return array('track' => self::track_head($log, $tid), 'a' => self::code($a), 'b' => self::code($b), 'changes' => array($ch));
		}
		if (!self::pv($log, $a) || !self::pv($log, $b)) {
			return self::not_found('Project version ' . self::code(self::pv($log, $a) ? $b : $a));
		}
		$ha  = self::heads_at($log, $a);
		$hb  = self::heads_at($log, $b);
		$va  = self::values_at($project, $log, $a);
		$vb  = self::values_at($project, $log, $b);
		$out = array();
		foreach (self::ordered_tracks($log, array_merge(array_keys($ha), array_keys($hb))) as $tid) {
			$ka = $ha[$tid] ?? null;
			$kb = $hb[$tid] ?? null;
			if ($ka === $kb) {
				continue;
			}
			$ch = self::track_changes($project, $log, $tid, $ka, $kb, $va, $vb);
			if ($ch['hunks']) {
				$out[] = $ch;
			}
		}
		return array('a' => self::code($a), 'b' => self::code($b), 'changes' => $out);
	}

	/**
	 * A document at track version k, with the differences from version $against
	 * (default: the one before) marked; for shared values, every value with the
	 * changed ones flagged.
	 */
	public static function render($project, $track, $k, $against = null) {
		$log = self::get_log($project);
		$tid = self::find_track($log, $track);
		if (!$tid) {
			return self::no_track($track);
		}
		$i = self::tv_index($log, $tid, $k);
		if (null === $i) {
			return self::not_found(self::track_label($log, $tid) . ' v' . self::code($k));
		}
		$tv = $log['tv'][$tid][$i];
		if (null === $against) {
			$against = $i > 0 ? $log['tv'][$tid][$i - 1]['k'] : 0;
		}
		$ta  = $against ? self::tv($log, $tid, $against) : null;
		$c   = self::get_blob($project, $tv['hash']);
		$ca  = $ta ? self::get_blob($project, $ta['hash']) : null;
		$vb  = self::values_at($project, $log, $tv['project']);
		$va  = $ta ? self::values_at($project, $log, $ta['project']) : self::EMPTY_VALUES;
		$out = array('track' => $tid, 'k' => $tv['k'], 'code' => self::code($tv['k']), 'against' => $ta ? self::code($ta['k']) : null, 'version' => self::tv_summary($log, $tid, $tv, $i > 0 ? $log['tv'][$tid][$i - 1] : null));
		if (self::VALUES === $tid) {
			return $out + self::values_view($c ?? self::EMPTY_VALUES, $ca);
		}
		if (null === $c) {
			if (null === $ca) {
				return $out + array('html' => '', 'changes' => 0, 'deleted' => true);
			}
			$model         = self::filled($ca, $va, $ta['name']);
			$model['body'] = '<div data-sv-diff="del">' . $model['body'] . '</div>';
			return $out + array('html' => SMS_Doc::serialize($model), 'changes' => 1, 'deleted' => true);
		}
		$model = self::filled($c, $vb, $tv['name']);
		$count = 0;
		if (null === $ca) {
			if ($ta || $i > 0) {
				$model['body'] = '<div data-sv-diff="add">' . $model['body'] . '</div>';
				$count         = 1;
			}
		} else {
			$mb    = self::filled($ca, $va, $ta['name']);
			$ab    = self::blocks($model['body']);
			$hunks = self::block_hunks(self::blocks($mb['body']), $ab);
			$count = count($hunks);
			foreach (array('title', 'lang', 'margins', 'font', 'fontSize') as $s) {
				if (wp_json_encode($mb[$s]) !== wp_json_encode($model[$s])) {
					$count++;
				}
			}
			$parts = array();
			$byat  = array();
			foreach ($hunks as $h) {
				$byat[$h['at']] = $h;
			}
			$n = count($ab);
			for ($j = 0; $j <= $n; $j++) {
				if (isset($byat[$j])) {
					$h     = $byat[$j];
					$pairs = min(count($h['before']), count($h['after']));
					for ($x = $pairs; $x < count($h['before']); $x++) {
						$parts[] = '<div data-sv-diff="del">' . $h['before'][$x]['html'] . '</div>';
					}
					foreach ($h['after'] as $x => $blk) {
						// A changed paragraph: mark the words that changed, not the whole paragraph.
						$marked  = $x < $pairs ? self::word_mark($h['before'][$x]['html'], $blk['html']) : null;
						$parts[] = $x >= $pairs ? '<div data-sv-diff="add">' . $blk['html'] . '</div>'
							: (null === $marked ? '<div data-sv-diff="chg">' . $blk['html'] . '</div>' : '<div data-sv-diff="edit">' . $marked . '</div>');
					}
					if ($h['after']) {
						$j += count($h['after']) - 1;
						continue;
					}
				}
				if ($j < $n) {
					$parts[] = $ab[$j]['html'];
				}
			}
			$model['body'] = implode('', $parts);
		}
		return $out + array('html' => SMS_Doc::serialize($model), 'changes' => $count);
	}

	/**
	 * The new version of a paragraph with the words added since the old one
	 * wrapped in <span data-sv-w="add"> and the removed words shown in place in
	 * <span data-sv-w="del">. Null when there is too much to compare.
	 */
	private static function word_mark($before_html, $after_html) {
		list($bdom, $broot) = SMS_Doc::load_fragment($before_html);
		list($dom, $root)   = SMS_Doc::load_fragment($after_html);
		if (!$broot || !$root) {
			return null;
		}
		$nodes = array();
		$walk  = function ($n) use (&$walk, &$nodes) {
			foreach (iterator_to_array($n->childNodes) as $c) {
				if (XML_TEXT_NODE === $c->nodeType) {
					$nodes[] = $c;
				} elseif (XML_ELEMENT_NODE === $c->nodeType && !in_array(strtolower($c->nodeName), array('style', 'script'), true)) {
					$walk($c);
				}
			}
		};
		$walk($root);
		$split = function ($t) {
			// Words, runs of spaces and single punctuation marks (text is split across tags at such places).
			return preg_split('/(\s+|[^\p{L}\p{M}\p{N}\s])/u', $t, -1, PREG_SPLIT_DELIM_CAPTURE | PREG_SPLIT_NO_EMPTY) ?: array();
		};
		$a = array(); // array(token, node index)
		foreach ($nodes as $i => $node) {
			foreach ($split($node->nodeValue) as $tok) {
				$a[] = array($tok, $i);
			}
		}
		$b = $split($broot->textContent);
		$N = count($b);
		$M = count($a);
		if (!$M || $N * $M > 250000) {
			return null;
		}
		$L = array_fill(0, $N + 1, array_fill(0, $M + 1, 0));
		for ($i = $N - 1; $i >= 0; $i--) {
			for ($j = $M - 1; $j >= 0; $j--) {
				$L[$i][$j] = $b[$i] === $a[$j][0] ? $L[$i + 1][$j + 1] + 1 : max($L[$i + 1][$j], $L[$i][$j + 1]);
			}
		}
		// Pieces per text node: array(kind, text), kind eq|add|del.
		$pieces  = array_fill(0, count($nodes), array());
		$pending = array(); // removed words waiting for the next node with new text
		$i       = 0;
		$j       = 0;
		$changed = false;
		$put     = function ($node, $kind, $text) use (&$pieces) {
			$last = count($pieces[$node]) - 1;
			if ($last >= 0 && $pieces[$node][$last][0] === $kind) {
				$pieces[$node][$last][1] .= $text;
			} else {
				$pieces[$node][] = array($kind, $text);
			}
		};
		while ($i < $N || $j < $M) {
			if ($i < $N && $j < $M && $b[$i] === $a[$j][0]) {
				foreach ($pending as $d) {
					$put($a[$j][1], 'del', $d);
				}
				$pending = array();
				$put($a[$j][1], 'eq', $a[$j][0]);
				$i++;
				$j++;
			} elseif ($i < $N && ($j >= $M || $L[$i + 1][$j] >= $L[$i][$j + 1])) {
				if ('' !== trim($b[$i])) {
					$pending[] = $b[$i];
					$changed   = true;
				} elseif ($pending) {
					$pending[count($pending) - 1] .= $b[$i];
				}
				$i++;
			} else {
				foreach ($pending as $d) {
					$put($a[$j][1], 'del', $d);
				}
				$pending = array();
				$ws = '' === trim($a[$j][0]);
				$put($a[$j][1], $ws ? 'eq' : 'add', $a[$j][0]);
				$changed = $changed || !$ws;
				$j++;
			}
		}
		foreach ($pending as $d) {
			$put(count($nodes) - 1, 'del', $d);
		}
		if (!$changed) {
			return $after_html;
		}
		foreach ($nodes as $k => $node) {
			$frag = $dom->createDocumentFragment();
			foreach ($pieces[$k] as $p) {
				if ('eq' === $p[0]) {
					$frag->appendChild($dom->createTextNode($p[1]));
				} else {
					$span = $dom->createElement('span');
					$span->setAttribute('data-sv-w', $p[0]);
					$span->appendChild($dom->createTextNode($p[1]));
					$frag->appendChild($span);
				}
			}
			$node->parentNode->replaceChild($frag, $node);
		}
		return SMS_Doc::inner_html($dom, $root);
	}

	/** Every shared value as people read it, with the ones changed since $before flagged. */
	private static function values_view($json, $before) {
		$v       = SMS_Values::parse($json);
		$changed = array();
		if (null !== $before) {
			foreach (self::value_hunks($before, $json) as $h) {
				$changed[0 === strpos($h['key'], 'guest') ? 'specialGuests' : ('host' === $h['key'] ? 'specialGuests' : $h['key'])] = true;
			}
		}
		$fields = array();
		foreach (SMS_Values::FIELDS as $k => $def) {
			if ('guest' === $def[2] || 'guests' === $def[2]) {
				continue;
			}
			$fields[] = array('key' => $k, 'label' => $def[0], 'en' => SMS_Values::scalar_text($v, $k, 'en'), 'bn' => SMS_Values::scalar_text($v, $k, 'bn'), 'changed' => isset($changed[$k]));
		}
		$fields[] = array('key' => 'chiefGuest', 'label' => 'Chief guest', 'en' => self::guest_name($v['chiefGuest']), 'bn' => $v['chiefGuest'] ? SMS_Values::guest_text($v['chiefGuest'], 'bn') : '', 'changed' => isset($changed['chiefGuest']));
		$host   = $v['specialGuests'] ? SMS_Values::host_index($v) : -1;
		$guests = array();
		foreach ($v['specialGuests'] as $i => $g) {
			$guests[] = array('en' => self::guest_name($g), 'bn' => SMS_Values::guest_text($g, 'bn'), 'host' => $i === $host);
		}
		return array('kind' => 'values', 'fields' => $fields, 'guests' => $guests, 'guests_changed' => isset($changed['specialGuests']), 'changes' => count($changed));
	}

	/** Plain text of a document (or readable values) at a project version or a track version. */
	public static function read($project, $n, $track, $project_level) {
		$log = self::get_log($project);
		$tid = self::find_track($log, $track);
		if (!$tid) {
			return self::no_track($track);
		}
		if ($project_level) {
			if (!self::pv($log, $n)) {
				return self::not_found('Project version ' . self::code($n));
			}
			$k = self::heads_at($log, $n)[$tid] ?? null;
			if (null === $k) {
				return new WP_Error('sms_not_found', self::track_label($log, $tid) . ' did not exist in project version ' . self::code($n) . '.', array('status' => 404));
			}
			$values = self::values_at($project, $log, $n);
		} else {
			$k = $n;
			$tv = self::tv($log, $tid, $k);
			if (!$tv) {
				return self::not_found(self::track_label($log, $tid) . ' v' . self::code($n));
			}
			$values = self::values_at($project, $log, $tv['project']);
		}
		$tv = self::tv($log, $tid, $k);
		$c  = self::get_blob($project, $tv['hash']);
		if (self::VALUES === $tid) {
			return array('track' => 'values', 'version' => self::code($k), 'values' => self::values_view($c ?? self::EMPTY_VALUES, null));
		}
		if (null === $c) {
			return array('file' => $tv['name'], 'version' => self::code($k), 'deleted' => true);
		}
		$m = self::filled($c, $values, $tv['name']);
		return array('file' => $tv['name'], 'version' => self::code($k), 'title' => $m['title'], 'lang' => $m['lang'], 'text' => SMS_Doc::text($m['body']));
	}

	/* ---------- Naming ---------- */

	/** Close the open project version now (Save version / Ctrl+S), optionally naming it. */
	public static function commit($project, $tag = null, $desc = null, $author = null) {
		$h   = self::lock($project);
		$log = self::load($project);
		$cnt = count($log['versions']);
		if (!$cnt) {
			self::unlock($h);
			return new WP_Error('sms_no_changes', 'Nothing has changed yet, so there is no version to save.', array('status' => 409));
		}
		$i   = $cnt - 1;
		$was = empty($log['versions'][$i]['sealed']);
		$log['versions'][$i]['sealed'] = true;
		foreach (array('tag' => array($tag, 40), 'desc' => array($desc, 500), 'author' => array($author, 60)) as $k => $x) {
			if (null !== $x[0] && '' !== trim((string) $x[0])) {
				$log['versions'][$i][$k] = self::clean_text($x[0], $x[1]);
			}
		}
		self::save($project, $log);
		self::unlock($h);
		return array('version' => self::pv_summary($log, $log['versions'][$i]), 'new_changes' => $was) + self::heads_info($log);
	}

	/** Set the tag, description or author of a project version or a track version ("" clears; null keeps). */
	public static function set_info($project, $n, $track = '', $tag = null, $desc = null, $author = null) {
		$h   = self::lock($project);
		$log = self::load($project);
		$set = function (&$row) use ($tag, $desc, $author) {
			foreach (array('tag' => array($tag, 40), 'desc' => array($desc, 500), 'author' => array($author, 60)) as $k => $x) {
				if (null !== $x[0]) {
					$row[$k] = self::clean_text($x[0], $x[1]);
				}
			}
		};
		$out = null;
		if ('' !== (string) $track) {
			$tid = self::find_track($log, $track);
			$i   = $tid ? self::tv_index($log, $tid, $n) : null;
			if (null !== $i) {
				$set($log['tv'][$tid][$i]);
				$out = array('version' => self::tv_summary($log, $tid, $log['tv'][$tid][$i]));
			}
		} else {
			foreach ($log['versions'] as $i => $v) {
				if ((int) $v['n'] === (int) $n) {
					$set($log['versions'][$i]);
					$out = array('version' => self::pv_summary($log, $log['versions'][$i]));
				}
			}
		}
		if ($out) {
			self::save($project, $log);
		}
		self::unlock($h);
		return $out ? $out : self::not_found('Version ' . self::code($n));
	}

	/* ---------- Restoring ---------- */

	private static function same_values($a, $b) {
		return wp_json_encode(SMS_Values::parse((string) $a)) === wp_json_encode(SMS_Values::parse((string) $b));
	}

	/**
	 * What bringing the whole project back to version n would write:
	 * list of array(file, content|null), plus whether anything really changes.
	 */
	private static function plan_project($project, $log, $n) {
		$heads  = self::heads_at($log, $n);
		$cur    = self::current_files($project);
		$values = self::values_at($project, $log, $n);
		$writes = array();
		$real   = false;
		if (!self::same_values($cur[SMS_Project::VALUES_FILE] ?? self::EMPTY_VALUES, $values)) {
			$writes[] = array(SMS_Project::VALUES_FILE, SMS_Values::to_json(SMS_Values::parse($values)));
			$real     = true;
		}
		$taken = array();
		foreach ($log['tracks'] as $tid => $tr) {
			if (self::VALUES === $tid) {
				continue;
			}
			$k    = $heads[$tid] ?? null;
			$tv   = self::tv($log, $tid, $k);
			$c    = $tv ? self::get_blob($project, $tv['hash']) : null;
			$name = empty($tr['deleted']) ? $tr['file'] : null;
			if (null === $c) {
				if (null !== $name && isset($cur[$name])) {
					$writes[] = array($name, null);
					$real     = true;
				}
				continue;
			}
			$from = null;
			if (null === $name) {
				$name = $tv['name'];
				if (isset($cur[$name]) || isset($taken[$name])) {
					$name = preg_replace('/\.html$/i', '', $name) . ' (restored).html';
				}
			} elseif ($name !== $tv['name'] && !isset($cur[$tv['name']]) && !isset($taken[$tv['name']])) {
				$from = $name; // Renamed since: take the old name back.
				$name = $tv['name'];
			}
			$taken[$name] = true;
			$new          = SMS_Doc::serialize(self::filled($c, $values, $name));
			$old          = $cur[$from ?? $name] ?? null;
			if (null !== $from || null === $old || $old !== $new) {
				$writes[] = array($name, $new, $from);
				$real     = $real || null !== $from || null === $old || !self::slots_only($name, $old, $new);
			}
		}
		return array($writes, $real);
	}

	/** What bringing one track back to its version k would write. */
	private static function plan_track($project, $log, $tid, $k) {
		$tv  = self::tv($log, $tid, $k);
		$c   = $tv ? self::get_blob($project, $tv['hash']) : null;
		$cur = self::current_files($project);
		if (self::VALUES === $tid) {
			$values = $c ?? self::EMPTY_VALUES;
			if (self::same_values($cur[SMS_Project::VALUES_FILE] ?? self::EMPTY_VALUES, $values)) {
				return array(array(), false);
			}
			// Every document shows the shared values of the same moment.
			$writes = array(array(SMS_Project::VALUES_FILE, SMS_Values::to_json(SMS_Values::parse($values))));
			foreach ($cur as $f => $content) {
				if (preg_match('/\.html$/i', $f)) {
					$new = SMS_Doc::serialize(self::filled($content, $values, $f));
					if ($new !== $content) {
						$writes[] = array($f, $new);
					}
				}
			}
			return array($writes, true);
		}
		$tr   = $log['tracks'][$tid];
		$name = empty($tr['deleted']) ? $tr['file'] : null;
		if (null === $c) {
			return null !== $name && isset($cur[$name]) ? array(array(array($name, null)), true) : array(array(), false);
		}
		$from = null;
		if (null === $name) {
			$name = isset($cur[$tv['name']]) ? preg_replace('/\.html$/i', '', $tv['name']) . ' (restored).html' : $tv['name'];
		} elseif ($name !== $tv['name'] && !isset($cur[$tv['name']])) {
			$from = $name;
			$name = $tv['name'];
		}
		$new = SMS_Doc::serialize(self::filled($c, $cur[SMS_Project::VALUES_FILE] ?? self::EMPTY_VALUES, $name));
		if (null === $from && isset($cur[$name]) && ($cur[$name] === $new || self::slots_only($name, $cur[$name], $new))) {
			return array(array(), false);
		}
		return array(array(array($name, $new, $from)), true);
	}

	private static function apply($project, $writes) {
		$store = SMS_Storage::instance();
		$done  = array();
		foreach ($writes as $w) {
			if (!empty($w[2])) {
				$r = $store->move($project . '/' . $w[2], $project . '/' . $w[0]);
				if (is_wp_error($r)) {
					return $r;
				}
			}
			$r = null === $w[1] ? $store->trash($project . '/' . $w[0]) : $store->write($project . '/' . $w[0], $w[1]);
			if (is_wp_error($r)) {
				return $r;
			}
			$done[] = $w[0];
		}
		return $done;
	}

	private static function run($project, $writes, $meta, $tmeta, $track, $reuse = null) {
		self::$ctx = array('project' => $project, 'n' => $reuse, 'meta' => $meta, 'tmeta' => $tmeta, 'track' => $track);
		$done      = self::apply($project, $writes);
		$n         = self::$ctx['n'];
		self::$ctx = null;
		$h         = self::lock($project);
		$log       = self::load($project);
		foreach ($log['versions'] as $i => $v) {
			$log['versions'][$i]['sealed'] = true;
		}
		self::save($project, $log);
		self::unlock($h);
		if (is_wp_error($done)) {
			return $done;
		}
		$v = null !== $n ? self::pv($log, $n) : null;
		return array('changed' => $done, 'version' => $v ? self::pv_summary($log, $v) : null) + self::heads_info($log);
	}

	/** Bring the whole project (every document and the shared values) back to project version n. */
	public static function restore($project, $n) {
		$log = self::get_log($project);
		if (!self::pv($log, $n)) {
			return self::not_found('Project version ' . self::code($n));
		}
		list($writes, $real) = self::plan_project($project, $log, (int) $n);
		if (!$real) {
			return array('changed' => array(), 'version' => null, 'message' => 'The project already matches v' . self::code($n) . '.') + self::heads_info($log);
		}
		return self::run($project, $writes, array('restored_from' => (int) $n, 'desc' => 'Restored the project to v' . self::code($n)), array('restored' => true), null);
	}

	/** Bring one document (or the shared values) back to its version k. */
	public static function restore_track($project, $track, $k) {
		$log = self::get_log($project);
		$tid = self::find_track($log, $track);
		if (!$tid) {
			return self::no_track($track);
		}
		if (!self::tv($log, $tid, $k)) {
			return self::not_found(self::track_label($log, $tid) . ' v' . self::code($k));
		}
		list($writes, $real) = self::plan_track($project, $log, $tid, (int) $k);
		$label = self::track_label($log, $tid);
		if (!$real) {
			return array('changed' => array(), 'version' => null, 'message' => $label . ' already matches v' . self::code($k) . '.') + self::heads_info($log);
		}
		return self::run($project, $writes, array('desc' => 'Restored ' . $label . ' to v' . self::code($k)), array('restored_from' => (int) $k), $tid);
	}

	/** ◀ / ▶ for the project or one track. Steps in a row share one version. */
	public static function step($project, $dir, $track = '') {
		$log  = self::get_log($project);
		$back = 'back' === $dir;
		$vs   = $log['versions'];
		$last = $vs ? end($vs) : null;
		if ('' !== (string) $track) {
			$tid = self::find_track($log, $track);
			if (!$tid) {
				return self::no_track($track);
			}
			$e    = self::track_effective($log, $tid);
			$real = array();
			foreach ((array) ($log['tv'][$tid] ?? array()) as $tv) {
				if (empty($tv['step'])) {
					$real[] = (int) $tv['k'];
				}
			}
			$cands = $back ? array_reverse(array_values(array_filter($real, function ($k) use ($e) { return $k < $e; }))) : array_values(array_filter($real, function ($k) use ($e) { return $k > $e; }));
			$reuse = $last && !empty($last['step']) && ($last['step_track'] ?? '') === $tid && !empty($last['sealed']) ? (int) $last['n'] : null;
			$label = self::track_label($log, $tid);
			foreach ($cands as $t) {
				list($writes, $real_change) = self::plan_track($project, $log, $tid, $t);
				if ($real_change) {
					$r = self::run($project, $writes, array('step' => true, 'step_track' => $tid, 'restored_from' => $t, 'desc' => $label . ' went ' . ($back ? 'back' : 'forward') . ' to v' . self::code($t)), array('restored_from' => $t, 'step' => true), $tid, $reuse);
					return is_wp_error($r) ? $r : array('now_at' => self::code($t)) + $r;
				}
			}
			return new WP_Error('sms_no_step', $back ? 'This is the earliest version of ' . $label . '.' : 'This is the latest version of ' . $label . '.', array('status' => 409));
		}
		$head = self::project_head($log);
		$e    = $head['effective'];
		$real = array();
		foreach ($vs as $v) {
			if (empty($v['step']) || !empty($v['step_track'])) {
				$real[] = (int) $v['n'];
			}
		}
		$cands = $back ? array_reverse(array_values(array_filter($real, function ($n) use ($e) { return $n < $e; }))) : array_values(array_filter($real, function ($n) use ($e) { return $n > $e; }));
		$reuse = $last && !empty($last['step']) && empty($last['step_track']) ? (int) $last['n'] : null;
		foreach ($cands as $t) {
			list($writes, $real_change) = self::plan_project($project, $log, $t);
			if ($real_change) {
				$r = self::run($project, $writes, array('step' => true, 'restored_from' => $t, 'desc' => 'Went ' . ($back ? 'back' : 'forward') . ' to v' . self::code($t)), array('restored' => true), null, $reuse);
				return is_wp_error($r) ? $r : array('now_at' => self::code($r['version'] ? $t : max($real))) + $r;
			}
		}
		return new WP_Error('sms_no_step', $back ? 'This is the earliest version.' : 'This is the latest version.', array('status' => 409));
	}

	/* ---------- Helpers for comparing ---------- */

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

}
