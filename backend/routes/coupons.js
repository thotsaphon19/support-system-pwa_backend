const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function computeDiscount(coupon, subtotal) {
  let discount = coupon.discount_type === 'percent'
    ? subtotal * (coupon.discount_value / 100)
    : coupon.discount_value;
  if (coupon.max_discount) discount = Math.min(discount, coupon.max_discount);
  return Math.min(discount, subtotal);
}

// GET /api/coupons — admin only, list all coupons
router.get('/', requireRole('admin'), async (req, res, next) => {
  try { res.json(await db.all('SELECT * FROM coupons ORDER BY created_at DESC')); } catch (e) { next(e); }
});

// POST /api/coupons — admin only, create a coupon
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { code, discount_type, discount_value, min_purchase, max_discount, usage_limit, expires_at } = req.body || {};
    if (!code || !discount_type || !discount_value) return res.status(400).json({ error: 'กรุณากรอกโค้ด ประเภทส่วนลด และมูลค่าส่วนลด' });
    if (!['percent', 'fixed'].includes(discount_type)) return res.status(400).json({ error: 'ประเภทส่วนลดไม่ถูกต้อง' });
    if (discount_type === 'percent' && (discount_value <= 0 || discount_value > 100)) return res.status(400).json({ error: 'เปอร์เซ็นต์ส่วนลดต้องอยู่ระหว่าง 1-100' });

    const existing = await db.get('SELECT id FROM coupons WHERE code = ?', [code.toUpperCase()]);
    if (existing) return res.status(409).json({ error: 'มีโค้ดนี้อยู่แล้ว' });

    const info = await db.run(`
      INSERT INTO coupons (code, discount_type, discount_value, min_purchase, max_discount, usage_limit, expires_at)
      VALUES (?,?,?,?,?,?,?)
    `, [code.toUpperCase(), discount_type, Number(discount_value), Number(min_purchase) || 0, max_discount ? Number(max_discount) : null, usage_limit ? Number(usage_limit) : null, expires_at || null]);

    res.status(201).json(await db.get('SELECT * FROM coupons WHERE id = ?', [info.lastInsertRowid]));
  } catch (e) { next(e); }
});

// PATCH /api/coupons/:id — admin only
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const c = await db.get('SELECT * FROM coupons WHERE id = ?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'ไม่พบคูปอง' });
    const fields = ['discount_type', 'discount_value', 'min_purchase', 'max_discount', 'usage_limit', 'expires_at', 'active'];
    const updates = {};
    fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
    if (setClause) await db.run(`UPDATE coupons SET ${setClause} WHERE id = @id`, { ...updates, id: c.id });
    res.json(await db.get('SELECT * FROM coupons WHERE id = ?', [c.id]));
  } catch (e) { next(e); }
});

// DELETE /api/coupons/:id — admin only
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    await db.run('DELETE FROM coupons WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/coupons/validate  { code, subtotal } — customer checks a code before checkout
router.post('/validate', requireRole('customer'), async (req, res, next) => {
  try {
    const { code, subtotal } = req.body || {};
    if (!code) return res.status(400).json({ error: 'กรุณากรอกโค้ดส่วนลด' });

    const coupon = await db.get('SELECT * FROM coupons WHERE code = ? AND active = 1', [String(code).toUpperCase()]);
    if (!coupon) return res.status(404).json({ error: 'ไม่พบโค้ดส่วนลดนี้ หรือถูกปิดใช้งานแล้ว' });
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) return res.status(400).json({ error: 'โค้ดส่วนลดหมดอายุแล้ว' });
    if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) return res.status(400).json({ error: 'โค้ดส่วนลดถูกใช้ครบจำนวนแล้ว' });
    if (subtotal < coupon.min_purchase) return res.status(400).json({ error: `ยอดซื้อขั้นต่ำ ฿${coupon.min_purchase.toLocaleString()} จึงจะใช้โค้ดนี้ได้` });

    const discount = computeDiscount(coupon, subtotal);
    res.json({ code: coupon.code, discount, discount_type: coupon.discount_type, discount_value: coupon.discount_value });
  } catch (e) { next(e); }
});

module.exports = { router, computeDiscount };
