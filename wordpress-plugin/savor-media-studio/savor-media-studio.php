<?php
/**
 * Plugin Name:       SAVOR Media Studio
 * Plugin URI:        https://github.com/md-alaminIslam/pr-and-media-invitation
 * Description:       Bangla & English media invitation and press release studio, served at a private, unlisted URL (default /media-studio) as a visual HTML editor with autosaving projects.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Savor International Limited
 * License:           Proprietary
 * Text Domain:       savor-media-studio
 */

if (!defined('ABSPATH')) {
	exit;
}

define('SMS_VERSION', '1.0.0');
define('SMS_FILE', __FILE__);
define('SMS_DIR', plugin_dir_path(__FILE__));
define('SMS_URL', plugin_dir_url(__FILE__));
define('SMS_REPO', 'md-alaminIslam/pr-and-media-invitation');

require_once SMS_DIR . 'includes/class-sms-storage.php';
require_once SMS_DIR . 'includes/class-sms-limits.php';
require_once SMS_DIR . 'includes/class-sms-translate.php';
require_once SMS_DIR . 'includes/class-sms-rest.php';
require_once SMS_DIR . 'includes/class-sms-doc.php';
require_once SMS_DIR . 'includes/class-sms-values.php';
require_once SMS_DIR . 'includes/class-sms-import.php';
require_once SMS_DIR . 'includes/class-sms-project.php';
require_once SMS_DIR . 'includes/class-sms-mcp.php';
require_once SMS_DIR . 'includes/class-sms-frontend.php';
require_once SMS_DIR . 'includes/class-sms-admin.php';
require_once SMS_DIR . 'includes/class-sms-updater.php';

/** Settings with defaults. */
function sms_settings() {
	$defaults = array(
		'slug'             => 'media-studio',
		'gemini_key'       => '',
		'gemini_model'     => '',
		'gemini_passcode'  => '',
		'ai_provider'      => 'gemini',
		'anthropic_key'    => '',
		'anthropic_model'  => '',
		'openai_key'       => '',
		'openai_model'     => '',
		'openrouter_key'   => '',
		'openrouter_model' => '',
		'mcp_enabled'      => false,
		'mcp_token'        => '',
	);
	$saved = get_option('sms_settings', array());
	return wp_parse_args(is_array($saved) ? $saved : array(), $defaults);
}

/** Gemini key: a SMS_GEMINI_API_KEY constant in wp-config.php wins over the settings page. */
function sms_gemini_key() {
	if (defined('SMS_GEMINI_API_KEY') && SMS_GEMINI_API_KEY) {
		return SMS_GEMINI_API_KEY;
	}
	return (string) sms_settings()['gemini_key'];
}

register_activation_hook(__FILE__, function () {
	SMS_Storage::instance()->ensure_dirs();
});

add_action('plugins_loaded', function () {
	SMS_Frontend::init();
	SMS_Rest::init();
	SMS_Mcp::init();
	SMS_Admin::init();
	SMS_Updater::init();
});
