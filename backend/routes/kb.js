const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/kb — public within the app (any logged-in user)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await db.all('SELECT * FROM kb_articles ORDER BY updated_at DESC');
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/kb/:id — increments view count
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM kb_articles WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'ไม่พบบทความ' });
    await db.run('UPDATE kb_articles SET views = views + 1 WHERE id = ?', [row.id]);
    res.json({ ...row, views: row.views + 1 });
  } catch (e) { next(e); }
});

// POST /api/kb — admin only
router.post('/', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'เฉพาะแอดมินเท่านั้น' });
    const { title, body, tag } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'กรุณากรอกหัวข้อและเนื้อหา' });
    const info = await db.run('INSERT INTO kb_articles (title, body, tag) VALUES (?,?,?)', [title, body, tag || 'ทั่วไป']);
    res.status(201).json(await db.get('SELECT * FROM kb_articles WHERE id = ?', [info.lastInsertRowid]));
  } catch (e) { next(e); }
});

// PATCH /api/kb/:id — admin only
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'เฉพาะแอดมินเท่านั้น' });
    const row = await db.get('SELECT * FROM kb_articles WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'ไม่พบบทความ' });
    const fields = ['title', 'body', 'tag'];
    const updates = {};
    fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
    if (setClause) await db.run(`UPDATE kb_articles SET ${setClause}, updated_at = to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS') WHERE id = @id`, { ...updates, id: row.id });
    res.json(await db.get('SELECT * FROM kb_articles WHERE id = ?', [row.id]));
  } catch (e) { next(e); }
});

module.exports = router;
