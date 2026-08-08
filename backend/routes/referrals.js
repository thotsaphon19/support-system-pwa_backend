const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const REFERRAL_REWARD = 50; // baht credited to the referrer's wallet per successful referral signup

// GET /api/referrals/me — my referral code, stats, and history (customer only)
router.get('/me', requireRole('customer'), async (req, res, next) => {
  try {
    const user = await db.get('SELECT referral_code FROM users WHERE id = ?', [req.user.id]);
    const referrals = await db.all(`
      SELECT r.*, u.name as referred_name
      FROM referrals r JOIN users u ON u.id = r.referred_user_id
      WHERE r.referrer_id = ?
      ORDER BY r.created_at DESC
    `, [req.user.id]);
    const totalEarned = referrals.reduce((sum, r) => sum + Number(r.reward_amount), 0);
    res.json({ referralCode: user.referral_code, referralCount: referrals.length, totalEarned, referrals });
  } catch (e) { next(e); }
});

// GET /api/referrals/all — admin-wide view of the whole referral program
router.get('/all', requireRole('admin'), async (req, res, next) => {
  try {
    const referrals = await db.all(`
      SELECT r.*, u1.name as referrer_name, u1.referral_code, u2.name as referred_name
      FROM referrals r
      JOIN users u1 ON u1.id = r.referrer_id
      JOIN users u2 ON u2.id = r.referred_user_id
      ORDER BY r.created_at DESC
    `);
    const totalRewardsPaid = referrals.reduce((sum, r) => sum + Number(r.reward_amount), 0);
    const topReferrersRaw = await db.all(`
      SELECT u.name, u.referral_code, COUNT(r.id) as referral_count, COALESCE(SUM(r.reward_amount), 0) as total_earned
      FROM users u JOIN referrals r ON r.referrer_id = u.id
      GROUP BY u.id ORDER BY referral_count DESC LIMIT 10
    `);
    const topReferrers = topReferrersRaw.map(r => ({ ...r, referral_count: Number(r.referral_count), total_earned: Number(r.total_earned) }));
    // The friend-referral code is now required at first sign-up, so brand-new customers
    // (with no existing customer to give them a code) need somewhere to start —
    // hand out this admin account's own code as the bootstrap referral.
    const me = await db.get('SELECT referral_code FROM users WHERE id = ?', [req.user.id]);
    res.json({ referrals, totalRewardsPaid, totalReferrals: referrals.length, topReferrers, myReferralCode: me ? me.referral_code : null });
  } catch (e) { next(e); }
});

module.exports = { router, REFERRAL_REWARD };
