const webpush = require('web-push');
const { db } = require('../db');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

const pushEnabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('⚠️  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications are disabled. See .env.example.');
}

async function saveSubscription(userId, subscription) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) throw new Error('subscription ไม่ถูกต้อง');
  await db.run(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
  `, [userId, endpoint, keys.p256dh, keys.auth]);
}

async function removeSubscription(endpoint) {
  await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

// Sends `payload` (plain object) to every subscription belonging to userId.
// Silently drops/removes subscriptions the push service reports as gone (410/404).
async function sendPushToUser(userId, payload) {
  if (!pushEnabled) return;
  const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await removeSubscription(sub.endpoint);
      else console.error('push send failed:', err.message);
    }
  }));
}

// Sends to every admin user (used for "new ticket" notifications).
async function sendPushToAdmins(payload) {
  if (!pushEnabled) return;
  const admins = await db.all("SELECT id FROM users WHERE role = 'admin'");
  await Promise.all(admins.map(a => sendPushToUser(a.id, payload)));
}

module.exports = { pushEnabled, VAPID_PUBLIC_KEY, saveSubscription, removeSubscription, sendPushToUser, sendPushToAdmins };
