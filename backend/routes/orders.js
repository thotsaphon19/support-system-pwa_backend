const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { computeDiscount } = require('./coupons');
const { generatePromptPayPayload } = require('../lib/promptpay');
const { notify } = require('../lib/notify');

const router = express.Router();
router.use(requireAuth);

const VALID_ORDER_STATUS = ['สั่งซื้อสำเร็จ', 'กำลังจัดเตรียมสินค้า', 'กำลังจัดส่ง', 'จัดส่งสำเร็จ', 'ยกเลิก'];
const VALID_PAYMENT_METHODS = ['กระเป๋าเงิน', 'บัตรเครดิต/เดบิต', 'โอนเงินผ่านธนาคาร'];
const VALID_PAYMENT_STATUS = ['ชำระเงินแล้ว', 'รอตรวจสอบการชำระเงิน'];
const VALID_SHIPPING_METHODS = ['ส่งด่วน', 'Kerry Express', 'DHL', 'Flash Express', 'J&T Express'];

const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'สั่งซื้อบ่อยเกินไป กรุณาลองใหม่อีกครั้งในภายหลัง' },
});

async function orderRow(o) {
  const items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [o.id]);
  const customer = await db.get('SELECT name, phone FROM users WHERE id = ?', [o.customer_id]);
  return { ...o, items, customer_name: customer ? customer.name : 'ไม่ทราบชื่อ' };
}
const orderRows = (rows) => Promise.all(rows.map(orderRow));

// GET /api/orders — customer: own orders; admin: all orders
router.get('/', async (req, res, next) => {
  try {
    const rows = req.user.role === 'admin'
      ? await db.all('SELECT * FROM orders ORDER BY created_at DESC')
      : await db.all('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json(await orderRows(rows));
  } catch (e) { next(e); }
});

// GET /api/orders/:id
router.get('/:id', async (req, res, next) => {
  try {
    const o = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'ไม่พบคำสั่งซื้อ' });
    if (req.user.role === 'customer' && o.customer_id !== req.user.id) return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึง' });
    res.json(await orderRow(o));
  } catch (e) { next(e); }
});

// POST /api/orders  { couponCode?, paymentMethod? } — checkout: turns the customer's cart into an order.
// Wrapped in a DB transaction so stock/wallet/coupon changes and order creation either all
// succeed together or all roll back (e.g. if stock runs out or a coupon becomes invalid mid-checkout).
router.post('/', checkoutLimiter, requireRole('customer'), async (req, res, next) => {
  try {
    const { couponCode, paymentMethod, shippingMethod } = req.body || {};
    const method = paymentMethod && VALID_PAYMENT_METHODS.includes(paymentMethod) ? paymentMethod : 'กระเป๋าเงิน';
    const shipping = shippingMethod && VALID_SHIPPING_METHODS.includes(shippingMethod) ? shippingMethod : 'ส่งด่วน';

    const rawCartItems = await db.all(`
      SELECT c.product_id, c.quantity, p.name, p.price, p.icon, p.stock, p.status, p.flash_price, p.flash_ends_at
      FROM cart_items c JOIN products p ON p.id = c.product_id
      WHERE c.customer_id = ?
    `, [req.user.id]);
    const cartItems = rawCartItems.map(i => {
      const flashActive = Boolean(i.flash_price && i.flash_ends_at && new Date(i.flash_ends_at) > new Date());
      return { ...i, effective_price: flashActive ? i.flash_price : i.price };
    });

    if (cartItems.length === 0) return res.status(400).json({ error: 'ตะกร้าสินค้าว่างเปล่า' });

    for (const item of cartItems) {
      if (item.status !== 'active') return res.status(400).json({ error: `สินค้า "${item.name}" ไม่พร้อมจำหน่ายแล้ว` });
      if (item.stock < item.quantity) return res.status(400).json({ error: `สินค้า "${item.name}" มีไม่เพียงพอในสต๊อก` });
    }

    const subtotal = cartItems.reduce((sum, i) => sum + i.effective_price * i.quantity, 0);

    // Validate + compute coupon discount (re-checked here, not trusted from the client)
    let discount = 0;
    let appliedCoupon = null;
    if (couponCode) {
      appliedCoupon = await db.get('SELECT * FROM coupons WHERE code = ? AND active = 1', [String(couponCode).toUpperCase()]);
      if (!appliedCoupon) return res.status(400).json({ error: 'ไม่พบโค้ดส่วนลดนี้ หรือถูกปิดใช้งานแล้ว' });
      if (appliedCoupon.expires_at && new Date(appliedCoupon.expires_at) < new Date()) return res.status(400).json({ error: 'โค้ดส่วนลดหมดอายุแล้ว' });
      if (appliedCoupon.usage_limit && appliedCoupon.used_count >= appliedCoupon.usage_limit) return res.status(400).json({ error: 'โค้ดส่วนลดถูกใช้ครบจำนวนแล้ว' });
      if (subtotal < appliedCoupon.min_purchase) return res.status(400).json({ error: `ยอดซื้อขั้นต่ำ ฿${appliedCoupon.min_purchase.toLocaleString()} จึงจะใช้โค้ดนี้ได้` });
      discount = computeDiscount(appliedCoupon, subtotal);
    }

    const total = Math.max(0, subtotal - discount);
    const payingByWallet = method === 'กระเป๋าเงิน';

    if (payingByWallet) {
      const user = await db.get('SELECT wallet_balance FROM users WHERE id = ?', [req.user.id]);
      if (user.wallet_balance < total) {
        return res.status(400).json({ error: 'ยอดเงินในกระเป๋าเงินไม่เพียงพอ กรุณาเติมเงินหรือเลือกช่องทางชำระเงินอื่น' });
      }
    }

    const pointsEarned = Math.floor(total / 100); // 1 point per 100 baht spent
    const orderId = 'ORD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const paymentStatus = payingByWallet ? 'ชำระเงินแล้ว' : 'รอตรวจสอบการชำระเงิน';

    try {
      await db.transaction(async (tx) => {
        await tx.run(`
          INSERT INTO orders (id, customer_id, subtotal, discount_amount, coupon_code, total, points_earned, status, payment_method, payment_status, shipping_method)
          VALUES (?,?,?,?,?,?,?, 'สั่งซื้อสำเร็จ', ?, ?, ?)
        `, [orderId, req.user.id, subtotal, discount, appliedCoupon ? appliedCoupon.code : null, total, pointsEarned, method, paymentStatus, shipping]);

        for (const item of cartItems) {
          await tx.run(`
            INSERT INTO order_items (order_id, product_id, product_name, product_icon, quantity, price)
            VALUES (?,?,?,?,?,?)
          `, [orderId, item.product_id, item.name, item.icon, item.quantity, item.effective_price]);
          await tx.run('UPDATE products SET stock = stock - ?, sold_count = sold_count + ? WHERE id = ?',
            [item.quantity, item.quantity, item.product_id]);
        }

        if (appliedCoupon) {
          await tx.run('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?', [appliedCoupon.id]);
        }

        if (payingByWallet) {
          await tx.run('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?', [total, req.user.id]);
          await tx.run('INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES (?,?,?,?)',
            [req.user.id, 'purchase', -total, `ชำระค่าสินค้า คำสั่งซื้อ ${orderId}`]);
        }
        // Points are earned on every completed order regardless of payment method.
        await tx.run('UPDATE users SET points_balance = points_balance + ? WHERE id = ?', [pointsEarned, req.user.id]);
        await tx.run('INSERT INTO wallet_transactions (user_id, type, points, description) VALUES (?,?,?,?)',
          [req.user.id, 'points_earned', pointsEarned, `ได้รับแต้มจากคำสั่งซื้อ ${orderId}`]);

        await tx.run('DELETE FROM cart_items WHERE customer_id = ?', [req.user.id]);
      });
    } catch (e) {
      console.error('[orders] checkout transaction failed', e);
      return res.status(500).json({ error: 'เกิดข้อผิดพลาดระหว่างสั่งซื้อ กรุณาลองใหม่อีกครั้ง' });
    }

    const order = await orderRow(await db.get('SELECT * FROM orders WHERE id = ?', [orderId]));
    const io = req.app.get('io');
    if (io) io.to('admins').emit('order:new', order);
    await notify({
      io, audience: 'admin', event: 'order_new_admin',
      vars: { customerName: order.customer_name, amount: total.toLocaleString() }, link: 'storeOrders',
    });
    await notify({
      io, userId: req.user.id, audience: 'customer', event: 'order_placed',
      vars: { orderId, amount: total.toLocaleString() }, link: 'orders',
    });

    res.status(201).json(order);
  } catch (e) { next(e); }
});

// PATCH /api/orders/:id  { status?, payment_status? } — admin only
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const o = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'ไม่พบคำสั่งซื้อ' });

    const { status, payment_status } = req.body || {};
    if (status !== undefined && !VALID_ORDER_STATUS.includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
    if (payment_status !== undefined && !VALID_PAYMENT_STATUS.includes(payment_status)) return res.status(400).json({ error: 'สถานะการชำระเงินไม่ถูกต้อง' });
    if (status === undefined && payment_status === undefined) return res.status(400).json({ error: 'ไม่มีข้อมูลให้อัปเดต' });

    const updates = {};
    if (status !== undefined) updates.status = status;
    if (payment_status !== undefined) updates.payment_status = payment_status;
    const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
    await db.run(`UPDATE orders SET ${setClause} WHERE id = @id`, { ...updates, id: o.id });

    const updated = await orderRow(await db.get('SELECT * FROM orders WHERE id = ?', [o.id]));

    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('order:update', updated);
      io.to('customer:' + o.customer_id).emit('order:update', updated);
    }
    if (status !== undefined) {
      await notify({
        io, userId: o.customer_id, audience: 'customer', event: 'order_status',
        vars: { status, orderId: o.id }, link: 'orders',
      });
    }
    if (payment_status !== undefined) {
      await notify({
        io, userId: o.customer_id, audience: 'customer', event: 'payment_status',
        vars: { status: payment_status, orderId: o.id }, link: 'orders',
      });
    }

    res.json(updated);
  } catch (e) { next(e); }
});

// GET /api/orders/:id/promptpay-qr — real, scannable PromptPay QR payload for this order's
// outstanding amount. Requires the shop's PromptPay ID to be set in settings.
router.get('/:id/promptpay-qr', async (req, res, next) => {
  try {
    const o = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'ไม่พบคำสั่งซื้อ' });
    if (req.user.role === 'customer' && o.customer_id !== req.user.id) return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึง' });
    if (o.payment_status !== 'รอตรวจสอบการชำระเงิน') return res.status(400).json({ error: 'คำสั่งซื้อนี้ชำระเงินแล้ว' });

    const settingsRows = await db.all("SELECT key, value FROM settings WHERE key IN ('promptpay_id','promptpay_name')");
    const s = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
    if (!s.promptpay_id) return res.status(400).json({ error: 'ร้านค้ายังไม่ได้ตั้งค่าเลขพร้อมเพย์ กรุณาติดต่อผู้ดูแลระบบ' });

    try {
      const payload = generatePromptPayPayload(s.promptpay_id, o.total);
      res.json({ payload, amount: o.total, merchantName: s.promptpay_name || '' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  } catch (e) { next(e); }
});

// POST /api/orders/:id/slip  { url } — customer uploads their payment slip image (after
// paying the PromptPay QR / bank transfer). Does not auto-confirm payment — it notifies
// admins immediately so they can verify and confirm it in the back office.
router.post('/:id/slip', requireRole('customer'), async (req, res, next) => {
  try {
    const o = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'ไม่พบคำสั่งซื้อ' });
    if (o.customer_id !== req.user.id) return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึง' });
    if (o.payment_status !== 'รอตรวจสอบการชำระเงิน') return res.status(400).json({ error: 'คำสั่งซื้อนี้ชำระเงินแล้ว' });

    const { url } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'กรุณาอัปโหลดรูปสลิปการโอนเงิน' });

    await db.run('UPDATE orders SET payment_slip_url = ? WHERE id = ?', [url, o.id]);
    const updated = await orderRow(await db.get('SELECT * FROM orders WHERE id = ?', [o.id]));

    const io = req.app.get('io');
    if (io) io.to('admins').emit('order:slip-uploaded', updated);
    await notify({
      io, audience: 'admin', event: 'payment_slip',
      vars: { customerName: updated.customer_name, orderId: o.id, amount: o.total.toLocaleString() }, link: 'storeOrders',
    });

    res.json(updated);
  } catch (e) { next(e); }
});

module.exports = router;
