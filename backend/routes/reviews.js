const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function refreshProductRatingStats(productId) {
  const stats = await db.get('SELECT AVG(rating) avg, COUNT(*) c FROM reviews WHERE product_id = ?', [productId]);
  const count = Number(stats.c);
  const rating = count > 0 ? Math.round(Number(stats.avg) * 10) / 10 : 4.8;
  await db.run('UPDATE products SET rating = ?, review_count = ? WHERE id = ?', [rating, count, productId]);
}

// GET /api/reviews/all — admin only, all reviews across all products
router.get('/all', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await db.all(`
      SELECT r.*, u.name as customer_name, p.name as product_name
      FROM reviews r
      JOIN users u ON u.id = r.customer_id
      JOIN products p ON p.id = r.product_id
      ORDER BY r.created_at DESC
    `);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/reviews/product/:productId — public within the app, list reviews for a product
router.get('/product/:productId', async (req, res, next) => {
  try {
    const rows = await db.all(`
      SELECT r.*, u.name as customer_name
      FROM reviews r JOIN users u ON u.id = r.customer_id
      WHERE r.product_id = ?
      ORDER BY r.created_at DESC
    `, [req.params.productId]);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/reviews/reviewable — customer: which of their purchased products can still be reviewed
router.get('/reviewable', requireRole('customer'), async (req, res, next) => {
  try {
    const rows = await db.all(`
      SELECT DISTINCT oi.product_id, oi.product_name, oi.product_icon, o.id as order_id, o.created_at
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.customer_id = ?
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.product_id = oi.product_id AND r.order_id = o.id AND r.customer_id = ?)
      ORDER BY o.created_at DESC
    `, [req.user.id, req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/reviews  { productId, orderId, rating, comment } — customer, must have purchased it
router.post('/', requireRole('customer'), async (req, res, next) => {
  try {
    const { productId, orderId, rating, comment } = req.body || {};
    const ratingNum = Number(rating);
    if (!productId || !orderId || !ratingNum || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: 'กรุณาให้คะแนน 1-5 ดาว และระบุสินค้า/คำสั่งซื้อ' });
    }

    const order = await db.get('SELECT * FROM orders WHERE id = ? AND customer_id = ?', [orderId, req.user.id]);
    if (!order) return res.status(403).json({ error: 'ไม่พบคำสั่งซื้อนี้ของคุณ' });

    const purchased = await db.get('SELECT 1 FROM order_items WHERE order_id = ? AND product_id = ?', [orderId, productId]);
    if (!purchased) return res.status(400).json({ error: 'คุณยังไม่ได้ซื้อสินค้านี้ในคำสั่งซื้อนี้' });

    const existing = await db.get('SELECT id FROM reviews WHERE product_id = ? AND order_id = ?', [productId, orderId]);
    if (existing) return res.status(409).json({ error: 'คุณรีวิวสินค้านี้จากคำสั่งซื้อนี้ไปแล้ว' });

    const info = await db.run('INSERT INTO reviews (product_id, customer_id, order_id, rating, comment) VALUES (?,?,?,?,?)',
      [productId, req.user.id, orderId, ratingNum, (comment || '').slice(0, 1000)]);

    await refreshProductRatingStats(productId);

    const review = await db.get(`
      SELECT r.*, u.name as customer_name FROM reviews r JOIN users u ON u.id = r.customer_id WHERE r.id = ?
    `, [info.lastInsertRowid]);
    res.status(201).json(review);
  } catch (e) { next(e); }
});

// DELETE /api/reviews/:id — admin can moderate/remove a review, or the author can delete their own
router.delete('/:id', async (req, res, next) => {
  try {
    const review = await db.get('SELECT * FROM reviews WHERE id = ?', [req.params.id]);
    if (!review) return res.status(404).json({ error: 'ไม่พบรีวิว' });
    if (req.user.role !== 'admin' && review.customer_id !== req.user.id) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์ลบรีวิวนี้' });
    }
    await db.run('DELETE FROM reviews WHERE id = ?', [review.id]);
    await refreshProductRatingStats(review.product_id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
