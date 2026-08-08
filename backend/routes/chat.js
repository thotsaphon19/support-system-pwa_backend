const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function getOrCreateConversation(customerId) {
  let conv = await db.get('SELECT * FROM conversations WHERE customer_id = ?', [customerId]);
  if (!conv) {
    const targetUser = await db.get("SELECT id FROM users WHERE id = ? AND role = 'customer'", [customerId]);
    if (!targetUser) return null;
    const info = await db.run('INSERT INTO conversations (customer_id) VALUES (?)', [customerId]);
    conv = { id: info.lastInsertRowid, customer_id: customerId };
  }
  return conv;
}

// GET /api/chat/me  — customer's own conversation history
router.get('/me', async (req, res, next) => {
  try {
    if (req.user.role !== 'customer') return res.status(403).json({ error: 'สำหรับลูกค้าเท่านั้น' });
    const conv = await getOrCreateConversation(req.user.id);
    if (!conv) return res.status(404).json({ error: 'ไม่พบบทสนทนา' });
    const messages = await db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [conv.id]);
    res.json({ conversation_id: conv.id, messages });
  } catch (e) { next(e); }
});

// Powers the ✉️ badge in the admin topbar — counts customer messages no admin
// session has opened that conversation to see yet.
async function getUnreadMessageCount() {
  return Number((await db.get("SELECT COUNT(*) c FROM messages WHERE sender_role = 'customer' AND read_by_admin = FALSE")).c);
}

// GET /api/chat/unread-count — admin only. Must be registered before GET /:customerId
// so Express doesn't swallow this path as a customer id.
router.get('/unread-count', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'สำหรับแอดมินเท่านั้น' });
    res.json({ count: await getUnreadMessageCount() });
  } catch (e) { next(e); }
});

// GET /api/chat/:customerId  — admin viewing a specific customer's conversation
router.get('/:customerId', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'สำหรับแอดมินเท่านั้น' });
    const conv = await getOrCreateConversation(Number(req.params.customerId));
    if (!conv) return res.status(404).json({ error: 'ไม่พบลูกค้ารายนี้' });
    const messages = await db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [conv.id]);
    // Opening the conversation is how the admin "reads" it — clears the ✉️ badge
    // for whatever share of the unread total belonged to this customer.
    await db.run("UPDATE messages SET read_by_admin = TRUE WHERE conversation_id = ? AND sender_role = 'customer' AND read_by_admin = FALSE", [conv.id]);
    const io = req.app.get('io');
    if (io) io.to('admins').emit('chat:unread-count', { count: await getUnreadMessageCount() });
    res.json({ conversation_id: conv.id, messages });
  } catch (e) { next(e); }
});

module.exports = router;
