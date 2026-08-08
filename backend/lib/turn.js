// lib/turn.js — generates short-lived TURN credentials using the same HMAC scheme
// coturn's REST API (`use-auth-secret`) expects. This means the shared secret never
// leaves the server; each client gets a fresh username/password pair that expires
// after TURN_CREDENTIAL_TTL seconds, which is the standard approach used by managed
// TURN providers (Twilio, Xirsys, Cloudflare Calls) too.
const crypto = require('crypto');

const TURN_URL = process.env.TURN_URL || '';           // e.g. turn:turn.yourdomain.com:3478
const TURN_SECRET = process.env.TURN_SECRET || '';       // must match `static-auth-secret` in turnserver.conf
const TURN_CREDENTIAL_TTL = Number(process.env.TURN_CREDENTIAL_TTL || 3600); // seconds

const turnEnabled = Boolean(TURN_URL && TURN_SECRET);

function generateTurnCredentials(userId) {
  const timestamp = Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL;
  const username = `${timestamp}:user${userId}`;
  const password = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { username, password, ttl: TURN_CREDENTIAL_TTL, urls: TURN_URL };
}

// Builds the full iceServers array to hand to RTCPeerConnection: a public STUN server
// (always available, no credentials needed) plus TURN if configured.
function buildIceServers(userId) {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (turnEnabled) {
    const { username, password, urls } = generateTurnCredentials(userId);
    iceServers.push({ urls, username, credential: password });
  }
  return iceServers;
}

module.exports = { turnEnabled, generateTurnCredentials, buildIceServers };
