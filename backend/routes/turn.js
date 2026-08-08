const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { turnEnabled, buildIceServers } = require('../lib/turn');

const router = express.Router();

// GET /api/turn-credentials — short-lived ICE server list (STUN always; TURN if configured).
// Called by the frontend right before starting or answering a call.
router.get('/', requireAuth, (req, res) => {
  res.json({ turnEnabled, iceServers: buildIceServers(req.user.id) });
});

module.exports = router;
