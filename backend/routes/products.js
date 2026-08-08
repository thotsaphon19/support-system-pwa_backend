const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const NOW_EXPR = `to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')`;

async function productRow(p) {
  const category = p.category_id ? await db.get('SELECT id, name, icon FROM categories WHERE id = ?', [p.category_id]) : null;
  const flashActive = Boolean(p.flash_price && p.flash_ends_at && new Date(p.flash_ends_at) > new Date());
  return { ...p, category, flash_active: flashActive, effective_price: flashActive ? p.flash_price : p.price };
}
const productRows = (rows) => Promise.all(rows.map(productRow));

// GET /api/products/flash-sale — active flash-sale products only
router.get('/flash-sale', requireAuth, async (req, res, next) => {
  try {
    // Cast to timestamptz for the comparison instead of comparing raw text: flash_ends_at
    // is stored as an ISO string (e.g. "2026-08-07T01:00:00.000Z") while NOW_EXPR is
    // formatted differently ("YYYY-MM-DD HH24:MI:SS") — comparing those as plain text
    // instead of real timestamps could sort them incorrectly, which is exactly the kind
    // of thing that quietly makes an active flash-sale item fail to show up (or an
    // expired one linger). Casting both sides removes that ambiguity entirely.
    const rows = await db.all(`SELECT * FROM products WHERE status = 'active' AND flash_price IS NOT NULL AND flash_ends_at IS NOT NULL AND flash_ends_at::timestamptz > now()`);
    res.json(await productRows(rows));
  } catch (e) { next(e); }
});

// GET /api/products — public within the app (any logged-in user). Supports ?category=&q=
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { category, q } = req.query;
    let rows = await db.all("SELECT * FROM products WHERE status = 'active' ORDER BY created_at DESC");
    if (category) rows = rows.filter(p => String(p.category_id) === String(category));
    if (q) {
      const s = q.toLowerCase();
      rows = rows.filter(p => p.name.toLowerCase().includes(s) || (p.description || '').toLowerCase().includes(s));
    }
    res.json(await productRows(rows));
  } catch (e) { next(e); }
});

// GET /api/products/all — admin view, includes hidden products too
router.get('/all', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await db.all('SELECT * FROM products ORDER BY created_at DESC');
    res.json(await productRows(rows));
  } catch (e) { next(e); }
});

// GET /api/products/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const p = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'ไม่พบสินค้า' });
    res.json(await productRow(p));
  } catch (e) { next(e); }
});

// POST /api/products — admin only
router.post('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { name, description, price, compare_at_price, category_id, icon, image_url, stock, flash_price, flash_ends_at } = req.body || {};
    if (!name || price === undefined) return res.status(400).json({ error: 'กรุณากรอกชื่อสินค้าและราคา' });
    if (name.length > 200) return res.status(400).json({ error: 'ชื่อสินค้ายาวเกินไป' });
    if (Number(price) < 0) return res.status(400).json({ error: 'ราคาต้องไม่ติดลบ' });
    if (flash_price && Number(flash_price) >= Number(price)) return res.status(400).json({ error: 'ราคาแฟลชเซลต้องต่ำกว่าราคาปกติ' });

    const info = await db.run(`
      INSERT INTO products (category_id, name, description, price, compare_at_price, icon, image_url, stock, flash_price, flash_ends_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `, [category_id || null, name, description || '', Number(price), compare_at_price ? Number(compare_at_price) : null, icon || '📦', image_url || null, Number(stock) || 0, flash_price ? Number(flash_price) : null, flash_ends_at || null]);

    const p = await db.get('SELECT * FROM products WHERE id = ?', [info.lastInsertRowid]);
    res.status(201).json(await productRow(p));
  } catch (e) { next(e); }
});

// PATCH /api/products/:id — admin only
router.patch('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const p = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'ไม่พบสินค้า' });

    const fields = ['name', 'description', 'price', 'compare_at_price', 'category_id', 'icon', 'image_url', 'stock', 'status', 'flash_price', 'flash_ends_at'];
    const updates = {};
    fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    if (updates.status && !['active', 'hidden'].includes(updates.status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
    if (updates.price !== undefined && Number(updates.price) < 0) return res.status(400).json({ error: 'ราคาต้องไม่ติดลบ' });
    // Same check the create route runs — without it, editing just the regular price on a
    // product that already has a flash price could silently leave flash_price >= price,
    // which would make it fail the flash-sale query's implicit assumptions.
    {
      const effectivePrice = updates.price !== undefined ? Number(updates.price) : Number(p.price);
      const effectiveFlashPrice = updates.flash_price !== undefined ? updates.flash_price : p.flash_price;
      if (effectiveFlashPrice && Number(effectiveFlashPrice) >= effectivePrice) {
        return res.status(400).json({ error: 'ราคาแฟลชเซลต้องต่ำกว่าราคาปกติ' });
      }
    }
    if (updates.name && updates.name.length > 200) return res.status(400).json({ error: 'ชื่อสินค้ายาวเกินไป' });

    const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
    if (setClause) await db.run(`UPDATE products SET ${setClause}, updated_at = ${NOW_EXPR} WHERE id = @id`, { ...updates, id: p.id });

    res.json(await productRow(await db.get('SELECT * FROM products WHERE id = ?', [p.id])));
  } catch (e) { next(e); }
});

// DELETE /api/products/:id — admin only
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const p = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'ไม่พบสินค้า' });
    await db.run('DELETE FROM products WHERE id = ?', [p.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
