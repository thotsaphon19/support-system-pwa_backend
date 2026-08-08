const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const all = await db.all('SELECT * FROM categories ORDER BY sort_order ASC, id ASC');
    if (req.query.tree === 'true') {
      const byParent = {};
      all.forEach(c => { byParent[c.parent_id || 'root'] = byParent[c.parent_id || 'root'] || []; byParent[c.parent_id || 'root'].push(c); });
      const attachChildren = (c) => ({ ...c, children: (byParent[c.id] || []).map(attachChildren) });
      return res.json((byParent.root || []).map(attachChildren));
    }
    res.json(all);
  } catch (e) { next(e); }
});

router.post('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { name, icon, sort_order, parent_id } = req.body || {};
    if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อหมวดหมู่' });
    const info = await db.run('INSERT INTO categories (name, icon, sort_order, parent_id) VALUES (?,?,?,?)',
      [name, icon || '🛍️', sort_order || 0, parent_id || null]);
    res.status(201).json(await db.get('SELECT * FROM categories WHERE id = ?', [info.lastInsertRowid]));
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const cat = await db.get('SELECT * FROM categories WHERE id = ?', [req.params.id]);
    if (!cat) return res.status(404).json({ error: 'ไม่พบหมวดหมู่' });
    if (req.body.parent_id !== undefined && Number(req.body.parent_id) === cat.id) {
      return res.status(400).json({ error: 'หมวดหมู่ไม่สามารถเป็นหมวดหมู่ย่อยของตัวเองได้' });
    }
    const fields = ['name', 'icon', 'sort_order', 'parent_id'];
    const updates = {};
    fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
    if (setClause) await db.run(`UPDATE categories SET ${setClause} WHERE id = @id`, { ...updates, id: cat.id });
    res.json(await db.get('SELECT * FROM categories WHERE id = ?', [cat.id]));
  } catch (e) { next(e); }
});

router.delete('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const cat = await db.get('SELECT * FROM categories WHERE id = ?', [req.params.id]);
    if (!cat) return res.status(404).json({ error: 'ไม่พบหมวดหมู่' });
    await db.run('UPDATE products SET category_id = NULL WHERE category_id = ?', [cat.id]);
    await db.run('UPDATE categories SET parent_id = NULL WHERE parent_id = ?', [cat.id]);
    await db.run('DELETE FROM categories WHERE id = ?', [cat.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
