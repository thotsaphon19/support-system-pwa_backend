const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/store-notifications/unread-count — must be registered before any
// future GET /:id route so Express doesn't swallow "unread-count" as an id.
// "Unread" = announcements posted since this user last opened the notifications
// list (users.store_notif_seen_at) — a NULL value (brand-new account) means
// everything posted so far counts as unread, which is the correct first-visit state.
router.get('/unread-count', async (req, res, next) => {
  try {
    const count = await db.get(`
      SELECT COUNT(*) c FROM store_notifications, users
      WHERE users.id = ?
        AND (users.store_notif_seen_at IS NULL OR store_notifications.created_at > users.store_notif_seen_at)
    `, [req.user.id]);
    res.json({ count: Number(count.c) });
  } catch (e) { next(e); }
});

// POST /api/store-notifications/mark-seen — called when the customer opens the
// notifications list; clears their unread badge from this point forward.
router.post('/mark-seen', async (req, res, next) => {
  try {
    await db.run("UPDATE users SET store_notif_seen_at = to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS') WHERE id = ?", [req.user.id]);
    res.json({ count: 0 });
  } catch (e) { next(e); }
});

// GET /api/store-notifications — any logged-in user
router.get('/', async (req, res, next) => {
  try {
    res.json(await db.all('SELECT * FROM store_notifications ORDER BY created_at DESC'));
  } catch (e) { next(e); }
});

// POST /api/store-notifications — admin only
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { title, body, icon } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'กรุณากรอกหัวข้อและเนื้อหา' });
    const info = await db.run('INSERT INTO store_notifications (title, body, icon) VALUES (?,?,?)', [title, body, icon || '🛍️']);
    const row = await db.get('SELECT * FROM store_notifications WHERE id = ?', [info.lastInsertRowid]);
    const io = req.app.get('io');
    if (io) io.emit('store-notification:new', row);
    res.status(201).json(row);
  } catch (e) { next(e); }
});

// DELETE /api/store-notifications/:id — admin only
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    await db.run('DELETE FROM store_notifications WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
