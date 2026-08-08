const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { computeVipTier, normalizeTiers } = require('../lib/vipTier');

const router = express.Router();
router.use(requireAuth, requireRole('customer'));

// GET /api/wallet — balance + recent transactions + VIP tier + lifetime stat breakdown
router.get('/', async (req, res, next) => {
  try {
    const user = await db.get('SELECT wallet_balance, points_balance FROM users WHERE id = ?', [req.user.id]);
    const transactions = await db.all('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30', [req.user.id]);
    const spend = await db.get("SELECT COALESCE(SUM(total),0) s FROM orders WHERE customer_id = ? AND status != 'ยกเลิก'", [req.user.id]);
    const tierSetting = await db.get("SELECT value FROM settings WHERE key = 'vip_tiers'");
    let customTiers = null;
    try { customTiers = tierSetting ? JSON.parse(tierSetting.value) : null; } catch (e) { customTiers = null; }
    const vip = computeVipTier(Number(spend.s), normalizeTiers(customTiers));

    const totalTopup = (await db.get("SELECT COALESCE(SUM(amount),0) s FROM wallet_transactions WHERE user_id = ? AND type = 'topup'", [req.user.id])).s;
    const totalWithdrawn = (await db.get("SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE user_id = ? AND status = 'โอนเงินแล้ว'", [req.user.id])).s;
    const pendingWithdrawal = (await db.get("SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE user_id = ? AND status = 'รอดำเนินการ'", [req.user.id])).s;

    res.json({
      walletBalance: user.wallet_balance,
      pointsBalance: user.points_balance,
      transactions,
      vip,
      stats: { totalTopup: Number(totalTopup), totalWithdrawn: Number(totalWithdrawn), pendingWithdrawal: Number(pendingWithdrawal) },
    });
  } catch (e) { next(e); }
});

// POST /api/wallet/topup  { amount }
// Demo-only top-up (no real payment gateway wired in) — instantly credits the wallet.
// A real deployment would replace this with a payment provider webhook confirming
// payment before crediting.
router.post('/topup', async (req, res, next) => {
  try {
    const amount = Number((req.body || {}).amount);
    if (!amount || amount <= 0 || amount > 100000) return res.status(400).json({ error: 'จำนวนเงินไม่ถูกต้อง' });

    await db.transaction(async (tx) => {
      await tx.run('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [amount, req.user.id]);
      await tx.run('INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES (?,?,?,?)',
        [req.user.id, 'topup', amount, `เติมเงินเข้ากระเป๋าเงิน ${amount.toLocaleString()} บาท`]);
    });

    const user = await db.get('SELECT wallet_balance, points_balance FROM users WHERE id = ?', [req.user.id]);
    res.json({ walletBalance: user.wallet_balance, pointsBalance: user.points_balance });
  } catch (e) { next(e); }
});

module.exports = router;
