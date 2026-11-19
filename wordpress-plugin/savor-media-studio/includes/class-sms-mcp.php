<?php
/**
 * MCP connector: lets Claude, ChatGPT or any MCP client work in the studio
 * with the same powers as a person using it — projects, documents, layout,
 * shared values, guests, translation and export.
 *
 * Transport: MCP "Streamable HTTP" (JSON-RPC 2.0 over POST, JSON responses).
 * Address:   /wp-json/savor-media-studio/v1/mcp/<secret>  (or /mcp with "Authorization: Bearer <secret>")
 * Enable it and copy the address in WordPress → Settings → Media Studio.
 */

if (!defined('ABSPATH')) {
	exit;
}

class SMS_Mcp {
	const PROTOCOLS = array('2025-06-18', '2025-03-26', '2024-11-05');

	public static function init() {
		add_action('rest_api_init', array(__CLASS__, 'routes'));
	}

	public static function enabled() {
		$s = sms_settings();
		return !empty($s['mcp_enabled']) && strlen((string) $s['mcp_token']) >= 20;
	}

	public static function url() {
		return rest_url(SMS_Rest::NS . '/mcp/' . sms_settings()['mcp_token']);
	}

	public static function new_token() {
		return wp_generate_password(40, false, false);
	}

	public static function routes() {
		$any = array('GET', 'POST', 'DELETE', 'OPTIONS');
		register_rest_route(SMS_Rest::NS, '/mcp/(?P<token>[A-Za-z0-9]{20,64})', array(
			'methods'             => $any,
			'callback'            => array(__CLASS__, 'handle'),
			'permission_callback' => '__return_true', // checked in handle()
		));
		register_rest_route(SMS_Rest::NS, '/mcp', array(
			'methods'             => $any,
			'callback'            => array(__CLASS__, 'handle'),
			'permission_callback' => '__return_true',
		));
		register_rest_route(SMS_Rest::NS, '/export', array(
			'methods'             => 'GET',
			'callback'            => array(__CLASS__, 'export'),
			'permission_callback' => function () { return SMS_Limits::hit('read'); },
		));
	}

	/* ---------- Transport ---------- */

	private static function send($status, $payload = null) {
		status_header($status);
		header('Cache-Control: no-store');
		if (null !== $payload) {
			header('Content-Type: application/json; charset=utf-8');
			echo wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
		}
		exit;
	}

	private static function authorized(WP_REST_Request $request) {
		$token = (string) sms_settings()['mcp_token'];
		if (!self::enabled()) {
			return false;
		}
		$given = (string) $request->get_param('token');
		if ('' === $given) {
			$auth = (string) $request->get_header('authorization');
			if (preg_match('/^Bearer\s+(\S+)$/i', $auth, $m)) {
				$given = $m[1];
			}
		}
		return '' !== $given && hash_equals($token, $given);
	}

	public static function handle(WP_REST_Request $request) {
		if (!self::authorized($request)) {
			self::send(401, array('jsonrpc' => '2.0', 'id' => null, 'error' => array('code' => -32001, 'message' => 'The Media Studio connector is off or this address is wrong. Turn it on and copy the address in WordPress → Settings → Media Studio.')));
		}
		$method = $request->get_method();
		if ('POST' !== $method) {
			header('Allow: POST');
			self::send(405, array('jsonrpc' => '2.0', 'id' => null, 'error' => array('code' => -32000, 'message' => 'Use POST (this server answers with JSON, no event stream).')));
		}
		$msg = json_decode($request->get_body(), true);
		if (null === $msg) {
			self::send(400, array('jsonrpc' => '2.0', 'id' => null, 'error' => array('code' => -32700, 'message' => 'Parse error')));
		}
		if (function_exists('set_time_limit')) {
			@set_time_limit(300); // phpcs:ignore WordPress.PHP.NoSilencedErrors
		}
		$batch = is_array($msg) && array_keys($msg) === range(0, count($msg) - 1);
		$out   = array();
		foreach ($batch ? $msg : array($msg) as $m) {
			$r = self::rpc($m);
			if (null !== $r) {
				$out[] = $r;
			}
		}
		if (!$out) {
			self::send(202);
		}
		self::send(200, $batch ? $out : $out[0]);
	}

	private static function rpc($m) {
		if (!is_array($m) || ($m['jsonrpc'] ?? '') !== '2.0' || !isset($m['method'])) {
			return array('jsonrpc' => '2.0', 'id' => $m['id'] ?? null, 'error' => array('code' => -32600, 'message' => 'Invalid request'));
		}
		$has_id = array_key_exists('id', $m);
		$id     = $m['id'] ?? null;
		$params = is_array($m['params'] ?? null) ? $m['params'] : array();
		$ok     = function ($result) use ($id) { return array('jsonrpc' => '2.0', 'id' => $id, 'result' => $result); };
		switch ($m['method']) {
			case 'initialize':
				$want = (string) ($params['protocolVersion'] ?? '');
				return $ok(array(
					'protocolVersion' => in_array($want, self::PROTOCOLS, true) ? $want : self::PROTOCOLS[0],
					'capabilities'    => array('tools' => array('listChanged' => false)),
					'serverInfo'      => array('name' => 'savor-media-studio', 'title' => 'SAVOR Media Studio', 'version' => SMS_VERSION),
					'instructions'    => self::guide(true),
				));
			case 'ping':
				return $ok(new stdClass());
			case 'tools/list':
				return $ok(array('tools' => self::tools()));
			case 'tools/call':
				return $ok(self::call((string) ($params['name'] ?? ''), is_array($params['arguments'] ?? null) ? $params['arguments'] : array()));
			case 'resources/list':
				return $ok(array('resources' => array()));
			case 'resources/templates/list':
				return $ok(array('resourceTemplates' => array()));
			case 'prompts/list':
				return $ok(array('prompts' => array()));
		}
		if (!$has_id || 0 === strpos($m['method'], 'notifications/')) {
			return null; // notifications get no answer
		}
		return array('jsonrpc' => '2.0', 'id' => $id, 'error' => array('code' => -32601, 'message' => 'Method not found: ' . $m['method']));
	}

	/* ---------- Tools ---------- */

	private static function t($name, $title, $desc, $props = array(), $required = array(), $hints = array()) {
		$schema = array('type' => 'object', 'properties' => $props ? $props : new stdClass());
		if ($required) {
			$schema['required'] = $required;
		}
		return array('name' => $name, 'title' => $title, 'description' => $desc, 'inputSchema' => $schema, 'annotations' => array_merge(array('title' => $title), $hints));
	}

	private static function tools() {
		$project = array('type' => 'string', 'description' => 'Project name (a folder), exactly as list_projects shows it.');
		$file    = array('type' => 'string', 'description' => 'Document file name inside the project, e.g. "Invitation (English).html".');
		$bi      = array('description' => 'A value in both languages: {"en": "...", "bn": "..."}. A plain string sets English only. noTranslate:true = "Don\'t translate": Bangla is kept as typed and never translated automatically.', 'oneOf' => array(array('type' => 'string'), array('type' => 'object', 'properties' => array('en' => array('type' => 'string'), 'bn' => array('type' => 'string'), 'noTranslate' => array('type' => 'boolean')))));
		$guest   = array(
			'type'        => 'object',
			'description' => 'A guest: [prefixes…] name [postfixes…], designation. Each part is {"en","bn"} or an English string.',
			'properties'  => array(
				'id'          => array('type' => 'string', 'description' => 'Keep the id when changing an existing guest.'),
				'prefixes'    => array('type' => 'array', 'items' => $bi, 'description' => 'Before the name, e.g. "Mr.", "Brig Gen", "Dr." (Bangla: "জনাব", "ব্রিগেডিয়ার জেনারেল").'),
				'name'        => $bi,
				'postfixes'   => array('type' => 'array', 'items' => $bi, 'description' => 'After the name, e.g. "(Retd)", "ndc", "psc", "PhD".'),
				'designation' => $bi,
			),
		);
		$ro   = array('readOnlyHint' => true, 'destructiveHint' => false, 'openWorldHint' => false);
		$rw   = array('readOnlyHint' => false, 'destructiveHint' => false, 'openWorldHint' => false);
		$del  = array('readOnlyHint' => false, 'destructiveHint' => true, 'openWorldHint' => false);
		$keys = array_keys(SMS_Values::FIELDS);
		return array(
			self::t('studio_guide', 'How the studio works', 'Read first. Explains projects, documents, shared values (linked fields), formats, layout conventions and the best way to make changes.', array(), array(), $ro),
			self::t('list_projects', 'List projects', 'All projects with their documents and studio links.', array(), array(), $ro),
			self::t('get_project', 'Get project', 'One project: every document with its settings, which shared values each one uses, and the current shared values in English and Bangla.', array('project' => $project), array('project'), $ro),
			self::t('create_project', 'Create project', 'Create a project. template "standard" = Bangla & English invitation and press release with linked fields ready to fill; "blank" = four empty pages; "empty" = no documents (add your own with create_document).', array('name' => array('type' => 'string'), 'template' => array('type' => 'string', 'enum' => array('standard', 'blank', 'empty'))), array('name'), $rw),
			self::t('rename_project', 'Rename project', 'Rename a project folder.', array('project' => $project, 'new_name' => array('type' => 'string')), array('project', 'new_name'), $rw),
			self::t('duplicate_project', 'Duplicate project', 'Copy a project (all documents and shared values) into a new project. Project names are unique (letter case ignored); an existing name is refused.', array('project' => $project, 'new_name' => array('type' => 'string')), array('project', 'new_name'), $rw),
			self::t('delete_project', 'Delete project', 'Move a whole project to the trash (recoverable by the site admin for 30 days).', array('project' => $project), array('project'), $del),
			self::t('read_document', 'Read document', 'A document\'s settings and full body HTML, plus every linked value in reading order. format "text" adds the plain text.', array('project' => $project, 'file' => $file, 'format' => array('type' => 'string', 'enum' => array('html', 'text', 'both'))), array('project', 'file'), $ro),
			self::t('write_document', 'Replace document body', 'Replace a document\'s whole body HTML (settings are kept). Linked slots are re-filled from the shared values on save. Prefer edit_document for small changes.', array('project' => $project, 'file' => $file, 'html' => array('type' => 'string', 'description' => 'Body HTML (no <html>/<head>).')), array('project', 'file', 'html'), $rw),
			self::t('edit_document', 'Edit document', 'Targeted find-and-replace edits on a document\'s body HTML, applied in order. Each "find" must match (exact text, or a PCRE pattern with regex:true) or nothing is saved. Use it to change wording, styles, attributes, move blocks, add or remove HTML.', array(
				'project' => $project, 'file' => $file,
				'edits'   => array('type' => 'array', 'items' => array('type' => 'object', 'properties' => array(
					'find'    => array('type' => 'string'),
					'replace' => array('type' => 'string'),
					'all'     => array('type' => 'boolean', 'description' => 'Replace every match (default: the first only).'),
					'regex'   => array('type' => 'boolean', 'description' => 'Treat find as a PCRE pattern without delimiters; replace may use $1.'),
				), 'required' => array('find', 'replace'))),
			), array('project', 'file', 'edits'), $rw),
			self::t('create_document', 'Create / upload document', 'Add a document to a project from HTML, Markdown, plain text or a Word file (docx_base64). Give exactly one content field.', array(
				'project' => $project, 'file' => $file,
				'lang'    => array('type' => 'string', 'enum' => array('en', 'bn'), 'description' => 'Which language of the shared values this document shows.'),
				'title'   => array('type' => 'string'),
				'html'    => array('type' => 'string'), 'markdown' => array('type' => 'string'), 'text' => array('type' => 'string'),
				'docx_base64' => array('type' => 'string', 'description' => 'A .docx file, base64-encoded.'),
				'replace' => array('type' => 'boolean', 'description' => 'Overwrite a document with the same name.'),
			), array('project', 'file'), $rw),
			self::t('update_document_settings', 'Page settings', 'Title, language, page margins (inches, A4), default font and size. Leave "files" out to change every document in the project.', array(
				'project'   => $project,
				'files'     => array('type' => 'array', 'items' => array('type' => 'string')),
				'title'     => array('type' => 'string'),
				'lang'      => array('type' => 'string', 'enum' => array('en', 'bn')),
				'margins'   => array('type' => 'object', 'properties' => array('top' => array('type' => 'number'), 'right' => array('type' => 'number'), 'bottom' => array('type' => 'number'), 'left' => array('type' => 'number')), 'description' => 'Inches, 0–3. Any sides you leave out stay as they are.'),
				'font'      => array('type' => 'string', 'description' => 'One of: ' . implode(', ', array_keys(SMS_Doc::FONTS)) . ' — or a CSS font-family.'),
				'font_size' => array('type' => 'number', 'description' => 'Points, 6–72.'),
			), array('project'), $rw),
			self::t('rename_document', 'Rename document', 'Rename a document file.', array('project' => $project, 'file' => $file, 'new_name' => array('type' => 'string')), array('project', 'file', 'new_name'), $rw),
			self::t('delete_document', 'Delete document', 'Move a document to the trash.', array('project' => $project, 'file' => $file), array('project', 'file'), $del),
			self::t('list_versions', 'Version history', 'Earlier versions of a document (saved automatically every 5 minutes while it changes; last 30 kept).', array('project' => $project, 'file' => $file), array('project', 'file'), $ro),
			self::t('restore_version', 'Restore version', 'Bring back an earlier version of a document (the current one is kept in the history).', array('project' => $project, 'file' => $file, 'version' => array('type' => 'string', 'description' => 'Version id from list_versions, e.g. 20261117-101500.')), array('project', 'file', 'version'), $rw),
			self::t('get_shared_values', 'Get shared values', 'The project\'s shared values (raw, as stored) and how each one reads in English and Bangla, with the special guests in printed order.', array('project' => $project), array('project'), $ro),
			self::t('set_shared_values', 'Set shared values', 'Change shared values; every document updates at once. Only the keys you give change. Keys: ' . implode(', ', $keys) . '. Text values take {"en","bn"}; dates "YYYY-MM-DD"; eventTime "HH:MM" (24h); edition/year numbers; chiefGuest a guest or null; specialGuests the full ordered list (order = printed order). When English changes without Bangla, Bangla is translated with the site\'s AI (translate:"none" to skip).', array(
				'project'   => $project,
				'values'    => array('type' => 'object', 'properties' => array(
					'edition' => array('type' => array('integer', 'null')), 'year' => array('type' => array('integer', 'null')),
					'eventDate' => array('type' => array('string', 'null')), 'endDate' => array('type' => array('string', 'null')), 'issueDate' => array('type' => array('string', 'null')),
					'eventTime' => array('type' => array('string', 'null')), 'contactPhone' => array('type' => 'string'),
					'exhibitionName' => $bi, 'shortName' => $bi, 'visitingHours' => $bi, 'contactName' => $bi, 'contactTitle' => $bi,
					'chiefGuest' => array('oneOf' => array($guest, array('type' => 'null'))),
					'specialGuests' => array('type' => 'array', 'items' => $guest),
				)),
				'translate' => array('type' => 'string', 'enum' => array('auto', 'none')),
			), array('project', 'values'), $rw),
			self::t('edit_special_guest', 'Edit a special guest', 'Add, change, remove or reorder one special guest (numbers are 1-based and are the printed order). Bangla is translated when you give only English.', array(
				'project'  => $project,
				'action'   => array('type' => 'string', 'enum' => array('add', 'update', 'remove', 'move')),
				'index'    => array('type' => 'integer', 'description' => 'Guest number (update/remove/move). For add: insert at this number (default: end).'),
				'to'       => array('type' => 'integer', 'description' => 'New number (move).'),
				'guest'    => $guest,
				'translate' => array('type' => 'string', 'enum' => array('auto', 'none')),
			), array('project', 'action'), $rw),
			self::t('link_text', 'Link text to a shared value', 'Turn text in a document into a linked slot for a shared value, so it follows the value everywhere. If the value is still empty, it is set from this text (text values only).', array(
				'project'    => $project, 'file' => $file,
				'text'       => array('type' => 'string', 'description' => 'Exact text as it appears (inside one paragraph, not across bold/italic boundaries).'),
				'field'      => array('type' => 'string', 'enum' => $keys),
				'occurrence' => array('type' => 'string', 'description' => '"1" (default), "2"… or "all".'),
				'format'     => array('type' => 'string', 'description' => 'Dates: "D MMMM, YYYY", "MMMM D, YYYY", "D MMMM YYYY", "DD MMM YYYY", add "dddd" for weekday. Time: "h:mm A", "h.mm A" (English); "P h.mm ঘটিকায়", "P hটায়" (Bangla). Edition: "ordinal".'),
				'separator'  => array('type' => 'string', 'enum' => array('comma', 'period', 'and', 'lines'), 'description' => 'specialGuests only.'),
				'bold_names' => array('type' => 'boolean', 'description' => 'Guests only: names in bold.'),
			), array('project', 'file', 'text', 'field'), $rw),
			self::t('unlink_field', 'Unlink a shared value', 'Make linked slots plain text again (the text stays as it is).', array('project' => $project, 'file' => $file, 'field' => array('type' => 'string', 'enum' => $keys), 'occurrence' => array('type' => 'string', 'description' => '"all" (default) or a number.')), array('project', 'file', 'field'), $rw),
			self::t('translate_text', 'Translate to Bangla', 'Translate English texts to formal Bangla with the AI configured on the site (Gemini, Claude, ChatGPT or OpenRouter).', array('texts' => array('type' => 'array', 'items' => array('type' => 'string')), 'provider' => array('type' => 'string', 'enum' => array_keys(SMS_Translate::PROVIDERS))), array('texts'), $ro),
			self::t('translate_shared_values', 'Translate shared values', 'Fill the Bangla side of shared values from the English with the site\'s AI. keys: which values ("all" or e.g. ["contactName","specialGuests"]).', array('project' => $project, 'keys' => array('type' => 'array', 'items' => array('type' => 'string')), 'provider' => array('type' => 'string', 'enum' => array_keys(SMS_Translate::PROVIDERS))), array('project'), $rw),
			self::t('export_document', 'Export / print', 'Links to download a document as PDF or Word (.docx), print it, or get the standalone HTML. PDF/Word/print are made by the studio with exactly the print-preview layout. Links work for anyone with them.', array('project' => $project, 'file' => $file, 'format' => array('type' => 'string', 'enum' => array('html', 'word', 'print', 'pdf'))), array('project', 'file'), $ro),
			self::t('open_in_studio', 'Studio link', 'A link that opens the project (or one document) in the visual studio. Open pages update live when you change things here.', array('project' => $project, 'file' => $file), array('project'), $ro),
		);
	}

	private static function call($name, $a) {
		$fn = 'tool_' . $name;
		if (!preg_match('/^[a-z_]+$/', $name) || !method_exists(__CLASS__, $fn)) {
			return array('isError' => true, 'content' => array(array('type' => 'text', 'text' => 'Unknown tool "' . $name . '".')));
		}
		try {
			$r = self::$fn($a);
		} catch (Throwable $e) {
			$r = new WP_Error('sms_error', 'Something went wrong: ' . $e->getMessage());
		}
		if (is_wp_error($r)) {
			return array('isError' => true, 'content' => array(array('type' => 'text', 'text' => $r->get_error_message())));
		}
		$text = is_string($r) ? $r : wp_json_encode($r, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
		// Some servers print floats with every digit (0.8000000000000000444…): show them as people write them.
		$text = preg_replace_callback('/(?<=[\s:\[,])-?\d+\.\d{7,}(?=[\s,\]}])/', function ($m) { return SMS_Doc::num(round((float) $m[0], 4)); }, $text);
		return array('content' => array(array('type' => 'text', 'text' => $text)));
	}

	private static function arg($a, $k, $default = null) {
		return array_key_exists($k, $a) ? $a[$k] : $default;
	}

	/* ---------- Guide ---------- */

	public static function guide($short = false) {
		$fields = array();
		foreach (SMS_Values::FIELDS as $k => $d) {
			$fields[] = $k . ' (' . $d[0] . ', ' . $d[2] . ')';
		}
		$text = "SAVOR Media Studio — Bangla & English media invitations and press releases.\n\n"
			. "MODEL\n"
			. "• A project is a folder of documents. Usually four: Invitation (Bangla/English) and Press Release (Bangla/English). Each document is A4, has a language (en/bn), page margins in inches, a default font and size, and a body of HTML.\n"
			. "• Shared values (project.json) are typed once and appear in every document: " . implode(', ', $fields) . ".\n"
			. "• In a document, a shared value is a slot: <span data-field=\"KEY\">…</span>. Optional attributes: data-fmt (date/time/edition format), data-sep (guest list separator: comma|period|and|lines), data-bold=\"1\" (guest names bold), data-override=\"1\" (this place keeps its own text and does not follow the value).\n"
			. "• The special-guest list slot contains <span data-guest=\"N\"> for guest N; N is the printed order. The chief guest is a separate value.\n"
			. "• Bangla documents show the bn side of each value, English documents the en side. Dates, numbers and times are converted to Bangla digits and words automatically.\n\n"
			. "HOW TO CHANGE THINGS\n"
			. "• A name, date, guest, contact etc.: set_shared_values or edit_special_guest. Never edit the text inside a data-field span to change a value — slots are re-filled from the shared values whenever a document is saved.\n"
			. "• Wording, layout, styles, adding/removing paragraphs: edit_document (small find-and-replace) or write_document (whole body). Use inline styles (text-align, font-family, font-size in pt, font-weight, color, margin). Keep slots intact.\n"
			. "• Page margins, font, size, title, language: update_document_settings (all documents at once if you leave files out).\n"
			. "• MC script: <span data-field=\"chiefGuest\" data-part=\"name|designation\"> shows one part of the chief guest; <span data-field=\"specialGuests\" data-pick=\"host\" data-part=\"name\"> is the host (welcome speech: the special guest picked as host in project.json hostGuestId, else the last one). <div data-field=\"specialGuests\" data-each=\"…wording with {name} {designation}…\" data-order=\"forward|reverse\" data-skip=\"host\"> repeats its wording once per special guest: change the wording in data-each, never the copies.\n"
			. "• Floating boxes (e.g. the program schedule) are <div class=\"sv-textbox\" style=\"…\">; move them up/down by moving the div between paragraphs or changing its margin-top. A manual page break is <hr class=\"sv-page-break\">.\n"
			. "• The canvas and print use the same A4 layout: a paragraph that doesn't fit at the bottom of a page moves whole to the next page.\n"
			. "• Bangla: give both en and bn when you know the correct Bangla; otherwise the site's AI translates (formal Bangladesh style).\n"
			. "• Check your work with read_document or get_project. Share results with export_document (Word, print/PDF, HTML) or open_in_studio.\n"
			. "• Every save keeps version history (list_versions / restore_version).";
		if ($short) {
			return $text;
		}
		return $text . "\n\nFORMATS\n• Dates (data-fmt): tokens D, DD, MMMM, MMM, YYYY, dddd — e.g. \"D MMMM, YYYY\" → 26 November, 2026 / ২৬ নভেম্বর, ২০২৬.\n• Time: English \"h:mm A\" → 10:00 AM, \"h.mm A\" → 10.00 AM; Bangla \"P h.mm ঘটিকায়\" → সকাল ১০.০০ ঘটিকায় (P = সকাল/দুপুর/বিকাল/সন্ধ্যা/রাত).\n• Edition: data-fmt=\"ordinal\" → 3rd / ৩য়.\n• Guest reads: prefixes name, postfixes, designation → \"Brig Gen M. Sakhawat Hossain, (Retd), Adviser, …\".\n\nFONTS: " . implode(', ', array_keys(SMS_Doc::FONTS)) . ".\nSTUDIO: " . SMS_Frontend::url();
	}

	private static function tool_studio_guide() {
		return self::guide(false);
	}

	/* ---------- Projects ---------- */

	private static function tool_list_projects() {
		return array('projects' => SMS_Project::projects());
	}

	private static function tool_get_project($a) {
		$p = SMS_Project::require_project(self::arg($a, 'project'));
		if (is_wp_error($p)) {
			return $p;
		}
		$values = SMS_Project::values($p);
		$docs   = array();
		foreach (SMS_Project::doc_files($p) as $f) {
			$d = SMS_Project::read_doc($p, $f);
			if (is_wp_error($d)) {
				continue;
			}
			$m      = $d['model'];
			$docs[] = array(
				'file' => $f, 'title' => $m['title'], 'lang' => $m['lang'], 'margins_in' => $m['margins'], 'font' => $m['font'], 'font_size_pt' => $m['fontSize'],
				'linked_values' => SMS_Values::usage($m['body']), 'words' => count(preg_split('/\s+/u', SMS_Doc::text($m['body']), -1, PREG_SPLIT_NO_EMPTY)),
				'modified' => gmdate('c', $d['modified']), 'studio_url' => SMS_Project::studio_url($p, $f),
			);
		}
		return array('project' => $p, 'studio_url' => SMS_Project::studio_url($p), 'documents' => $docs, 'shared_values' => self::readable_values($values));
	}

	private static function tool_create_project($a) {
		$template = self::arg($a, 'template', 'standard');
		if (!in_array($template, array('standard', 'blank', 'empty'), true)) {
			return new WP_Error('sms_bad', 'template must be standard, blank or empty.');
		}
		return SMS_Project::create(self::arg($a, 'name'), $template);
	}

	private static function tool_rename_project($a) {
		$p = SMS_Project::require_project(self::arg($a, 'project'));
		$n = SMS_Project::clean_project(self::arg($a, 'new_name'));
		if (is_wp_error($p)) {
			return $p;
		}
		if (is_wp_error($n)) {
			return $n;
		}
		$r = SMS_Project::store()->move($p, $n);
		return is_wp_error($r) ? $r : array('project' => $n, 'studio_url' => SMS_Project::studio_url($n));
	}

	private static function tool_duplicate_project($a) {
		return SMS_Project::duplicate(self::arg($a, 'project'), self::arg($a, 'new_name'));
	}

	private static function tool_delete_project($a) {
		$p = SMS_Project::require_project(self::arg($a, 'project'));
		if (is_wp_error($p)) {
			return $p;
		}
		$r = SMS_Project::store()->trash($p);
		return is_wp_error($r) ? $r : array('deleted' => $p, 'note' => 'Moved to the trash; the site admin can recover it for 30 days.');
	}

	/* ---------- Documents ---------- */

	private static function doc($a) {
		$p = SMS_Project::require_project(self::arg($a, 'project'));
		if (is_wp_error($p)) {
			return $p;
		}
		$d = SMS_Project::read_doc($p, (string) self::arg($a, 'file'));
		if (is_wp_error($d)) {
			return $d;
		}
		$d['project'] = $p;
		return $d;
	}

	/** Linked slots in reading order. */
	private static function slots($body) {
		list($dom, $root) = SMS_Doc::load_fragment($body);
		$xp  = new DOMXPath($dom);
		$out = array();
		foreach ($xp->query('.//*[@data-field]', $root) as $el) {
			$item = array('field' => $el->getAttribute('data-field'), 'text' => trim(preg_replace('/\s+/u', ' ', $el->textContent)));
			if ($el->getAttribute('data-fmt')) {
				$item['format'] = $el->getAttribute('data-fmt');
			}
			if ($el->hasAttribute('data-override')) {
				$item['own_text'] = true;
			}
			if ('specialGuests' === $item['field']) {
				$item['guests'] = array();
				foreach ($xp->query('.//*[@data-guest]', $el) as $g) {
					$item['guests'][] = $g->getAttribute('data-guest') . '. ' . trim(preg_replace('/\s+/u', ' ', $g->textContent));
				}
				unset($item['text']);
			}
			$out[] = $item;
		}
		return $out;
	}

	private static function tool_read_document($a) {
		$d = self::doc($a);
		if (is_wp_error($d)) {
			return $d;
		}
		$m      = $d['model'];
		$format = self::arg($a, 'format', 'html');
		$out    = array(
			'project' => $d['project'], 'file' => $d['file'], 'title' => $m['title'], 'lang' => $m['lang'],
			'margins_in' => $m['margins'], 'font' => $m['font'], 'font_size_pt' => $m['fontSize'],
			'linked_values_in_order' => self::slots($m['body']),
		);
		if ('text' === $format || 'both' === $format) {
			$out['text'] = SMS_Doc::text($m['body']);
		}
		if ('text' !== $format) {
			$out['body_html'] = $m['body'];
		}
		return $out;
	}

	private static function tool_write_document($a) {
		$d = self::doc($a);
		if (is_wp_error($d)) {
			return $d;
		}
		$d['model']['body'] = (string) self::arg($a, 'html', '');
		$r = SMS_Project::write_doc($d['project'], $d['file'], $d['model']);
		return is_wp_error($r) ? $r : array_merge($r, array('linked_values_in_order' => self::slots(SMS_Project::read_doc($d['project'], $d['file'])['model']['body'])));
	}

	private static function tool_edit_document($a) {
		$d = self::doc($a);
		if (is_wp_error($d)) {
			return $d;
		}
		$body  = $d['model']['body'];
		$edits = self::arg($a, 'edits', array());
		if (!is_array($edits) || !$edits) {
			return new WP_Error('sms_bad', 'Give at least one edit: {"find": "...", "replace": "..."}.');
		}
		$report = array();
		foreach (array_values($edits) as $i => $e) {
			$find    = (string) ($e['find'] ?? '');
			$replace = (string) ($e['replace'] ?? '');
			$all     = !empty($e['all']);
			if ('' === $find) {
				return new WP_Error('sms_bad', 'Edit ' . ($i + 1) . ' has an empty "find". Nothing was saved.');
			}
			if (!empty($e['regex'])) {
				$pattern = '~' . str_replace('~', '\~', $find) . '~u';
				if (false === @preg_match($pattern, '')) { // phpcs:ignore WordPress.PHP.NoSilencedErrors
					return new WP_Error('sms_bad', 'Edit ' . ($i + 1) . ': invalid regular expression. Nothing was saved.');
				}
				$new = preg_replace($pattern, $replace, $body, $all ? -1 : 1, $count);
			} else {
				$count = substr_count($body, $find);
				$new   = $all ? str_replace($find, $replace, $body) : (false !== ($pos = strpos($body, $find)) ? substr_replace($body, $replace, $pos, strlen($find)) : $body);
				$count = $all ? $count : min(1, $count);
			}
			if (!$count) {
				$hint = SMS_Doc::text($body);
				return new WP_Error('sms_not_found', 'Edit ' . ($i + 1) . ': "' . mb_substr($find, 0, 80) . '" was not found in the body HTML (it must match the HTML source exactly, including tags and entities). Nothing was saved. Use read_document to see the HTML.' . ('' === $hint ? '' : ''));
			}
			$body     = $new;
			$report[] = array('edit' => $i + 1, 'replaced' => $count);
		}
		$d['model']['body'] = $body;
		$r = SMS_Project::write_doc($d['project'], $d['file'], $d['model']);
		return is_wp_error($r) ? $r : array_merge($r, array('edits' => $report));
	}

	private static function tool_create_document($a) {
		$p = SMS_Project::require_project(self::arg($a, 'project'));
		if (is_wp_error($p)) {
			return $p;
		}
		$file = (string) self::arg($a, 'file', '');
		$path = SMS_Project::doc_path($p, $file);
		if (is_wp_error($path)) {
			return $path;
		}
		$margins = null;
		if (null !== self::arg($a, 'docx_base64')) {
			$bytes = base64_decode((string) self::arg($a, 'docx_base64'), true);
			if (false === $bytes) {
				return new WP_Error('sms_bad', 'docx_base64 is not valid base64.');
			}
			$r = SMS_Import::docx_to_html($bytes);
			if (is_wp_error($r)) {
				return $r;
			}
			$body    = $r['html'];
			$margins = $r['margins'];
		} elseif (null !== self::arg($a, 'html')) {
			$html = (string) self::arg($a, 'html');
			$body = preg_match('#<body[^>]*>(.*)</body>#is', $html, $bm) ? $bm[1] : $html;
		} elseif (null !== self::arg($a, 'markdown')) {
			$body = SMS_Import::markdown_to_html((string) self::arg($a, 'markdown'));
		} elseif (null !== self::arg($a, 'text')) {
			$body = SMS_Import::text_to_html((string) self::arg($a, 'text'));
		} else {
			$body = '<p><br></p>';
		}
		$lang  = self::arg($a, 'lang');
		$lang  = in_array($lang, array('en', 'bn'), true) ? $lang : SMS_Doc::guess_lang(SMS_Doc::text($body));
		$model = SMS_Doc::empty_doc((string) self::arg($a, 'title', preg_replace('/\.html$/i', '', basename($path))), $lang, $body);
		if ($margins) {
			$model['margins'] = SMS_Doc::normalize_margins($margins);
		}
		$r = SMS_Project::write_doc($p, basename($path), $model, self::arg($a, 'replace') ? 'save' : 'create');
		return is_wp_error($r) ? $r : array_merge($r, array('lang' => $lang, 'studio_url' => SMS_Project::studio_url($p, basename($path)), 'tip' => 'Use link_text to connect names, dates and guests in this document to the shared values.'));
	}

	private static function tool_update_document_settings($a) {
		$p = SMS_Project::require_project(self::arg($a, 'project'));
		if (is_wp_error($p)) {
			return $p;
		}
		$files = self::arg($a, 'files');
		$files = is_array($files) && $files ? $files : SMS_Project::doc_files($p);
		$font  = self::arg($a, 'font');
		if (null !== $font) {
			$font = SMS_Doc::FONTS[$font] ?? (string) $font;
			if (preg_match('/[;{}<>]|url\s*\(/i', $font)) {
				return new WP_Error('sms_bad', 'That font name is not allowed.');
			}
		}
		$size = self::arg($a, 'font_size');
		if (null !== $size && (!is_numeric($size) || $size < 6 || $size > 72)) {
			return new WP_Error('sms_bad', 'font_size must be 6–72 pt.');
		}
		$done = array();
		foreach ($files as $f) {
			$d = SMS_Project::read_doc($p, $f);
			if (is_wp_error($d)) {
				return $d;
			}
			$m = $d['model'];
			if (null !== self::arg($a, 'title')) {
				$m['title'] = (string) self::arg($a, 'title');
			}
			if (in_array(self::arg($a, 'lang'), array('en', 'bn'), true)) {
				$m['lang'] = self::arg($a, 'lang');
			}
			if (is_array(self::arg($a, 'margins'))) {
				$m['margins'] = SMS_Doc::normalize_margins(array_merge($m['margins'], array_intersect_key(self::arg($a, 'margins'), $m['margins'])));
			}
			if (null !== $font) {
				$m['font'] = $font;
			}
			if (null !== $size) {
				$m['fontSize'] = round((float) $size, 1);
			}
			$r = SMS_Project::write_doc($p, $d['file'], $m);
			if (is_wp_error($r)) {
				return $r;
			}
			$done[] = array('file' => $d['file'], 'title' => $m['title'], 'lang' => $m['lang'], 'margins_in' => $m['margins'], 'font' => $m['font'], 'font_size_pt' => $m['fontSize']);
		}
		return array('updated' => $done);
	}

	private static function tool_rename_document($a) {
		$d = self::doc($a);
		if (is_wp_error($d)) {
			return $d;
		}
		$to = SMS_Project::doc_path($d['project'], (string) self::arg($a, 'new_name'));
		if (is_wp_error($to)) {
			return $to;
		}
		$r = SMS_Project::store()->move($d['path'], $to);
		return is_wp_error($r) ? $r : array('file' => basename($to));
	}

	private static function tool_delete_document($a) {
		$d = self::doc($a);
		if (is_wp_error($d)) {
			return $d;
		}
		$r = SMS_Project::store()->trash($d['path']);
		return is_wp_error($r) ? $r : array('deleted' => $d['file']);
	}

	private static function tool_list_versions($a) {
		$d = self::doc($a);
		if (is_wp_error($d)) {
			return $d;
		}
		return array('file' => $d['file'], 'versions' => array_map(function ($v) {
			return array('version' => $v['id'], 'saved' => gmdate('c', $v['modified']), 'bytes' => $v['size']);
		}, SMS_Project::store()->versions($d['path'])));
	}

	private static function tool_restore_version($a) {
		$d = self::doc($a);
		if (is_wp_error($d)) {
			return $d;
		}
		$v = SMS_Project::store()->read_version($d['path'], (string) self::arg($a, 'version'));
		if (is_wp_error($v)) {
			return $v;
		}
		$r = SMS_Project::store()->write($d['path'], $v['content']);
		return is_wp_error($r) ? $r : array('restored' => $d['file'], 'version' => self::arg($a, 'version'));
	}

	/* ---------- Shared values ---------- */

	private static function readable_values($v) {
		$out = array();
		foreach (SMS_Values::FIELDS as $k => $def) {
			if ('guest' === $def[2] || 'guests' === $def[2]) {
				continue;
			}
			$out[$k] = array('label' => $def[0], 'en' => SMS_Values::scalar_text($v, $k, 'en'), 'bn' => SMS_Values::scalar_text($v, $k, 'bn'));
			if (!empty($v['text'][$k]['noTranslate'])) {
				$out[$k]['noTranslate'] = true;
			}
		}
		$out['chiefGuest'] = $v['chiefGuest'] ? array('en' => SMS_Values::guest_text($v['chiefGuest'], 'en'), 'bn' => SMS_Values::guest_text($v['chiefGuest'], 'bn')) : null;
		$out['specialGuests_in_printed_order'] = array();
		foreach ($v['specialGuests'] as $i => $g) {
			$out['specialGuests_in_printed_order'][] = array('number' => $i + 1, 'id' => $g['id'] ?? '', 'en' => SMS_Values::guest_text($g, 'en'), 'bn' => SMS_Values::guest_text($g, 'bn'));
		}
		return $out;
	}

	private static function tool_get_shared_values($a) {
		$p = SMS_Project::require_project(self::arg($a, 'project'));
		if (is_wp_error($p)) {
			return $p;
		}
		$v = SMS_Project::values($p);
		return array('readable' => self::readable_values($v), 'raw' => $v);
	}

	/** Merge a {en,bn} input into an existing value; queue a translation when only English changed. */
	private static function bi_merge($in, $old, $id, &$queue) {
		$old = is_array($old) ? $old : array('en' => '', 'bn' => '');
		if (is_string($in)) {
			$in = array('en' => $in);
		}
		if (!is_array($in)) {
			return $old;
		}
		$out = $old;
		if (array_key_exists('en', $in)) {
			$out['en'] = trim((string) $in['en']);
		}
		if (array_key_exists('noTranslate', $in)) {
			$out['noTranslate'] = (bool) $in['noTranslate'];
		}
		if (array_key_exists('bn', $in)) {
			$out['bn']       = trim((string) $in['bn']);
			$out['bnCustom'] = '' !== $out['bn'];
		} elseif (($out['en'] ?? '') !== ($old['en'] ?? '') && '' !== $out['en'] && empty($old['noTranslate'])) {
			$queue[$id] = $out['en'];
			$out['bnCustom'] = false;
		}
		return $out;
	}

	private static function guest_merge($in, $old, $gid, &$queue) {
		if (!is_array($in)) {
			return new WP_Error('sms_bad', 'A guest must be an object with prefixes, name, postfixes, designation.');
		}
		$old = is_array($old) ? $old : array('id' => SMS_Values::new_id(), 'prefixes' => array(), 'name' => array('en' => '', 'bn' => ''), 'postfixes' => array(), 'designation' => array('en' => '', 'bn' => ''));
		$g   = $old;
		$g['id'] = (string) ($old['id'] ?? SMS_Values::new_id());
		if (array_key_exists('noTranslate', $in)) {
			$g['noTranslate'] = (bool) $in['noTranslate'];
		}
		$skip = array();
		$q    = &$queue;
		if (!empty($g['noTranslate'])) {
			$q = &$skip; // "Don't translate": Bangla is typed by hand, never translated.
		}
		foreach (array('prefixes', 'postfixes') as $list) {
			if (array_key_exists($list, $in)) {
				$g[$list] = array();
				foreach (array_values((array) $in[$list]) as $i => $item) {
					$prev = $old[$list][$i] ?? null;
					$g[$list][] = self::bi_merge($item, $prev, $gid . '.' . $list . '.' . $i, $q);
				}
			}
		}
		foreach (array('name', 'designation') as $part) {
			if (array_key_exists($part, $in)) {
				$g[$part] = self::bi_merge($in[$part], $old[$part] ?? null, $gid . '.' . $part, $q);
			}
		}
		return $g;
	}

	/** Translate queued English texts into the values (AI). Returns a note. */
	private static function run_queue(&$v, $queue, $mode, $provider = '') {
		if (!$queue || 'none' === $mode) {
			return $queue ? 'Bangla not translated (translate:"none"). Give bn yourself or call translate_shared_values.' : null;
		}
		if (!SMS_Translate::available()) {
			return 'No AI key is set on the site, so Bangla was left as it was. Give bn yourself, or add a key in WordPress → Settings → Media Studio.';
		}
		$fields = array();
		foreach ($queue as $id => $text) {
			$fields[] = array('id' => $id, 'text' => $text);
		}
		$r = SMS_Translate::translate($fields, 'fields', $provider);
		if (is_wp_error($r)) {
			return 'Bangla translation failed: ' . $r->get_error_message();
		}
		foreach ($r['translations'] as $t) {
			$parts = explode('.', $t['id']);
			if ('t' === $parts[0]) {
				$v['text'][$parts[1]]['bn'] = $t['text'];
				$v['text'][$parts[1]]['bnCustom'] = false;
				continue;
			}
			// g.<n|chief>.<part>[.<i>]
			if ('chief' === $parts[1]) {
				$g = &$v['chiefGuest'];
			} else {
				$g = &$v['specialGuests'][(int) $parts[1]];
			}
			if (!is_array($g)) {
				unset($g);
				continue;
			}
			if (isset($parts[3])) {
				$g[$parts[2]][(int) $parts[3]]['bn'] = $t['text'];
				$g[$parts[2]][(int) $parts[3]]['bnCustom'] = false;
			} else {
				$g[$parts[2]]['bn'] = $t['text'];
				$g[$parts[2]]['bnCustom'] = false;
			}
			unset($g);
		}
		return 'Bangla translated with ' . $r['provider'] . ' (' . $r['model'] . '). Check names before publishing.';
	}

	private static function tool_set_shared_values($a) {
		$p = SMS_Project::require_project(self::arg($a, 'project'));
		if (is_wp_error($p)) {
			return $p;
		}
		$in = self::arg($a, 'values');
		if (!is_array($in) || !$in) {
			return new WP_Error('sms_bad', 'Give "values" with the keys to change.');
		}
		$v     = SMS_Project::values($p);
		$queue = array();
		$bad   = array();
		foreach ($in as $k => $val) {
			if (in_array($k, SMS_Values::RETIRED, true)) {
				$bad[] = $k . ' is no longer a shared value (type it into the documents instead)';
				continue;
			}
			$def = SMS_Values::FIELDS[$k] ?? null;
			if (!$def) {
				$bad[] = 'unknown key ' . $k;
				continue;
			}
			switch ($def[2]) {
				case 'text':
					$v['text'][$k] = self::bi_merge($val, $v['text'][$k] ?? null, 't.' . $k, $queue);
					break;
				case 'ordinal':
				case 'year':
					$v[$k] = (null === $val || '' === $val) ? null : (int) $val;
					break;
				case 'date':
					if (null !== $val && '' !== $val && !preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $val)) {
						$bad[] = $k . ' must be YYYY-MM-DD';
						break;
					}
					$v[$k] = ('' === $val) ? null : $val;
					break;
				case 'time':
					if (null !== $val && '' !== $val && !preg_match('/^\d{1,2}:\d{2}$/', (string) $val)) {
						$bad[] = $k . ' must be HH:MM (24 hour)';
						break;
					}
					$v[$k] = ('' === $val) ? null : $val;
					break;
				case 'phone':
					$v['contactPhone'] = (string) $val;
					break;
				case 'guest':
					if (null === $val) {
						$v['chiefGuest'] = null;
						break;
					}
					$g = self::guest_merge($val, $v['chiefGuest'], 'g.chief', $queue);
					if (is_wp_error($g)) {
						return $g;
					}
					$v['chiefGuest'] = $g;
					break;
				case 'guests':
					if (!is_array($val)) {
						$bad[] = 'specialGuests must be a list';
						break;
					}
					$byId = array();
					foreach ($v['specialGuests'] as $g) {
						$byId[$g['id'] ?? ''] = $g;
					}
					$list = array();
					foreach (array_values($val) as $i => $gin) {
						$old = (is_array($gin) && isset($gin['id']) && isset($byId[$gin['id']])) ? $byId[$gin['id']] : null;
						$tmp = array();
						$g   = self::guest_merge($gin, $old, 'g.' . $i, $tmp);
						if (is_wp_error($g)) {
							return $g;
						}
						$queue  = array_merge($queue, $tmp);
						$list[] = $g;
					}
					$v['specialGuests'] = $list;
					break;
			}
		}
		if ($bad) {
			return new WP_Error('sms_bad', 'Nothing was saved: ' . implode('; ', $bad) . '.');
		}
		$note    = self::run_queue($v, $queue, self::arg($a, 'translate', 'auto'));
		$changed = SMS_Project::save_values($p, $v);
		if (is_wp_error($changed)) {
			return $changed;
		}
		return array_filter(array('saved' => true, 'documents_updated' => $changed, 'translation' => $note, 'shared_values' => self::readable_values($v)), function ($x) { return null !== $x; });
	}

	private static function tool_edit_special_guest($a) {
		$p = SMS_Project::require_project(self::arg($a, 'project'));
		if (is_wp_error($p)) {
			return $p;
		}
		$v      = SMS_Project::values($p);
		$list   = $v['specialGuests'];
		$n      = count($list);
		$action = self::arg($a, 'action');
		$index  = (int) self::arg($a, 'index', 0);
		$queue  = array();
		if ('add' === $action) {
			$pos = $index >= 1 && $index <= $n + 1 ? $index - 1 : $n;
			array_splice($list, $pos, 0, array(null));
			$g = self::guest_merge(self::arg($a, 'guest'), null, 'g.' . $pos, $queue);
			if (is_wp_error($g)) {
				return $g;
			}
			$list[$pos] = $g;
		} else {
			if ($index < 1 || $index > $n) {
				return new WP_Error('sms_bad', 'index must be 1–' . $n . ' (there are ' . $n . ' special guests).');
			}
			if ('update' === $action) {
				$g = self::guest_merge(self::arg($a, 'guest'), $list[$index - 1], 'g.' . ($index - 1), $queue);
				if (is_wp_error($g)) {
					return $g;
				}
				$list[$index - 1] = $g;
			} elseif ('remove' === $action) {
				array_splice($list, $index - 1, 1);
			} elseif ('move' === $action) {
				$to = (int) self::arg($a, 'to', 0);
				if ($to < 1 || $to > $n) {
					return new WP_Error('sms_bad', '"to" must be 1–' . $n . '.');
				}
				$g = array_splice($list, $index - 1, 1);
				array_splice($list, $to - 1, 0, $g);
			} else {
				return new WP_Error('sms_bad', 'action must be add, update, remove or move.');
			}
		}
		$v['specialGuests'] = array_values($list);
		$note    = self::run_queue($v, $queue, self::arg($a, 'translate', 'auto'));
		$changed = SMS_Project::save_values($p, $v);
		if (is_wp_error($changed)) {
			return $changed;
		}
		return array_filter(array('saved' => true, 'documents_updated' => $changed, 'translation' => $note, 'special_guests_in_printed_order' => self::readable_values($v)['specialGuests_in_printed_order']), function ($x) { return null !== $x; });
	}

	private static function tool_link_text($a) {
		$d = self::doc($a);
		if (is_wp_error($d)) {
			return $d;
		}
		$field = (string) self::arg($a, 'field');
		if (!isset(SMS_Values::FIELDS[$field])) {
			return new WP_Error('sms_bad', 'Unknown field "' . $field . '".');
		}
		$text = (string) self::arg($a, 'text');
		if ('' === trim($text)) {
			return new WP_Error('sms_bad', 'Give the exact text to link.');
		}
		$occ = (string) self::arg($a, 'occurrence', '1');
		list($dom, $root) = SMS_Doc::load_fragment($d['model']['body']);
		$xp    = new DOMXPath($dom);
		$nodes = iterator_to_array($xp->query('.//text()[not(ancestor::*[@data-field])]', $root));
		$seen  = 0;
		$done  = 0;
		foreach ($nodes as $node) {
			$offset = 0;
			while (false !== ($pos = mb_strpos($node->data, $text, $offset, 'UTF-8'))) {
				$seen++;
				if ('all' !== $occ && (int) $occ !== $seen) {
					$offset = $pos + mb_strlen($text, 'UTF-8');
					continue;
				}
				$after  = $node->splitText($pos);
				$rest   = $after->splitText(mb_strlen($text, 'UTF-8'));
				$span   = $dom->createElement('span');
				$span->setAttribute('data-field', $field);
				foreach (array('format' => 'data-fmt', 'separator' => 'data-sep') as $arg => $attr) {
					if (self::arg($a, $arg)) {
						$span->setAttribute($attr, (string) self::arg($a, $arg));
					}
				}
				if (self::arg($a, 'bold_names')) {
					$span->setAttribute('data-bold', '1');
				}
				$after->parentNode->replaceChild($span, $after);
				$span->appendChild($after);
				$done++;
				$node   = $rest;
				$offset = 0;
				if ('all' !== $occ) {
					break 2;
				}
			}
		}
		if (!$done) {
			return new WP_Error('sms_not_found', 'Text "' . mb_substr($text, 0, 80) . '" was not found as plain text (it may cross bold/italic tags or already be linked). Use edit_document to wrap it in <span data-field="' . $field . '">…</span> instead.');
		}
		$note = null;
		$def  = SMS_Values::FIELDS[$field];
		$lang = $d['model']['lang'];
		if ('text' === $def[2] || 'phone' === $def[2]) {
			$v   = SMS_Project::values($d['project']);
			$cur = 'phone' === $def[2] ? $v['contactPhone'] : ($v['text'][$field][$lang] ?? '');
			if ('' === trim((string) $cur)) {
				if ('phone' === $def[2]) {
					$v['contactPhone'] = trim($text);
				} else {
					$v['text'][$field] = array_merge(array('en' => '', 'bn' => ''), (array) ($v['text'][$field] ?? array()), array($lang => trim($text)));
					if ('bn' === $lang) {
						$v['text'][$field]['bnCustom'] = true;
					} elseif ('' === trim((string) ($v['text'][$field]['bn'] ?? ''))) {
						self::run_queue($v, array('t.' . $field => trim($text)), 'auto');
					}
				}
				SMS_Project::save_values($d['project'], $v);
				$note = 'The shared value was empty, so it was set to this text (' . $lang . ').';
			}
		} elseif ('' === trim(SMS_Values::scalar_text(SMS_Project::values($d['project']), $field, $lang)) && !in_array($def[2], array('guest', 'guests'), true)) {
			$note = 'This value is still empty; set it with set_shared_values or the slot shows a placeholder.';
		}
		$d['model']['body'] = SMS_Doc::inner_html($dom, $root);
		$r = SMS_Project::write_doc($d['project'], $d['file'], $d['model']);
		return is_wp_error($r) ? $r : array_filter(array('linked' => $done, 'field' => $field, 'note' => $note), function ($x) { return null !== $x; });
	}

	private static function tool_unlink_field($a) {
		$d = self::doc($a);
		if (is_wp_error($d)) {
			return $d;
		}
		$field = (string) self::arg($a, 'field');
		$occ   = (string) self::arg($a, 'occurrence', 'all');
		list($dom, $root) = SMS_Doc::load_fragment($d['model']['body']);
		$xp   = new DOMXPath($dom);
		$done = 0;
		foreach (iterator_to_array($xp->query('.//*[@data-field="' . str_replace('"', '', $field) . '"]', $root)) as $i => $el) {
			if ('all' !== $occ && (int) $occ !== $i + 1) {
				continue;
			}
			foreach (iterator_to_array($xp->query('.//*[@data-guest]', $el)) as $g) {
				while ($g->firstChild) {
					$g->parentNode->insertBefore($g->firstChild, $g);
				}
				$g->parentNode->removeChild($g);
			}
			while ($el->firstChild) {
				$el->parentNode->insertBefore($el->firstChild, $el);
			}
			$el->parentNode->removeChild($el);
			$done++;
		}
		if (!$done) {
			return new WP_Error('sms_not_found', 'No linked "' . $field . '" found in ' . $d['file'] . '.');
		}
		$d['model']['body'] = SMS_Doc::inner_html($dom, $root);
		$r = SMS_Project::write_doc($d['project'], $d['file'], $d['model']);
		return is_wp_error($r) ? $r : array('unlinked' => $done);
	}

	private static function tool_translate_text($a) {
		$texts = self::arg($a, 'texts');
		if (!is_array($texts) || !$texts) {
			return new WP_Error('sms_bad', 'Give "texts": a list of English strings.');
		}
		$fields = array();
		foreach (array_values($texts) as $i => $t) {
			if ('' !== trim((string) $t)) {
				$fields[] = array('id' => 'x' . $i, 'text' => (string) $t);
			}
		}
		$r = SMS_Translate::translate($fields, 'fields', (string) self::arg($a, 'provider', ''));
		if (is_wp_error($r)) {
			return $r;
		}
		$out = array();
		foreach ($r['translations'] as $t) {
			$out[(int) substr($t['id'], 1)] = $t['text'];
		}
		ksort($out);
		return array('provider' => $r['provider'], 'model' => $r['model'], 'bangla' => array_values($out));
	}

	private static function tool_translate_shared_values($a) {
		$p = SMS_Project::require_project(self::arg($a, 'project'));
		if (is_wp_error($p)) {
			return $p;
		}
		$v    = SMS_Project::values($p);
		$keys = self::arg($a, 'keys');
		$all  = !is_array($keys) || !$keys || in_array('all', $keys, true);
		$want = function ($k) use ($all, $keys) { return $all || in_array($k, (array) $keys, true); };
		$queue = array();
		foreach (SMS_Values::TEXT_KEYS as $k) {
			if ($want($k) && !empty($v['text'][$k]['en']) && empty($v['text'][$k]['noTranslate'])) {
				$queue['t.' . $k] = $v['text'][$k]['en'];
			}
		}
		$guestQueue = function ($g, $id) use (&$queue) {
			if (!empty($g['noTranslate'])) {
				return;
			}
			foreach (array('prefixes', 'postfixes') as $list) {
				foreach ((array) ($g[$list] ?? array()) as $i => $b) {
					if (!empty($b['en'])) {
						$queue[$id . '.' . $list . '.' . $i] = $b['en'];
					}
				}
			}
			foreach (array('name', 'designation') as $part) {
				if (!empty($g[$part]['en'])) {
					$queue[$id . '.' . $part] = $g[$part]['en'];
				}
			}
		};
		if ($want('chiefGuest') && $v['chiefGuest']) {
			$guestQueue($v['chiefGuest'], 'g.chief');
		}
		if ($want('specialGuests')) {
			foreach ($v['specialGuests'] as $i => $g) {
				$guestQueue($g, 'g.' . $i);
			}
		}
		if (!$queue) {
			return new WP_Error('sms_bad', 'Nothing to translate: fill in the English first.');
		}
		$note = self::run_queue($v, $queue, 'auto', (string) self::arg($a, 'provider', ''));
		if (0 !== strpos((string) $note, 'Bangla translated')) {
			return new WP_Error('sms_ai', (string) $note);
		}
		$changed = SMS_Project::save_values($p, $v);
		return is_wp_error($changed) ? $changed : array('translated' => count($queue), 'note' => $note, 'documents_updated' => $changed, 'shared_values' => self::readable_values($v));
	}

	/* ---------- Export ---------- */

	private static function tool_export_document($a) {
		$d = self::doc($a);
		if (is_wp_error($d)) {
			return $d;
		}
		$format = self::arg($a, 'format', 'print');
		$link   = function ($f) use ($d) { return add_query_arg(array('path' => rawurlencode($d['path']), 'format' => $f), rest_url(SMS_Rest::NS . '/export')); };
		$out    = array('file' => $d['file'], 'pdf' => $link('pdf'), 'word' => $link('word'), 'print' => $link('print'), 'html' => $link('html'));
		$out['note']      = 'PDF, Word and print links open the studio, which makes the file with exactly the print-preview layout (A4, same page breaks). Open them in a browser.';
		$out['requested'] = $out[$format] ?? $out['pdf'];
		return $out;
	}

	private static function tool_open_in_studio($a) {
		$p = SMS_Project::require_project(self::arg($a, 'project'));
		if (is_wp_error($p)) {
			return $p;
		}
		$f = (string) self::arg($a, 'file', '');
		return array('url' => SMS_Project::studio_url($p, $f));
	}

	/** GET /export?path=Project/File.html&format=html|word|print */
	public static function export(WP_REST_Request $request) {
		$path = SMS_Storage::clean_path((string) $request->get_param('path'), 'file');
		if (is_wp_error($path) || !preg_match('/\.html$/i', $path)) {
			return new WP_Error('sms_bad_path', 'Unknown document.', array('status' => 404));
		}
		$r = SMS_Storage::instance()->read($path);
		if (is_wp_error($r)) {
			return $r;
		}
		$format = (string) $request->get_param('format');
		if (in_array($format, array('word', 'pdf', 'print'), true)) {
			// PDF, Word and print are made by the studio itself, so they match its print preview exactly.
			wp_safe_redirect(SMS_Frontend::url() . '#/export/' . $format . '/' . rawurlencode($path), 302);
			exit;
		}
		$html   = $r['content'];
		$name   = preg_replace('/\.html$/i', '', basename($path));
		header('X-Robots-Tag: noindex, nofollow');
		header('Cache-Control: no-store');
		if ('word' === $format) {
			// Word opens HTML documents saved with a .doc name.
			$doc = str_replace('<html lang=', '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang=', $html);
			header('Content-Type: application/msword; charset=utf-8');
			header('Content-Disposition: attachment; filename*=UTF-8\'\'' . rawurlencode($name . '.doc'));
			echo $doc; // phpcs:ignore WordPress.Security.EscapeOutput
			exit;
		}
		header('Content-Type: text/html; charset=utf-8');
		if ('print' === $format) {
			$html = str_replace('</body>', '<script>window.addEventListener("load",function(){(document.fonts?document.fonts.ready:Promise.resolve()).then(function(){setTimeout(function(){window.print()},300)})});</script></body>', $html);
		} else {
			header('Content-Disposition: inline; filename*=UTF-8\'\'' . rawurlencode($name . '.html'));
		}
		echo $html; // phpcs:ignore WordPress.Security.EscapeOutput
		exit;
	}
}
