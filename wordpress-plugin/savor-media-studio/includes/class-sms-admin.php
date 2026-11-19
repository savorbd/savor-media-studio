<?php
/**
 * Settings → Media Studio (administrators only).
 */

if (!defined('ABSPATH')) {
	exit;
}

class SMS_Admin {
	public static function init() {
		add_action('admin_menu', array(__CLASS__, 'menu'));
		add_action('admin_init', array(__CLASS__, 'register'));
		add_filter('plugin_action_links_' . plugin_basename(SMS_FILE), array(__CLASS__, 'links'));
	}

	public static function links($links) {
		array_unshift(
			$links,
			'<a href="' . esc_url(admin_url('options-general.php?page=savor-media-studio')) . '">Settings</a>',
			'<a href="' . esc_url(SMS_Frontend::url()) . '" target="_blank" rel="noopener">Open studio</a>'
		);
		return $links;
	}

	public static function menu() {
		add_options_page('SAVOR Media Studio', 'Media Studio', 'manage_options', 'savor-media-studio', array(__CLASS__, 'page'));
	}

	public static function register() {
		register_setting('sms_settings_group', 'sms_settings', array(
			'type'              => 'array',
			'sanitize_callback' => array(__CLASS__, 'sanitize'),
			'default'           => array(),
		));
	}

	public static function sanitize($input) {
		$old  = sms_settings();
		$slug = isset($input['slug']) ? trim(sanitize_title_with_dashes(wp_unslash($input['slug'])), '/') : $old['slug'];
		$out  = array(
			'slug'            => '' === $slug ? 'media-studio' : $slug,
			'gemini_passcode' => isset($input['gemini_passcode']) ? trim(sanitize_text_field(wp_unslash($input['gemini_passcode']))) : '',
			'ai_provider'     => isset($input['ai_provider']) && isset(SMS_Translate::PROVIDERS[$input['ai_provider']]) ? $input['ai_provider'] : 'gemini',
		);
		$out['mcp_enabled'] = !empty($input['mcp_enabled']);
		$out['mcp_token']   = (string) ($old['mcp_token'] ?? '');
		if ($out['mcp_enabled'] && strlen($out['mcp_token']) < 20) {
			$out['mcp_token'] = SMS_Mcp::new_token();
		}
		foreach (array_keys(SMS_Translate::PROVIDERS) as $p) {
			// The key field shows the saved key; clearing it removes the key.
			$key = isset($input[$p . '_key']) ? trim(sanitize_text_field(wp_unslash($input[$p . '_key']))) : (string) ($old[$p . '_key'] ?? '');
			if ($key !== (string) ($old[$p . '_key'] ?? '')) {
				delete_option('sms_model_found_' . $p); // a new key may have different models
			}
			$out[$p . '_key']   = $key;
			$out[$p . '_model'] = isset($input[$p . '_model']) ? preg_replace('/[^a-z0-9.\-_:\/,]/i', '', wp_unslash($input[$p . '_model'])) : '';
		}
		return $out;
	}

	public static function page() {
		if (!current_user_can('manage_options')) {
			return;
		}
		$s          = sms_settings();
				$items      = SMS_Storage::instance()->list_tree();
		$files      = count(array_filter($items, function ($i) {
			return 'file' === $i['type'];
		}));
		?>
		<div class="wrap">
			<h1>SAVOR Media Studio</h1>
			<p>
				Studio address: <a href="<?php echo esc_url(SMS_Frontend::url()); ?>" target="_blank" rel="noopener"><strong><?php echo esc_html(SMS_Frontend::url()); ?></strong></a>
				&nbsp;·&nbsp; Version <?php echo esc_html(SMS_VERSION); ?> &nbsp;·&nbsp; <?php echo (int) $files; ?> documents
			</p>
			<p class="description">
				The studio is public to anyone who knows this address (no login) and is hidden from search engines.
				It is not linked from your website. Each project is a folder of HTML documents in <code>wp-content/uploads/savor-media-studio/</code>,
				which is blocked from direct download. Deleted files are kept in its <code>trash</code> folder for 30 days,
				and each file keeps its last 30 automatic versions.
			</p>
			<?php
			if (isset($_GET['sms_test'], $_GET['_wpnonce']) && wp_verify_nonce(sanitize_text_field(wp_unslash($_GET['_wpnonce'])), 'sms_test')) {
				$pid = sanitize_key(wp_unslash($_GET['sms_test']));
				if (isset(SMS_Translate::PROVIDERS[$pid])) {
					$r = SMS_Translate::translate(array(array('id' => 'test', 'text' => 'Chief Guest: Hon\'ble Minister, Ministry of Commerce')), 'fields', $pid);
					if (is_wp_error($r)) {
						echo '<div class="notice notice-error"><p><strong>' . esc_html(SMS_Translate::PROVIDERS[$pid]['label']) . ' test failed.</strong> ' . esc_html($r->get_error_message()) . '</p></div>';
					} else {
						echo '<div class="notice notice-success"><p><strong>' . esc_html(SMS_Translate::PROVIDERS[$pid]['label']) . ' works</strong> with model <code>' . esc_html($r['model']) . '</code>: ' . esc_html($r['translations'][0]['text']) . '</p></div>';
					}
				}
			}
			?>
			<?php
			if (isset($_GET['sms_mcp_regen'], $_GET['_wpnonce']) && wp_verify_nonce(sanitize_text_field(wp_unslash($_GET['_wpnonce'])), 'sms_mcp_regen')) {
				$all              = get_option('sms_settings', array());
				$all              = is_array($all) ? $all : array();
				$all['mcp_token'] = SMS_Mcp::new_token();
				update_option('sms_settings', $all);
				$s = sms_settings();
				echo '<div class="notice notice-success"><p>New connector address created. The old address no longer works — update it in Claude / ChatGPT.</p></div>';
			}
			?>
			<form method="post" action="options.php">
				<?php settings_fields('sms_settings_group'); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="sms-slug">Studio address</label></th>
						<td>
							<code><?php echo esc_html(home_url('/')); ?></code><input id="sms-slug" name="sms_settings[slug]" value="<?php echo esc_attr($s['slug']); ?>" class="regular-text" style="width:16em">
							<p class="description">Change this to move the studio to a different, harder-to-guess address.</p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="sms-provider">Translation AI</label></th>
						<td>
							<select id="sms-provider" name="sms_settings[ai_provider]">
								<?php foreach (SMS_Translate::PROVIDERS as $id => $info) : ?>
									<option value="<?php echo esc_attr($id); ?>" <?php selected($s['ai_provider'], $id); ?>><?php echo esc_html($info['label']); ?><?php echo SMS_Translate::key($id) ? '' : ' (no key yet)'; ?></option>
								<?php endforeach; ?>
							</select>
							<p class="description">Default AI for translation. Every provider with a key can also be picked inside the studio. Without any key, the studio uses Offline translation only. Keys are only shown here to administrators; the studio never sends them to the browser.</p>
						</td>
					</tr>
					<?php foreach (array('gemini' => array('Google Gemini', 'aistudio.google.com', 'SMS_GEMINI_API_KEY'), 'anthropic' => array('Anthropic Claude', 'console.anthropic.com', 'SMS_ANTHROPIC_API_KEY'), 'openai' => array('OpenAI ChatGPT', 'platform.openai.com', 'SMS_OPENAI_API_KEY'), 'openrouter' => array('OpenRouter (free models)', 'openrouter.ai/keys', 'SMS_OPENROUTER_API_KEY')) as $pid => $info) : ?>
					<tr>
						<th scope="row"><label for="sms-<?php echo esc_attr($pid); ?>-key"><?php echo esc_html($info[0]); ?></label></th>
						<td>
							<?php if (defined($info[2]) && constant($info[2])) : ?>
								<p><strong>Key set in wp-config.php</strong> (<code><?php echo esc_html($info[2]); ?></code>).</p>
							<?php else : ?>
								<input id="sms-<?php echo esc_attr($pid); ?>-key" type="text" name="sms_settings[<?php echo esc_attr($pid); ?>_key]" value="<?php echo esc_attr($s[$pid . '_key'] ?? ''); ?>" class="regular-text code" autocomplete="off" spellcheck="false" placeholder="<?php echo esc_attr('API key from ' . $info[1]); ?>">
							<?php endif; ?>
							<?php if (SMS_Translate::key($pid)) : ?>
								<a class="button" style="margin-left:6px" href="<?php echo esc_url(wp_nonce_url(admin_url('options-general.php?page=savor-media-studio&sms_test=' . $pid), 'sms_test')); ?>">Test</a>
							<?php endif; ?>
							<?php if ('openrouter' === $pid) : ?>
								<?php $free = SMS_Translate::openrouter_free_models(); ?>
								<p style="margin-top:6px"><input name="sms_settings[openrouter_model]" list="sms-or-free" value="<?php echo esc_attr($s['openrouter_model'] ?? ''); ?>" class="regular-text code" placeholder="Model — automatic (best free models, with fallbacks)"></p>
								<datalist id="sms-or-free"><?php foreach ($free as $m) : ?><option value="<?php echo esc_attr($m); ?>"><?php endforeach; ?><option value="openrouter/free"></datalist>
								<p class="description">Leave the model empty: the studio uses OpenRouter's current free models, best for Bangla first, and falls back to the next one when a model is busy or retired (<?php echo esc_html(count($free)); ?> free models available now<?php echo $free ? ': ' . esc_html(implode(', ', array_slice($free, 0, 4))) . '…' : ''; ?>). Or type one or more model ids, separated by commas. Free models allow about 20 requests a minute and 50 a day (1,000 a day after buying $10 of OpenRouter credit).</p>
							<?php else : ?>
							<p style="margin-top:6px"><input name="sms_settings[<?php echo esc_attr($pid); ?>_model]" value="<?php echo esc_attr($s[$pid . '_model'] ?? ''); ?>" class="regular-text" placeholder="Model — automatic (<?php echo esc_attr(SMS_Translate::model($pid)); ?>)"></p>
							<?php endif; ?>
						</td>
					</tr>
					<?php endforeach; ?>
					<tr>
						<th scope="row">AI connector (MCP)</th>
						<td>
							<label><input type="checkbox" name="sms_settings[mcp_enabled]" value="1" <?php checked(!empty($s['mcp_enabled'])); ?>> Let Claude, ChatGPT and other AI assistants work in the studio</label>
							<?php if (SMS_Mcp::enabled()) : ?>
								<p style="margin-top:8px"><input type="text" readonly class="large-text code" value="<?php echo esc_attr(SMS_Mcp::url()); ?>" onclick="this.select()"></p>
								<p class="description">
									<strong>Claude:</strong> Settings → Connectors → Add custom connector → paste this address.
									<strong>ChatGPT:</strong> Settings → Apps &amp; Connectors → Advanced → Developer mode → Create → paste this address, authentication "No authentication".
									<strong>Claude Code:</strong> <code>claude mcp add --transport http media-studio &lt;address&gt;</code>.<br>
									The address is the key: anyone who has it can read and change every project. Keep it private.
									<a href="<?php echo esc_url(wp_nonce_url(admin_url('options-general.php?page=savor-media-studio&sms_mcp_regen=1'), 'sms_mcp_regen')); ?>">Create a new address</a> (the old one stops working).
								</p>
							<?php else : ?>
								<p class="description">Tick and save to get the connector address.</p>
							<?php endif; ?>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="sms-pass">Gemini passcode</label></th>
						<td>
							<input id="sms-pass" name="sms_settings[gemini_passcode]" value="<?php echo esc_attr($s['gemini_passcode']); ?>" class="regular-text" autocomplete="off">
							<p class="description">Optional. There is no usage cap, and anyone with the studio address can use Gemini on your API bill.
							If set, the studio asks for this passcode once before Gemini translation. Offline translation never needs it.</p>
						</td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>
		</div>
		<?php
	}
}
