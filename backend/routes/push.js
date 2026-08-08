const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { pushEnabled, VAPID_PUBLIC_KEY, saveSubscription, removeSubscription } = require('../lib/push');

const router = express.Router();

// GET /api/push/vapid-public-key — frontend needs this to call pushManager.subscribe()
router.get('/vapid-public-key', (req, res) => {
  res.json({ enabled: pushEnabled, publicKey: VAPID_PUBLIC_KEY || null });
});

// POST /api/push/subscribe  (auth) body: PushSubscription JSON from the browser
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    await saveSubscription(req.user.id, req.body);
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/push/unsubscribe  { endpoint }
router.post('/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) await removeSubscription(endpoint);
  res.json({ ok: true });
});

module.exports = router;
