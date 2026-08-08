const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../lib/notify');

const router = express.Router();
router.use(requireAuth);

const VALID_STATUS = ['รอดำเนินการ', 'กำลังดำเนินการ', 'เสร็จสิ้น'];
const VALID_PRIORITY = ['ต่ำ', 'ปานกลาง', 'สูง'];

// Prevents a compromised/malicious account from flooding the system (and spamming
// admin push notifications) with tickets.
const createTicketLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'สร้างรายการแจ้งบ่อยเกินไป กรุณาลองใหม่อีกครั้งในภายหลัง' },
});

async function ticketRow(t) {
  const customer = await db.get('SELECT name, phone FROM users WHERE id = ?', [t.customer_id]);
  return { ...t, customer_name: customer ? customer.name : 'ไม่ทราบชื่อ', customer_phone: customer ? customer.phone : null };
}
const ticketRows = (rows) => Promise.all(rows.map(ticketRow));

// Powers the 🔔 badge in the admin topbar — counts tickets nobody on the admin
// side has looked at yet (see 'seen_by_admin' below).
async function getUnseenTicketCount() {
  return Number((await db.get('SELECT COUNT(*) c FROM tickets WHERE seen_by_admin = FALSE')).c);
}

// GET /api/tickets/unread-count — admin only. Must be registered before GET /:id
// so Express doesn't swallow this path as a ticket id.
router.get('/unread-count', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'สำหรับแอดมินเท่านั้น' });
    res.json({ count: await getUnseenTicketCount() });
  } catch (e) { next(e); }
});

// POST /api/tickets/mark-seen — admin only. Called when the admin opens the
// Tickets page; clears the 🔔 badge for every admin session.
router.post('/mark-seen', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'สำหรับแอดมินเท่านั้น' });
    await db.run('UPDATE tickets SET seen_by_admin = TRUE WHERE seen_by_admin = FALSE');
    const io = req.app.get('io');
    if (io) io.to('admins').emit('tickets:unread-count', { count: 0 });
    res.json({ count: 0 });
  } catch (e) { next(e); }
});

// GET /api/tickets  (admin: all + filters; customer: own only)
router.get('/', async (req, res, next) => {
  try {
    const { status, channel, q } = req.query;
    let rows;
    if (req.user.role === 'admin') {
      rows = await db.all('SELECT * FROM tickets ORDER BY created_at DESC');
    } else {
      rows = await db.all('SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at DESC', [req.user.id]);
    }
    rows = await ticketRows(rows);
    if (status) rows = rows.filter(t => t.status === status);
    if (channel) rows = rows.filter(t => t.channel === channel);
    if (q) {
      const s = q.toLowerCase();
      rows = rows.filter(t => t.id.toLowerCase().includes(s) || t.title.toLowerCase().includes(s) || t.customer_name.toLowerCase().includes(s));
    }
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/tickets/:id
router.get('/:id', async (req, res, next) => {
  try {
    const t = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'ไม่พบรายการ' });
    if (req.user.role === 'customer' && t.customer_id !== req.user.id) return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึง' });
    res.json(await ticketRow(t));
  } catch (e) { next(e); }
});

// POST /api/tickets  (customer creates a new report)
router.post('/', createTicketLimiter, async (req, res, next) => {
  try {
    const { title, description, channel, priority } = req.body || {};
    if (!title || !description) return res.status(400).json({ error: 'กรุณากรอกหัวข้อและรายละเอียด' });
    if (title.length > 200) return res.status(400).json({ error: 'หัวข้อยาวเกินไป (สูงสุด 200 ตัวอักษร)' });
    if (description.length > 5000) return res.status(400).json({ error: 'รายละเอียดยาวเกินไป (สูงสุด 5000 ตัวอักษร)' });
    if (priority && !VALID_PRIORITY.includes(priority)) return res.status(400).json({ error: 'ระดับความเร่งด่วนไม่ถูกต้อง' });

    const customerId = req.user.role === 'customer' ? req.user.id : req.body.customer_id;
    if (!customerId) return res.status(400).json({ error: 'ไม่พบลูกค้า' });

    const now = new Date();
    const countToday = (await db.get('SELECT COUNT(*) c FROM tickets WHERE id LIKE ?', ['TK-' + now.toISOString().slice(0,10).replace(/-/g,'') + '-%'])).c;
    const id = 'TK-' + now.toISOString().slice(0,10).replace(/-/g,'') + '-' + String(Number(countToday) + 1).padStart(3, '0');

    await db.run(`INSERT INTO tickets (id, customer_id, title, description, channel, priority, status)
      VALUES (?,?,?,?,?,?, 'รอดำเนินการ')`,
      [id, customerId, title, description, channel || 'เว็บไซต์', priority || 'ปานกลาง']);

    const t = await db.get('SELECT * FROM tickets WHERE id = ?', [id]);
    const rowForClients = await ticketRow(t);
    const io = req.app.get('io');
    io.to('admins').emit('ticket:new', rowForClients);
    io.to('admins').emit('tickets:unread-count', { count: await getUnseenTicketCount() });
    await notify({
      io, audience: 'admin', event: 'ticket_new',
      vars: { customerName: rowForClients.customer_name, ticketTitle: t.title }, link: 'tickets',
    });
    res.status(201).json(rowForClients);
  } catch (e) { next(e); }
});

// PATCH /api/tickets/:id  (admin updates status/priority/assignment)
router.patch('/:id', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'เฉพาะแอดมินเท่านั้นที่แก้ไขสถานะได้' });
    const t = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'ไม่พบรายการ' });

    const fields = ['title', 'description', 'channel', 'priority', 'status'];
    const updates = {};
    fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    if (updates.status && !VALID_STATUS.includes(updates.status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
    if (updates.priority && !VALID_PRIORITY.includes(updates.priority)) return res.status(400).json({ error: 'ระดับความเร่งด่วนไม่ถูกต้อง' });
    if (updates.title && updates.title.length > 200) return res.status(400).json({ error: 'หัวข้อยาวเกินไป' });
    if (updates.description && updates.description.length > 5000) return res.status(400).json({ error: 'รายละเอียดยาวเกินไป' });

    const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
    if (setClause) {
      await db.run(`UPDATE tickets SET ${setClause}, updated_at = to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS') WHERE id = @id`, { ...updates, id: t.id });
    }
    const updated = await ticketRow(await db.get('SELECT * FROM tickets WHERE id = ?', [t.id]));
    const io = req.app.get('io');
    io.to('admins').emit('ticket:update', updated);
    io.to('customer:' + t.customer_id).emit('ticket:update', updated);
    if (updates.status) {
      await notify({
        io, userId: t.customer_id, audience: 'customer', event: 'ticket_status',
        vars: { status: updated.status, ticketTitle: updated.title }, link: 'history',
      });
    }
    res.json(updated);
  } catch (e) { next(e); }
});

module.exports = router;
