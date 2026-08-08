const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/notifications — the signed-in person's own feed. Customers only ever
// see rows addressed to them (user_id = them, audience = 'customer'); admins see
// every admin-audience row (their own personal ones plus store-wide broadcasts
// where user_id IS NULL), i.e. a shared activity log across the back office.
router.get('/', async (req, res, next) => {
  try {
    const rows = req.user.role === 'admin'
      ? await db.all(`SELECT * FROM notifications WHERE audience = 'admin' ORDER BY created_at DESC LIMIT 100`)
      : await db.all(`SELECT * FROM notifications WHERE audience = 'customer' AND user_id = ? ORDER BY created_at DESC LIMIT 100`, [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/notifications/unread-count — must be registered before any future
// GET /:id route so Express doesn't swallow "unread-count" as an id.
router.get('/unread-count', async (req, res, next) => {
  try {
    const user = await db.get('SELECT notif_seen_at FROM users WHERE id = ?', [req.user.id]);
    const seenAt = user && user.notif_seen_at;
    const count = req.user.role === 'admin'
      ? await db.get(`SELECT COUNT(*) c FROM notifications WHERE audience = 'admin' AND (? IS NULL OR created_at > ?)`, [seenAt, seenAt])
      : await db.get(`SELECT COUNT(*) c FROM notifications WHERE audience = 'customer' AND user_id = ? AND (? IS NULL OR created_at > ?)`, [req.user.id, seenAt, seenAt]);
    res.json({ count: Number(count.c) });
  } catch (e) { next(e); }
});

// POST /api/notifications/mark-seen — called when the person opens their
// notification list; clears the badge from this point forward (persists).
router.post('/mark-seen', async (req, res, next) => {
  try {
    await db.run("UPDATE users SET notif_seen_at = to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS') WHERE id = ?", [req.user.id]);
    res.json({ count: 0 });
  } catch (e) { next(e); }
});

module.exports = router;
