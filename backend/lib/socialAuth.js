// lib/socialAuth.js — Social login (Google / Facebook / LINE) helpers.
//
// This is a small hand-rolled OAuth 2.0 "authorization code" client — no passport.js
// dependency needed. Each provider exposes three things:
//   1. buildAuthUrl(state, redirectUri)  -> the URL we redirect the browser to
//   2. exchangeCode(code, redirectUri)   -> trades the ?code=... callback param for an access token
//   3. fetchProfile(token)               -> gets { id, name, email, avatarUrl } from the provider
//
// Client ID/Secret come from the database first (Admin > Settings > "Social Login" —
// see routes/settings.js), falling back to environment variables so servers set up the
// "classic" .env way before this UI existed keep working unchanged. redirect_uri is
// computed per-request from the incoming host (see routes/social-auth.js) rather than a
// fixed env var, so it's always correct for whatever domain the backend is actually
// running on — one less thing for a non-developer admin to configure by hand.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db } = require('../db');

const STATE_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the OAuth round-trip

// ---------- CSRF-protecting "state" param ----------
// Signed + timestamped so the callback can verify the request actually originated
// from us a few minutes ago, without needing server-side session storage.
function createState() {
  const payload = JSON.stringify({ t: Date.now(), n: crypto.randomBytes(8).toString('hex') });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyState(state) {
  if (!state || typeof state !== 'string' || !state.includes('.')) return false;
  const [b64, sig] = state.split('.');
  const expectedSig = crypto.createHmac('sha256', STATE_SECRET).update(b64).digest('base64url');
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return false;
  }
  try {
    const { t } = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return Date.now() - t < STATE_TTL_MS;
  } catch (e) {
    return false;
  }
}

// ---------- Credentials: DB (Admin UI) first, .env as fallback ----------
async function dbSetting(key) {
  try {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
    return row && row.value ? row.value : '';
  } catch (e) {
    return '';
  }
}

const ENV_FALLBACK = {
  google: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
  facebook: { id: 'FACEBOOK_APP_ID', secret: 'FACEBOOK_APP_SECRET' },
  line: { id: 'LINE_CHANNEL_ID', secret: 'LINE_CHANNEL_SECRET' },
};

async function credentials(name) {
  const fb = ENV_FALLBACK[name];
  const clientId = (await dbSetting(`oauth_${name}_client_id`)) || process.env[fb.id] || '';
  const clientSecret = (await dbSetting(`oauth_${name}_client_secret`)) || process.env[fb.secret] || '';
  return { clientId, clientSecret };
}

async function frontendUrl() {
  return (await dbSetting('oauth_frontend_url')) || process.env.FRONTEND_URL || 'http://localhost:5500/customer/index.html';
}

// ---------- Provider configs ----------
const providers = {
  google: {
    async enabled() {
      const { clientId, clientSecret } = await credentials('google');
      return !!(clientId && clientSecret);
    },
    async buildAuthUrl(state, redirectUri) {
      const { clientId } = await credentials('google');
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        access_type: 'online',
        prompt: 'select_account',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    },
    async exchangeCode(code, redirectUri) {
      const { clientId, clientSecret } = await credentials('google');
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!res.ok) throw new Error('google token exchange failed: ' + (await res.text()));
      const data = await res.json();
      return data.access_token;
    },
    async fetchProfile(accessToken) {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('google profile fetch failed: ' + (await res.text()));
      const p = await res.json();
      return { id: p.sub, name: p.name || p.email, email: p.email || null, avatarUrl: p.picture || null };
    },
  },

  facebook: {
    async enabled() {
      const { clientId, clientSecret } = await credentials('facebook');
      return !!(clientId && clientSecret);
    },
    async buildAuthUrl(state, redirectUri) {
      const { clientId } = await credentials('facebook');
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        scope: 'email,public_profile',
      });
      return `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;
    },
    async exchangeCode(code, redirectUri) {
      const { clientId, clientSecret } = await credentials('facebook');
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      });
      const res = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${params.toString()}`);
      if (!res.ok) throw new Error('facebook token exchange failed: ' + (await res.text()));
      const data = await res.json();
      return data.access_token;
    },
    async fetchProfile(accessToken) {
      const params = new URLSearchParams({ fields: 'id,name,email,picture.type(large)', access_token: accessToken });
      const res = await fetch(`https://graph.facebook.com/me?${params.toString()}`);
      if (!res.ok) throw new Error('facebook profile fetch failed: ' + (await res.text()));
      const p = await res.json();
      return {
        id: p.id,
        name: p.name,
        // Facebook only returns email if the user granted it AND the app has been
        // through App Review for the email permission — treat as optional.
        email: p.email || null,
        avatarUrl: p.picture && p.picture.data && !p.picture.data.is_silhouette ? p.picture.data.url : null,
      };
    },
  },

  line: {
    async enabled() {
      const { clientId, clientSecret } = await credentials('line');
      return !!(clientId && clientSecret);
    },
    async buildAuthUrl(state, redirectUri) {
      const { clientId } = await credentials('line');
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        scope: 'profile openid email',
      });
      return `https://access.line.me/oauth2/v2.1/authorize?${params.toString()}`;
    },
    async exchangeCode(code, redirectUri) {
      const { clientId, clientSecret } = await credentials('line');
      const res = await fetch('https://api.line.me/oauth2/v2.1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      if (!res.ok) throw new Error('line token exchange failed: ' + (await res.text()));
      return res.json(); // { access_token, id_token, ... } — LINE profile needs access_token
    },
    async fetchProfile(tokenResponse) {
      const res = await fetch('https://api.line.me/v2/profile', {
        headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
      });
      if (!res.ok) throw new Error('line profile fetch failed: ' + (await res.text()));
      const p = await res.json();
      // LINE only exposes email if the channel has "Email address permission" approved
      // by the LINE team AND it was included in the id_token — most setups won't have it.
      return { id: p.userId, name: p.displayName, email: null, avatarUrl: p.pictureUrl || null };
    },
  },
};

// ---------- "Social signup draft" token ----------
// First-time social sign-ups must enter a friend referral code before their account is
// actually created (see routes/social-auth.js). Rather than keep server-side session
// state for that pause, we hand the frontend a short-lived signed JWT that carries the
// already-verified provider profile — the referral-code submission step below just
// re-presents this token, so nothing about the OAuth round-trip needs to be redone.
const SOCIAL_DRAFT_TTL = '10m';

function signSocialDraft(provider, profile) {
  return jwt.sign({ purpose: 'social_draft', provider, profile }, STATE_SECRET, { expiresIn: SOCIAL_DRAFT_TTL });
}

function verifySocialDraft(token) {
  try {
    const decoded = jwt.verify(token, STATE_SECRET);
    if (decoded.purpose !== 'social_draft' || !decoded.provider || !decoded.profile) return null;
    return { provider: decoded.provider, profile: decoded.profile };
  } catch (e) {
    return null;
  }
}

module.exports = { providers, createState, verifyState, frontendUrl, signSocialDraft, verifySocialDraft };
