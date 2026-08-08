const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TOKEN_DAYS = Number(process.env.REFRESH_TOKEN_DAYS || 30);

function signAccessToken(user) {
  return jwt.sign({
    id: user.id,
    role: user.role,
    name: user.name,
    isOwner: !!user.is_owner,
    permissions: user.role === 'admin' ? safeParsePermissions(user.permissions) : undefined,
  }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

function safeParsePermissions(raw) {
  try { return JSON.parse(raw || '[]'); } catch (e) { return []; }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Issues a new refresh token, stores its hash, returns the raw token (only time it's visible).
async function issueRefreshToken(userId) {
  const raw = crypto.randomBytes(48).toString('hex');
  const hash = hashToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.run('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?,?,?)', [userId, hash, expiresAt]);
  return raw;
}

// Validates a raw refresh token; returns the user row if valid, else null.
// Rotates the token (revokes the old one, issues a new one) — standard refresh-token-rotation practice.
async function rotateRefreshToken(rawToken) {
  const hash = hashToken(rawToken);
  const row = await db.get('SELECT * FROM refresh_tokens WHERE token_hash = ?', [hash]);
  if (!row || row.revoked || new Date(row.expires_at) < new Date()) return null;

  await db.run('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [row.id]);
  const user = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
  if (!user) return null;

  const newRefresh = await issueRefreshToken(user.id);
  return { user, refreshToken: newRefresh };
}

async function revokeRefreshToken(rawToken) {
  const hash = hashToken(rawToken);
  await db.run('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?', [hash]);
}

async function revokeAllForUser(userId) {
  await db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [userId]);
}

module.exports = { JWT_SECRET, signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken, revokeAllForUser };
