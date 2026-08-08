// lib/notify.js — single entry point for creating a row in the personal/
// transactional notification center (see the `notifications` table in db.js).
// Every route that triggers a customer- or admin-facing event (an order status
// changing, a wallet adjustment, an account freeze, a ticket update, ...) calls
// this with an `event` key instead of writing raw text — the actual title/body
// wording comes from EVENT_DEFAULTS below, unless the admin has customized it
// from Settings > การแจ้งเตือน (stored in settings.notif_event_templates), so
// editing the wording in one place changes every place that event fires from.

const { db } = require('../db');
const { sendPushToUser, sendPushToAdmins } = require('./push');

const CATEGORY_LABELS = {
  order: 'คำสั่งซื้อ',
  payment: 'การชำระเงิน',
  wallet: 'กระเป๋าเงิน',
  shipping: 'การจัดส่ง',
  account_status: 'สถานะบัญชี',
  ticket: 'งานแจ้งบริการ',
  coupon: 'คูปอง/โปรโมชั่น',
};

// One entry per real event in the codebase — see the notify() call sites in
// routes/tickets.js, orders.js, bank-account.js, customers.js. `vars` passed at
// the call site fill in the {placeholder} tokens below. Admins edit these
// defaults (not the code) from Settings > การแจ้งเตือน.
const EVENT_DEFAULTS = {
  wallet_credit:    { category: 'wallet', icon: '💰', title: 'เติมยอดเงิน ฿{amount}', body: '{description} (ยอดคงเหลือ ฿{balance})' },
  wallet_debit:     { category: 'wallet', icon: '➖', title: 'หักยอดเงิน ฿{amount}', body: '{description} (ยอดคงเหลือ ฿{balance})' },
  withdraw_new:     { category: 'wallet', icon: '🏦', title: 'คำขอถอนเงินใหม่', body: '฿{amount} • {bank}' },
  withdraw_result:  { category: 'wallet', icon: '🏦', title: 'คำขอถอนเงิน ฿{amount}: {status}', body: '{note}' },
  account_frozen:   { category: 'account_status', icon: '🧊', title: 'บัญชีอยู่ระหว่างดำเนินการถอนเงิน', body: 'ยอดเงินคงเหลือถูกล้างและอยู่ระหว่างดำเนินการถอนเงิน กรุณาติดต่อผู้ดูแลระบบ' },
  account_unfrozen: { category: 'account_status', icon: '✅', title: 'บัญชีกลับมาใช้งานได้ตามปกติ', body: 'บัญชีของคุณปลดการระงับแล้ว เข้าใช้งานได้ตามปกติ' },
  ticket_new:       { category: 'ticket', icon: '📋', title: 'งานแจ้งบริการใหม่', body: '{customerName}: {ticketTitle}' },
  ticket_status:    { category: 'ticket', icon: '📋', title: 'อัปเดตสถานะงานแจ้งบริการ: {status}', body: '{ticketTitle}' },
  order_new_admin:  { category: 'order', icon: '📦', title: 'คำสั่งซื้อใหม่', body: '{customerName} • ฿{amount}' },
  order_placed:     { category: 'order', icon: '📦', title: 'สั่งซื้อสำเร็จ', body: 'คำสั่งซื้อ {orderId} • ฿{amount}' },
  order_status:     { category: 'shipping', icon: '🚚', title: 'สถานะคำสั่งซื้อ: {status}', body: 'คำสั่งซื้อ {orderId}' },
  payment_status:   { category: 'payment', icon: '💳', title: 'สถานะการชำระเงิน: {status}', body: 'คำสั่งซื้อ {orderId}' },
  payment_slip:     { category: 'payment', icon: '💳', title: 'ลูกค้าแจ้งชำระเงินแล้ว', body: '{customerName} • {orderId} • ฿{amount}' },
};

function fillTemplate(str, vars) {
  if (!str) return str;
  return str.replace(/\{(\w+)\}/g, (m, key) => (vars && vars[key] != null ? vars[key] : m));
}

async function categoryEnabled(category) {
  const row = await db.get("SELECT value FROM settings WHERE key = 'notif_categories_enabled'");
  if (!row) return true; // no setting saved yet => everything on by default
  try {
    const map = JSON.parse(row.value);
    return map[category] !== false;
  } catch (e) {
    return true;
  }
}

async function getEventTemplates() {
  const row = await db.get("SELECT value FROM settings WHERE key = 'notif_event_templates'");
  if (!row) return {};
  try { return JSON.parse(row.value); } catch (e) { return {}; }
}

// notify({ io, userId, audience, event, vars, link })
// - userId: the customer this is for, or omit/null for an admin-audience broadcast
// - audience: 'customer' | 'admin'
// - event: a key from EVENT_DEFAULTS above
// - vars: values to fill into the template's {placeholder} tokens
async function notify({ io, userId, audience, event, vars, link }) {
  try {
    const def = EVENT_DEFAULTS[event];
    if (!def) { console.error('[notify] unknown event key', event); return null; }
    if (!(await categoryEnabled(def.category))) return null;

    const overrides = await getEventTemplates();
    const tpl = { ...def, ...(overrides[event] || {}) };

    const title = fillTemplate(tpl.title, vars);
    const body = fillTemplate(tpl.body, vars);

    const inserted = await db.run(
      `INSERT INTO notifications (user_id, audience, category, title, body, icon, link) VALUES (?,?,?,?,?,?,?) RETURNING *`,
      [userId || null, audience, def.category, title, body || null, tpl.icon || '🔔', link || null]
    );
    const row = inserted.rows[0];

    if (io) {
      const room = audience === 'admin' ? 'admins' : 'customer:' + userId;
      io.to(room).emit('notification:new', row);
    }

    // Real OS-level push — this is what shows up even when the app/tab is closed,
    // as opposed to the socket emit above (which only reaches an already-open app).
    // Same title/body the in-app notification just got, so the two are always
    // consistent with each other and with whatever the admin has customized.
    const pushPayload = {
      title, body: body || '', tag: `${event}-${row.id}`,
      url: (audience === 'admin' ? '/admin/#' : '/app/#') + (link || ''),
    };
    if (audience === 'admin') sendPushToAdmins(pushPayload).catch(() => {});
    else sendPushToUser(userId, pushPayload).catch(() => {});

    return row;
  } catch (e) {
    // A notification is a side-effect, never the main point of the request it's
    // attached to — a failure here must not break order/wallet/ticket flows.
    console.error('[notify] failed to create notification', e.message);
    return null;
  }
}

module.exports = { notify, CATEGORY_LABELS, EVENT_DEFAULTS };
