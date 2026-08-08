const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    res.json(await db.all('SELECT * FROM announcements ORDER BY created_at DESC'));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'เฉพาะแอดมินเท่านั้น' });
    const { title, body, icon } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'กรุณากรอกหัวข้อและเนื้อหา' });
    const info = await db.run('INSERT INTO announcements (title, body, icon) VALUES (?,?,?)', [title, body, icon || '📢']);
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [info.lastInsertRowid]);
    req.app.get('io').emit('announcement:new', row);
    res.status(201).json(row);
  } catch (e) { next(e); }
});

module.exports = router;
