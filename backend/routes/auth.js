const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken, revokeAllForUser } = require('../lib/tokens');
const { upload: mediaUpload, saveFileToMedia } = require('./upload');

const router = express.Router();

// Rate limit login/register attempts to slow down brute-force/credential-stuffing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20,                 // 20 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่อีกครั้งในภายหลัง' },
});

// POST /api/auth/login  { username, password }
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });

    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
    if (user.role === 'customer' && user.account_status === 'แช่แข็ง') {
      return res.status(403).json({ error: 'บัญชีของคุณอยู่ระหว่างดำเนินการถอนเงิน กรุณาติดต่อผู้ดูแลระบบ', code: 'ACCOUNT_FROZEN' });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);
    res.json({
      token: accessToken,
      refreshToken,
      user: {
        id: user.id, role: user.role, name: user.name, phone: user.phone, position: user.position, avatar_url: user.avatar_url,
        isOwner: !!user.is_owner,
        permissions: user.role === 'admin' ? (() => { try { return JSON.parse(user.permissions || '[]'); } catch (e) { return []; } })() : undefined,
      },
    });
  } catch (e) { next(e); }
});

// POST /api/auth/refresh  { refreshToken }
// Exchanges a valid refresh token for a new short-lived access token (+ rotates the refresh token).
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'ไม่พบ refresh token' });

    const result = await rotateRefreshToken(refreshToken);
    if (!result) return res.status(401).json({ error: 'refresh token ไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่' });

    const accessToken = signAccessToken(result.user);
    res.json({
      token: accessToken,
      refreshToken: result.refreshToken,
      user: {
        id: result.user.id, role: result.user.role, name: result.user.name, phone: result.user.phone, position: result.user.position, avatar_url: result.user.avatar_url,
        isOwner: !!result.user.is_owner,
        permissions: result.user.role === 'admin' ? (() => { try { return JSON.parse(result.user.permissions || '[]'); } catch (e) { return []; } })() : undefined,
      },
    });
  } catch (e) { next(e); }
});

// POST /api/auth/logout  { refreshToken }
router.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (refreshToken) await revokeRefreshToken(refreshToken);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/auth/logout-all  — revoke every session for the current user (e.g. "sign out everywhere")
router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await revokeAllForUser(req.user.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await db.get(
      'SELECT id, role, username, name, phone, position, avatar_url, created_at, referral_code, referred_by_user_id, is_owner, permissions FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    if (user.referred_by_user_id) {
      const referrer = await db.get('SELECT referral_code FROM users WHERE id = ?', [user.referred_by_user_id]);
      user.referred_by_code = referrer ? referrer.referral_code : null;
    } else {
      user.referred_by_code = null;
    }
    delete user.referred_by_user_id;
    user.isOwner = !!user.is_owner;
    delete user.is_owner;
    if (user.role === 'admin') {
      try { user.permissions = JSON.parse(user.permissions || '[]'); } catch (e) { user.permissions = []; }
    } else {
      delete user.permissions;
    }
    res.json(user);
  } catch (e) { next(e); }
});

// POST /api/auth/avatar — any logged-in user (customer or admin) uploads/replaces their
// own profile icon. multipart/form-data, field name "image". Stores the image in the
// `media` table (same as product photos/branding — see routes/upload.js) and saves the
// resulting URL onto the user's own avatar_url column, then returns it so the frontend
// can update the avatar circle immediately without a second round trip.
router.post('/avatar', requireAuth, (req, res, next) => {
  mediaUpload.single('image')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'ไฟล์รูปภาพต้องมีขนาดไม่เกิน 5MB'
        : err.message || 'อัปโหลดไฟล์ไม่สำเร็จ';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์รูปภาพ' });

    try {
      const { url } = await saveFileToMedia(req, req.file);
      await db.run('UPDATE users SET avatar_url = ? WHERE id = ?', [url, req.user.id]);
      res.json({ avatar_url: url });
    } catch (e) { next(e); }
  });
});

// POST /api/auth/register  (customer self sign-up)
router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { username, password, name, phone, referralCode } = req.body || {};
    if (!username || !password || !name) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    if (!referralCode || !String(referralCode).trim()) {
      return res.status(400).json({ error: 'กรุณากรอกรหัสแนะนำเพื่อนก่อนสมัครสมาชิก' });
    }

    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return res.status(409).json({ error: 'มีชื่อผู้ใช้นี้อยู่แล้ว' });

    const referrer = await db.get("SELECT id, role FROM users WHERE referral_code = ?", [String(referralCode).trim().toUpperCase()]);
    if (!referrer) return res.status(400).json({ error: 'ไม่พบรหัสแนะนำเพื่อนนี้' });

    const hash = bcrypt.hashSync(password, 10);
    let newReferralCode;
    do {
      // 5-digit numeric code (10000–99999) — easy for a customer to read out loud
      // or type from memory, unlike the old 8-char alphanumeric format.
      newReferralCode = String(Math.floor(10000 + Math.random() * 90000));
    } while (await db.get('SELECT id FROM users WHERE referral_code = ?', [newReferralCode]));

    // Admin can change the referral bonus amount from Settings; fall back to ฿50 if unset.
    const rewardSetting = await db.get("SELECT value FROM settings WHERE key = 'referral_reward'");
    const REFERRAL_REWARD = Number(rewardSetting && rewardSetting.value) || 50;

    const userId = await db.transaction(async (tx) => {
      const info = await tx.run('INSERT INTO users (role, username, password_hash, name, phone, referral_code, referred_by_user_id) VALUES (?,?,?,?,?,?,?)',
        ['customer', username, hash, name, phone || null, newReferralCode, referrer ? referrer.id : null]);
      await tx.run('INSERT INTO conversations (customer_id) VALUES (?)', [info.lastInsertRowid]);

      if (referrer) {
        // Skip the wallet bonus when the "friend" is actually the shop's admin/staff
        // bootstrap code (see /referrals/all "myReferralCode") — it exists so the very
        // first customers have someone to enter, not to pay the shop itself a reward.
        if (referrer.role === 'customer') {
          await tx.run("INSERT INTO referrals (referrer_id, referred_user_id, reward_amount, status) VALUES (?,?,?,'ได้รับรางวัลแล้ว')",
            [referrer.id, info.lastInsertRowid, REFERRAL_REWARD]);
          await tx.run('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [REFERRAL_REWARD, referrer.id]);
          await tx.run('INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES (?,?,?,?)',
            [referrer.id, 'referral_bonus', REFERRAL_REWARD, `ได้รับรางวัลแนะนำเพื่อน: ${name}`]);
        }
      }

      return info.lastInsertRowid;
    });

    const user = { id: userId, role: 'customer', name, phone };
    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);
    res.status(201).json({ token: accessToken, refreshToken, user });
  } catch (e) { next(e); }
});

module.exports = router;
