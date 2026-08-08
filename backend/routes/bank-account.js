const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../lib/notify');

const router = express.Router();
router.use(requireAuth);

const withdrawLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'ขอถอนเงินบ่อยเกินไป กรุณาลองใหม่อีกครั้งในภายหลัง' },
});

const VALID_BANKS = [
  'พร้อมเพย์',
  'ไทยพาณิชย์', 'กสิกรไทย', 'กรุงเทพ', 'กรุงไทย', 'ทีเอ็มบีธนชาต', 'กรุงศรีอยุธยา',
  'เกียรตินาคินภัทร', 'ซีไอเอ็มบีไทย', 'ยูโอบี', 'ทหารไทยธนชาต', 'แลนด์ แอนด์ เฮ้าส์',
  'ออมสิน', 'ธ.ก.ส.', 'อาคารสงเคราะห์', 'เพื่อการส่งออกและนำเข้าแห่งประเทศไทย', 'พัฒนาวิสาหกิจขนาดกลางและขนาดย่อมแห่งประเทศไทย', 'อิสลามแห่งประเทศไทย',
];

// ---------- Bank account (customer) ----------

// GET /api/bank-account/me
router.get('/me', requireRole('customer'), async (req, res, next) => {
  try {
    const account = await db.get('SELECT * FROM bank_accounts WHERE user_id = ?', [req.user.id]);
    res.json(account || null);
  } catch (e) { next(e); }
});

// POST /api/bank-account  { bankName, accountName, accountNumber } — link or replace
router.post('/', requireRole('customer'), async (req, res, next) => {
  try {
    const { bankName, accountName, accountNumber } = req.body || {};
    if (!bankName || !accountName || !accountNumber) return res.status(400).json({ error: 'กรุณากรอกข้อมูลบัญชีธนาคารให้ครบถ้วน' });
    if (!VALID_BANKS.includes(bankName)) return res.status(400).json({ error: 'ไม่พบธนาคารนี้ในรายการ' });
    if (!/^\d{10,15}$/.test(accountNumber.replace(/[-\s]/g, ''))) return res.status(400).json({ error: 'เลขบัญชีต้องเป็นตัวเลข 10-15 หลัก' });

    const cleanNumber = accountNumber.replace(/[-\s]/g, '');
    const existing = await db.get('SELECT id FROM bank_accounts WHERE user_id = ?', [req.user.id]);
    if (existing) {
      await db.run('UPDATE bank_accounts SET bank_name = ?, account_name = ?, account_number = ? WHERE user_id = ?',
        [bankName, accountName, cleanNumber, req.user.id]);
    } else {
      await db.run('INSERT INTO bank_accounts (user_id, bank_name, account_name, account_number) VALUES (?,?,?,?)',
        [req.user.id, bankName, accountName, cleanNumber]);
    }
    res.status(201).json(await db.get('SELECT * FROM bank_accounts WHERE user_id = ?', [req.user.id]));
  } catch (e) { next(e); }
});

// DELETE /api/bank-account
router.delete('/', requireRole('customer'), async (req, res, next) => {
  try {
    await db.run('DELETE FROM bank_accounts WHERE user_id = ?', [req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Withdrawals ----------

// GET /api/bank-account/withdrawals — customer: own; admin: all
router.get('/withdrawals', async (req, res, next) => {
  try {
    const rows = req.user.role === 'admin'
      ? await db.all(`
          SELECT w.*, u.name as customer_name FROM withdrawals w JOIN users u ON u.id = w.user_id
          ORDER BY w.created_at DESC
        `)
      : await db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/bank-account/withdraw  { amount } — customer, must have a linked bank account
router.post('/withdraw', withdrawLimiter, requireRole('customer'), async (req, res, next) => {
  try {
    const amount = Number((req.body || {}).amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'จำนวนเงินไม่ถูกต้อง' });
    if (amount < 100) return res.status(400).json({ error: 'ถอนขั้นต่ำ ฿100' });

    const account = await db.get('SELECT * FROM bank_accounts WHERE user_id = ?', [req.user.id]);
    if (!account) return res.status(400).json({ error: 'กรุณาผูกบัญชีธนาคารก่อนทำการถอนเงิน' });

    const user = await db.get('SELECT wallet_balance FROM users WHERE id = ?', [req.user.id]);
    if (user.wallet_balance < amount) return res.status(400).json({ error: 'ยอดเงินในกระเป๋าเงินไม่เพียงพอ' });

    let withdrawalId;
    try {
      withdrawalId = await db.transaction(async (tx) => {
        await tx.run('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?', [amount, req.user.id]);
        const info = await tx.run('INSERT INTO withdrawals (user_id, amount, bank_name, account_number) VALUES (?,?,?,?)',
          [req.user.id, amount, account.bank_name, account.account_number]);
        await tx.run('INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES (?,?,?,?)',
          [req.user.id, 'purchase', -amount, `ขอถอนเงินไปยังบัญชี ${account.bank_name} (คำขอ #${info.lastInsertRowid})`]);
        return info.lastInsertRowid;
      });
    } catch (e) {
      return res.status(500).json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง' });
    }

    const withdrawal = await db.get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);
    await notify({
      io: req.app.get('io'), audience: 'admin', event: 'withdraw_new',
      vars: { amount: amount.toLocaleString(), bank: account.bank_name }, link: 'finance',
    });
    res.status(201).json(withdrawal);
  } catch (e) { next(e); }
});

// PATCH /api/bank-account/withdrawals/:id  { status } — admin only, approve/reject a withdrawal
router.patch('/withdrawals/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const w = await db.get('SELECT * FROM withdrawals WHERE id = ?', [req.params.id]);
    if (!w) return res.status(404).json({ error: 'ไม่พบคำขอถอนเงิน' });
    if (w.status !== 'รอดำเนินการ') return res.status(400).json({ error: 'คำขอนี้ถูกดำเนินการไปแล้ว' });

    const { status } = req.body || {};
    if (!['โอนเงินแล้ว', 'ปฏิเสธ'].includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });

    await db.transaction(async (tx) => {
      await tx.run("UPDATE withdrawals SET status = ?, processed_at = to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS') WHERE id = ?", [status, w.id]);
      // If rejected, refund the wallet balance that was deducted at request time.
      if (status === 'ปฏิเสธ') {
        await tx.run('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [w.amount, w.user_id]);
        await tx.run('INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES (?,?,?,?)',
          [w.user_id, 'refund', w.amount, `คืนเงิน: คำขอถอนเงิน #${w.id} ถูกปฏิเสธ`]);
      }
    });

    await notify({
      io: req.app.get('io'), userId: w.user_id, audience: 'customer', event: 'withdraw_result',
      vars: {
        amount: w.amount.toLocaleString(), status,
        note: status === 'ปฏิเสธ' ? 'คืนยอดเงินเข้ากระเป๋าเงินแล้ว' : 'โอนเงินเข้าบัญชีเรียบร้อยแล้ว',
      },
      link: 'wallet',
    });
    res.json(await db.get('SELECT * FROM withdrawals WHERE id = ?', [w.id]));
  } catch (e) { next(e); }
});

module.exports = router;
