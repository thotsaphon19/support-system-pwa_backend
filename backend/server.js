require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const { db, migrate } = require('./db');
const { JWT_SECRET } = require('./middleware/auth');
const { sendPushToUser, sendPushToAdmins } = require('./lib/push');

// ---------- Fail-fast startup checks (catches insecure config before it ever goes live) ----------
const isProd = process.env.NODE_ENV === 'production';
if (isProd && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-this-to-a-long-random-string')) {
  console.error('❌ Refusing to start: JWT_SECRET is unset or still the placeholder value. Generate one with:');
  console.error(`   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`);
  process.exit(1);
}
if (isProd && (!process.env.CORS_ORIGINS || process.env.CORS_ORIGINS === '*')) {
  console.error('❌ Refusing to start: CORS_ORIGINS is unset or "*" in production. Set it to your real frontend domain(s),');
  console.error('   e.g. CORS_ORIGINS=https://app.yourdomain.com,https://admin.yourdomain.com');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('❌ Refusing to start: DATABASE_URL is not set. Point it at a Postgres database');
  console.error('   (a free Neon project works great) — see backend/.env.example.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

// Required so rate limiting and logs see the real client IP when running behind
// Nginx/a load balancer, instead of the proxy's own IP.
app.set('trust proxy', 1);

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());

app.use(helmet({
  // This is a JSON API (no HTML rendered here), so the default CSP meant for web pages
  // isn't relevant — the frontends set their own CSP via Nginx (see nginx.conf.example).
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '200kb' }));

// Generous global limit as defense-in-depth against abuse/DoS; specific sensitive
// endpoints (login, ticket creation) have their own stricter limits on top of this.
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'มีการเรียกใช้งานถี่เกินไป กรุณาลองใหม่อีกครั้งในภายหลัง' },
}));

// ---------- REST routes ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/auth', require('./routes/auth'));
// Social login (Google/Facebook/LINE) — mounted after routes/auth so its generic
// /:provider and /:provider/callback patterns never shadow /login, /me, etc. above.
app.use('/api/auth', require('./routes/social-auth'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/kb', require('./routes/kb'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/push', require('./routes/push'));
app.use('/api/turn-credentials', require('./routes/turn'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/cart', require('./routes/cart'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/coupons', require('./routes/coupons').router);
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/referrals', require('./routes/referrals').router);
app.use('/api/store-notifications', require('./routes/store-notifications'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/team', require('./routes/team'));
app.use('/api/bank-account', require('./routes/bank-account'));
app.use('/api/upload', require('./routes/upload'));

// Uploaded product photos / branding / payment slips — stored as rows in Postgres/Neon
// (see routes/upload.js + the `media` table in db.js), not local disk, so they survive
// redeploys. This route streams them back out with long-lived caching (the URL itself
// changes whenever a new file is uploaded, so caching it forever is safe).
app.use('/media', require('./routes/media'));

// Optional: serve the built frontend folders directly from this same server/origin.
// Handy in production so the customer/admin PWAs and the API share one origin (simplifies
// CORS + lets them share auth cookies/localStorage if ever needed).
if (process.env.SERVE_FRONTENDS === 'true') {
  // sw.js and index.html must NEVER be cached by the browser's own HTTP cache —
  // otherwise a fresh deploy can sit behind a stale sw.js/index.html forever,
  // even with the service worker itself doing the right thing. Everything else
  // (hashed/static assets) is safe to cache normally.
  const frontendStaticOptions = {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('sw.js') || filePath.endsWith('index.html') || filePath.endsWith('manifest.json') || filePath.endsWith('config.js')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  };
  app.use('/app', express.static(path.join(__dirname, '..', 'customer'), frontendStaticOptions));
  app.use('/admin', express.static(path.join(__dirname, '..', 'admin'), frontendStaticOptions));
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
});

// ---------- Socket.io realtime chat ----------
const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS } });
app.set('io', io);

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('unauthorized'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

async function getOrCreateConversation(customerId) {
  let conv = await db.get('SELECT * FROM conversations WHERE customer_id = ?', [customerId]);
  if (!conv) {
    // Guard against admins accidentally (or maliciously, if a token were ever stolen)
    // creating conversation rows for non-customer/non-existent user IDs.
    const targetUser = await db.get("SELECT id FROM users WHERE id = ? AND role = 'customer'", [customerId]);
    if (!targetUser) return null;
    const info = await db.run('INSERT INTO conversations (customer_id) VALUES (?)', [customerId]);
    conv = { id: info.lastInsertRowid, customer_id: customerId };
  }
  return conv;
}

// Powers the ✉️ badge in the admin topbar — counts customer messages no admin
// session has opened that conversation to see yet. Shared with routes/chat.js's
// own copy since REST and socket paths both need to recompute it after changes.
async function getUnreadMessageCount() {
  return Number((await db.get("SELECT COUNT(*) c FROM messages WHERE sender_role = 'customer' AND read_by_admin = FALSE")).c);
}

io.on('connection', (socket) => {
  const { user } = socket;

  if (user.role === 'admin') {
    socket.join('admins');
  } else {
    socket.join('customer:' + user.id);
    getOrCreateConversation(user.id).then(conv => {
      if (conv) socket.join('conversation:' + conv.id);
    }).catch(err => console.error('[socket] join conversation failed', err));
  }

  // Admin opens a specific customer's conversation
  socket.on('chat:open', async (customerId) => {
    if (user.role !== 'admin') return;
    try {
      const conv = await getOrCreateConversation(Number(customerId));
      if (conv) {
        socket.join('conversation:' + conv.id);
        // Opening the conversation is how the admin "reads" it — clears the
        // ✉️ badge for whatever share of the unread total belonged to this customer.
        await db.run("UPDATE messages SET read_by_admin = TRUE WHERE conversation_id = ? AND sender_role = 'customer' AND read_by_admin = FALSE", [conv.id]);
        io.to('admins').emit('chat:unread-count', { count: await getUnreadMessageCount() });
      }
    } catch (err) { console.error('[socket] chat:open failed', err); }
  });

  // Basic per-connection flood guard: max 20 chat messages per 10 seconds.
  let msgTimestamps = [];
  function isRateLimited() {
    const now = Date.now();
    msgTimestamps = msgTimestamps.filter(t => now - t < 10000);
    if (msgTimestamps.length >= 20) return true;
    msgTimestamps.push(now);
    return false;
  }

  // Sending a chat message (customer or admin) — text, an image, or both.
  socket.on('chat:send', async ({ customerId, text, imageUrl }) => {
    try {
      const cleanText = (text || '').trim();
      const cleanImage = (imageUrl || '').trim();
      if ((!cleanText && !cleanImage) || cleanText.length > 4000) return;
      if (isRateLimited()) return;
      const targetCustomerId = user.role === 'customer' ? user.id : Number(customerId);
      if (!targetCustomerId) return;

      const conv = await getOrCreateConversation(targetCustomerId);
      if (!conv) return;
      // Admin messages are read by the admin side by definition; only a customer
      // message starts out unread, which is what feeds the ✉️ badge count below.
      const info = await db.run('INSERT INTO messages (conversation_id, sender_id, sender_role, text, image_url, read_by_admin) VALUES (?,?,?,?,?,?)',
        [conv.id, user.id, user.role, cleanText, cleanImage || null, user.role === 'admin']);
      const message = await db.get('SELECT * FROM messages WHERE id = ?', [info.lastInsertRowid]);

      io.to('conversation:' + conv.id).to('admins').emit('chat:message', { conversationId: conv.id, customerId: targetCustomerId, message });

      // Push-notify whichever side didn't send the message (best-effort; harmless if they're online too).
      const notifyBody = cleanText || (cleanImage ? '📷 ส่งรูปภาพ' : '');
      if (user.role === 'customer') {
        io.to('admins').emit('chat:unread-count', { count: await getUnreadMessageCount() });
        sendPushToAdmins({ title: 'ข้อความใหม่จาก ' + user.name, body: notifyBody.slice(0, 120), url: '/admin/#inbox', tag: 'chat-' + targetCustomerId }).catch(() => {});
      } else {
        sendPushToUser(targetCustomerId, { title: 'ข้อความใหม่จากเจ้าหน้าที่', body: notifyBody.slice(0, 120), url: '/app/#chat', tag: 'chat-' + targetCustomerId }).catch(() => {});
      }
    } catch (err) { console.error('[socket] chat:send failed', err); }
  });

  // ---------- WebRTC signaling relay (two-way video/audio calls) ----------
  // The server never touches media itself — it just relays SDP offers/answers and ICE
  // candidates between the customer and the admin currently handling their conversation.
  // Actual audio/video flows peer-to-peer once the connection is established.

  function callRoomTargets(customerId) {
    // Message goes to the specific customer room and to all admins (whichever admin
    // is watching that conversation in the Inbox will pick it up).
    return [ 'customer:' + customerId, 'admins' ];
  }

  socket.on('webrtc:call', ({ customerId, mode }) => {
    const targetCustomerId = user.role === 'customer' ? user.id : Number(customerId);
    if (!targetCustomerId) return;
    const payload = { customerId: targetCustomerId, mode, from: { id: user.id, role: user.role, name: user.name } };
    callRoomTargets(targetCustomerId).forEach(room => socket.to(room).emit('webrtc:incoming', payload));
  });

  socket.on('webrtc:offer', ({ customerId, sdp }) => {
    const targetCustomerId = user.role === 'customer' ? user.id : Number(customerId);
    if (!targetCustomerId) return;
    callRoomTargets(targetCustomerId).forEach(room => socket.to(room).emit('webrtc:offer', { customerId: targetCustomerId, sdp, from: user.role }));
  });

  socket.on('webrtc:answer', ({ customerId, sdp }) => {
    const targetCustomerId = user.role === 'customer' ? user.id : Number(customerId);
    if (!targetCustomerId) return;
    callRoomTargets(targetCustomerId).forEach(room => socket.to(room).emit('webrtc:answer', { customerId: targetCustomerId, sdp, from: user.role }));
  });

  socket.on('webrtc:ice-candidate', ({ customerId, candidate }) => {
    const targetCustomerId = user.role === 'customer' ? user.id : Number(customerId);
    if (!targetCustomerId) return;
    callRoomTargets(targetCustomerId).forEach(room => socket.to(room).emit('webrtc:ice-candidate', { customerId: targetCustomerId, candidate, from: user.role }));
  });

  socket.on('webrtc:reject', ({ customerId }) => {
    const targetCustomerId = user.role === 'customer' ? user.id : Number(customerId);
    if (!targetCustomerId) return;
    callRoomTargets(targetCustomerId).forEach(room => socket.to(room).emit('webrtc:rejected', { customerId: targetCustomerId }));
  });

  socket.on('webrtc:end', ({ customerId }) => {
    const targetCustomerId = user.role === 'customer' ? user.id : Number(customerId);
    if (!targetCustomerId) return;
    callRoomTargets(targetCustomerId).forEach(room => socket.to(room).emit('webrtc:ended', { customerId: targetCustomerId }));
  });
});

const PORT = process.env.PORT || 4000;

// Migration runs automatically on every startup (idempotent — safe to run on every
// deploy) so a brand-new Neon database gets its schema created on first boot, and an
// existing one silently picks up any new columns/tables added by a later app update.
// Seeding likewise checks-before-inserting, so it never overwrites/duplicates real data.
(async () => {
  try {
    await migrate();
    await require('./seed')();
    server.listen(PORT, () => {
      console.log(`✅ Support system API listening on http://localhost:${PORT}`);
      console.log(`   Socket.io realtime chat is active on the same port.`);
      console.log(`   Database: Postgres (${new URL(process.env.DATABASE_URL).hostname})`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
})();
