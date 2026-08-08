const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isValidPromptPayId } = require('../lib/promptpay');

const router = express.Router();

async function getSettings() {
  const rows = await db.all('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

const PUBLIC_KEYS = ['store_name', 'app_logo_url', 'home_logo_url', 'theme_primary_color', 'theme_secondary_color', 'theme_font', 'payment_logos'];

// Client IDs aren't secret, but there's no reason a plain customer session needs them —
// only admins reading the Settings > Social Login screen do.
const OAUTH_ADMIN_ONLY_KEYS = ['oauth_google_client_id', 'oauth_facebook_client_id', 'oauth_line_client_id', 'oauth_frontend_url'];
// Client Secrets are never sent back over the API to anyone, admin included — same
// principle as a password field. The Social Login screen only ever writes these, and
// shows "already configured" (from /api/auth/social/status) instead of the real value.
const OAUTH_SECRET_KEYS = ['oauth_google_client_secret', 'oauth_facebook_client_secret', 'oauth_line_client_secret'];

// GET /api/settings/public — no auth required. Used to paint branding (app name, logo,
// theme colors/font, payment logos) on the login/splash screen before the user signs in.
router.get('/public', async (req, res, next) => {
  try {
    const all = await getSettings();
    res.json(Object.fromEntries(PUBLIC_KEYS.map(k => [k, all[k]])));
  } catch (e) { next(e); }
});

router.use(requireAuth);

// GET /api/settings — any logged-in user can read (customer app needs call_mode).
// OAuth secrets are always stripped; OAuth client IDs/frontend URL are admin-only.
router.get('/', async (req, res, next) => {
  try {
    const all = await getSettings();
    OAUTH_SECRET_KEYS.forEach((k) => delete all[k]);
    if (req.user.role !== 'admin') {
      OAUTH_ADMIN_ONLY_KEYS.forEach((k) => delete all[k]);
    }
    res.json(all);
  } catch (e) { next(e); }
});

// PATCH /api/settings — admin only
router.patch('/', requireRole('admin'), async (req, res, next) => {
  try {
    const allowedKeys = [
      'call_mode', 'agent_name', 'agent_title', 'agent_greeting', 'agent_avatar_url', 'chat_welcome_messages', 'chat_header_stats',
      'auto_switch', 'avatar_skin_tone', 'avatar_hair_color', 'avatar_uniform_color', 'store_name',
      'app_logo_url', 'home_logo_url', 'theme_primary_color', 'theme_secondary_color', 'theme_font', 'payment_logos',
      'promptpay_id', 'promptpay_name',
      'oauth_google_client_id', 'oauth_google_client_secret',
      'oauth_facebook_client_id', 'oauth_facebook_client_secret',
      'oauth_line_client_id', 'oauth_line_client_secret',
      'oauth_frontend_url',
      'home_banners', 'promo_image_cards', 'home_stats', 'home_category_tabs', 'home_cta_title', 'home_cta_subtitle', 'home_seo_html', 'shipping_logos',
      'home_popular_cats_title', 'home_popular_cats_subtitle', 'home_popular_cat_ids',
      'home_top_rated_title', 'home_top_rated_subtitle', 'home_top_rated_count',
      'footer_about_title', 'footer_about_sections', 'footer_campaign_dates', 'footer_nav_columns',
      'vip_tiers', 'referral_reward', 'profile_menu_items', 'notif_categories_enabled', 'notif_event_templates',
    ];
    if (req.body.promptpay_id !== undefined && req.body.promptpay_id !== '' && !isValidPromptPayId(req.body.promptpay_id)) {
      return res.status(400).json({ error: 'เลขพร้อมเพย์ไม่ถูกต้อง (ต้องเป็นเบอร์โทร 10 หลัก หรือเลขบัตรประชาชน/นิติบุคคล 13 หลัก)' });
    }
    for (const key of allowedKeys) {
      if (req.body[key] === undefined) continue;
      // Leaving a Client Secret field blank on save means "keep the current value" (like
      // most API-key forms) — an empty string would otherwise silently disable the provider.
      if (OAUTH_SECRET_KEYS.includes(key) && String(req.body[key]).trim() === '') continue;
      await db.run('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(req.body[key])]);
    }
    const settings = await getSettings();
    OAUTH_SECRET_KEYS.forEach((k) => delete settings[k]);
    if (req.user.role !== 'admin') OAUTH_ADMIN_ONLY_KEYS.forEach((k) => delete settings[k]);
    req.app.get('io').emit('settings:update', settings);
    res.json(settings);
  } catch (e) { next(e); }
});

module.exports = router;
