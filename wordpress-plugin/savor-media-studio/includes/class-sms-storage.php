<?php
/**
 * File storage for Media Studio projects.
 *
 * A project is a folder of .html documents under wp-content/uploads/savor-media-studio/files.
 * The whole folder is blocked from direct web access; everything goes
 * through the REST API, which only reads and writes .html files with scripts removed.
 */

if (!defined('ABSPATH')) {
	exit;
}

class SMS_Storage {
	const MAX_FILE_BYTES  = 12582912;  // 12 MB per document (embedded images).
	const MAX_TOTAL_BYTES = 1073741824; // 1 GB for all files.
	const MAX_FILES       = 3000;
	const MAX_DEPTH       = 6;
	const VERSION_EVERY   = 300;       // Seconds between automatic version snapshots.
	const VERSIONS_KEPT   = 30;
	const TRASH_DAYS      = 30;

	private static $instance;
	private $root;

	public static function instance() {
		if (!self::$instance) {
			$uploads        = wp_upload_dir(null, false);
			self::$instance = new self(trailingslashit($uploads['basedir']) . 'savor-media-studio');
		}
		return self::$instance;
	}

	public function __construct($root) {
		$this->root = rtrim($root, '/\\');
	}

	public function root_dir() {
		return $this->root;
	}

	public function files_dir() {
		return $this->root . '/files';
	}

	private function versions_dir() {
		return $this->root . '/versions';
	}

	private function trash_dir() {
		return $this->root . '/trash';
	}

	/** Create folders and lock them against direct web access. */
	public function ensure_dirs() {
		foreach (array($this->root, $this->files_dir(), $this->versions_dir(), $this->trash_dir()) as $dir) {
			if (!is_dir($dir)) {
				wp_mkdir_p($dir);
			}
		}
		$htaccess = $this->root . '/.htaccess';
		if (!file_exists($htaccess)) {
			file_put_contents($htaccess, "# SAVOR Media Studio: files are served only through the REST API.\n<IfModule mod_authz_core.c>\n\tRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n\tOrder allow,deny\n\tDeny from all\n</IfModule>\nOptions -Indexes\n");
		}
		foreach (array($this->root, $this->files_dir(), $this->versions_dir(), $this->trash_dir()) as $dir) {
			if (!file_exists($dir . '/index.php')) {
				file_put_contents($dir . '/index.php', "<?php\n// Silence is golden.\n");
			}
		}
	}

	/** First activation: start with one empty folder. */
	public function seed_if_empty() {
		if (!$this->list_tree()) {
			$this->mkdir_rel('Projects');
		}
	}

	/**
	 * Validate a relative path and return its clean form, or WP_Error.
	 * Segments may contain letters (any script, including Bangla), marks, digits,
	 * spaces and - _ . ( ) &. No dot files, no traversal.
	 */
	public static function clean_path($path, $kind = 'file') {
		if (!is_string($path)) {
			return new WP_Error('sms_bad_path', 'Invalid file name.', array('status' => 400));
		}
		$path = str_replace('\\', '/', trim($path));
		$path = trim(preg_replace('#/+#', '/', $path), '/');
		if ('' === $path) {
			return 'folder' === $kind ? '' : new WP_Error('sms_bad_path', 'Enter a file name.', array('status' => 400));
		}
		$parts = explode('/', $path);
		if (count($parts) > self::MAX_DEPTH) {
			return new WP_Error('sms_bad_path', 'Folders are nested too deeply.', array('status' => 400));
		}
		foreach ($parts as $part) {
			$part = trim($part);
			if ('' === $part || '.' === $part[0] || strlen($part) > 120 || !preg_match('/^[\p{L}\p{M}\p{N} _\-.()&]+$/u', $part)) {
				return new WP_Error('sms_bad_path', 'Use only letters, numbers, spaces and - _ . ( ) & in names.', array('status' => 400));
			}
		}
		$clean = implode('/', array_map('trim', $parts));
		if ('file' === $kind && !preg_match('/\.html$/i', $clean) && !self::is_data_file($clean)) {
			$clean .= '.html';
		}
		if ('folder' === $kind && preg_match('/\.html$/i', $clean)) {
			return new WP_Error('sms_bad_path', 'Folder names cannot end in .html.', array('status' => 400));
		}
		return $clean;
	}

	/** Remove anything that could run code when a document is opened. */
	public static function strip_active_content($html) {
		$html = preg_replace('#<(script|iframe|object|embed|applet|frame|frameset|base|meta\s+http-equiv)\b[^>]*>.*?</\1\s*>#is', '', $html);
		$html = preg_replace('#<(script|iframe|object|embed|applet|frame|frameset|base)\b[^>]*/?>#i', '', $html);
		$html = preg_replace('#\son[a-z]+\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)#i', '', $html);
		$html = preg_replace('#(href|src|action|formaction)\s*=\s*(["\']?)\s*(javascript|vbscript):#i', '$1=$2#', $html);
		return $html;
	}

	/** The only non-HTML files allowed: a project's shared values and the translation glossary. */
	public static function is_data_file($rel) {
		return (bool) preg_match('#^(?:[^/]+/project\.json|glossary\.json)$#', $rel);
	}

	private function abs($rel) {
		return $this->files_dir() . ('' === $rel ? '' : '/' . $rel);
	}

	/** Flat list of all folders and files, sorted. */
	public function list_tree() {
		$base = $this->files_dir();
		if (!is_dir($base)) {
			return array();
		}
		$out = array();
		$it  = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
		foreach ($it as $info) {
			$name = $info->getFilename();
			if ('.' === $name[0] || 'index.php' === $name) {
				continue;
			}
			$rel = ltrim(str_replace('\\', '/', substr($info->getPathname(), strlen($base))), '/');
			if ($info->isDir()) {
				$out[] = array('path' => $rel, 'type' => 'folder', 'modified' => $info->getMTime());
			} elseif (preg_match('/\.html$/i', $name) || 'project.json' === $name || 'glossary.json' === $name) {
				$out[] = array('path' => $rel, 'type' => 'file', 'size' => $info->getSize(), 'modified' => $info->getMTime());
			}
		}
		usort($out, function ($a, $b) {
			return strnatcasecmp($a['path'], $b['path']);
		});
		return $out;
	}

	public function read($rel) {
		$file = $this->abs($rel);
		if (!is_file($file)) {
			return new WP_Error('sms_not_found', 'File not found.', array('status' => 404));
		}
		$raw = (string) file_get_contents($file);
		return array(
			'path'     => $rel,
			'content'  => $raw,
			'etag'     => md5($raw),
			'modified' => filemtime($file),
		);
	}

	private function usage() {
		$bytes = 0;
		$count = 0;
		foreach ($this->list_tree() as $item) {
			if ('file' === $item['type']) {
				$bytes += $item['size'];
				$count++;
			}
		}
		return array($bytes, $count);
	}

	/**
	 * Save JSON content. $etag (optional) guards against overwriting someone
	 * else's newer save. $mode: 'save' (create or update), 'create' (fail if exists).
	 */
	public function write($rel, $content, $etag = null, $mode = 'save') {
		if (!is_string($content)) {
			return new WP_Error('sms_bad_content', 'Document content must be HTML text.', array('status' => 400));
		}
		$json = self::is_data_file($rel) ? $content : self::strip_active_content($content);
		if (self::is_data_file($rel) && null === json_decode($json)) {
			return new WP_Error('sms_bad_content', 'Invalid data file.', array('status' => 400));
		}
		if (strlen($json) > self::MAX_FILE_BYTES) {
			return new WP_Error('sms_too_big', 'This document is too large (max 12 MB).', array('status' => 413));
		}
		$file   = $this->abs($rel);
		$exists = is_file($file);
		if ($exists && 'create' === $mode) {
			return new WP_Error('sms_exists', 'A file with this name already exists.', array('status' => 409));
		}
		if ($exists && $etag) {
			$current = md5_file($file);
			if ($current !== $etag) {
				return new WP_Error('sms_conflict', 'This document was changed somewhere else.', array('status' => 409, 'etag' => $current));
			}
		}
		list($bytes, $count) = $this->usage();
		if (!$exists && $count >= self::MAX_FILES) {
			return new WP_Error('sms_quota', 'File limit reached.', array('status' => 507));
		}
		if ($bytes + strlen($json) - ($exists ? filesize($file) : 0) > self::MAX_TOTAL_BYTES) {
			return new WP_Error('sms_quota', 'Storage is full. Delete old projects.', array('status' => 507));
		}
		$dir = dirname($file);
		if (!is_dir($dir)) {
			return new WP_Error('sms_no_folder', 'Folder not found.', array('status' => 404));
		}
		$old = $exists ? (string) file_get_contents($file) : null;
		$tmp = $file . '.tmp-' . wp_generate_password(8, false);
		if (false === file_put_contents($tmp, $json, LOCK_EX) || !@rename($tmp, $file)) {
			@unlink($tmp);
			return new WP_Error('sms_write_failed', 'The server could not save this file.', array('status' => 500));
		}
		clearstatcache(true, $file);
		SMS_History::record($rel, $old, $json);
		return array('path' => $rel, 'etag' => md5($json), 'modified' => filemtime($file), 'size' => strlen($json));
	}

	/** Project names are unique regardless of letter case ("BIMOX" and "bimox" are the same project). */
	public function top_level_taken($name, $except = '') {
		if (false !== strpos($name, '/')) {
			return false;
		}
		foreach ((array) @scandir($this->files_dir()) as $entry) {
			if ('.' === $entry || '..' === $entry || !is_dir($this->abs($entry))) {
				continue;
			}
			if (0 === strcasecmp($entry, $name) && $entry !== $except) {
				return true;
			}
		}
		return false;
	}

	public function mkdir_rel($rel) {
		$dir = $this->abs($rel);
		if (file_exists($dir) || $this->top_level_taken($rel)) {
			return new WP_Error('sms_exists', 'A folder or file with this name already exists.', array('status' => 409));
		}
		if (!is_dir(dirname($dir))) {
			return new WP_Error('sms_no_folder', 'Parent folder not found.', array('status' => 404));
		}
		if (!wp_mkdir_p($dir)) {
			return new WP_Error('sms_write_failed', 'Could not create the folder.', array('status' => 500));
		}
		return array('path' => $rel, 'type' => 'folder');
	}

	public function move($from, $to) {
		$a = $this->abs($from);
		$b = $this->abs($to);
		if (!file_exists($a)) {
			return new WP_Error('sms_not_found', 'File not found.', array('status' => 404));
		}
		if ((file_exists($b) && 0 !== strcasecmp($from, $to)) || (is_dir($a) && $this->top_level_taken($to, $from))) {
			return new WP_Error('sms_exists', 'A file or folder with this name already exists.', array('status' => 409));
		}
		if (is_dir($a) && 0 === strpos($to . '/', $from . '/')) {
			return new WP_Error('sms_bad_path', 'A folder cannot be moved inside itself.', array('status' => 400));
		}
		if (!is_dir(dirname($b))) {
			return new WP_Error('sms_no_folder', 'Destination folder not found.', array('status' => 404));
		}
		$moved_versions = array();
		if (is_file($a)) {
			$moved_versions[] = array($from, $to);
		} else {
			foreach ($this->list_tree() as $item) {
				if ('file' === $item['type'] && 0 === strpos($item['path'], $from . '/')) {
					$moved_versions[] = array($item['path'], $to . substr($item['path'], strlen($from)));
				}
			}
		}
		$moved_content = is_file($a) ? (string) file_get_contents($a) : null;
		if (!@rename($a, $b)) {
			return new WP_Error('sms_write_failed', 'Could not rename.', array('status' => 500));
		}
		if (null !== $moved_content) {
			SMS_History::renamed($from, $to, $moved_content);
		} elseif (false === strpos($from, '/') && false === strpos($to, '/')) {
			SMS_History::project_renamed($from, $to);
		}
		foreach ($moved_versions as $pair) {
			$va = $this->version_dir_for($pair[0]);
			$vb = $this->version_dir_for($pair[1]);
			if (is_dir($va) && !file_exists($vb)) {
				@rename($va, $vb);
			}
		}
		return array('from' => $from, 'to' => $to);
	}

	/** Deleting moves the item into trash/ so it can be recovered for 30 days. */
	public function trash($rel) {
		$src = $this->abs($rel);
		if ('' === $rel || !file_exists($src)) {
			return new WP_Error('sms_not_found', 'File not found.', array('status' => 404));
		}
		$this->purge_trash();
		$was  = is_file($src) ? (string) file_get_contents($src) : null;
		$dest = $this->trash_dir() . '/' . gmdate('Ymd-His') . '__' . str_replace('/', '__', $rel);
		if (!@rename($src, $dest)) {
			return new WP_Error('sms_write_failed', 'Could not delete.', array('status' => 500));
		}
		if (null !== $was) {
			SMS_History::record($rel, $was, null);
		} elseif (false === strpos($rel, '/')) {
			SMS_History::project_trashed($rel);
		}
		return array('path' => $rel, 'trashed' => true);
	}

	private function purge_trash() {
		$cutoff = time() - self::TRASH_DAYS * DAY_IN_SECONDS;
		foreach ((array) glob($this->trash_dir() . '/*') as $item) {
			if ('index.php' !== basename($item) && filemtime($item) < $cutoff) {
				$this->rrmdir($item);
			}
		}
	}

	private function rrmdir($path) {
		if (is_dir($path)) {
			foreach ((array) scandir($path) as $name) {
				if ('.' !== $name && '..' !== $name) {
					$this->rrmdir($path . '/' . $name);
				}
			}
			@rmdir($path);
		} else {
			@unlink($path);
		}
	}

	/* ---- Versions ---- */

	private function version_dir_for($rel) {
		return $this->versions_dir() . '/' . md5(strtolower($rel));
	}

	private function maybe_snapshot($rel, $file) {
		$dir      = $this->version_dir_for($rel);
		$existing = is_dir($dir) ? (array) glob($dir . '/*.html') : array();
		sort($existing);
		$last = end($existing);
		if ($last && time() - filemtime($last) < self::VERSION_EVERY) {
			return;
		}
		if (!is_dir($dir)) {
			wp_mkdir_p($dir);
		}
		@copy($file, $dir . '/' . gmdate('Ymd-His') . '.html');
		$existing = (array) glob($dir . '/*.html');
		sort($existing);
		while (count($existing) > self::VERSIONS_KEPT) {
			@unlink(array_shift($existing));
		}
	}

	public function versions($rel) {
		$dir = $this->version_dir_for($rel);
		$out = array();
		foreach (is_dir($dir) ? (array) glob($dir . '/*.html') : array() as $file) {
			$out[] = array('id' => basename($file, '.html'), 'modified' => filemtime($file), 'size' => filesize($file));
		}
		usort($out, function ($a, $b) {
			return strcmp($b['id'], $a['id']);
		});
		return $out;
	}

	public function read_version($rel, $id) {
		if (!preg_match('/^\d{8}-\d{6}$/', (string) $id)) {
			return new WP_Error('sms_bad_version', 'Invalid version.', array('status' => 400));
		}
		$file = $this->version_dir_for($rel) . '/' . $id . '.html';
		if (!is_file($file)) {
			return new WP_Error('sms_not_found', 'Version not found.', array('status' => 404));
		}
		return array('path' => $rel, 'id' => $id, 'content' => (string) file_get_contents($file), 'modified' => filemtime($file));
	}
}
