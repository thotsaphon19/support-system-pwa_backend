const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { revokeAllForUser } = require('../lib/tokens');
const { notify } = require('../lib/notify');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/', async (req, res, next) => {
  try {
    const { q } = req.query;
    let rows = await db.all("SELECT id, name, phone, username, wallet_balance, account_status, created_at FROM users WHERE role = 'customer'");
    const stats = await db.all(`
      SELECT customer_id, COUNT(*) as ticket_count
      FROM tickets GROUP BY customer_id
    `);
    const statMap = Object.fromEntries(stats.map(s => [s.customer_id, Number(s.ticket_count)]));
    rows = rows.map(c => ({ ...c, ticket_count: statMap[c.id] || 0 }));
    if (q) {
      const s = q.toLowerCase();
      rows = rows.filter(c => c.name.toLowerCase().includes(s) || (c.phone || '').includes(s));
    }
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/customers/:id — full detail for the admin edit panel: profile, wallet
// balance and account status, plus recent wallet transactions (so the admin can
// see the effect of every top-up/deduction they make, and any the customer made themselves).
router.get('/:id', async (req, res, next) => {
  try {
    const c = await db.get(
      "SELECT id, name, phone, username, wallet_balance, account_status, created_at FROM users WHERE id = ? AND role = 'customer'",
      [req.params.id]
    );
    if (!c) return res.status(404).json({ error: 'ไม่พบลูกค้า' });
    const ticketCount = (await db.get('SELECT COUNT(*) c FROM tickets WHERE customer_id = ?', [req.params.id])).c;
    const transactions = await db.all(
      'SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    );
    res.json({ ...c, ticket_count: Number(ticketCount), transactions });
  } catch (e) { next(e); }
});

const WALLET_CATEGORIES = ['เติมเงิน', 'ค่าคอมมิชชั่น', 'โบนัส', 'หักยอดเงิน', 'ปรับปรุงยอด'];

// POST /api/customers/:id/wallet — admin credits or debits a customer's wallet
// directly (top-up, commission payout, bonus, or a correction/deduction). Always
// goes through a transaction so the balance and the transaction log never drift
// apart, and a debit is rejected outright if it would take the balance negative.
router.post('/:id/wallet', requirePermission('finance'), async (req, res, next) => {
  try {
    const customer = await db.get("SELECT id, name, wallet_balance FROM users WHERE id = ? AND role = 'customer'", [req.params.id]);
    if (!customer) return res.status(404).json({ error: 'ไม่พบลูกค้า' });

    const { direction, category, note } = req.body || {};
    const amount = Number((req.body || {}).amount);

    if (!['credit', 'debit'].includes(direction)) return res.status(400).json({ error: 'กรุณาระบุประเภทรายการ (เติม/หัก)' });
    if (!category || !WALLET_CATEGORIES.includes(category)) return res.status(400).json({ error: 'หมวดหมู่รายการไม่ถูกต้อง' });
    if (!amount || amount <= 0 || amount > 1000000) return res.status(400).json({ error: 'จำนวนเงินไม่ถูกต้อง' });
    if (direction === 'debit' && Number(customer.wallet_balance) < amount) {
      return res.status(400).json({ error: `ยอดเงินคงเหลือของลูกค้าไม่เพียงพอ (คงเหลือ ฿${Number(customer.wallet_balance).toLocaleString()})` });
    }

    const signedAmount = direction === 'credit' ? amount : -amount;
    const description = `${category}${note ? ' - ' + String(note).trim() : ''} (ปรับโดยเจ้าหน้าที่ ${req.user.name})`;

    const txRow = await db.transaction(async (tx) => {
      await tx.run('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [signedAmount, req.params.id]);
      const inserted = await tx.run(
        'INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES (?,?,?,?) RETURNING *',
        [req.params.id, direction === 'credit' ? 'admin_credit' : 'admin_debit', signedAmount, description]
      );
      return inserted.rows[0];
    });

    const updated = await db.get('SELECT wallet_balance FROM users WHERE id = ?', [req.params.id]);

    const io = req.app.get('io');
    if (io) {
      io.to('customer:' + req.params.id).emit('wallet:update', { walletBalance: updated.wallet_balance, transaction: txRow });
    }
    await notify({
      io, userId: req.params.id, audience: 'customer',
      event: direction === 'credit' ? 'wallet_credit' : 'wallet_debit',
      vars: { amount: amount.toLocaleString(), description, balance: Number(updated.wallet_balance).toLocaleString() }, link: 'wallet',
    });

    res.json({ walletBalance: updated.wallet_balance, transaction: txRow });
  } catch (e) { next(e); }
});

// PATCH /api/customers/:id/status — freeze/unfreeze a customer's account. Freezing
// now represents "processing a full withdrawal": it zeroes the customer's wallet
// balance out (logged as a normal wallet transaction, same as any other admin
// adjustment, so it shows up in their history), immediately revokes their refresh
// tokens (forced to re-authenticate, and login is blocked while frozen — see
// routes/auth.js), and pushes a realtime notice so an already-open session logs
// itself out right away instead of waiting for its short-lived access token to expire.
router.patch('/:id/status', requirePermission('finance'), async (req, res, next) => {
  try {
    const customer = await db.get("SELECT id, name, wallet_balance FROM users WHERE id = ? AND role = 'customer'", [req.params.id]);
    if (!customer) return res.status(404).json({ error: 'ไม่พบลูกค้า' });

    const { status } = req.body || {};
    if (!['ปกติ', 'แช่แข็ง'].includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });

    const io = req.app.get('io');
    let clearedTx = null;

    if (status === 'แช่แข็ง' && Number(customer.wallet_balance) > 0) {
      const balance = Number(customer.wallet_balance);
      clearedTx = await db.transaction(async (tx) => {
        await tx.run('UPDATE users SET wallet_balance = 0, account_status = ? WHERE id = ?', [status, req.params.id]);
        const inserted = await tx.run(
          'INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES (?,?,?,?) RETURNING *',
          [req.params.id, 'admin_debit', -balance, `ล้างยอดเงินทั้งหมด — ดำเนินการถอนเงิน (ปรับโดยเจ้าหน้าที่ ${req.user.name})`]
        );
        return inserted.rows[0];
      });
      if (io) io.to('customer:' + req.params.id).emit('wallet:update', { walletBalance: 0, transaction: clearedTx });
    } else {
      await db.run('UPDATE users SET account_status = ? WHERE id = ?', [status, req.params.id]);
    }

    if (status === 'แช่แข็ง') {
      await revokeAllForUser(req.params.id);
      if (io) io.to('customer:' + req.params.id).emit('account:frozen', { message: 'บัญชีของคุณอยู่ระหว่างดำเนินการถอนเงิน กรุณาติดต่อผู้ดูแลระบบ' });
    }
    await notify({
      io, userId: req.params.id, audience: 'customer',
      event: status === 'แช่แข็ง' ? 'account_frozen' : 'account_unfrozen',
      link: 'profile',
    });

    const row = await db.get('SELECT id, name, phone, username, wallet_balance, account_status, created_at FROM users WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (e) { next(e); }
});

// POST /api/customers — admin creates a new customer account directly (no referral needed).
router.post('/', async (req, res, next) => {
  try {
    const { username, password, name, phone } = req.body || {};
    if (!username || !password || !name) return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้ รหัสผ่าน และชื่อลูกค้า' });
    if (String(password).length < 6) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });

    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return res.status(409).json({ error: 'มีชื่อผู้ใช้นี้อยู่แล้ว' });

    const hash = bcrypt.hashSync(password, 10);
    let referralCode;
    do {
      referralCode = String(Math.floor(10000 + Math.random() * 90000));
    } while (await db.get('SELECT id FROM users WHERE referral_code = ?', [referralCode]));

    // Admin-created accounts skip the normal "enter a friend's code" requirement,
    // but should still end up linked to *someone* (for a consistent "รหัสผู้แนะนำ"
    // field) rather than showing "ไม่มี" — pick a random existing customer to credit
    // as the referrer. No reward is paid out for this (it isn't a real referral,
    // just backfilling the relationship), matching how the admin-bootstrap referral
    // code in routes/referrals.js also never pays a reward.
    const randomReferrer = await db.get(
      "SELECT id FROM users WHERE role = 'customer' ORDER BY RANDOM() LIMIT 1"
    );

    const userId = await db.transaction(async (tx) => {
      const info = await tx.run(
        'INSERT INTO users (role, username, password_hash, name, phone, referral_code, referred_by_user_id) VALUES (?,?,?,?,?,?,?)',
        ['customer', username, hash, name, phone || null, referralCode, randomReferrer ? randomReferrer.id : null]
      );
      await tx.run('INSERT INTO conversations (customer_id) VALUES (?)', [info.lastInsertRowid]);
      return info.lastInsertRowid;
    });

    const row = await db.get('SELECT id, name, phone, username, wallet_balance, account_status, created_at FROM users WHERE id = ?', [userId]);
    res.status(201).json({ ...row, ticket_count: 0 });
  } catch (e) { next(e); }
});

// PUT /api/customers/:id — edit name/phone/username, optionally reset password.
router.put('/:id', async (req, res, next) => {
  try {
    const customer = await db.get("SELECT id FROM users WHERE id = ? AND role = 'customer'", [req.params.id]);
    if (!customer) return res.status(404).json({ error: 'ไม่พบลูกค้า' });

    const { name, phone, username, password } = req.body || {};
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อลูกค้า' });

    if (username !== undefined && username) {
      const clash = await db.get('SELECT id FROM users WHERE username = ? AND id != ?', [username, req.params.id]);
      if (clash) return res.status(409).json({ error: 'มีชื่อผู้ใช้นี้อยู่แล้ว' });
      await db.run('UPDATE users SET username = ? WHERE id = ?', [username, req.params.id]);
    }
    if (name !== undefined) await db.run('UPDATE users SET name = ? WHERE id = ?', [name, req.params.id]);
    if (phone !== undefined) await db.run('UPDATE users SET phone = ? WHERE id = ?', [phone || null, req.params.id]);
    if (password) {
      if (String(password).length < 6) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(password, 10), req.params.id]);
    }

    const row = await db.get('SELECT id, name, phone, username, wallet_balance, account_status, created_at FROM users WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (e) { next(e); }
});

// DELETE /api/customers/:id — refuses if the account still has related records
// (orders, tickets, etc.) so removing a customer can never silently orphan/corrupt data.
router.delete('/:id', async (req, res, next) => {
  try {
    const customer = await db.get("SELECT id FROM users WHERE id = ? AND role = 'customer'", [req.params.id]);
    if (!customer) return res.status(404).json({ error: 'ไม่พบลูกค้า' });

    await db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    if (e && (e.code === '23503' || /foreign key/i.test(e.message || ''))) {
      return res.status(409).json({ error: 'ไม่สามารถลบลูกค้ารายนี้ได้ เนื่องจากมีคำสั่งซื้อ/ประวัติการใช้งานอยู่ในระบบ' });
    }
    next(e);
  }
});

module.exports = router;
