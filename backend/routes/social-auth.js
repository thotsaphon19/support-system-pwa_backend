// routes/social-auth.js — "Sign in with Google / Facebook / LINE" for the customer PWA.
//
// Flow (standard OAuth 2.0 authorization-code flow):
//   1. Browser hits GET /api/auth/:provider           -> we redirect to the provider's consent screen
//   2. User approves on the provider's own site
//   3. Provider redirects to GET /api/auth/:provider/callback?code=...&state=...
//   4. We exchange the code for a token, fetch the user's profile, find-or-create a
//      local account, issue our own access+refresh tokens (same as normal login),
//      and redirect back to the frontend with those tokens in the URL fragment.
//
// See SOCIAL_LOGIN_SETUP.md for how to register apps with each provider. Client ID/Secret
// are configured from Admin > Settings > "Social Login" (stored in the database, no
// redeploy needed) — the buttons stay disabled until those are set.

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const { providers, createState, verifyState, frontendUrl, signSocialDraft, verifySocialDraft } = require('../lib/socialAuth');
const { signAccessToken, issueRefreshToken } = require('../lib/tokens');

const router = express.Router();

const socialCompleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่อีกครั้งในภายหลัง' },
});

// The redirect_uri OAuth providers send the browser back to must exactly match what's
// registered in each provider's console. Computing it from the incoming request (rather
// than a fixed env var) means it's always correct for whatever domain the backend is
// actually deployed on — the admin just copies this value (shown in Settings > Social
// Login) into the Google/Facebook/LINE developer console once.
function redirectUriFor(req, provider) {
  return `${req.protocol}://${req.get('host')}/api/auth/${provider}/callback`;
}

async function redirectWithError(res, message) {
  const url = new URL(await frontendUrl());
  url.hash = `social_error&message=${encodeURIComponent(message)}`;
  res.redirect(url.toString());
}

// Finds an existing account for this provider identity. If the provider gave us an
// email that matches an existing password-based account, we link this OAuth identity
// onto that same account instead of creating a duplicate — so a customer never ends up
// with two separate wallets. Returns null if this is a brand-new person (first-time
// social sign-up), in which case the caller must collect a referral code before calling
// createOAuthUser — see the "first login only" referral gate below.
async function findExistingOAuthUser(provider, profile) {
  const existing = await db.get('SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?', [provider, profile.id]);
  if (existing) {
    // Keep name/avatar fresh in case the person updated their profile picture, etc.
    await db.run('UPDATE users SET name = ?, avatar_url = COALESCE(?, avatar_url) WHERE id = ?',
      [profile.name || existing.name, profile.avatarUrl, existing.id]);
    return db.get('SELECT * FROM users WHERE id = ?', [existing.id]);
  }

  if (profile.email) {
    const byEmail = await db.get('SELECT * FROM users WHERE email = ? AND role = ?', [profile.email, 'customer']);
    if (byEmail) {
      await db.run('UPDATE users SET oauth_provider = ?, oauth_id = ?, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?',
        [provider, profile.id, profile.avatarUrl, byEmail.id]);
      return db.get('SELECT * FROM users WHERE id = ?', [byEmail.id]);
    }
  }

  return null;
}

// Creates a brand-new customer account for a first-time social sign-up. referrer is
// { id, role } for the user whose friend-referral code was entered — by this point it
// has already been validated as required, same as the regular registration form.
async function createOAuthUser(provider, profile, referrer) {
  // password_hash is required by the schema but unusable (random, never handed out) —
  // the person can only get in via this OAuth identity unless they later set a
  // password from account settings.
  const randomPasswordHash = crypto.randomBytes(32).toString('hex');
  let username;
  do {
    username = `${provider}_${crypto.randomBytes(5).toString('hex')}`;
  } while (await db.get('SELECT id FROM users WHERE username = ?', [username]));

  let referralCode;
  do {
    referralCode = String(Math.floor(10000 + Math.random() * 90000));
  } while (await db.get('SELECT id FROM users WHERE referral_code = ?', [referralCode]));

  // Admin can change the referral bonus amount from Settings; fall back to ฿50 if unset.
  const rewardSetting = await db.get("SELECT value FROM settings WHERE key = 'referral_reward'");
  const REFERRAL_REWARD = Number(rewardSetting && rewardSetting.value) || 50;

  const userId = await db.transaction(async (tx) => {
    const info = await tx.run(`
      INSERT INTO users (role, username, password_hash, name, email, avatar_url, oauth_provider, oauth_id, referral_code, referred_by_user_id)
      VALUES ('customer', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [username, randomPasswordHash, profile.name || username, profile.email, profile.avatarUrl, provider, profile.id, referralCode, referrer ? referrer.id : null]);
    await tx.run('INSERT INTO conversations (customer_id) VALUES (?)', [info.lastInsertRowid]);

    // Skip the wallet bonus when the "friend" is actually the shop's admin/staff
    // bootstrap code (see /referrals/all "myReferralCode") — it exists so the very
    // first customers have someone to enter, not to pay the shop itself a reward.
    if (referrer && referrer.role === 'customer') {
      await tx.run("INSERT INTO referrals (referrer_id, referred_user_id, reward_amount, status) VALUES (?,?,?,'ได้รับรางวัลแล้ว')",
        [referrer.id, info.lastInsertRowid, REFERRAL_REWARD]);
      await tx.run('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [REFERRAL_REWARD, referrer.id]);
      await tx.run('INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES (?,?,?,?)',
        [referrer.id, 'referral_bonus', REFERRAL_REWARD, `ได้รับรางวัลแนะนำเพื่อน: ${profile.name || username}`]);
    }
    return info.lastInsertRowid;
  });
  return db.get('SELECT * FROM users WHERE id = ?', [userId]);
}

// GET /api/auth/social/status — lets the frontend know which providers are actually
// configured, so it can grey out/hide buttons for ones that aren't instead of the
// user tapping a button that can only ever fail. Also returns each provider's callback
// URL so Admin > Settings > Social Login can show exactly what to register with each
// provider's console. No secrets are exposed here.
router.get('/social/status', async (req, res) => {
  res.json({
    google: { enabled: await providers.google.enabled(), callbackUrl: redirectUriFor(req, 'google') },
    facebook: { enabled: await providers.facebook.enabled(), callbackUrl: redirectUriFor(req, 'facebook') },
    line: { enabled: await providers.line.enabled(), callbackUrl: redirectUriFor(req, 'line') },
  });
});

// GET /api/auth/:provider  — kick off the redirect to the provider's consent screen
router.get('/:provider', async (req, res, next) => {
  const provider = providers[req.params.provider];
  if (!provider) return next(); // not a social-login path — let other routes/404 handle it
  if (!(await provider.enabled())) {
    return redirectWithError(res, `ยังไม่ได้ตั้งค่า ${req.params.provider} Client ID/Secret — ไปที่ Admin > Settings > Social Login`);
  }
  const state = createState();
  res.redirect(await provider.buildAuthUrl(state, redirectUriFor(req, req.params.provider)));
});

// GET /api/auth/:provider/callback — provider redirects back here with ?code=&state=
router.get('/:provider/callback', async (req, res, next) => {
  const providerName = req.params.provider;
  const provider = providers[providerName];
  if (!provider) return next();

  const { code, state, error } = req.query;
  if (error) return redirectWithError(res, `ยกเลิกการเข้าสู่ระบบด้วย ${providerName}`);
  if (!code || !verifyState(state)) return redirectWithError(res, 'คำขอเข้าสู่ระบบไม่ถูกต้องหรือหมดอายุ กรุณาลองใหม่');

  try {
    const redirectUri = redirectUriFor(req, providerName);
    const tokenResult = await provider.exchangeCode(code, redirectUri);
    const profile = await provider.fetchProfile(tokenResult);
    if (!profile || !profile.id) throw new Error('no profile id returned');

    const existingUser = await findExistingOAuthUser(providerName, profile);
    const url = new URL(await frontendUrl());

    if (existingUser) {
      // Returning customer — log straight in, same as before.
      const accessToken = signAccessToken(existingUser);
      const refreshToken = await issueRefreshToken(existingUser.id);
      url.hash = new URLSearchParams({ social_login: '1', token: accessToken, refresh: refreshToken }).toString();
      return res.redirect(url.toString());
    }

    // First time this person has ever signed in — hold off on creating the account
    // until they provide a friend referral code (required once, at account creation
    // only). The already-fetched profile travels in a short-lived signed draft token
    // so the frontend doesn't need to redo the OAuth round-trip.
    const draftToken = signSocialDraft(providerName, profile);
    url.hash = new URLSearchParams({ social_referral_required: '1', draft: draftToken, provider: providerName }).toString();
    res.redirect(url.toString());
  } catch (e) {
    console.error(`[social-auth:${providerName}]`, e.message);
    redirectWithError(res, 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
  }
});

// POST /api/auth/social/complete  { draftToken, referralCode }
// Finishes a first-time social sign-up once the person has entered a friend referral
// code. Only reachable via a valid, still-fresh draft token issued by the callback
// above — the OAuth profile itself was already verified there.
router.post('/social/complete', socialCompleteLimiter, async (req, res, next) => {
  try {
    const { draftToken, referralCode } = req.body || {};
    if (!draftToken) return res.status(400).json({ error: 'คำขอไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่' });

    const draft = verifySocialDraft(draftToken);
    if (!draft) return res.status(400).json({ error: 'คำขอหมดอายุ กรุณาเข้าสู่ระบบใหม่อีกครั้ง' });

    if (!referralCode || !String(referralCode).trim()) {
      return res.status(400).json({ error: 'กรุณากรอกรหัสแนะนำเพื่อนก่อนเข้าสู่ระบบครั้งแรก' });
    }
    const referrer = await db.get("SELECT id, role FROM users WHERE referral_code = ?",
      [String(referralCode).trim().toUpperCase()]);
    if (!referrer) return res.status(400).json({ error: 'ไม่พบรหัสแนะนำเพื่อนนี้' });

    // Guard against the same draft being submitted twice (double-click, retry, etc.) —
    // if the account already got created in the meantime, just log into it instead of
    // erroring or creating a duplicate.
    const existingUser = await findExistingOAuthUser(draft.provider, draft.profile);
    const user = existingUser || await createOAuthUser(draft.provider, draft.profile, referrer);

    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);
    res.json({ token: accessToken, refreshToken, user: { id: user.id, role: user.role, name: user.name } });
  } catch (e) { next(e); }
});

module.exports = router;
