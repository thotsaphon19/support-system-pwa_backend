const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('customer'));

async function getCart(customerId) {
  const raw = await db.all(`
    SELECT c.id, c.product_id, c.quantity, p.name, p.price, p.compare_at_price, p.icon, p.image_url, p.stock, p.status,
           p.flash_price, p.flash_ends_at
    FROM cart_items c JOIN products p ON p.id = c.product_id
    WHERE c.customer_id = ?
    ORDER BY c.created_at DESC
  `, [customerId]);
  const rows = raw.map(r => {
    const flashActive = Boolean(r.flash_price && r.flash_ends_at && new Date(r.flash_ends_at) > new Date());
    return { ...r, flash_active: flashActive, effective_price: flashActive ? r.flash_price : r.price };
  });
  const total = rows.reduce((sum, r) => sum + r.effective_price * r.quantity, 0);
  return { items: rows, total, itemCount: rows.reduce((s, r) => s + r.quantity, 0) };
}

// GET /api/cart
router.get('/', async (req, res, next) => {
  try { res.json(await getCart(req.user.id)); } catch (e) { next(e); }
});

// POST /api/cart  { productId, quantity }
router.post('/', async (req, res, next) => {
  try {
    const { productId, quantity } = req.body || {};
    const qty = Math.max(1, Number(quantity) || 1);
    const product = await db.get("SELECT * FROM products WHERE id = ? AND status = 'active'", [productId]);
    if (!product) return res.status(404).json({ error: 'ไม่พบสินค้านี้' });
    if (product.stock < qty) return res.status(400).json({ error: 'สินค้าในสต๊อกไม่เพียงพอ' });

    const existing = await db.get('SELECT * FROM cart_items WHERE customer_id = ? AND product_id = ?', [req.user.id, productId]);
    if (existing) {
      await db.run('UPDATE cart_items SET quantity = quantity + ? WHERE id = ?', [qty, existing.id]);
    } else {
      await db.run('INSERT INTO cart_items (customer_id, product_id, quantity) VALUES (?,?,?)', [req.user.id, productId, qty]);
    }
    res.status(201).json(await getCart(req.user.id));
  } catch (e) { next(e); }
});

// PATCH /api/cart/:productId  { quantity }
router.patch('/:productId', async (req, res, next) => {
  try {
    const { quantity } = req.body || {};
    const qty = Number(quantity);
    const item = await db.get('SELECT * FROM cart_items WHERE customer_id = ? AND product_id = ?', [req.user.id, req.params.productId]);
    if (!item) return res.status(404).json({ error: 'ไม่พบสินค้าในตะกร้า' });

    if (qty <= 0) {
      await db.run('DELETE FROM cart_items WHERE id = ?', [item.id]);
    } else {
      await db.run('UPDATE cart_items SET quantity = ? WHERE id = ?', [qty, item.id]);
    }
    res.json(await getCart(req.user.id));
  } catch (e) { next(e); }
});

// DELETE /api/cart/:productId
router.delete('/:productId', async (req, res, next) => {
  try {
    await db.run('DELETE FROM cart_items WHERE customer_id = ? AND product_id = ?', [req.user.id, req.params.productId]);
    res.json(await getCart(req.user.id));
  } catch (e) { next(e); }
});

module.exports = router;
