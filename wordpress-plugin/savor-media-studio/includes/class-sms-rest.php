<?php
/**
 * REST API: /wp-json/savor-media-studio/v1/...
 *
 * Public by design (the studio has no login), so every route is rate limited,
 * writes are same-site only, and storage accepts nothing but validated JSON
 * project files inside the protected studio folder.
 */

if (!defined('ABSPATH')) {
	exit;
}

class SMS_Rest {
	const NS = 'savor-media-studio/v1';

	public static function init() {
		add_action('rest_api_init', array(__CLASS__, 'routes'));
	}

	public static function routes() {
		$read  = function () {
			return SMS_Limits::hit('read');
		};
		$write = function (WP_REST_Request $request) {
			$site = SMS_Limits::same_site($request);
			if (is_wp_error($site)) {
				return $site;
			}
			return SMS_Limits::hit('write');
		};

		register_rest_route(self::NS, '/files', array(
			'methods'             => 'GET',
			'callback'            => array(__CLASS__, 'list_files'),
			'permission_callback' => $read,
		));
		register_rest_route(self::NS, '/file', array(
			array(
				'methods'             => 'GET',
				'callback'            => array(__CLASS__, 'get_file'),
				'permission_callback' => $read,
			),
			array(
				'methods'             => 'PUT',
				'callback'            => array(__CLASS__, 'put_file'),
				'permission_callback' => $write,
			),
			array(
				'methods'             => 'DELETE',
				'callback'            => array(__CLASS__, 'delete_item'),
				'permission_callback' => $write,
			),
		));
		register_rest_route(self::NS, '/folder', array(
			'methods'             => 'POST',
			'callback'            => array(__CLASS__, 'create_folder'),
			'permission_callback' => $write,
		));
		register_rest_route(self::NS, '/move', array(
			'methods'             => 'POST',
			'callback'            => array(__CLASS__, 'move'),
			'permission_callback' => $write,
		));
		register_rest_route(self::NS, '/versions', array(
			'methods'             => 'GET',
			'callback'            => array(__CLASS__, 'versions'),
			'permission_callback' => $read,
		));
		register_rest_route(self::NS, '/version', array(
			'methods'             => 'GET',
			'callback'            => array(__CLASS__, 'version'),
			'permission_callback' => $read,
		));
		foreach (array('' => 'history_list', '/version' => 'history_version', '/preview' => 'history_preview') as $r => $cb) {
			register_rest_route(self::NS, '/history' . $r, array(
				'methods'             => 'GET',
				'callback'            => array(__CLASS__, $cb),
				'permission_callback' => $read,
			));
		}
		foreach (array('commit', 'info', 'restore', 'step', 'undo') as $r) {
			register_rest_route(self::NS, '/history/' . $r, array(
				'methods'             => 'POST',
				'callback'            => array(__CLASS__, 'history_' . $r),
				'permission_callback' => $write,
			));
		}
		register_rest_route(self::NS, '/translate', array(
			'methods'             => 'POST',
			'callback'            => array(__CLASS__, 'translate'),
			'permission_callback' => array('SMS_Limits', 'same_site'),
		));
	}

	private static function storage() {
		$s = SMS_Storage::instance();
		$s->ensure_dirs();
		return $s;
	}

	private static function respond($result, $status = 200) {
		if (is_wp_error($result)) {
			return $result;
		}
		$response = new WP_REST_Response($result, $status);
		$response->header('Cache-Control', 'no-store');
		$response->header('X-Robots-Tag', 'noindex, nofollow');
		return $response;
	}

	public static function list_files() {
		return self::respond(array('items' => self::storage()->list_tree()));
	}

	public static function get_file(WP_REST_Request $request) {
		$path = SMS_Storage::clean_path($request->get_param('path'));
		if (is_wp_error($path)) {
			return $path;
		}
		return self::respond(self::storage()->read($path));
	}

	public static function put_file(WP_REST_Request $request) {
		$body = $request->get_json_params();
		$path = SMS_Storage::clean_path($body['path'] ?? null);
		if (is_wp_error($path)) {
			return $path;
		}
		if (!isset($body['content']) || !is_string($body['content'])) {
			return new WP_Error('sms_bad_content', 'Invalid document content.', array('status' => 400));
		}
		$mode = (isset($body['mode']) && 'create' === $body['mode']) ? 'create' : 'save';
		$etag = isset($body['etag']) && is_string($body['etag']) && preg_match('/^[a-f0-9]{32}$/', $body['etag']) ? $body['etag'] : null;
		return self::respond(self::storage()->write($path, $body['content'], $etag, $mode));
	}

	public static function delete_item(WP_REST_Request $request) {
		$raw  = (string) $request->get_param('path');
		$kind = preg_match('/\.(html|json)$/i', $raw) ? 'file' : 'folder';
		$path = SMS_Storage::clean_path($raw, $kind);
		if (is_wp_error($path)) {
			return $path;
		}
		if ('' === $path) {
			return new WP_Error('sms_bad_path', 'The root folder cannot be deleted.', array('status' => 400));
		}
		return self::respond(self::storage()->trash($path));
	}

	public static function create_folder(WP_REST_Request $request) {
		$body = $request->get_json_params();
		$path = SMS_Storage::clean_path($body['path'] ?? null, 'folder');
		if (is_wp_error($path)) {
			return $path;
		}
		if ('' === $path) {
			return new WP_Error('sms_bad_path', 'Enter a folder name.', array('status' => 400));
		}
		return self::respond(self::storage()->mkdir_rel($path), 201);
	}

	public static function move(WP_REST_Request $request) {
		$body = $request->get_json_params();
		$from = (string) ($body['from'] ?? '');
		$kind = preg_match('/\.html$/i', $from) ? 'file' : 'folder';
		$a    = SMS_Storage::clean_path($from, $kind);
		$b    = SMS_Storage::clean_path($body['to'] ?? null, $kind);
		if (is_wp_error($a)) {
			return $a;
		}
		if (is_wp_error($b)) {
			return $b;
		}
		if ('' === $a || '' === $b) {
			return new WP_Error('sms_bad_path', 'Enter a name.', array('status' => 400));
		}
		return self::respond(self::storage()->move($a, $b));
	}

	public static function versions(WP_REST_Request $request) {
		$path = SMS_Storage::clean_path($request->get_param('path'));
		if (is_wp_error($path)) {
			return $path;
		}
		return self::respond(array('path' => $path, 'versions' => self::storage()->versions($path)));
	}

	public static function version(WP_REST_Request $request) {
		$path = SMS_Storage::clean_path($request->get_param('path'));
		if (is_wp_error($path)) {
			return $path;
		}
		return self::respond(self::storage()->read_version($path, $request->get_param('id')));
	}

	/* ---- Version history (one log per project) ---- */

	private static function hp($value) {
		self::storage();
		return SMS_Project::require_project($value);
	}

	public static function history_list(WP_REST_Request $request) {
		$p = self::hp($request->get_param('project'));
		return is_wp_error($p) ? $p : self::respond(SMS_History::listing($p, (int) ($request->get_param('limit') ?: 100), (int) $request->get_param('before')));
	}

	public static function history_version(WP_REST_Request $request) {
		$p = self::hp($request->get_param('project'));
		return is_wp_error($p) ? $p : self::respond(SMS_History::version_detail($p, (int) $request->get_param('n')));
	}

	public static function history_preview(WP_REST_Request $request) {
		$p = self::hp($request->get_param('project'));
		if (is_wp_error($p)) {
			return $p;
		}
		$f = SMS_Project::doc_path($p, $request->get_param('file'));
		return is_wp_error($f) ? $f : self::respond(SMS_History::preview($p, (int) $request->get_param('n'), basename($f)));
	}

	private static function str($body, $key) {
		return isset($body[$key]) && is_string($body[$key]) ? $body[$key] : null;
	}

	public static function history_commit(WP_REST_Request $request) {
		$b = $request->get_json_params();
		$p = self::hp($b['project'] ?? null);
		return is_wp_error($p) ? $p : self::respond(SMS_History::commit($p, self::str($b, 'tag'), self::str($b, 'description')));
	}

	public static function history_info(WP_REST_Request $request) {
		$b = $request->get_json_params();
		$p = self::hp($b['project'] ?? null);
		return is_wp_error($p) ? $p : self::respond(SMS_History::set_info($p, (int) ($b['n'] ?? 0), self::str($b, 'tag'), self::str($b, 'description')));
	}

	public static function history_restore(WP_REST_Request $request) {
		$b = $request->get_json_params();
		$p = self::hp($b['project'] ?? null);
		if (is_wp_error($p)) {
			return $p;
		}
		$files = array_values(array_filter((array) ($b['files'] ?? array()), function ($f) { return is_string($f) && preg_match('/^[^\/]+\.html$/i', $f); }));
		return self::respond(SMS_History::restore($p, (int) ($b['n'] ?? 0), $files));
	}

	public static function history_step(WP_REST_Request $request) {
		$b = $request->get_json_params();
		$p = self::hp($b['project'] ?? null);
		return is_wp_error($p) ? $p : self::respond(SMS_History::step($p, 'forward' === ($b['direction'] ?? '') ? 'forward' : 'back'));
	}

	public static function history_undo(WP_REST_Request $request) {
		$b = $request->get_json_params();
		$p = self::hp($b['project'] ?? null);
		return is_wp_error($p) ? $p : self::respond(SMS_History::undo($p, (int) ($b['n'] ?? 0), (string) ($b['change'] ?? '')));
	}

	public static function translate(WP_REST_Request $request) {
		if (SMS_Translate::passcode_required()) {
			$given = (string) $request->get_header('x-studio-passcode');
			if (!hash_equals((string) sms_settings()['gemini_passcode'], $given)) {
				return new WP_Error('sms_passcode', 'Incorrect Gemini passcode.', array('status' => 401, 'passcode' => true));
			}
		}
		$body   = $request->get_json_params();
		$mode   = (isset($body['mode']) && 'html' === $body['mode']) ? 'html' : 'fields';
		$fields = SMS_Translate::validate_fields($body['fields'] ?? null, $mode);
		if (is_wp_error($fields)) {
			return $fields;
		}
		$provider = isset($body['provider']) && is_string($body['provider']) && isset(SMS_Translate::PROVIDERS[$body['provider']]) ? $body['provider'] : '';
		return self::respond(SMS_Translate::translate($fields, $mode, $provider));
	}
}
