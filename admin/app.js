/* ============ Config & API helper ============ */
const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.API_BASE) || 'http://localhost:4000/api';
const SOCKET_URL = (window.APP_CONFIG && window.APP_CONFIG.SOCKET_URL) || 'http://localhost:4000';

function getToken() { return localStorage.getItem('supportsys_admin_token'); }
function setToken(t) { localStorage.setItem('supportsys_admin_token', t); }
function clearToken() { localStorage.removeItem('supportsys_admin_token'); }
function getRefreshToken() { return localStorage.getItem('supportsys_admin_refresh_token'); }
function setRefreshToken(t) { localStorage.setItem('supportsys_admin_refresh_token', t); }
function clearRefreshToken() { localStorage.removeItem('supportsys_admin_refresh_token'); }

let refreshInFlight = null;
async function refreshAccessToken() {
  if (refreshInFlight) return refreshInFlight;
  const rt = getRefreshToken();
  if (!rt) return false;
  refreshInFlight = fetch(API_BASE + '/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: rt }),
  }).then(async (res) => {
    if (!res.ok) { clearToken(); clearRefreshToken(); return false; }
    const data = await res.json();
    setToken(data.token);
    setRefreshToken(data.refreshToken);
    return true;
  }).catch(() => false).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function api(path, options = {}, _retried = false) {
  const token = getToken();
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }

  if (res.status === 401 && !_retried && getRefreshToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return api(path, options, true);
    adminLogout();
  }
  if (!res.ok) throw new Error((data && data.error) || 'เกิดข้อผิดพลาด (' + res.status + ')');
  return data;
}

/* ============ State ============ */
let currentAdmin = null;
let socket = null;
let tickets = [];
let customers = [];
let currentCustomerDetail = null; // full detail (wallet balance/status/transactions) for whichever customer the edit modal currently shows
let kbArticles = [];
let dashboardStats = null;
let currentInboxCustomerId = null;
let inboxMessagesCache = {};
let productsAdmin = [];
let categoriesAdmin = [];
let storeOrders = [];
let couponsAdmin = [];
let reviewsAdmin = [];
let storeNotifsAdmin = [];
let referralsAdminData = null;
// Flash Sale tab (Marketing > แฟลชเซล): keyed by product id -> { enabled, price, endsLocal }.
// Kept as a persistent draft (not rebuilt on every re-render) so in-progress edits across
// several products survive searching/filtering until the admin hits "บันทึกแฟลชเซล".
let flashSaleDraft = null;
let flashSaleSearch = '';

/* ============ Call state ============ */
async function getIceServers() {
  try {
    const data = await api('/turn-credentials');
    return data.iceServers;
  } catch (e) {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}
let pendingOffers = {}; // customerId -> { sdp, mode, fromName }
let currentCallCustomerId = null;
let adminPc = null;
let adminRawStream = null;
let adminAvatarHandle = null;
let adminCurrentVideoMode = 'real';
let adminCallTimerInterval = null;
let adminCallSeconds = 0;
let adminMuted = false;

/* ============ Branding (tab title + favicon) ============ */
// Applies the store name / uploaded logo to the browser tab title and the tab's
// favicon (address-bar icon). Falls back to the default app icon when no logo has
// been uploaded, or after one is removed.
function applyAdminBranding(s) {
  if (!s) return;
  if (s.store_name) document.title = `${s.store_name} | Admin Console`;
  const faviconEl = document.getElementById('app-favicon');
  if (faviconEl) {
    faviconEl.removeAttribute('type'); // let the browser sniff it from the Content-Type header
    faviconEl.href = s.app_logo_url || 'icons/icon-192.png';
  }
}

async function loadPublicBranding() {
  try {
    const s = await api('/settings/public');
    applyAdminBranding(s);
  } catch (e) { /* keep defaults */ }
}

/* ============ Bootstrap ============ */
window.addEventListener('DOMContentLoaded', async () => {
  loadPublicBranding(); // paints tab title/favicon on the login screen too, no auth required
  setupInboxImageUploader();
  const token = getToken();
  if (token) {
    try {
      currentAdmin = await api('/auth/me');
      enterApp();
      return;
    } catch (e) { clearToken(); }
  }
  document.getElementById('login-screen').style.display = 'flex';
});

/* ============ Login ============ */
async function adminLogin() {
  const username = document.getElementById('al-user').value.trim();
  const password = document.getElementById('al-pass').value;
  const errEl = document.getElementById('al-error');
  errEl.style.display = 'none';
  try {
    const data = await api('/auth/login', { method: 'POST', body: { username, password } });
    if (data.user.role !== 'admin') throw new Error('บัญชีนี้ไม่มีสิทธิ์เข้าถึงระบบแอดมิน');
    setToken(data.token);
    setRefreshToken(data.refreshToken);
    currentAdmin = data.user;
    enterApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

function enterApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('admin-app').classList.add('active');
  document.querySelector('.user-chip .u-name').textContent = currentAdmin.name;
  document.querySelector('.user-chip .u-role').textContent = currentAdmin.position || 'แอดมิน';
  connectSocket();
  api('/settings').then(applyAdminBranding).catch(() => { /* keep defaults */ });
  refreshNotifBadges();
  refreshGeneralNotifBadge();
  subscribeToPush().catch(() => { /* push is optional — never block the app on it */ });
  go('dashboard').then(() => applyAdminPermissionGating());
}

/* ============ Push notifications ============ */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const { enabled, publicKey } = await api('/push/vapid-public-key');
  if (!enabled || !publicKey) return;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  await api('/push/subscribe', { method: 'POST', body: subscription.toJSON() });
}

// Reflects the *real* browser push-subscription state on the Settings > การแจ้งเตือน tab
// (previously this was hardcoded "เปิด" regardless of whether push was actually on).
async function refreshNotifyPushToggle() {
  const statusEl = document.getElementById('notify-push-status');
  const checkbox = document.getElementById('notify-push-toggle');
  const track = document.getElementById('notify-push-track');
  const knob = document.getElementById('notify-push-knob');
  if (!statusEl || !checkbox) return;

  const setSwitch = (on) => {
    checkbox.checked = on;
    track.style.background = on ? 'var(--purple-500)' : '#D9D5EA';
    knob.style.left = on ? '21px' : '3px';
  };

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    statusEl.textContent = 'เบราว์เซอร์นี้ไม่รองรับ Push Notification';
    checkbox.disabled = true;
    setSwitch(false);
    return;
  }
  try {
    const { enabled } = await api('/push/vapid-public-key');
    if (!enabled) {
      statusEl.textContent = 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า VAPID keys (ดู .env.example)';
      checkbox.disabled = true;
      setSwitch(false);
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    const isOn = !!sub && Notification.permission === 'granted';
    checkbox.disabled = false;
    setSwitch(isOn);
    statusEl.textContent = isOn ? 'เปิดอยู่ — จะได้รับแจ้งเตือนตั๋วใหม่แบบเรียลไทม์' : 'ปิดอยู่';
  } catch (e) {
    statusEl.textContent = 'ตรวจสอบสถานะไม่สำเร็จ: ' + e.message;
  }
}

async function onNotifyPushToggle(e) {
  const checkbox = e.target;
  const wantOn = checkbox.checked;
  checkbox.disabled = true;
  try {
    if (wantOn) {
      await subscribeToPush();
      if (Notification.permission !== 'granted') {
        showToastA('ต้องกด "อนุญาต" แจ้งเตือนจากเบราว์เซอร์ก่อนถึงจะเปิดได้');
      } else {
        showToastA('เปิดการแจ้งเตือนผ่านแอปแล้ว');
      }
    } else {
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await api('/push/unsubscribe', { method: 'POST', body: { endpoint } });
      }
      showToastA('ปิดการแจ้งเตือนผ่านแอปแล้ว');
    }
  } catch (err) {
    showToastA(err.message || 'เปลี่ยนการตั้งค่าไม่สำเร็จ');
  } finally {
    await refreshNotifyPushToggle();
  }
}

function adminLogout() {
  const rt = getRefreshToken();
  if (rt) {
    fetch(API_BASE + '/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    }).catch(() => {});
  }
  clearToken();
  clearRefreshToken();
  if (socket) { socket.disconnect(); socket = null; }
  location.reload();
}

/* ============ Notification badges (🔔 tickets / ✉️ inbox) ============ */
function setNotifBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = count > 99 ? '99+' : String(count);
  el.style.display = count > 0 ? '' : 'none';
}
async function refreshNotifBadges() {
  try {
    const [tk, ch] = await Promise.all([api('/tickets/unread-count'), api('/chat/unread-count')]);
    setNotifBadge('notif-bell-badge', tk.count);
    setNotifBadge('notif-mail-badge', ch.count);
  } catch (e) { /* badges just stay hidden if this fails */ }
}

/* ============ General notification center (📣) — order/payment/wallet/shipping/
   account/ticket alerts, distinct from the ticket-specific 🔔. Category-level
   on/off toggles live in Settings > การแจ้งเตือน (see routes/notifications.js and
   lib/notify.js on the backend). ============ */
async function refreshGeneralNotifBadge() {
  try {
    const { count } = await api('/notifications/unread-count');
    setNotifBadge('notif-general-badge', count);
  } catch (e) { /* non-critical */ }
}
async function loadNotifPanel() {
  const listEl = document.getElementById('notif-panel-list');
  listEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--ink-400);font-size:12px">กำลังโหลด...</div>`;
  try {
    const items = await api('/notifications');
    listEl.innerHTML = items.length ? items.map(n => `
      <div style="padding:9px 6px;border-bottom:1px solid #F8F7FC">
        <div style="font-size:12.5px;font-weight:700;color:var(--ink-900)">${n.icon || '🔔'} ${escapeHtml(n.title)}</div>
        ${n.body ? `<div style="font-size:11.5px;color:var(--ink-600);margin-top:2px">${escapeHtml(n.body)}</div>` : ''}
        <div style="font-size:10px;color:var(--ink-400);margin-top:3px">${formatDate(n.created_at)}</div>
      </div>`).join('') : `<div style="text-align:center;padding:20px;color:var(--ink-400);font-size:12px">ยังไม่มีการแจ้งเตือน</div>`;
  } catch (e) {
    listEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--danger);font-size:12px">${e.message}</div>`;
  }
}
function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? 'block' : 'none';
  if (opening) loadNotifPanel();
}
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notif-panel');
  if (panel && panel.style.display !== 'none' && !e.target.closest('#notif-panel') && !e.target.closest('[onclick="toggleNotifPanel()"]')) {
    panel.style.display = 'none';
  }
});
async function markAllNotifRead() {
  try {
    await api('/notifications/mark-seen', { method: 'POST' });
    setNotifBadge('notif-general-badge', 0);
    loadNotifPanel();
  } catch (e) { showToastA(e.message); }
}

/* ============ Realtime ============ */
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io(SOCKET_URL, { auth: { token: getToken() } });

  socket.on('connect_error', async (err) => {
    if (err.message === 'unauthorized' && getRefreshToken()) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        socket.auth.token = getToken();
        socket.connect();
      }
    }
  });

  socket.on('settings:update', (s) => { applyAdminBranding(s); });

  socket.on('chat:message', ({ customerId, message }) => {
    if (!inboxMessagesCache[customerId]) inboxMessagesCache[customerId] = [];
    inboxMessagesCache[customerId].push(message);
    if (currentInboxCustomerId === customerId) renderInboxMessages();
    else showToastA('ข้อความใหม่จากลูกค้า');
  });

  socket.on('ticket:new', (t) => {
    tickets.unshift(t);
    showToastA('มีงานแจ้งใหม่: ' + t.id);
    playNotifSoundA();
    refreshCurrentPage();
  });
  socket.on('ticket:update', (t) => {
    const idx = tickets.findIndex(x => x.id === t.id);
    if (idx >= 0) tickets[idx] = t; else tickets.unshift(t);
    refreshCurrentPage();
  });
  socket.on('tickets:unread-count', ({ count }) => setNotifBadge('notif-bell-badge', count));
  socket.on('chat:unread-count', ({ count }) => setNotifBadge('notif-mail-badge', count));

  // 'ticket'/'order' categories already get their own toast+sound above (ticket:new
  // / order:new carry richer info than the generic notification row) — skip those
  // here to avoid a duplicate toast+beep for the same event; badge/panel still refresh.
  socket.on('notification:new', (n) => {
    refreshGeneralNotifBadge();
    if (document.getElementById('notif-panel').style.display !== 'none') loadNotifPanel();
    if (n.category !== 'ticket' && n.category !== 'order') {
      showToastA(`${n.icon || '🔔'} ${n.title}`);
      playNotifSoundA();
    }
  });

  socket.on('order:new', (o) => {
    storeOrders.unshift(o);
    showToastA('มีคำสั่งซื้อใหม่: ' + o.id + ' (฿' + o.total.toLocaleString() + ')');
    playNotifSoundA();
    if (document.getElementById('page-storeOrders').classList.contains('active')) renderStoreOrders();
  });
  socket.on('order:update', (o) => {
    const idx = storeOrders.findIndex(x => x.id === o.id);
    if (idx >= 0) storeOrders[idx] = o; else storeOrders.unshift(o);
    if (document.getElementById('page-storeOrders').classList.contains('active')) renderStoreOrders();
  });
  socket.on('order:slip-uploaded', (o) => {
    const idx = storeOrders.findIndex(x => x.id === o.id);
    if (idx >= 0) storeOrders[idx] = o; else storeOrders.unshift(o);
    showToastA(`💰 ${o.customer_name} แจ้งชำระเงินแล้ว • ${o.id} • ฿${o.total.toLocaleString()}`);
    if (document.getElementById('page-storeOrders').classList.contains('active')) renderStoreOrders();
  });

  // ---------- WebRTC signaling ----------
  socket.on('webrtc:incoming', ({ customerId, mode, from }) => {
    pendingOffers[customerId] = pendingOffers[customerId] || {};
    pendingOffers[customerId].mode = mode;
    pendingOffers[customerId].fromName = from.name;
    showIncomingCallBanner(customerId, from.name);
  });
  socket.on('webrtc:offer', ({ customerId, sdp }) => {
    pendingOffers[customerId] = pendingOffers[customerId] || {};
    pendingOffers[customerId].sdp = sdp;
  });
  socket.on('webrtc:ice-candidate', async ({ customerId, candidate }) => {
    if (adminPc && currentCallCustomerId === customerId && candidate) {
      try { await adminPc.addIceCandidate(candidate); } catch (e) { /* ignore late/duplicate candidates */ }
    }
  });
  socket.on('webrtc:ended', ({ customerId }) => {
    if (currentCallCustomerId === customerId) {
      showToastA('ลูกค้าวางสายแล้ว');
      cleanupAdminCall();
    } else {
      delete pendingOffers[customerId];
      hideIncomingCallBanner();
    }
  });
}

function refreshCurrentPage() {
  const active = document.querySelector('.page.active');
  if (!active) return;
  const id = active.id.replace('page-', '');
  if (id === 'dashboard') renderDashTickets();
  if (id === 'tickets') renderTickets();
  if (id === 'tasks') renderKanban();
}

/* ============ Incoming call banner ============ */
function showIncomingCallBanner(customerId, name) {
  const banner = document.getElementById('incoming-call-banner');
  banner.dataset.customerId = customerId;
  document.getElementById('icb-customer-name').textContent = name;
  banner.style.display = 'flex';
}
function hideIncomingCallBanner() {
  document.getElementById('incoming-call-banner').style.display = 'none';
}
function rejectIncomingCall() {
  const banner = document.getElementById('incoming-call-banner');
  const customerId = Number(banner.dataset.customerId);
  if (customerId && socket) socket.emit('webrtc:reject', { customerId });
  delete pendingOffers[customerId];
  hideIncomingCallBanner();
}

/* ============ Accepting a call: build outgoing stream (real cam or AI avatar) ============ */
let currentCallSettings = {};
let previewStream = null;
let previewAvatarHandle = null;
let previewCopyRAF = null;

function stopAvatarPreview() {
  if (previewCopyRAF) { cancelAnimationFrame(previewCopyRAF); previewCopyRAF = null; }
  if (previewAvatarHandle) { previewAvatarHandle.stop(); previewAvatarHandle = null; }
  if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); previewStream = null; }
}

async function previewAvatarAppearance() {
  stopAvatarPreview();
  const skin = document.querySelector('#swatch-skin .selected')?.dataset.value || '#F0C8A0';
  const hair = document.querySelector('#swatch-hair .selected')?.dataset.value || '#3A2A20';
  const uniform = document.querySelector('#swatch-uniform .selected')?.dataset.value || '#6C3CE9';
  const video = document.getElementById('settings-avatar-source');
  const previewCanvas = document.getElementById('settings-avatar-preview');
  const pctx = previewCanvas.getContext('2d');

  try {
    previewStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    video.srcObject = previewStream;
    await video.play().catch(() => {});
    previewAvatarHandle = await window.createAvatarStream(video, { skinTone: skin, hairColor: hair, uniformColor: uniform });

    const copyLoop = () => {
      if (!previewAvatarHandle) return;
      pctx.drawImage(previewAvatarHandle.canvas, 0, 0, previewCanvas.width, previewCanvas.height);
      previewCopyRAF = requestAnimationFrame(copyLoop);
    };
    copyLoop();
    showToastA('กำลังแสดงตัวอย่างอวตารจากกล้อง');
  } catch (e) {
    showToastA('ไม่สามารถเข้าถึงกล้องได้: ' + e.message);
  }
}

async function getOutgoingVideoTrack(mode) {
  if (mode === 'ai') {
    if (!adminAvatarHandle) {
      const rawVideoEl = document.getElementById('admin-raw-camera-source');
      rawVideoEl.srcObject = adminRawStream;
      await rawVideoEl.play().catch(() => {});
      adminAvatarHandle = await window.createAvatarStream(rawVideoEl, {
        skinTone: currentCallSettings.avatar_skin_tone,
        hairColor: currentCallSettings.avatar_hair_color,
        uniformColor: currentCallSettings.avatar_uniform_color,
      });
    }
    return adminAvatarHandle.stream.getVideoTracks()[0];
  }
  return adminRawStream.getVideoTracks()[0];
}

async function acceptIncomingCall() {
  const banner = document.getElementById('incoming-call-banner');
  const customerId = Number(banner.dataset.customerId);
  const offer = pendingOffers[customerId];
  hideIncomingCallBanner();
  if (!customerId || !offer || !offer.sdp) { showToastA('ไม่พบสายเรียกเข้า (อาจถูกยกเลิกแล้ว)'); return; }

  currentCallCustomerId = customerId;
  adminCallSeconds = 0;
  adminMuted = false;
  document.getElementById('acall-customer-name').textContent = offer.fromName || 'ลูกค้า';
  document.getElementById('acall-tag-text').textContent = 'กำลังเชื่อมต่อ...';
  document.getElementById('acall-mute-btn').textContent = '🎙️';

  // Read the server-side setting fresh — it's the source of truth for which mode to use.
  let s = {};
  try { s = await api('/settings'); } catch (e) { /* fall back to default */ }
  adminCurrentVideoMode = s.call_mode || 'ai';
  currentCallSettings = s;
  updateModeButtonUI();

  try {
    adminRawStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    showToastA('ไม่สามารถเข้าถึงกล้อง/ไมโครโฟนได้');
    if (socket) socket.emit('webrtc:reject', { customerId });
    return;
  }

  const videoTrack = await getOutgoingVideoTrack(adminCurrentVideoMode);
  const outgoingStream = new MediaStream([videoTrack, ...adminRawStream.getAudioTracks()]);
  document.getElementById('acall-local-video').srcObject = adminCurrentVideoMode === 'ai' ? adminAvatarHandle.stream : adminRawStream;

  adminPc = new RTCPeerConnection({ iceServers: await getIceServers() });
  outgoingStream.getTracks().forEach(track => adminPc.addTrack(track, outgoingStream));

  adminPc.onicecandidate = (e) => {
    if (e.candidate && socket) socket.emit('webrtc:ice-candidate', { customerId, candidate: e.candidate });
  };
  adminPc.ontrack = (e) => {
    document.getElementById('acall-remote-video').srcObject = e.streams[0];
  };
  adminPc.onconnectionstatechange = () => {
    if (adminPc && (adminPc.connectionState === 'disconnected' || adminPc.connectionState === 'failed')) {
      showToastA('การเชื่อมต่อสายหลุด');
      cleanupAdminCall();
    }
  };

  await adminPc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
  const answer = await adminPc.createAnswer();
  await adminPc.setLocalDescription(answer);
  socket.emit('webrtc:answer', { customerId, sdp: answer.sdp });

  document.getElementById('admin-call-overlay').style.display = 'flex';
  document.getElementById('acall-tag-text').textContent = 'สายกำลังใช้งาน';
  adminCallTimerInterval = setInterval(() => { adminCallSeconds++; updateAdminCallTimer(); }, 1000);
  updateAdminCallTimer();
}

function updateAdminCallTimer() {
  const m = Math.floor(adminCallSeconds / 60).toString().padStart(2, '0');
  const s = (adminCallSeconds % 60).toString().padStart(2, '0');
  document.getElementById('acall-timer').textContent = `${m}:${s}`;
}

function toggleAdminMute() {
  adminMuted = !adminMuted;
  document.getElementById('acall-mute-btn').textContent = adminMuted ? '🔇' : '🎙️';
  if (adminRawStream) adminRawStream.getAudioTracks().forEach(t => t.enabled = !adminMuted);
}

function updateModeButtonUI() {
  const btn = document.getElementById('acall-mode-btn');
  btn.textContent = adminCurrentVideoMode === 'ai' ? '🤖' : '🧑‍💼';
  btn.title = adminCurrentVideoMode === 'ai'
    ? 'กำลังใช้ AI Avatar — คลิกเพื่อสลับเป็นหน้าจริง'
    : 'กำลังใช้หน้าจริง — คลิกเพื่อสลับเป็น AI Avatar';
}

// Swaps the outgoing video track live, mid-call, without renegotiating the connection
// (RTCRtpSender.replaceTrack — no new offer/answer needed for a like-for-like track swap).
async function toggleAdminCallVideoMode() {
  if (!adminPc) return;
  adminCurrentVideoMode = adminCurrentVideoMode === 'ai' ? 'real' : 'ai';
  updateModeButtonUI();
  try {
    const newTrack = await getOutgoingVideoTrack(adminCurrentVideoMode);
    const sender = adminPc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);
    document.getElementById('acall-local-video').srcObject = adminCurrentVideoMode === 'ai' ? adminAvatarHandle.stream : adminRawStream;
    showToastA(adminCurrentVideoMode === 'ai' ? 'สลับเป็น AI Avatar สำหรับสายนี้แล้ว' : 'สลับเป็นหน้าจริงสำหรับสายนี้แล้ว');
  } catch (e) {
    showToastA('ไม่สามารถสลับโหมดได้: ' + e.message);
  }
}

function cleanupAdminCall() {
  clearInterval(adminCallTimerInterval);
  if (adminRawStream) { adminRawStream.getTracks().forEach(t => t.stop()); adminRawStream = null; }
  if (adminAvatarHandle) { adminAvatarHandle.stop(); adminAvatarHandle = null; }
  if (adminPc) { adminPc.close(); adminPc = null; }
  currentCallCustomerId = null;
  document.getElementById('admin-call-overlay').style.display = 'none';
}

function endAdminCall() {
  if (socket && currentCallCustomerId) socket.emit('webrtc:end', { customerId: currentCallCustomerId });
  cleanupAdminCall();
  showToastA('วางสายแล้ว');
}

/* ============ Admin-initiated outgoing call (from the Inbox) ============ */
async function adminInitiateCall() {
  if (!currentInboxCustomerId) return;
  const customerId = currentInboxCustomerId;
  const customer = customers.find(c => c.id === customerId);
  currentCallCustomerId = customerId;
  adminCallSeconds = 0;
  adminMuted = false;
  document.getElementById('acall-customer-name').textContent = (customer && customer.name) || 'ลูกค้า';
  document.getElementById('acall-tag-text').textContent = 'กำลังโทรออก...';
  document.getElementById('acall-mute-btn').textContent = '🎙️';

  let s = {};
  try { s = await api('/settings'); } catch (e) { /* fall back to default */ }
  adminCurrentVideoMode = s.call_mode || 'ai';
  currentCallSettings = s;
  updateModeButtonUI();

  try {
    adminRawStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    showToastA('ไม่สามารถเข้าถึงกล้อง/ไมโครโฟนได้');
    currentCallCustomerId = null;
    return;
  }

  const videoTrack = await getOutgoingVideoTrack(adminCurrentVideoMode);
  const outgoingStream = new MediaStream([videoTrack, ...adminRawStream.getAudioTracks()]);
  document.getElementById('acall-local-video').srcObject = adminCurrentVideoMode === 'ai' ? adminAvatarHandle.stream : adminRawStream;

  adminPc = new RTCPeerConnection({ iceServers: await getIceServers() });
  outgoingStream.getTracks().forEach(track => adminPc.addTrack(track, outgoingStream));

  adminPc.onicecandidate = (e) => {
    if (e.candidate && socket) socket.emit('webrtc:ice-candidate', { customerId, candidate: e.candidate });
  };
  adminPc.ontrack = (e) => {
    document.getElementById('acall-remote-video').srcObject = e.streams[0];
  };
  adminPc.onconnectionstatechange = () => {
    if (adminPc && (adminPc.connectionState === 'disconnected' || adminPc.connectionState === 'failed')) {
      showToastA('การเชื่อมต่อสายหลุด');
      cleanupAdminCall();
    }
  };

  const onAnswer = async ({ customerId: cid, sdp }) => {
    if (cid !== customerId || !adminPc) return;
    await adminPc.setRemoteDescription({ type: 'answer', sdp });
    document.getElementById('acall-tag-text').textContent = 'สายกำลังใช้งาน';
    socket.off('webrtc:answer', onAnswer);
  };
  const onRejected = ({ customerId: cid }) => {
    if (cid !== customerId) return;
    showToastA('ลูกค้าไม่รับสาย');
    cleanupAdminCall();
    socket.off('webrtc:rejected', onRejected);
  };
  socket.on('webrtc:answer', onAnswer);
  socket.on('webrtc:rejected', onRejected);

  const offer = await adminPc.createOffer();
  await adminPc.setLocalDescription(offer);
  socket.emit('webrtc:call', { customerId, mode: adminCurrentVideoMode });
  socket.emit('webrtc:offer', { customerId, sdp: offer.sdp });

  document.getElementById('admin-call-overlay').style.display = 'flex';
  adminCallTimerInterval = setInterval(() => { adminCallSeconds++; updateAdminCallTimer(); }, 1000);
  updateAdminCallTimer();
}

/* ============ Navigation ============ */
async function go(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelectorAll('.side-link').forEach(l => l.classList.toggle('active', l.dataset.page === page));
  const titles = { dashboard: 'หน้าหลัก', inbox: 'กล่องข้อความ', products: 'จัดการสินค้า', categories: 'หมวดหมู่สินค้า', storeOrders: 'คำสั่งซื้อ', reviews: 'รีวิวสินค้า', marketing: 'การตลาด', tickets: 'รายการแจ้งบริการ', tasks: 'จัดการงาน', customers: 'ลูกค้า', finance: 'บริหารการเงิน', channels: 'ช่องทางการติดต่อ', kb: 'คลังความรู้', reports: 'รายงานและสถิติ', settings: 'ตั้งค่า' };
  document.getElementById('page-title').textContent = titles[page];

  try {
    if (page === 'dashboard') { dashboardStats = await api('/stats/dashboard'); tickets = await api('/tickets'); renderDashTickets(); drawChart('dash-chart', dashboardStats.last7Days.map(d => d.count), dashboardStats.last7Days.map(d => d.date)); renderDashStatCards(); }
    if (page === 'inbox') { await loadInboxCustomers(); }
    if (page === 'tickets') {
      tickets = await api('/tickets');
      renderTickets();
      // Opening this page is how the admin "reads" the notification — clears the 🔔 badge.
      api('/tickets/mark-seen', { method: 'POST' }).then(() => setNotifBadge('notif-bell-badge', 0)).catch(() => {});
    }
    if (page === 'tasks') { tickets = await api('/tickets'); renderKanban(); }
    if (page === 'customers') { customers = await api('/customers'); renderCustomers(); }
    if (page === 'finance') { customers = await api('/customers'); renderFinance(); loadFinanceReferralSection(); }
    if (page === 'kb') { kbArticles = await api('/kb'); renderKbAdmin(); }
    if (page === 'products') { categoriesAdmin = await api('/categories'); productsAdmin = await api('/products/all'); populateCategoryFilter(); renderProductsAdmin(); }
    if (page === 'categories') { categoriesAdmin = await api('/categories'); productsAdmin = await api('/products/all'); renderCategoriesAdmin(); }
    if (page === 'storeOrders') { storeOrders = await api('/orders'); renderStoreOrders(); }
    if (page === 'reviews') { reviewsAdmin = await api('/reviews/all'); renderReviewsAdmin(); }
    if (page === 'marketing') { renderMarketing('coupons'); }
    if (page === 'reports') { dashboardStats = await api('/stats/dashboard'); drawChart('report-chart', dashboardStats.last7Days.map(d => d.count), dashboardStats.last7Days.map(d => d.date)); }
    if (page === 'settings') renderSettings('profile');
  } catch (e) {
    showToastA(e.message);
  }
}

document.getElementById('side-nav').addEventListener('click', (e) => {
  const link = e.target.closest('.side-link');
  if (link) go(link.dataset.page);
});

// Hides sidebar links (and blocks direct go() calls) for pages the signed-in admin
// doesn't have permission for — see routes/team.js. The owner account always sees
// everything. Called once right after login/session-restore.
function applyAdminPermissionGating() {
  if (!currentAdmin || currentAdmin.role !== 'admin') return;
  if (currentAdmin.isOwner) return; // owner: no restrictions
  const allowed = new Set(currentAdmin.permissions || []);
  document.querySelectorAll('.side-link').forEach(l => {
    l.style.display = allowed.has(l.dataset.page) ? '' : 'none';
  });
  // If the admin landed on (or is currently viewing) a page they don't have access
  // to — e.g. a stale bookmark, or a permission that was revoked mid-session — bounce
  // them to the first page they DO have access to instead of showing a blank screen.
  const currentPage = document.querySelector('.page.active');
  const currentKey = currentPage ? currentPage.id.replace('page-', '') : null;
  if (currentKey && !allowed.has(currentKey)) {
    const firstAllowed = [...allowed][0] || 'dashboard';
    go(firstAllowed);
  }
}

function statusCls(s) {
  if (s === 'รอดำเนินการ') return 'st-wait';
  if (s === 'กำลังดำเนินการ') return 'st-progress';
  return 'st-done';
}
function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ============ Dashboard ============ */
function renderDashStatCards() {
  const s = dashboardStats;
  document.querySelectorAll('.stat-card .st-val')[0].textContent = s.total;
  document.querySelectorAll('.stat-card .st-val')[1].textContent = s.inProgress;
  document.querySelectorAll('.stat-card .st-val')[2].textContent = s.done;
  document.querySelectorAll('.stat-card .st-val')[3].textContent = s.satisfaction.average + ' / 5';
}
function renderDashTickets() {
  const body = document.getElementById('dash-ticket-body');
  body.innerHTML = tickets.slice(0, 4).map(t => `
    <tr>
      <td>${t.id}</td><td>${t.title}</td><td>${t.customer_name}</td><td>${t.channel}</td>
      <td><span class="priority-chip priority-${t.priority}">${t.priority}</span></td>
      <td><span class="status-chip2 ${statusCls(t.status)}">${t.status}</span></td>
    </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--ink-400)">ยังไม่มีงาน</td></tr>`;
}

/* ============ Inbox ============ */
async function loadInboxCustomers() {
  customers = await api('/customers');
  renderInboxList();
}
function renderInboxList() {
  const el = document.getElementById('inbox-list');
  el.innerHTML = customers.map(c => `
    <div class="inbox-cust-row ${currentInboxCustomerId === c.id ? 'active' : ''}" onclick="openInboxChat(${c.id}, '${c.name.replace(/'/g,"")}')">
      <div class="ic-avatar">${c.name.charAt(0)}</div>
      <div><div class="ic-name">${c.name}</div><div class="ic-sub">${c.phone || '-'}</div></div>
    </div>`).join('') || `<div style="padding:20px;text-align:center;color:var(--ink-400);font-size:12px">ยังไม่มีลูกค้า</div>`;
}
async function openInboxChat(customerId, name) {
  currentInboxCustomerId = customerId;
  renderInboxList();
  document.getElementById('inbox-chat-header').textContent = name;
  document.getElementById('inbox-text').disabled = false;
  document.getElementById('inbox-send-btn').disabled = false;
  document.getElementById('inbox-attach-btn').disabled = false;
  if (socket) socket.emit('chat:open', customerId);
  try {
    const data = await api('/chat/' + customerId);
    inboxMessagesCache[customerId] = data.messages;
    renderInboxMessages();
  } catch (e) { showToastA(e.message); }
}
function renderInboxMessages() {
  const el = document.getElementById('inbox-messages');
  const msgs = inboxMessagesCache[currentInboxCustomerId] || [];
  el.innerHTML = msgs.map(m => `
    <div class="ib-msg-row ${m.sender_role === 'admin' ? 'me' : 'them'}">
      <div class="ib-msg-bubble">
        ${m.image_url ? `<img class="ib-msg-image" src="${escapeHtml(m.image_url)}" alt="">` : ''}
        ${m.text ? escapeHtml(m.text) : ''}
        <span class="ib-msg-time">${formatTime(m.created_at)}</span>
      </div>
    </div>`).join('') || `<div style="text-align:center;color:var(--ink-400);font-size:12px;padding:30px">ยังไม่มีข้อความ</div>`;
  el.scrollTop = el.scrollHeight;
}
function sendInboxMsg() {
  const input = document.getElementById('inbox-text');
  const text = input.value.trim();
  if (!text || !currentInboxCustomerId || !socket) return;
  socket.emit('chat:send', { customerId: currentInboxCustomerId, text });
  input.value = '';
}

// Wires the 📎 attach button in the inbox chat: picks an image, uploads it to
// /upload/chat-image, then sends it to the currently open customer's conversation.
function setupInboxImageUploader() {
  const input = document.getElementById('inbox-image-input');
  if (!input) return;
  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !currentInboxCustomerId) return;
    const MAX_SIZE = 5 * 1024 * 1024;
    const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!ALLOWED.includes(file.type)) { showToastA('รองรับเฉพาะไฟล์รูปภาพ JPG, PNG, WEBP หรือ GIF เท่านั้น'); input.value = ''; return; }
    if (file.size > MAX_SIZE) { showToastA('ไฟล์ต้องมีขนาดไม่เกิน 5MB'); input.value = ''; return; }
    try {
      const form = new FormData();
      form.append('image', file);
      const res = await fetch(API_BASE + '/upload/chat-image', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: form,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || 'ส่งรูปภาพไม่สำเร็จ');
      if (socket) socket.emit('chat:send', { customerId: currentInboxCustomerId, imageUrl: data.url });
    } catch (err) {
      showToastA(err.message || 'ส่งรูปภาพไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      input.value = '';
    }
  });
}
function formatTime(iso) {
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d)) return '';
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

/* ============ Tickets page ============ */
function renderTickets() {
  const statusF = document.getElementById('tk-status-filter').value;
  const chF = document.getElementById('tk-channel-filter').value;
  const q = (document.getElementById('tk-search').value || '').toLowerCase();
  const filtered = tickets.filter(t =>
    (!statusF || t.status === statusF) &&
    (!chF || t.channel === chF) &&
    (t.id.toLowerCase().includes(q) || t.customer_name.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
  );
  const body = document.getElementById('tickets-body');
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--ink-400)">ไม่พบข้อมูล</td></tr>`;
    return;
  }
  body.innerHTML = filtered.map(t => `
    <tr onclick="cycleStatus('${t.id}')" style="cursor:pointer">
      <td>${t.id}</td><td>${t.title}</td><td>${t.customer_name}</td><td>${t.channel}</td>
      <td><span class="priority-chip priority-${t.priority}">${t.priority}</span></td>
      <td><span class="status-chip2 ${statusCls(t.status)}">${t.status}</span></td>
      <td><button class="btn-danger btn-sm" onclick="event.stopPropagation();openCustomerForm(${t.customer_id})">✎ แก้ไข</button></td>
      <td>${formatDate(t.updated_at)}</td>
    </tr>`).join('');
}

async function cycleStatus(id) {
  const t = tickets.find(x => x.id === id);
  const order = ['รอดำเนินการ', 'กำลังดำเนินการ', 'เสร็จสิ้น'];
  const nextStatus = order[(order.indexOf(t.status) + 1) % order.length];
  try {
    const updated = await api('/tickets/' + id, { method: 'PATCH', body: { status: nextStatus } });
    const idx = tickets.findIndex(x => x.id === id);
    tickets[idx] = updated;
    refreshCurrentPage();
    showToastA('อัปเดตสถานะงาน ' + id + ' เป็น "' + nextStatus + '"');
  } catch (e) { showToastA(e.message); }
}

function addTicket() {
  showToastA('เลือกลูกค้าจากหน้า "ลูกค้า" หรือให้ลูกค้าแจ้งผ่านแอปฝั่งลูกค้าเพื่อสร้างงานใหม่');
}

/* ============ Kanban (tasks) ============ */
function renderKanban() {
  const cols = { 'รอดำเนินการ': 'kcol-wait', 'กำลังดำเนินการ': 'kcol-progress', 'เสร็จสิ้น': 'kcol-done' };
  ['รอดำเนินการ','กำลังดำเนินการ','เสร็จสิ้น'].forEach(s => {
    const list = tickets.filter(t => t.status === s);
    document.getElementById(cols[s]).innerHTML = list.map(t => `
      <div class="kanban-card" onclick="cycleStatus('${t.id}')">
        <div class="kc-title">${t.title}</div>
        <div class="kc-meta"><span>${t.customer_name}</span><span class="priority-chip priority-${t.priority}">${t.priority}</span></div>
      </div>`).join('') || `<div style="font-size:11px;color:var(--ink-400);text-align:center;padding:14px">ไม่มีงาน</div>`;
  });
  document.getElementById('kcount-wait').textContent = '(' + tickets.filter(t=>t.status==='รอดำเนินการ').length + ')';
  document.getElementById('kcount-progress').textContent = '(' + tickets.filter(t=>t.status==='กำลังดำเนินการ').length + ')';
  document.getElementById('kcount-done').textContent = '(' + tickets.filter(t=>t.status==='เสร็จสิ้น').length + ')';
}

/* ============ Customers ============ */
function renderCustomers() {
  const q = (document.getElementById('cu-search').value || '').toLowerCase();
  const filtered = customers.filter(c => c.name.toLowerCase().includes(q) || (c.phone||'').includes(q));
  document.getElementById('customers-grid').innerHTML = filtered.map(c => `
    <div class="cust-card">
      <div class="cu-top">
        <div class="cu-avatar">${c.name.charAt(0)}</div>
        <div><div class="cu-name">${c.name} ${c.account_status === 'แช่แข็ง' ? '<span class="status-chip2 st-wait">🧊 ดำเนินการถอนเงิน</span>' : ''}</div><div class="cu-sub">${c.phone || '-'} • ฿${Number(c.wallet_balance || 0).toLocaleString()}</div></div>
      </div>
      <div class="cu-stats"><span>เรื่องที่แจ้ง: ${c.ticket_count}</span><a style="color:var(--purple-600);font-weight:700;cursor:pointer" onclick="go('inbox');setTimeout(()=>openInboxChat(${c.id},'${c.name.replace(/'/g,"")}'),200)">แชท ›</a></div>
      <div class="cu-stats" style="margin-top:8px">
        <a style="color:var(--purple-600);font-weight:700;cursor:pointer" onclick="openCustomerForm(${c.id})">✎ แก้ไข</a>
        <a style="color:var(--danger);font-weight:700;cursor:pointer" onclick="deleteCustomer(${c.id})">🗑 ลบ</a>
      </div>
    </div>`).join('') || `<div style="grid-column:1/-1;text-align:center;padding:30px;color:var(--ink-400)">ไม่พบลูกค้า</div>`;
}

/* ============ Finance management (บริหารการเงิน) ============
   A dedicated back-office page for every customer's wallet: balance, account
   status, and quick access to the same credit/debit/freeze modal used elsewhere
   (openCustomerForm). Since that modal's actions hit POST /customers/:id/wallet
   and PATCH /customers/:id/status — which push realtime `wallet:update` /
   `account:frozen` events straight to the customer's own profile page — any
   change made from here is reflected on the customer's side immediately. */
function renderFinance() {
  const totalBalance = customers.reduce((sum, c) => sum + Number(c.wallet_balance || 0), 0);
  const frozenCount = customers.filter(c => c.account_status === 'แช่แข็ง').length;
  document.getElementById('fin-total-balance').textContent = '฿' + totalBalance.toLocaleString();
  document.getElementById('fin-active-count').textContent = (customers.length - frozenCount).toLocaleString();
  document.getElementById('fin-frozen-count').textContent = frozenCount.toLocaleString();

  const statusF = document.getElementById('fin-status-filter').value;
  const q = (document.getElementById('fin-search').value || '').toLowerCase();
  const filtered = customers.filter(c =>
    (!statusF || c.account_status === statusF) &&
    (c.name.toLowerCase().includes(q) || (c.phone || '').includes(q))
  );

  const body = document.getElementById('finance-body');
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--ink-400)">ไม่พบข้อมูล</td></tr>`;
    return;
  }
  body.innerHTML = filtered.map(c => {
    const frozen = c.account_status === 'แช่แข็ง';
    return `
    <tr>
      <td><div style="display:flex;align-items:center;gap:8px"><div class="cu-avatar" style="width:28px;height:28px;font-size:12px">${c.name.charAt(0)}</div>${c.name}</div></td>
      <td>${c.phone || '-'}</td>
      <td style="font-weight:800;color:var(--purple-600)">฿${Number(c.wallet_balance || 0).toLocaleString()}</td>
      <td><span class="status-chip2 ${frozen ? 'st-wait' : 'st-done'}">${frozen ? '🧊 ดำเนินการถอนเงิน' : '✅ ปกติ'}</span></td>
      <td><button class="btn btn-sm" onclick="openFinanceDetail(${c.id})">💰 จัดการยอดเงิน</button></td>
    </tr>`;
  }).join('');
}

let currentFinanceCustomer = null; // whichever customer the inline detail panel below is showing

// Opens the account detail panel directly on the Finance page itself (no modal) —
// balance, freeze/unfreeze, the wallet-adjust form, and transaction history all
// live inline here so an admin can manage money without leaving this page.
async function openFinanceDetail(id) {
  try {
    const c = await api('/customers/' + id);
    currentFinanceCustomer = c;
    renderFinanceDetail(c);
    const panel = document.getElementById('fin-detail-panel');
    panel.style.display = 'block';
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { showToastA(e.message); }
}
function closeFinanceDetail() {
  document.getElementById('fin-detail-panel').style.display = 'none';
  currentFinanceCustomer = null;
}
function renderFinanceDetail(c) {
  document.getElementById('fin-detail-name').textContent = c.name;
  document.getElementById('fin-detail-balance').textContent = '฿' + Number(c.wallet_balance || 0).toLocaleString();

  const frozen = c.account_status === 'แช่แข็ง';
  const badge = document.getElementById('fin-detail-status-badge');
  badge.textContent = frozen ? '🧊 ดำเนินการถอนเงิน' : '✅ ปกติ';
  badge.className = 'status-chip2 ' + (frozen ? 'st-wait' : 'st-done');
  const toggleBtn = document.getElementById('fin-detail-status-toggle-btn');
  toggleBtn.textContent = frozen ? '✅ ปลดแช่แข็งบัญชี' : '🧊 แช่แข็งบัญชี';
  toggleBtn.className = frozen ? 'btn-outline btn-sm' : 'btn-danger btn-sm';

  const txList = document.getElementById('fin-detail-tx-list');
  const txs = c.transactions || [];
  txList.innerHTML = txs.slice(0, 15).map(tx => {
    const amt = Number(tx.amount || 0);
    const positive = amt >= 0;
    return `
      <div class="wtx-row">
        <div><div class="wtx-desc">${escapeHtml(tx.description || '')}</div><div class="wtx-date">${formatDate(tx.created_at)}</div></div>
        <div class="wtx-amt ${positive ? 'pos' : 'neg'}">${positive ? '+' : ''}฿${amt.toLocaleString()}</div>
      </div>`;
  }).join('') || `<div style="text-align:center;color:var(--ink-400);font-size:12px;padding:10px">ยังไม่มีประวัติรายการ</div>`;
}

async function submitFinanceWalletAdjust() {
  if (!currentFinanceCustomer) return;
  const id = currentFinanceCustomer.id;
  const errEl = document.getElementById('fin-detail-error');
  errEl.style.display = 'none';

  const direction = document.getElementById('fin-detail-direction').value;
  const category = document.getElementById('fin-detail-category').value;
  const amount = Number(document.getElementById('fin-detail-amount').value);
  const note = document.getElementById('fin-detail-note').value.trim();

  if (!amount || amount <= 0) {
    errEl.textContent = 'กรุณากรอกจำนวนเงินให้ถูกต้อง';
    errEl.style.display = 'block';
    return;
  }

  try {
    const result = await api('/customers/' + id + '/wallet', { method: 'POST', body: { direction, category, amount, note } });
    currentFinanceCustomer.wallet_balance = result.walletBalance;
    currentFinanceCustomer.transactions = [result.transaction, ...(currentFinanceCustomer.transactions || [])];
    renderFinanceDetail(currentFinanceCustomer);
    document.getElementById('fin-detail-amount').value = '';
    document.getElementById('fin-detail-note').value = '';
    customers = customers.map(c => c.id === id ? { ...c, wallet_balance: result.walletBalance } : c);
    renderFinance();
    if (document.getElementById('page-customers').classList.contains('active')) renderCustomers();
    if (currentCustomerDetail && currentCustomerDetail.id === id) {
      currentCustomerDetail.wallet_balance = result.walletBalance;
      currentCustomerDetail.transactions = [result.transaction, ...(currentCustomerDetail.transactions || [])];
      renderCustomerWalletSection(currentCustomerDetail);
    }
    showToastA((direction === 'credit' ? '➕ เติมยอดเงิน' : '➖ หักยอดเงิน') + ' ฿' + amount.toLocaleString() + ' เรียบร้อยแล้ว');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

async function toggleFinanceCustomerStatus() {
  if (!currentFinanceCustomer) return;
  const id = currentFinanceCustomer.id;
  const next = currentFinanceCustomer.account_status === 'แช่แข็ง' ? 'ปกติ' : 'แช่แข็ง';
  const confirmMsg = next === 'แช่แข็ง'
    ? `ดำเนินการถอนเงินและระงับบัญชีของ "${currentFinanceCustomer.name}" ใช่หรือไม่?\n\nยอดเงินคงเหลือ (฿${Number(currentFinanceCustomer.wallet_balance || 0).toLocaleString()}) จะถูกล้างเป็น 0.00 บาททันที และลูกค้าจะไม่สามารถเข้าสู่ระบบได้จนกว่าจะปลดสถานะ`
    : `ปลดสถานะ "ดำเนินการถอนเงิน" ของ "${currentFinanceCustomer.name}" ใช่หรือไม่?`;
  if (!confirm(confirmMsg)) return;

  try {
    const updated = await api('/customers/' + id + '/status', { method: 'PATCH', body: { status: next } });
    currentFinanceCustomer.account_status = updated.account_status;
    currentFinanceCustomer.wallet_balance = updated.wallet_balance;
    renderFinanceDetail(currentFinanceCustomer);
    customers = customers.map(c => c.id === id ? { ...c, account_status: updated.account_status, wallet_balance: updated.wallet_balance } : c);
    renderFinance();
    if (document.getElementById('page-customers').classList.contains('active')) renderCustomers();
    if (currentCustomerDetail && currentCustomerDetail.id === id) {
      currentCustomerDetail.account_status = updated.account_status;
      currentCustomerDetail.wallet_balance = updated.wallet_balance;
      renderCustomerWalletSection(currentCustomerDetail);
    }
    showToastA(next === 'แช่แข็ง' ? '🧊 ล้างยอดเงินและดำเนินการถอนเงินเรียบร้อยแล้ว' : '✅ ปลดสถานะเรียบร้อยแล้ว');
  } catch (e) { showToastA(e.message); }
}

// Referral program panel on the Finance page — same data source as Marketing >
// โปรแกรมแนะนำเพื่อน (GET /referrals/all), plus an editable reward-amount field
// (settings.referral_reward) so admins can manage the whole money-related program
// from one place instead of hopping to Settings.
async function loadFinanceReferralSection() {
  try {
    const [data, settingsData] = await Promise.all([api('/referrals/all'), api('/settings')]);
    document.getElementById('fin-referral-reward').value = settingsData.referral_reward || 50;
    document.getElementById('fin-referral-total-count').textContent = data.totalReferrals.toLocaleString();
    document.getElementById('fin-referral-total-paid').textContent = '฿' + data.totalRewardsPaid.toLocaleString();
    document.getElementById('fin-referral-top-body').innerHTML = data.topReferrers.map(r => `
      <tr><td>${r.name}</td><td><span class="coupon-chip">${r.referral_code}</span></td><td>${r.referral_count}</td><td>฿${r.total_earned.toLocaleString()}</td></tr>
    `).join('') || `<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--ink-400)">ยังไม่มีข้อมูล</td></tr>`;
  } catch (e) { showToastA(e.message); }
}

async function saveFinanceReferralReward() {
  const value = document.getElementById('fin-referral-reward').value;
  if (value === '' || Number(value) < 0) { showToastA('กรุณากรอกยอดโบนัสให้ถูกต้อง'); return; }
  try {
    await api('/settings', { method: 'PATCH', body: { referral_reward: value } });
    showToastA('บันทึกยอดโบนัสแนะนำเพื่อนเรียบร้อยแล้ว ลูกค้าจะเห็นการเปลี่ยนแปลงทันที');
  } catch (e) { showToastA(e.message); }
}

// Opens the customer edit/create modal. Works from anywhere in the admin (the
// Customers page cards, or the red "✎ แก้ไข" button on the Tickets page — see
// renderTickets) since it always pulls fresh data from the server rather than
// relying on whatever's cached in the `customers` array.
async function openCustomerForm(id) {
  document.getElementById('cuf-id').value = '';
  document.getElementById('cuf-name').value = '';
  document.getElementById('cuf-phone').value = '';
  document.getElementById('cuf-username').value = '';
  document.getElementById('cuf-password').value = '';
  document.getElementById('cuf-error').style.display = 'none';
  document.getElementById('customer-form-title').textContent = 'เพิ่มลูกค้าใหม่';
  document.getElementById('cuf-password-label').textContent = 'รหัสผ่าน';
  document.getElementById('cuf-wallet-section').style.display = 'none';
  document.getElementById('cuf-wallet-error').style.display = 'none';
  document.getElementById('cuf-wallet-amount').value = '';
  document.getElementById('cuf-wallet-note').value = '';
  currentCustomerDetail = null;
  document.getElementById('customer-form-overlay').style.display = 'flex';

  if (!id) return;

  document.getElementById('customer-form-title').textContent = 'แก้ไขลูกค้า';
  document.getElementById('cuf-password-label').textContent = 'รหัสผ่านใหม่ (เว้นว่างไว้หากไม่เปลี่ยน)';

  try {
    const c = await api('/customers/' + id);
    document.getElementById('cuf-id').value = c.id;
    document.getElementById('cuf-name').value = c.name;
    document.getElementById('cuf-phone').value = c.phone || '';
    document.getElementById('cuf-username').value = c.username || '';
    currentCustomerDetail = c;
    renderCustomerWalletSection(c);
    document.getElementById('cuf-wallet-section').style.display = 'block';
  } catch (e) {
    showToastA(e.message);
  }
}
function closeCustomerForm() {
  document.getElementById('customer-form-overlay').style.display = 'none';
}

function renderCustomerWalletSection(c) {
  document.getElementById('cuf-wallet-balance').textContent = '฿' + Number(c.wallet_balance || 0).toLocaleString();

  const frozen = c.account_status === 'แช่แข็ง';
  const badge = document.getElementById('cuf-status-badge');
  badge.textContent = frozen ? '🧊 ดำเนินการถอนเงิน' : '✅ ปกติ';
  badge.className = 'status-chip2 ' + (frozen ? 'st-wait' : 'st-done');
  const toggleBtn = document.getElementById('cuf-status-toggle-btn');
  toggleBtn.textContent = frozen ? '✅ ปลดแช่แข็งบัญชี' : '🧊 แช่แข็งบัญชี';
  toggleBtn.className = frozen ? 'btn-outline btn-sm' : 'btn-danger btn-sm';

  const txList = document.getElementById('cuf-wallet-tx-list');
  const txs = c.transactions || [];
  txList.innerHTML = txs.slice(0, 10).map(tx => {
    const amt = Number(tx.amount || 0);
    const positive = amt >= 0;
    return `
      <div class="wtx-row">
        <div><div class="wtx-desc">${escapeHtml(tx.description || '')}</div><div class="wtx-date">${formatDate(tx.created_at)}</div></div>
        <div class="wtx-amt ${positive ? 'pos' : 'neg'}">${positive ? '+' : ''}฿${amt.toLocaleString()}</div>
      </div>`;
  }).join('') || `<div style="text-align:center;color:var(--ink-400);font-size:12px;padding:10px">ยังไม่มีประวัติรายการ</div>`;
}

// Admin credits or debits the customer's wallet (top-up, commission, bonus, or a
// correction). Runs against POST /customers/:id/wallet, which does the balance
// math + transaction log atomically on the server — this just wires up the form.
async function submitWalletAdjust() {
  const id = document.getElementById('cuf-id').value;
  if (!id) return;
  const errEl = document.getElementById('cuf-wallet-error');
  errEl.style.display = 'none';

  const direction = document.getElementById('cuf-wallet-direction').value;
  const category = document.getElementById('cuf-wallet-category').value;
  const amount = Number(document.getElementById('cuf-wallet-amount').value);
  const note = document.getElementById('cuf-wallet-note').value.trim();

  if (!amount || amount <= 0) {
    errEl.textContent = 'กรุณากรอกจำนวนเงินให้ถูกต้อง';
    errEl.style.display = 'block';
    return;
  }

  try {
    const result = await api('/customers/' + id + '/wallet', { method: 'POST', body: { direction, category, amount, note } });
    currentCustomerDetail.wallet_balance = result.walletBalance;
    currentCustomerDetail.transactions = [result.transaction, ...(currentCustomerDetail.transactions || [])];
    renderCustomerWalletSection(currentCustomerDetail);
    document.getElementById('cuf-wallet-amount').value = '';
    document.getElementById('cuf-wallet-note').value = '';
    customers = customers.map(c => c.id === Number(id) ? { ...c, wallet_balance: result.walletBalance } : c);
    if (document.getElementById('page-customers').classList.contains('active')) renderCustomers();
    if (document.getElementById('page-finance').classList.contains('active')) renderFinance();
    if (currentFinanceCustomer && currentFinanceCustomer.id === Number(id)) {
      currentFinanceCustomer.wallet_balance = result.walletBalance;
      currentFinanceCustomer.transactions = [result.transaction, ...(currentFinanceCustomer.transactions || [])];
      renderFinanceDetail(currentFinanceCustomer);
    }
    showToastA((direction === 'credit' ? '➕ เติมยอดเงิน' : '➖ หักยอดเงิน') + ' ฿' + amount.toLocaleString() + ' เรียบร้อยแล้ว');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

// Freezes/unfreezes a customer's account — freezing now also processes a full
// withdrawal (clears their wallet balance to ฿0.00, logged as a normal
// transaction) and blocks login + force-logs-out any open session — see
// PATCH /customers/:id/status on the server.
async function toggleCustomerStatus() {
  const id = document.getElementById('cuf-id').value;
  if (!id || !currentCustomerDetail) return;
  const next = currentCustomerDetail.account_status === 'แช่แข็ง' ? 'ปกติ' : 'แช่แข็ง';
  const confirmMsg = next === 'แช่แข็ง'
    ? `ดำเนินการถอนเงินและระงับบัญชีของ "${currentCustomerDetail.name}" ใช่หรือไม่?\n\nยอดเงินคงเหลือ (฿${Number(currentCustomerDetail.wallet_balance || 0).toLocaleString()}) จะถูกล้างเป็น 0.00 บาททันที และลูกค้าจะไม่สามารถเข้าสู่ระบบได้จนกว่าจะปลดสถานะ`
    : `ปลดสถานะ "ดำเนินการถอนเงิน" ของ "${currentCustomerDetail.name}" ใช่หรือไม่?`;
  if (!confirm(confirmMsg)) return;

  try {
    const updated = await api('/customers/' + id + '/status', { method: 'PATCH', body: { status: next } });
    currentCustomerDetail.account_status = updated.account_status;
    currentCustomerDetail.wallet_balance = updated.wallet_balance;
    renderCustomerWalletSection(currentCustomerDetail);
    customers = customers.map(c => c.id === Number(id) ? { ...c, account_status: updated.account_status, wallet_balance: updated.wallet_balance } : c);
    if (document.getElementById('page-customers').classList.contains('active')) renderCustomers();
    if (document.getElementById('page-finance').classList.contains('active')) renderFinance();
    if (currentFinanceCustomer && currentFinanceCustomer.id === Number(id)) {
      currentFinanceCustomer.account_status = updated.account_status;
      currentFinanceCustomer.wallet_balance = updated.wallet_balance;
      renderFinanceDetail(currentFinanceCustomer);
    }
    showToastA(next === 'แช่แข็ง' ? '🧊 ล้างยอดเงินและดำเนินการถอนเงินเรียบร้อยแล้ว' : '✅ ปลดสถานะเรียบร้อยแล้ว');
  } catch (e) { showToastA(e.message); }
}

async function saveCustomer() {
  const id = document.getElementById('cuf-id').value;
  const errEl = document.getElementById('cuf-error');
  errEl.style.display = 'none';

  const body = {
    name: document.getElementById('cuf-name').value.trim(),
    phone: document.getElementById('cuf-phone').value.trim(),
    username: document.getElementById('cuf-username').value.trim(),
    password: document.getElementById('cuf-password').value,
  };
  if (!body.name || !body.username) { errEl.textContent = 'กรุณากรอกชื่อและชื่อผู้ใช้'; errEl.style.display = 'block'; return; }
  if (!id && !body.password) { errEl.textContent = 'กรุณาตั้งรหัสผ่านสำหรับลูกค้าใหม่'; errEl.style.display = 'block'; return; }

  try {
    if (id) {
      const updated = await api('/customers/' + id, { method: 'PUT', body });
      customers = customers.map(c => c.id === updated.id ? { ...c, ...updated } : c);
      showToastA('บันทึกการแก้ไขลูกค้าเรียบร้อยแล้ว');
    } else {
      const created = await api('/customers', { method: 'POST', body });
      customers = [created, ...customers];
      showToastA('เพิ่มลูกค้าใหม่เรียบร้อยแล้ว');
    }
    closeCustomerForm();
    renderCustomers();
  } catch (e) {
    errEl.textContent = e.message || 'บันทึกไม่สำเร็จ';
    errEl.style.display = 'block';
  }
}

async function deleteCustomer(id) {
  const c = customers.find(x => x.id === id);
  if (!confirm(`ลบลูกค้า "${c ? c.name : ''}" ใช่หรือไม่?`)) return;
  try {
    await api('/customers/' + id, { method: 'DELETE' });
    customers = customers.filter(x => x.id !== id);
    renderCustomers();
    showToastA('ลบลูกค้าเรียบร้อยแล้ว');
  } catch (e) { showToastA(e.message); }
}

/* ============ Knowledge base admin ============ */
function renderKbAdmin() {
  document.getElementById('kbadm-grid').innerHTML = kbArticles.map(a => `
    <div class="kbadm-card">
      <span class="kb-tag" style="display:inline-block;font-size:10px;font-weight:700;color:var(--purple-600);background:var(--purple-100);padding:3px 9px;border-radius:20px;margin-bottom:8px">${a.tag}</span>
      <h4>${a.title}</h4>
      <p>อัปเดตล่าสุด ${formatDate(a.updated_at)} • เข้าชม ${a.views.toLocaleString()} ครั้ง</p>
      <div class="kb-foot"><span>${formatDate(a.updated_at)}</span><a style="color:var(--purple-600);font-weight:700;cursor:pointer" onclick="alert('${a.title.replace(/'/g,"")}\\n\\n${a.body.replace(/'/g,"")}')">ดูเนื้อหา ›</a></div>
    </div>`).join('') || `<div style="grid-column:1/-1;text-align:center;padding:30px;color:var(--ink-400)">ยังไม่มีบทความ</div>`;
}
async function addKbArticle() {
  const title = prompt('หัวข้อบทความใหม่:');
  if (!title) return;
  const body = prompt('เนื้อหาบทความ:') || '-';
  try {
    await api('/kb', { method: 'POST', body: { title, body, tag: 'ทั่วไป' } });
    kbArticles = await api('/kb');
    renderKbAdmin();
    showToastA('เพิ่มบทความใหม่เรียบร้อยแล้ว');
  } catch (e) { showToastA(e.message); }
}

/* ============ Products (Lazmall) ============ */
function populateCategoryFilter() {
  const filterSel = document.getElementById('pr-category-filter');
  const current = filterSel.value;
  filterSel.innerHTML = '<option value="">ทุกหมวดหมู่</option>' +
    categoriesAdmin.map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
  filterSel.value = current;

  const formSel = document.getElementById('pf-category');
  formSel.innerHTML = '<option value="">ไม่ระบุหมวดหมู่</option>' +
    categoriesAdmin.map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
}

// A product counts as an active flash-sale item once it has both a flash price
// and a future end time — mirrors the same check the storefront API uses.
function isFlashActiveAdmin(p) {
  return Boolean(p.flash_price && p.flash_ends_at && new Date(p.flash_ends_at) > new Date());
}
function isFlashScheduledAdmin(p) {
  return Boolean(p.flash_price && p.flash_ends_at && new Date(p.flash_ends_at) <= new Date());
}
function formatFlashCountdown(endsAt) {
  const diff = new Date(endsAt).getTime() - Date.now();
  if (diff <= 0) return 'หมดเวลา';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `เหลือ ${h} ชม. ${m} นาที` : `เหลือ ${m} นาที`;
}

function renderProductsAdmin() {
  const catFilter = document.getElementById('pr-category-filter').value;
  const q = (document.getElementById('pr-search').value || '').toLowerCase();
  const flashOnly = document.getElementById('pr-flash-filter').checked;
  let list = productsAdmin;
  if (catFilter) list = list.filter(p => String(p.category_id) === String(catFilter));
  if (q) list = list.filter(p => p.name.toLowerCase().includes(q));
  if (flashOnly) list = list.filter(p => p.flash_price && p.flash_ends_at);

  const grid = document.getElementById('products-admin-grid');
  if (!list.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:var(--ink-400)">ไม่พบสินค้า</div>`;
    return;
  }
  grid.innerHTML = list.map(p => `
    <div class="product-admin-card">
      <div class="pa-icon">${p.image_url ? `<img src="${p.image_url}" alt="${p.name}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><span style="display:none">${p.icon}</span>` : p.icon}</div>
      <div class="pa-name">${p.name}${p.status === 'hidden' ? '<span class="pa-hidden-tag">ซ่อนอยู่</span>' : ''}${isFlashActiveAdmin(p) ? '<span class="pa-flash-tag">⚡ แฟลชเซล</span>' : isFlashScheduledAdmin(p) ? '<span class="pa-flash-tag pa-flash-tag-expired">⚡ หมดเวลาแล้ว</span>' : ''}</div>
      <div><span class="pa-price">฿${(isFlashActiveAdmin(p) ? p.flash_price : p.price).toLocaleString()}</span>${isFlashActiveAdmin(p) ? `<span class="pa-compare">฿${p.price.toLocaleString()}</span>` : (p.compare_at_price ? `<span class="pa-compare">฿${p.compare_at_price.toLocaleString()}</span>` : '')}</div>
      <div class="pa-meta">สต๊อก ${p.stock} • ขายแล้ว ${p.sold_count} • ${p.category ? p.category.icon + ' ' + p.category.name : 'ไม่มีหมวดหมู่'}</div>
      ${isFlashActiveAdmin(p) ? `<div class="pa-flash-countdown">⏱ ${formatFlashCountdown(p.flash_ends_at)}</div>` : ''}
      <div class="pa-actions">
        <button class="pa-edit" onclick="openProductForm(${p.id})">แก้ไข</button>
        <button class="pa-delete" onclick="deleteProduct(${p.id})">ลบ</button>
      </div>
    </div>`).join('');
}

// datetime-local inputs need "YYYY-MM-DDTHH:MM" in the browser's local time;
// the API stores/returns a plain ISO string, so these two convert between them.
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToIso(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function toggleFlashFields() {
  const enabled = document.getElementById('pf-flash-enable').checked;
  document.getElementById('pf-flash-fields').style.display = enabled ? '' : 'none';
  if (enabled && !document.getElementById('pf-flash-ends').value) {
    // Default the end time to 24h from now so admins don't have to think about it.
    const d = new Date(Date.now() + 24 * 3600000);
    document.getElementById('pf-flash-ends').value = isoToLocalInput(d.toISOString());
  }
}

function openProductForm(id) {
  populateCategoryFilter();
  document.getElementById('pf-id').value = '';
  document.getElementById('pf-name').value = '';
  document.getElementById('pf-desc').value = '';
  document.getElementById('pf-price').value = '';
  document.getElementById('pf-compare').value = '';
  document.getElementById('pf-stock').value = '';
  document.getElementById('pf-icon').value = '';
  document.getElementById('pf-image').value = '';
  document.getElementById('pf-category').value = '';
  document.getElementById('pf-status').value = 'active';
  document.getElementById('pf-flash-enable').checked = false;
  document.getElementById('pf-flash-price').value = '';
  document.getElementById('pf-flash-ends').value = '';
  document.getElementById('pf-flash-fields').style.display = 'none';
  document.getElementById('product-form-title').textContent = 'เพิ่มสินค้าใหม่';

  if (id) {
    const p = productsAdmin.find(x => x.id === id);
    if (p) {
      document.getElementById('pf-id').value = p.id;
      document.getElementById('pf-name').value = p.name;
      document.getElementById('pf-desc').value = p.description || '';
      document.getElementById('pf-price').value = p.price;
      document.getElementById('pf-compare').value = p.compare_at_price || '';
      document.getElementById('pf-stock').value = p.stock;
      document.getElementById('pf-icon').value = p.icon;
      document.getElementById('pf-image').value = p.image_url || '';
      document.getElementById('pf-category').value = p.category_id || '';
      document.getElementById('pf-status').value = p.status;
      if (p.flash_price && p.flash_ends_at) {
        document.getElementById('pf-flash-enable').checked = true;
        document.getElementById('pf-flash-price').value = p.flash_price;
        document.getElementById('pf-flash-ends').value = isoToLocalInput(p.flash_ends_at);
        document.getElementById('pf-flash-fields').style.display = '';
      }
      document.getElementById('product-form-title').textContent = 'แก้ไขสินค้า';
    }
  }
  updateProductImagePreview();
  document.getElementById('product-form-overlay').style.display = 'flex';
}

function updateProductImagePreview() {
  const preview = document.getElementById('pf-image-preview');
  const url = document.getElementById('pf-image').value.trim();
  const icon = document.getElementById('pf-icon').value.trim() || '📦';
  if (url) {
    preview.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.textContent='${icon}'">`;
  } else {
    preview.innerHTML = icon;
  }
}
function closeProductForm() {
  document.getElementById('product-form-overlay').style.display = 'none';
}

async function uploadProductImage(file) {
  if (!file) return;
  const statusEl = document.getElementById('pf-upload-status');
  const btnEl = document.getElementById('pf-upload-btn');

  const MAX_SIZE = 5 * 1024 * 1024;
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!ALLOWED.includes(file.type)) {
    statusEl.textContent = 'รองรับเฉพาะไฟล์ JPG, PNG, WEBP หรือ GIF';
    statusEl.style.color = 'var(--danger)';
    return;
  }
  if (file.size > MAX_SIZE) {
    statusEl.textContent = 'ไฟล์ต้องมีขนาดไม่เกิน 5MB';
    statusEl.style.color = 'var(--danger)';
    return;
  }

  statusEl.textContent = 'กำลังอัปโหลด...';
  statusEl.style.color = 'var(--ink-400)';
  btnEl.style.pointerEvents = 'none';
  btnEl.style.opacity = '0.6';

  try {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch(API_BASE + '/upload/product-image', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + getToken() },
      body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'อัปโหลดไม่สำเร็จ');

    document.getElementById('pf-image').value = data.url;
    updateProductImagePreview();
    statusEl.textContent = 'อัปโหลดสำเร็จ ✓';
    statusEl.style.color = 'var(--success)';
  } catch (e) {
    statusEl.textContent = e.message || 'อัปโหลดไม่สำเร็จ กรุณาลองใหม่';
    statusEl.style.color = 'var(--danger)';
  } finally {
    btnEl.style.pointerEvents = '';
    btnEl.style.opacity = '';
    document.getElementById('pf-image-file').value = '';
  }
}

async function saveProduct() {
  const id = document.getElementById('pf-id').value;
  const flashEnabled = document.getElementById('pf-flash-enable').checked;
  const body = {
    name: document.getElementById('pf-name').value.trim(),
    description: document.getElementById('pf-desc').value.trim(),
    price: Number(document.getElementById('pf-price').value),
    compare_at_price: document.getElementById('pf-compare').value ? Number(document.getElementById('pf-compare').value) : null,
    stock: Number(document.getElementById('pf-stock').value) || 0,
    icon: document.getElementById('pf-icon').value.trim() || '📦',
    image_url: document.getElementById('pf-image').value.trim() || null,
    category_id: document.getElementById('pf-category').value || null,
    status: document.getElementById('pf-status').value,
    // Sending null explicitly (rather than omitting the key) is what lets an
    // admin turn flash sale back off for a product that previously had it on.
    flash_price: flashEnabled && document.getElementById('pf-flash-price').value ? Number(document.getElementById('pf-flash-price').value) : null,
    flash_ends_at: flashEnabled ? localInputToIso(document.getElementById('pf-flash-ends').value) : null,
  };
  if (!body.name || !body.price) { showToastA('กรุณากรอกชื่อสินค้าและราคา'); return; }
  if (flashEnabled) {
    if (!body.flash_price || !body.flash_ends_at) { showToastA('กรุณากรอกราคาแฟลชเซลและเวลาสิ้นสุดให้ครบ'); return; }
    if (body.flash_price >= body.price) { showToastA('ราคาแฟลชเซลต้องต่ำกว่าราคาปกติ'); return; }
  }

  try {
    if (id) {
      await api('/products/' + id, { method: 'PATCH', body });
      showToastA('บันทึกการแก้ไขสินค้าเรียบร้อยแล้ว');
    } else {
      await api('/products', { method: 'POST', body });
      showToastA('เพิ่มสินค้าใหม่เรียบร้อยแล้ว');
    }
    closeProductForm();
    productsAdmin = await api('/products/all');
    renderProductsAdmin();
  } catch (e) { showToastA(e.message); }
}

async function deleteProduct(id) {
  const p = productsAdmin.find(x => x.id === id);
  if (!confirm(`ลบสินค้า "${p ? p.name : ''}" ใช่หรือไม่?`)) return;
  try {
    await api('/products/' + id, { method: 'DELETE' });
    productsAdmin = productsAdmin.filter(x => x.id !== id);
    renderProductsAdmin();
    showToastA('ลบสินค้าเรียบร้อยแล้ว');
  } catch (e) { showToastA(e.message); }
}

/* ============ Store orders ============ */
const ORDER_STATUS_FLOW = ['สั่งซื้อสำเร็จ', 'กำลังจัดเตรียมสินค้า', 'กำลังจัดส่ง', 'จัดส่งสำเร็จ'];
function orderStatusClass(status) {
  if (status === 'ยกเลิก') return 'st-wait';
  if (status === 'จัดส่งสำเร็จ') return 'st-done';
  return 'st-progress';
}

function renderStoreOrders() {
  const q = (document.getElementById('so-search').value || '').toLowerCase();
  let list = storeOrders;
  if (q) list = list.filter(o => o.id.toLowerCase().includes(q) || o.customer_name.toLowerCase().includes(q));

  const body = document.getElementById('store-orders-body');
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--ink-400)">ไม่พบคำสั่งซื้อ</td></tr>`;
    return;
  }
  body.innerHTML = list.map(o => {
    const pending = o.payment_status === 'รอตรวจสอบการชำระเงิน';
    const paymentCell = !pending
      ? `<span class="status-chip2 st-done">ชำระเงินแล้ว</span>`
      : `
        <span class="status-chip2 st-wait" style="margin-bottom:4px;display:inline-block">รอตรวจสอบ</span><br>
        ${o.payment_slip_url
          ? `<a href="${o.payment_slip_url}" target="_blank" onclick="event.stopPropagation()" style="font-size:11px;color:var(--purple-600);text-decoration:underline">ดูสลิป</a> ·
             <button onclick="event.stopPropagation();confirmOrderPayment('${o.id}')" style="font-size:11px;color:var(--success);background:none;border:none;text-decoration:underline;cursor:pointer;padding:0">ยืนยันแล้ว</button>`
          : `<span style="font-size:11px;color:var(--ink-400)">ลูกค้ายังไม่แจ้งสลิป</span>`}
      `;
    return `
    <tr onclick="cycleOrderStatus('${o.id}')" style="cursor:pointer" title="คลิกเพื่อเปลี่ยนสถานะ">
      <td>${o.id}</td>
      <td>${o.customer_name}</td>
      <td>${o.items.map(i => i.product_name + ' ×' + i.quantity).join(', ')}</td>
      <td>฿${o.total.toLocaleString()}</td>
      <td><span class="status-chip2 ${orderStatusClass(o.status)}">${o.status}</span></td>
      <td>${paymentCell}</td>
      <td>${formatDate(o.created_at)}</td>
    </tr>`;
  }).join('');
}

async function confirmOrderPayment(id) {
  try {
    const updated = await api('/orders/' + id, { method: 'PATCH', body: { payment_status: 'ชำระเงินแล้ว' } });
    const i = storeOrders.findIndex(x => x.id === id);
    if (i >= 0) storeOrders[i] = updated;
    renderStoreOrders();
    showToastA('ยืนยันการชำระเงินคำสั่งซื้อ ' + id + ' แล้ว');
  } catch (e) { showToastA(e.message); }
}

async function cycleOrderStatus(id) {
  const o = storeOrders.find(x => x.id === id);
  if (!o || o.status === 'ยกเลิก') return;
  const idx = ORDER_STATUS_FLOW.indexOf(o.status);
  const next = idx >= 0 && idx < ORDER_STATUS_FLOW.length - 1 ? ORDER_STATUS_FLOW[idx + 1] : ORDER_STATUS_FLOW[0];
  try {
    const updated = await api('/orders/' + id, { method: 'PATCH', body: { status: next } });
    const i = storeOrders.findIndex(x => x.id === id);
    storeOrders[i] = updated;
    renderStoreOrders();
    showToastA('อัปเดตสถานะคำสั่งซื้อ ' + id + ' เป็น "' + next + '"');
  } catch (e) { showToastA(e.message); }
}

/* ============ Categories (with subcategory / mega-menu support) ============ */
function renderCategoriesAdmin() {
  const productCountByCategory = {};
  productsAdmin.forEach(p => { if (p.category_id) productCountByCategory[p.category_id] = (productCountByCategory[p.category_id] || 0) + 1; });

  const body = document.getElementById('categories-body');
  if (!categoriesAdmin.length) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--ink-400)">ยังไม่มีหมวดหมู่</td></tr>`;
    return;
  }
  body.innerHTML = categoriesAdmin.map(c => {
    const parent = c.parent_id ? categoriesAdmin.find(x => x.id === c.parent_id) : null;
    return `
    <tr>
      <td style="font-size:18px">${c.icon}</td>
      <td>${parent ? '↳ ' : ''}${c.name}</td>
      <td>${parent ? parent.name : '<span style="color:var(--ink-400)">— หมวดหมู่หลัก —</span>'}</td>
      <td>${c.sort_order}</td>
      <td>${productCountByCategory[c.id] || 0}</td>
      <td>
        <button class="pa-edit" style="border:none;border-radius:8px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer" onclick="openCategoryForm(${c.id})">แก้ไข</button>
        <button class="pa-delete" style="border:none;border-radius:8px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer" onclick="deleteCategory(${c.id})">ลบ</button>
      </td>
    </tr>`;
  }).join('');
}

function openCategoryForm(id) {
  const parentSel = document.getElementById('cf-parent');
  parentSel.innerHTML = '<option value="">— ไม่มี (เป็นหมวดหมู่หลัก) —</option>' +
    categoriesAdmin.filter(c => c.id !== id).map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');

  document.getElementById('cf-id').value = '';
  document.getElementById('cf-name').value = '';
  document.getElementById('cf-icon').value = '';
  document.getElementById('cf-sort').value = '0';
  parentSel.value = '';
  document.getElementById('category-form-title').textContent = 'เพิ่มหมวดหมู่ใหม่';

  if (id) {
    const c = categoriesAdmin.find(x => x.id === id);
    if (c) {
      document.getElementById('cf-id').value = c.id;
      document.getElementById('cf-name').value = c.name;
      document.getElementById('cf-icon').value = c.icon;
      document.getElementById('cf-sort').value = c.sort_order;
      parentSel.value = c.parent_id || '';
      document.getElementById('category-form-title').textContent = 'แก้ไขหมวดหมู่';
    }
  }
  document.getElementById('category-form-overlay').style.display = 'flex';
}
function closeCategoryForm() {
  document.getElementById('category-form-overlay').style.display = 'none';
}
async function saveCategory() {
  const id = document.getElementById('cf-id').value;
  const body = {
    name: document.getElementById('cf-name').value.trim(),
    icon: document.getElementById('cf-icon').value.trim() || '🛍️',
    sort_order: Number(document.getElementById('cf-sort').value) || 0,
    parent_id: document.getElementById('cf-parent').value || null,
  };
  if (!body.name) { showToastA('กรุณากรอกชื่อหมวดหมู่'); return; }
  try {
    if (id) await api('/categories/' + id, { method: 'PATCH', body });
    else await api('/categories', { method: 'POST', body });
    closeCategoryForm();
    categoriesAdmin = await api('/categories');
    renderCategoriesAdmin();
    showToastA(id ? 'บันทึกการแก้ไขแล้ว' : 'เพิ่มหมวดหมู่ใหม่แล้ว');
  } catch (e) { showToastA(e.message); }
}
async function deleteCategory(id) {
  const c = categoriesAdmin.find(x => x.id === id);
  if (!confirm(`ลบหมวดหมู่ "${c ? c.name : ''}" ใช่หรือไม่? (สินค้าในหมวดนี้จะกลายเป็นไม่มีหมวดหมู่)`)) return;
  try {
    await api('/categories/' + id, { method: 'DELETE' });
    categoriesAdmin = await api('/categories');
    renderCategoriesAdmin();
    showToastA('ลบหมวดหมู่แล้ว');
  } catch (e) { showToastA(e.message); }
}

/* ============ Reviews moderation ============ */
function renderReviewsAdmin() {
  const q = (document.getElementById('rv-search').value || '').toLowerCase();
  let list = reviewsAdmin;
  if (q) list = list.filter(r => r.product_name.toLowerCase().includes(q) || r.customer_name.toLowerCase().includes(q));

  const body = document.getElementById('reviews-admin-body');
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--ink-400)">ยังไม่มีรีวิว</td></tr>`;
    return;
  }
  body.innerHTML = list.map(r => `
    <tr>
      <td>${r.product_name}</td>
      <td>${r.customer_name}</td>
      <td>${'⭐'.repeat(r.rating)}</td>
      <td style="max-width:280px">${r.comment || '<span style="color:var(--ink-400)">— ไม่มีความคิดเห็น —</span>'}</td>
      <td>${formatDate(r.created_at)}</td>
      <td><button class="pa-delete" style="border:none;border-radius:8px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer" onclick="deleteReviewAdmin(${r.id})">ลบ</button></td>
    </tr>`).join('');
}
async function deleteReviewAdmin(id) {
  if (!confirm('ลบรีวิวนี้ใช่หรือไม่?')) return;
  try {
    await api('/reviews/' + id, { method: 'DELETE' });
    reviewsAdmin = reviewsAdmin.filter(r => r.id !== id);
    renderReviewsAdmin();
    showToastA('ลบรีวิวแล้ว');
  } catch (e) { showToastA(e.message); }
}

/* ============ Marketing: coupons / store notifications / referrals ============ */
document.getElementById('marketing-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.settings-tab');
  if (!tab) return;
  document.querySelectorAll('#marketing-tabs .settings-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  renderMarketing(tab.dataset.tab);
});

async function renderMarketing(tab) {
  const el = document.getElementById('marketing-content');
  if (tab === 'coupons') {
    couponsAdmin = await api('/coupons');
    el.innerHTML = `
      <div class="p-head"><h3>คูปองส่วนลด</h3><a class="btn" style="padding:8px 14px" onclick="openCouponForm()">+ สร้างคูปอง</a></div>
      ${couponsAdmin.map(c => `
        <div class="marketing-row">
          <div>
            <span class="coupon-chip ${c.active ? '' : 'coupon-inactive'}">${c.code}</span>
            <div style="font-size:11.5px;color:var(--ink-600);margin-top:4px">
              ${c.discount_type === 'percent' ? 'ลด ' + c.discount_value + '%' : 'ลด ฿' + c.discount_value}
              ${c.min_purchase ? ' • ซื้อขั้นต่ำ ฿' + c.min_purchase.toLocaleString() : ''}
              • ใช้แล้ว ${c.used_count}${c.usage_limit ? '/' + c.usage_limit : ''} ครั้ง
              ${c.expires_at ? ' • หมดอายุ ' + formatDate(c.expires_at) : ''}
            </div>
          </div>
          <div class="mr-actions">
            <button class="mr-toggle" onclick="toggleCoupon(${c.id}, ${c.active ? 0 : 1})">${c.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}</button>
            <button class="mr-delete" onclick="deleteCoupon(${c.id})">ลบ</button>
          </div>
        </div>`).join('') || `<p style="color:var(--ink-400);font-size:12.5px;text-align:center;padding:20px">ยังไม่มีคูปอง</p>`}
    `;
  } else if (tab === 'notifications') {
    storeNotifsAdmin = await api('/store-notifications');
    el.innerHTML = `
      <div class="p-head"><h3>แจ้งเตือนร้านค้า</h3><a class="btn" style="padding:8px 14px" onclick="openNotifForm()">+ สร้างแจ้งเตือน</a></div>
      ${storeNotifsAdmin.map(n => `
        <div class="marketing-row">
          <div style="display:flex;gap:10px;align-items:flex-start">
            <span style="font-size:20px">${n.icon}</span>
            <div><div style="font-weight:700;font-size:12.5px">${n.title}</div><div style="font-size:11.5px;color:var(--ink-600)">${n.body}</div><div style="font-size:10px;color:var(--ink-400);margin-top:3px">${formatDate(n.created_at)}</div></div>
          </div>
          <div class="mr-actions"><button class="mr-delete" onclick="deleteNotif(${n.id})">ลบ</button></div>
        </div>`).join('') || `<p style="color:var(--ink-400);font-size:12.5px;text-align:center;padding:20px">ยังไม่มีการแจ้งเตือน</p>`}
    `;
  } else if (tab === 'referrals') {
    referralsAdminData = await api('/referrals/all');
    el.innerHTML = `
      <div class="p-head"><h3>โปรแกรมแนะนำเพื่อน</h3></div>
      <div class="marketing-row" style="margin-bottom:16px">
        <div>
          <div style="font-weight:700;font-size:13px;margin-bottom:2px">🎁 รหัสเริ่มต้นของร้าน (สำหรับลูกค้าคนแรก)</div>
          <div style="font-size:11.5px;color:var(--ink-600)">ตอนนี้ต้องกรอกรหัสแนะนำเพื่อนตอนสมัคร/ล็อกอินครั้งแรกเสมอ ลูกค้าคนแรกๆ ที่ยังไม่มีเพื่อนแนะนำ ให้ใช้รหัสนี้แทนได้ (ไม่นับรางวัลเข้ากระเป๋าเงินร้าน)</div>
        </div>
        <span class="coupon-chip" style="font-size:14px">${referralsAdminData.myReferralCode || '-'}</span>
      </div>
      <div class="stats-grid" style="grid-template-columns:1fr 1fr;margin-bottom:20px">
        <div class="stat-card"><div class="st-val">${referralsAdminData.totalReferrals}</div><div class="st-label">จำนวนการแนะนำทั้งหมด</div></div>
        <div class="stat-card"><div class="st-val">฿${referralsAdminData.totalRewardsPaid.toLocaleString()}</div><div class="st-label">รางวัลที่จ่ายไปทั้งหมด</div></div>
      </div>
      <div class="p-head"><h3>ผู้แนะนำยอดนิยม</h3></div>
      <table class="data-table">
        <thead><tr><th>ชื่อ</th><th>รหัสแนะนำ</th><th>จำนวนเพื่อน</th><th>รางวัลที่ได้รับ</th></tr></thead>
        <tbody>
          ${referralsAdminData.topReferrers.map(r => `<tr><td>${r.name}</td><td><span class="coupon-chip">${r.referral_code}</span></td><td>${r.referral_count}</td><td>฿${r.total_earned.toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--ink-400)">ยังไม่มีข้อมูล</td></tr>'}
        </tbody>
      </table>
    `;
  } else if (tab === 'flashSale') {
    productsAdmin = await api('/products/all');
    if (!flashSaleDraft) flashSaleDraft = {};
    productsAdmin.forEach((p) => {
      if (!flashSaleDraft[p.id]) {
        flashSaleDraft[p.id] = {
          enabled: Boolean(p.flash_price && p.flash_ends_at),
          price: p.flash_price || '',
          endsLocal: p.flash_ends_at ? isoToLocalInput(p.flash_ends_at) : '',
        };
      }
    });
    renderFlashSaleTab();
    return;
  }
}

function renderFlashSaleTab() {
  const el = document.getElementById('marketing-content');
  const q = flashSaleSearch.toLowerCase();
  const list = productsAdmin.filter(p => !q || p.name.toLowerCase().includes(q));
  const activeCount = Object.values(flashSaleDraft).filter(d => d.enabled).length;

  el.innerHTML = `
    <div class="p-head">
      <h3>⚡ แฟลชเซล</h3>
      <a class="btn" style="padding:8px 14px" onclick="saveFlashSaleTab()">💾 บันทึกแฟลชเซล</a>
    </div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">เลือกสินค้าที่ต้องการทำแฟลชเซล ตั้งราคาและเวลาสิ้นสุด แล้วกด "บันทึกแฟลชเซล" — จะขึ้นแถบ FLASH SALE ที่หน้าหลักให้ลูกค้าทันที${activeCount ? ` • ตอนนี้มี ${activeCount} รายการที่เปิดอยู่` : ''}</p>
    <input id="fs-search" placeholder="ค้นหาสินค้า..." value="${flashSaleSearch}" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:9px 12px;font-size:12.5px;margin-bottom:14px">
    <div id="fs-rows">
      ${list.map((p) => {
        const d = flashSaleDraft[p.id] || { enabled: false, price: '', endsLocal: '' };
        return `
        <div class="fs-row">
          <div class="fs-row-main">
            <div class="fs-icon">${p.image_url ? `<img src="${p.image_url}" alt="${p.name}" loading="lazy">` : p.icon}</div>
            <div class="fs-info">
              <div class="fs-name">${p.name}</div>
              <div class="fs-regprice">ราคาปกติ ฿${p.price.toLocaleString()}</div>
            </div>
            <label class="fs-toggle">
              <input type="checkbox" class="fs-enable" data-id="${p.id}" ${d.enabled ? 'checked' : ''}>
              <span>แฟลชเซล</span>
            </label>
          </div>
          <div class="fs-fields" data-id="${p.id}" style="display:${d.enabled ? 'grid' : 'none'}">
            <input type="number" class="fs-price-input" data-id="${p.id}" placeholder="ราคาแฟลชเซล (บาท)" value="${d.price}">
            <input type="datetime-local" class="fs-ends-input" data-id="${p.id}" value="${d.endsLocal}">
          </div>
        </div>`;
      }).join('') || '<p style="text-align:center;color:var(--ink-400);font-size:12.5px;padding:20px">ไม่พบสินค้า</p>'}
    </div>
  `;

  document.getElementById('fs-search').addEventListener('input', (e) => {
    flashSaleSearch = e.target.value;
    renderFlashSaleTab();
  });
  document.querySelectorAll('.fs-enable').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id);
      flashSaleDraft[id].enabled = cb.checked;
      const fields = document.querySelector(`.fs-fields[data-id="${id}"]`);
      if (fields) fields.style.display = cb.checked ? 'grid' : 'none';
      // Give a sensible default end time (24h from now) so the admin isn't stuck with
      // an empty required field the moment they flip the toggle on.
      if (cb.checked && !flashSaleDraft[id].endsLocal) {
        flashSaleDraft[id].endsLocal = isoToLocalInput(new Date(Date.now() + 24 * 3600000).toISOString());
        const endsInput = document.querySelector(`.fs-ends-input[data-id="${id}"]`);
        if (endsInput) endsInput.value = flashSaleDraft[id].endsLocal;
      }
    });
  });
  document.querySelectorAll('.fs-price-input').forEach((inp) => {
    inp.addEventListener('input', () => { flashSaleDraft[Number(inp.dataset.id)].price = inp.value; });
  });
  document.querySelectorAll('.fs-ends-input').forEach((inp) => {
    inp.addEventListener('input', () => { flashSaleDraft[Number(inp.dataset.id)].endsLocal = inp.value; });
  });
}

async function saveFlashSaleTab() {
  const problems = [];
  const tasks = [];
  productsAdmin.forEach((p) => {
    const d = flashSaleDraft[p.id];
    if (!d) return;
    const wasActive = Boolean(p.flash_price && p.flash_ends_at);
    if (!d.enabled) {
      if (wasActive) tasks.push({ id: p.id, body: { flash_price: null, flash_ends_at: null } });
      return;
    }
    if (!d.price || !d.endsLocal) { problems.push(`${p.name}: กรอกราคาและเวลาสิ้นสุดให้ครบ`); return; }
    const flashPrice = Number(d.price);
    if (flashPrice >= p.price) { problems.push(`${p.name}: ราคาแฟลชเซลต้องต่ำกว่าราคาปกติ`); return; }
    const flashEndsAt = localInputToIso(d.endsLocal);
    if (!flashEndsAt) { problems.push(`${p.name}: เวลาสิ้นสุดไม่ถูกต้อง`); return; }
    tasks.push({ id: p.id, body: { flash_price: flashPrice, flash_ends_at: flashEndsAt } });
  });

  if (problems.length) { showToastA(problems[0] + (problems.length > 1 ? ` (และอีก ${problems.length - 1} รายการ)` : '')); }
  if (!tasks.length) { if (!problems.length) showToastA('ไม่มีการเปลี่ยนแปลงให้บันทึก'); return; }

  try {
    await Promise.all(tasks.map(t => api('/products/' + t.id, { method: 'PATCH', body: t.body })));
    showToastA('บันทึกแฟลชเซลเรียบร้อยแล้ว ลูกค้าจะเห็นที่หน้าหลักทันที');
    flashSaleDraft = null; // force a fresh rebuild from the server on next visit
    renderMarketing('flashSale');
    document.querySelectorAll('#marketing-tabs .settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'flashSale'));
  } catch (err) { showToastA(err.message); }
}

function openCouponForm() {
  document.getElementById('cpf-code').value = '';
  document.getElementById('cpf-type').value = 'fixed';
  document.getElementById('cpf-value').value = '';
  document.getElementById('cpf-min').value = '0';
  document.getElementById('cpf-max').value = '';
  document.getElementById('cpf-limit').value = '';
  document.getElementById('cpf-expires').value = '';
  document.getElementById('coupon-form-overlay').style.display = 'flex';
}
function closeCouponForm() { document.getElementById('coupon-form-overlay').style.display = 'none'; }
async function saveCoupon() {
  const body = {
    code: document.getElementById('cpf-code').value.trim(),
    discount_type: document.getElementById('cpf-type').value,
    discount_value: Number(document.getElementById('cpf-value').value),
    min_purchase: Number(document.getElementById('cpf-min').value) || 0,
    max_discount: document.getElementById('cpf-max').value ? Number(document.getElementById('cpf-max').value) : null,
    usage_limit: document.getElementById('cpf-limit').value ? Number(document.getElementById('cpf-limit').value) : null,
    expires_at: document.getElementById('cpf-expires').value || null,
  };
  if (!body.code || !body.discount_value) { showToastA('กรุณากรอกโค้ดและมูลค่าส่วนลด'); return; }
  try {
    await api('/coupons', { method: 'POST', body });
    closeCouponForm();
    renderMarketing('coupons');
    showToastA('สร้างคูปองเรียบร้อยแล้ว');
  } catch (e) { showToastA(e.message); }
}
async function toggleCoupon(id, active) {
  try {
    await api('/coupons/' + id, { method: 'PATCH', body: { active } });
    renderMarketing('coupons');
  } catch (e) { showToastA(e.message); }
}
async function deleteCoupon(id) {
  if (!confirm('ลบคูปองนี้ใช่หรือไม่?')) return;
  try {
    await api('/coupons/' + id, { method: 'DELETE' });
    renderMarketing('coupons');
    showToastA('ลบคูปองแล้ว');
  } catch (e) { showToastA(e.message); }
}

function openNotifForm() {
  document.getElementById('ntf-icon').value = '🛍️';
  document.getElementById('ntf-title').value = '';
  document.getElementById('ntf-body').value = '';
  document.getElementById('notif-form-overlay').style.display = 'flex';
}
function closeNotifForm() { document.getElementById('notif-form-overlay').style.display = 'none'; }
async function saveNotif() {
  const body = {
    icon: document.getElementById('ntf-icon').value.trim() || '🛍️',
    title: document.getElementById('ntf-title').value.trim(),
    body: document.getElementById('ntf-body').value.trim(),
  };
  if (!body.title || !body.body) { showToastA('กรุณากรอกหัวข้อและเนื้อหา'); return; }
  try {
    await api('/store-notifications', { method: 'POST', body });
    closeNotifForm();
    renderMarketing('notifications');
    showToastA('ส่งแจ้งเตือนเรียบร้อยแล้ว');
  } catch (e) { showToastA(e.message); }
}
async function deleteNotif(id) {
  if (!confirm('ลบการแจ้งเตือนนี้ใช่หรือไม่?')) return;
  try {
    await api('/store-notifications/' + id, { method: 'DELETE' });
    renderMarketing('notifications');
    showToastA('ลบการแจ้งเตือนแล้ว');
  } catch (e) { showToastA(e.message); }
}

/* ============ Settings ============ */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('settings-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.settings-tab');
    if (!tab) return;
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderSettings(tab.dataset.tab);
  });
});
function selectSettingsTab(name) {
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  renderSettings(name);
}

/* ============ Team & permissions (ทีมงาน/สิทธิ์การใช้งาน) ============ */
const PAGE_PERMISSION_LABELS = { dashboard: 'หน้าหลัก', inbox: 'กล่องข้อความ', products: 'จัดการสินค้า', categories: 'หมวดหมู่สินค้า', storeOrders: 'คำสั่งซื้อ', reviews: 'รีวิวสินค้า', marketing: 'การตลาด', tickets: 'รายการแจ้งบริการ', tasks: 'จัดการงาน', customers: 'ลูกค้า', finance: 'บริหารการเงิน', channels: 'ช่องทางการติดต่อ', kb: 'คลังความรู้', reports: 'รายงานและสถิติ', settings: 'ตั้งค่า' };
let teamMembers = [];
let currentTeamMember = null;

async function loadTeamList() {
  try {
    teamMembers = await api('/team');
    renderTeamList();
  } catch (e) { showToastA(e.message); }
}
function renderTeamList() {
  document.getElementById('team-list').innerHTML = teamMembers.map(m => `
    <div class="panel" style="margin-bottom:10px;padding:14px 16px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-weight:800;font-size:13.5px">${escapeHtml(m.name)} ${m.is_owner ? '<span class="status-chip2 st-done">เจ้าของร้าน</span>' : ''}</div>
          <div style="font-size:11.5px;color:var(--ink-400);margin-top:2px">@${escapeHtml(m.username)}${m.position ? ' • ' + escapeHtml(m.position) : ''}</div>
          <div style="font-size:11px;color:var(--ink-600);margin-top:6px;max-width:480px">${m.is_owner ? 'สิทธิ์เข้าถึงทุกส่วน' : (m.permissions.length ? m.permissions.map(p => PAGE_PERMISSION_LABELS[p] || p).join(', ') : '⚠️ ยังไม่ได้กำหนดสิทธิ์เข้าถึงหน้าใดเลย')}</div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button class="btn-outline btn-sm" onclick="openTeamForm(${m.id})">✎ แก้ไข</button>
          ${!m.is_owner ? `<button class="btn-danger btn-sm" onclick="deleteTeamMember(${m.id})">🗑 ลบ</button>` : ''}
        </div>
      </div>
    </div>
  `).join('') || `<div style="text-align:center;padding:30px;color:var(--ink-400)">ยังไม่มีทีมงาน</div>`;
}

function openTeamForm(id) {
  currentTeamMember = id ? teamMembers.find(m => m.id === id) : null;
  document.getElementById('team-form-title').textContent = currentTeamMember ? 'แก้ไขทีมงาน' : 'เพิ่มทีมงานใหม่';
  document.getElementById('tf-name').value = currentTeamMember ? currentTeamMember.name : '';
  document.getElementById('tf-username').value = currentTeamMember ? currentTeamMember.username : '';
  document.getElementById('tf-username').disabled = !!currentTeamMember;
  document.getElementById('tf-phone').value = currentTeamMember ? (currentTeamMember.phone || '') : '';
  document.getElementById('tf-position').value = currentTeamMember ? (currentTeamMember.position || '') : '';
  document.getElementById('tf-password').value = '';
  document.getElementById('tf-password-label').textContent = currentTeamMember ? 'รหัสผ่านใหม่ (เว้นว่างไว้หากไม่เปลี่ยน)' : 'รหัสผ่าน';
  document.getElementById('tf-error').style.display = 'none';

  const isOwnerMember = !!(currentTeamMember && currentTeamMember.is_owner);
  const perms = currentTeamMember ? currentTeamMember.permissions : [];
  document.getElementById('tf-permissions').innerHTML = Object.entries(PAGE_PERMISSION_LABELS).map(([key, label]) => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:5px 0">
      <input type="checkbox" class="tf-perm-cb" value="${key}" ${perms.includes(key) ? 'checked' : ''} ${isOwnerMember ? 'disabled checked' : ''}>
      ${label}
    </label>`).join('');
  document.getElementById('tf-owner-note').style.display = isOwnerMember ? 'block' : 'none';

  document.getElementById('team-form-overlay').style.display = 'flex';
}
function closeTeamForm() {
  document.getElementById('team-form-overlay').style.display = 'none';
}
async function saveTeamMember() {
  const errEl = document.getElementById('tf-error');
  errEl.style.display = 'none';
  const name = document.getElementById('tf-name').value.trim();
  const username = document.getElementById('tf-username').value.trim();
  const phone = document.getElementById('tf-phone').value.trim();
  const position = document.getElementById('tf-position').value.trim();
  const password = document.getElementById('tf-password').value;
  const permissions = [...document.querySelectorAll('.tf-perm-cb:checked')].map(cb => cb.value);

  if (!name || (!currentTeamMember && (!username || !password))) {
    errEl.textContent = 'กรุณากรอกชื่อ ชื่อผู้ใช้ และรหัสผ่าน';
    errEl.style.display = 'block';
    return;
  }
  try {
    if (currentTeamMember) {
      const body = { name, phone, position, permissions };
      if (password) body.password = password;
      await api('/team/' + currentTeamMember.id, { method: 'PUT', body });
    } else {
      await api('/team', { method: 'POST', body: { name, username, phone, position, permissions, password } });
    }
    closeTeamForm();
    await loadTeamList();
    showToastA('บันทึกข้อมูลทีมงานเรียบร้อยแล้ว');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}
async function deleteTeamMember(id) {
  const m = teamMembers.find(x => x.id === id);
  if (!m) return;
  if (!confirm(`ลบทีมงาน "${m.name}" ใช่หรือไม่?`)) return;
  try {
    await api('/team/' + id, { method: 'DELETE' });
    await loadTeamList();
    showToastA('ลบทีมงานเรียบร้อยแล้ว');
  } catch (e) { showToastA(e.message); }
}

async function saveNotifCategories() {
  const map = {};
  document.querySelectorAll('.notif-cat-cb').forEach(cb => { map[cb.dataset.key] = cb.checked; });
  try {
    await api('/settings', { method: 'PATCH', body: { notif_categories_enabled: JSON.stringify(map) } });
    showToastA('บันทึกการตั้งค่าหมวดหมู่การแจ้งเตือนเรียบร้อยแล้ว');
  } catch (e) { showToastA(e.message); }
}

// Mirrors backend/lib/notify.js EVENT_DEFAULTS — labels + which {placeholders} each
// event's template supports, so the admin knows what's safe to reference in the text.
const NOTIF_EVENT_META = [
  { key: 'wallet_credit', label: 'เติมยอดเงินให้ลูกค้า', vars: ['amount', 'description', 'balance'], title: 'เติมยอดเงิน ฿{amount}', body: '{description} (ยอดคงเหลือ ฿{balance})' },
  { key: 'wallet_debit', label: 'หักยอดเงินลูกค้า', vars: ['amount', 'description', 'balance'], title: 'หักยอดเงิน ฿{amount}', body: '{description} (ยอดคงเหลือ ฿{balance})' },
  { key: 'withdraw_new', label: 'ลูกค้าขอถอนเงินใหม่ (แจ้งแอดมิน)', vars: ['amount', 'bank'], title: 'คำขอถอนเงินใหม่', body: '฿{amount} • {bank}' },
  { key: 'withdraw_result', label: 'ผลอนุมัติ/ปฏิเสธคำขอถอนเงิน', vars: ['amount', 'status', 'note'], title: 'คำขอถอนเงิน ฿{amount}: {status}', body: '{note}' },
  { key: 'account_frozen', label: 'แช่แข็งบัญชี/ดำเนินการถอนเงิน', vars: [], title: 'บัญชีอยู่ระหว่างดำเนินการถอนเงิน', body: 'ยอดเงินคงเหลือถูกล้างและอยู่ระหว่างดำเนินการถอนเงิน กรุณาติดต่อผู้ดูแลระบบ' },
  { key: 'account_unfrozen', label: 'ปลดแช่แข็งบัญชี', vars: [], title: 'บัญชีกลับมาใช้งานได้ตามปกติ', body: 'บัญชีของคุณปลดการระงับแล้ว เข้าใช้งานได้ตามปกติ' },
  { key: 'ticket_new', label: 'งานแจ้งบริการใหม่ (แจ้งแอดมิน)', vars: ['customerName', 'ticketTitle'], title: 'งานแจ้งบริการใหม่', body: '{customerName}: {ticketTitle}' },
  { key: 'ticket_status', label: 'อัปเดตสถานะงานแจ้งบริการ (แจ้งลูกค้า)', vars: ['status', 'ticketTitle'], title: 'อัปเดตสถานะงานแจ้งบริการ: {status}', body: '{ticketTitle}' },
  { key: 'order_new_admin', label: 'คำสั่งซื้อใหม่ (แจ้งแอดมิน)', vars: ['customerName', 'amount'], title: 'คำสั่งซื้อใหม่', body: '{customerName} • ฿{amount}' },
  { key: 'order_placed', label: 'สั่งซื้อสำเร็จ (แจ้งลูกค้า)', vars: ['orderId', 'amount'], title: 'สั่งซื้อสำเร็จ', body: 'คำสั่งซื้อ {orderId} • ฿{amount}' },
  { key: 'order_status', label: 'อัปเดตสถานะคำสั่งซื้อ/จัดส่ง', vars: ['status', 'orderId'], title: 'สถานะคำสั่งซื้อ: {status}', body: 'คำสั่งซื้อ {orderId}' },
  { key: 'payment_status', label: 'อัปเดตสถานะการชำระเงิน', vars: ['status', 'orderId'], title: 'สถานะการชำระเงิน: {status}', body: 'คำสั่งซื้อ {orderId}' },
  { key: 'payment_slip', label: 'ลูกค้าแจ้งชำระเงินแล้ว (แจ้งแอดมิน)', vars: ['customerName', 'orderId', 'amount'], title: 'ลูกค้าแจ้งชำระเงินแล้ว', body: '{customerName} • {orderId} • ฿{amount}' },
];

function renderNotifTemplateEditor(s) {
  let overrides = {};
  try { overrides = JSON.parse(s.notif_event_templates || '{}'); } catch (e) { overrides = {}; }
  document.getElementById('notif-tpl-list').innerHTML = NOTIF_EVENT_META.map(ev => {
    const current = overrides[ev.key] || {};
    return `
    <div class="panel" style="margin-bottom:10px;padding:14px 16px">
      <div style="font-size:12.5px;font-weight:700;margin-bottom:8px">${ev.label}</div>
      <input class="notif-tpl-title" data-event="${ev.key}" value="${escapeHtml(current.title || ev.title)}" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:8px 10px;font-size:12.5px;margin-bottom:6px" placeholder="หัวข้อ">
      <input class="notif-tpl-body" data-event="${ev.key}" value="${escapeHtml(current.body || ev.body || '')}" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:8px 10px;font-size:12.5px" placeholder="รายละเอียด">
      ${ev.vars.length ? `<div style="font-size:10.5px;color:var(--ink-400);margin-top:6px">ตัวแปรที่ใช้ได้: ${ev.vars.map(v => `<code>{${v}}</code>`).join(' ')}</div>` : ''}
    </div>`;
  }).join('');
}

async function saveNotifTemplates() {
  const map = {};
  NOTIF_EVENT_META.forEach(ev => {
    const titleEl = document.querySelector(`.notif-tpl-title[data-event="${ev.key}"]`);
    const bodyEl = document.querySelector(`.notif-tpl-body[data-event="${ev.key}"]`);
    map[ev.key] = { title: titleEl.value.trim() || ev.title, body: bodyEl.value.trim() || ev.body || '' };
  });
  try {
    await api('/settings', { method: 'PATCH', body: { notif_event_templates: JSON.stringify(map) } });
    showToastA('บันทึกข้อความแจ้งเตือนเรียบร้อยแล้ว');
  } catch (e) { showToastA(e.message); }
}

async function renderSettings(tab) {
  stopAvatarPreview();
  const el = document.getElementById('settings-content');
  if (tab === 'profile') {
    el.innerHTML = `
      <div class="p-head"><h3>โปรไฟล์ผู้ดูแลระบบ</h3></div>
      <div class="field" style="margin-bottom:14px"><label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">ชื่อ-นามสกุล</label><input style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${currentAdmin.name}"></div>
      <div class="field" style="margin-bottom:14px"><label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">ตำแหน่ง</label><input style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${currentAdmin.position || ''}"></div>
      <button class="btn" onclick="showToastA('บันทึกโปรไฟล์เรียบร้อยแล้ว')">บันทึกการเปลี่ยนแปลง</button>
      <button class="btn-outline" style="margin-top:10px" onclick="adminLogout()">ออกจากระบบ</button>`;
  } else if (tab === 'branding') {
    let s = {};
    try { s = await api('/settings'); } catch (e) { showToastA(e.message); }
    const appName = s.store_name || 'Lazmall';
    const logoUrl = s.app_logo_url || '';
    const homeLogoUrl = s.home_logo_url || '';
    const primaryColor = s.theme_primary_color || '#4F46E5';
    const secondaryColor = s.theme_secondary_color || '#7C3AED';
    const fontChoices = ['Noto Sans Thai', 'Sarabun', 'Prompt', 'Kanit', 'Mitr', 'IBM Plex Sans Thai'];
    const currentFont = s.theme_font || 'Noto Sans Thai';
    let paymentLogos = [];
    try { paymentLogos = JSON.parse(s.payment_logos || '[]'); } catch (e) { paymentLogos = []; }
    const promptpayId = s.promptpay_id || '';
    const promptpayName = s.promptpay_name || '';

    el.innerHTML = `
      <div class="p-head"><h3>ชื่อแอปและโลโก้</h3></div>
      <p style="font-size:12px;color:var(--ink-400);margin-top:0">การเปลี่ยนแปลงจะมีผลกับหน้าบ้าน (แอปลูกค้า) ทันทีหลังบันทึก</p>
      <div class="field" style="margin-bottom:14px">
        <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">ชื่อแอป / ชื่อร้าน</label>
        <input id="branding-app-name" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${appName}">
      </div>
      <div class="field" style="margin-bottom:20px">
        <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">โลโก้แอป</label>
        <p style="font-size:11px;color:var(--ink-400);margin:0 0 8px">ใช้ในหน้าเข้าสู่ระบบ/สมัครสมาชิก และไอคอนแอป (favicon)</p>
        <div style="display:flex;align-items:center;gap:14px">
          <div id="branding-logo-preview" style="width:64px;height:64px;border-radius:14px;background:#F1EEFB;display:flex;align-items:center;justify-content:center;overflow:hidden;border:1.5px solid #E3DEF7">
            ${logoUrl ? `<img src="${logoUrl}" style="width:100%;height:100%;object-fit:cover">` : '<span style="font-size:11px;color:var(--ink-400)">ไม่มีโลโก้</span>'}
          </div>
          <div>
            <input type="file" id="branding-logo-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
            <button class="btn-outline" onclick="document.getElementById('branding-logo-file').click()">📤 อัปโหลดโลโก้</button>
          </div>
        </div>
      </div>

      <div class="field" style="margin-bottom:20px">
        <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">โลโก้หน้าหลัก (หน้าร้านค้า)</label>
        <p style="font-size:11px;color:var(--ink-400);margin:0 0 8px">ใช้ในแถบเมนูด้านบนของหน้าร้านค้า (หน้าหลัก) — แยกจากโลโก้แอปด้านบน หากไม่อัปโหลด จะใช้โลโก้แอปแทน</p>
        <div style="display:flex;align-items:center;gap:14px">
          <div id="branding-home-logo-preview" style="width:64px;height:64px;border-radius:14px;background:#F1EEFB;display:flex;align-items:center;justify-content:center;overflow:hidden;border:1.5px solid #E3DEF7">
            ${homeLogoUrl ? `<img src="${homeLogoUrl}" style="width:100%;height:100%;object-fit:cover">` : '<span style="font-size:11px;color:var(--ink-400)">ไม่มีโลโก้</span>'}
          </div>
          <div>
            <input type="file" id="branding-home-logo-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
            <button class="btn-outline" onclick="document.getElementById('branding-home-logo-file').click()">📤 อัปโหลดโลโก้หน้าหลัก</button>
            <button id="branding-home-logo-remove-btn" class="btn-outline" style="margin-left:8px;${homeLogoUrl ? '' : 'display:none'}" onclick="document.getElementById('branding-home-logo-preview').innerHTML='<span style=&quot;font-size:11px;color:var(--ink-400)&quot;>ไม่มีโลโก้</span>';document.getElementById('branding-home-logo-preview').dataset.url='';document.getElementById('branding-home-logo-remove-btn').style.display='none';">ลบ</button>
          </div>
        </div>
      </div>

      <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>รับชำระเงินผ่านพร้อมเพย์ (PromptPay)</h3></div>
      <p style="font-size:12px;color:var(--ink-400);margin-top:0;line-height:1.6">
        ระบุเลขพร้อมเพย์ของร้าน (เบอร์โทร 10 หลัก หรือเลขบัตรประชาชน/เลขนิติบุคคล 13 หลัก) ระบบจะสร้าง QR Code จริงให้ลูกค้าสแกนโอนเงินเข้าบัญชีร้านโดยตรง
        เมื่อลูกค้าโอนแล้วจะอัปโหลดสลิป และแอดมินกดยืนยันในหน้าคำสั่งซื้อ (ระบบยังไม่รองรับการยืนยันอัตโนมัติแบบเชื่อม Bank API/Payment Gateway)
      </p>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:20px">
        <div class="field" style="flex:1;min-width:200px">
          <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">เลขพร้อมเพย์ (เบอร์โทร หรือ เลข 13 หลัก)</label>
          <input id="branding-promptpay-id" placeholder="เช่น 0812345678" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${promptpayId}">
        </div>
        <div class="field" style="flex:1;min-width:200px">
          <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">ชื่อผู้รับเงิน (แสดงให้ลูกค้าเห็น)</label>
          <input id="branding-promptpay-name" placeholder="เช่น Lazmall จำกัด" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${promptpayName}">
        </div>
      </div>

      <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>สีและฟอนต์</h3></div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:16px">
        <div class="field">
          <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">สีหลัก (Primary)</label>
          <input type="color" id="branding-color-primary" value="${primaryColor}" style="width:60px;height:38px;border:1.5px solid #E3DEF7;border-radius:8px;padding:2px">
        </div>
        <div class="field">
          <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">สีรอง (Secondary)</label>
          <input type="color" id="branding-color-secondary" value="${secondaryColor}" style="width:60px;height:38px;border:1.5px solid #E3DEF7;border-radius:8px;padding:2px">
        </div>
        <div class="field" style="flex:1;min-width:180px">
          <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">ฟอนต์ที่ใช้ในแอป</label>
          <select id="branding-font" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px">
            ${fontChoices.map(f => `<option value="${f}" ${f===currentFont?'selected':''}>${f}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>โลโก้ช่องทางการชำระเงิน</h3></div>
      <p style="font-size:12px;color:var(--ink-400);margin-top:0">แสดงในส่วนท้ายของหน้าแอปลูกค้า (footer) เพื่อบอกลูกค้าว่ารองรับการชำระเงินช่องทางใดบ้าง</p>
      <div id="branding-payment-logos" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px">
        ${paymentLogos.map((p, i) => `
          <div class="branding-pay-item" data-idx="${i}" style="position:relative;width:72px;height:52px;border:1.5px solid #E3DEF7;border-radius:10px;overflow:hidden;background:white;display:flex;align-items:center;justify-content:center">
            <img src="${p.url}" style="max-width:100%;max-height:100%;object-fit:contain">
            <button class="branding-pay-remove" data-idx="${i}" style="position:absolute;top:-2px;right:-2px;width:18px;height:18px;border-radius:50%;background:#DC2626;color:white;border:none;font-size:10px;line-height:1;cursor:pointer">✕</button>
          </div>`).join('')}
      </div>
      <input type="file" id="branding-payment-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
      <button class="btn-outline" onclick="document.getElementById('branding-payment-file').click()">📤 เพิ่มโลโก้การชำระเงิน</button>

      <div style="margin-top:24px;border-top:1px solid #F1EEFB;padding-top:18px">
        <button class="btn" onclick="saveBrandingSettings()">บันทึกการตั้งค่าแบรนด์</button>
      </div>
    `;

    document.getElementById('branding-logo-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const url = await uploadBrandingImage(file);
        document.getElementById('branding-logo-preview').innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover">`;
        document.getElementById('branding-logo-preview').dataset.url = url;
      } catch (err) { showToastA(err.message); }
    });

    document.getElementById('branding-home-logo-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const url = await uploadBrandingImage(file);
        document.getElementById('branding-home-logo-preview').innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover">`;
        document.getElementById('branding-home-logo-preview').dataset.url = url;
        document.getElementById('branding-home-logo-remove-btn').style.display = '';
      } catch (err) { showToastA(err.message); }
    });

    document.getElementById('branding-payment-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const url = await uploadBrandingImage(file);
        let s2 = {};
        try { s2 = await api('/settings'); } catch (er) { /* ignore */ }
        let logos = [];
        try { logos = JSON.parse(s2.payment_logos || '[]'); } catch (er) { logos = []; }
        logos.push({ url });
        await api('/settings', { method: 'PATCH', body: { payment_logos: JSON.stringify(logos) } });
        showToastA('เพิ่มโลโก้การชำระเงินแล้ว');
        renderSettings('branding');
      } catch (err) { showToastA(err.message); }
    });

    document.getElementById('branding-payment-logos').addEventListener('click', async (e) => {
      const btn = e.target.closest('.branding-pay-remove');
      if (!btn) return;
      const idx = Number(btn.dataset.idx);
      try {
        let s2 = {};
        try { s2 = await api('/settings'); } catch (er) { /* ignore */ }
        let logos = [];
        try { logos = JSON.parse(s2.payment_logos || '[]'); } catch (er) { logos = []; }
        logos.splice(idx, 1);
        await api('/settings', { method: 'PATCH', body: { payment_logos: JSON.stringify(logos) } });
        showToastA('ลบโลโก้แล้ว');
        renderSettings('branding');
      } catch (err) { showToastA(err.message); }
    });
  } else if (tab === 'homepage') {
    let s = {};
    try { s = await api('/settings'); } catch (e) { showToastA(e.message); }
    if (!categoriesAdmin.length) {
      try { categoriesAdmin = await api('/categories'); } catch (e) { /* picker just shows no options */ }
    }
    if (!homepageDraft) {
      homepageDraft = {
        banners: safeParseArray(s.home_banners),
        promoCards: (() => { const arr = safeParseArray(s.promo_image_cards); while (arr.length < 2) arr.push({}); return arr.slice(0, 2); })(),
        stats: safeParseArray(s.home_stats),
        categoryTabs: safeParseArray(s.home_category_tabs),
        ctaTitle: s.home_cta_title || '',
        ctaSubtitle: s.home_cta_subtitle || '',
        seoHtml: s.home_seo_html || '',
        shippingLogos: safeParseArray(s.shipping_logos),
        popularCatsTitle: s.home_popular_cats_title || '',
        popularCatsSubtitle: s.home_popular_cats_subtitle || '',
        popularCatIds: safeParseArray(s.home_popular_cat_ids),
        topRatedTitle: s.home_top_rated_title || '',
        topRatedSubtitle: s.home_top_rated_subtitle || '',
        topRatedCount: s.home_top_rated_count || '8',
        footerAboutTitle: s.footer_about_title || '',
        footerAboutSections: safeParseArray(s.footer_about_sections),
        footerCampaignDates: safeParseArray(s.footer_campaign_dates),
        footerNavColumns: safeParseArray(s.footer_nav_columns),
      };
    }
    renderHomepageTab();
  } else if (tab === 'customer-profile') {
    let s = {};
    try { s = await api('/settings'); } catch (e) { showToastA(e.message); }
    if (!profileMenuDraft) {
      let items = safeParseArray(s.profile_menu_items);
      if (!items.length) items = PROFILE_MENU_TAB_DEFAULT.map(it => ({ ...it }));
      profileMenuDraft = items;
    }
    renderCustomerProfileTab();
  } else if (tab === 'membership') {
    let s = {};
    try { s = await api('/settings'); } catch (e) { showToastA(e.message); }
    if (!membershipDraft) {
      let tiers = safeParseArray(s.vip_tiers);
      if (!tiers.length) {
        tiers = [
          { name: 'สมาชิกทั่วไป', icon: '🥉', minSpend: 0 },
          { name: 'Silver', icon: '🥈', minSpend: 1000 },
          { name: 'Gold', icon: '🥇', minSpend: 5000 },
          { name: 'Platinum', icon: '💎', minSpend: 20000 },
        ];
      }
      membershipDraft = { tiers, referralReward: s.referral_reward || '50' };
    }
    renderMembershipTab();
  } else if (tab === 'social') {
    let s = {};
    let status = {};
    try { s = await api('/settings'); } catch (e) { showToastA(e.message); }
    try { status = await api('/auth/social/status'); } catch (e) { /* backend offline — cards still render, just show "unknown" */ }

    const providerMeta = {
      google: { label: 'Google', color: '#4285F4', help: 'Google Cloud Console → APIs & Services → Credentials → OAuth Client ID (Web application)' },
      facebook: { label: 'Facebook', color: '#1877F2', help: 'Facebook Developers → แอปของคุณ → Facebook Login → Settings' },
      line: { label: 'LINE', color: '#06C755', help: 'LINE Developers Console → Provider → Channel (LINE Login)' },
    };

    const providerCard = (key) => {
      const meta = providerMeta[key];
      const st = status[key] || {};
      const clientId = s['oauth_' + key + '_client_id'] || '';
      const callbackUrl = st.callbackUrl || '';
      return `
        <div class="social-provider-card" style="border:1.5px solid #E3DEF7;border-radius:14px;padding:16px;margin-bottom:14px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="width:10px;height:10px;border-radius:50%;background:${meta.color}"></span>
              <b style="font-size:14px">${meta.label}</b>
            </div>
            <span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;background:${st.enabled ? '#DCFCE7' : '#F1EEFB'};color:${st.enabled ? '#16A34A' : 'var(--ink-400)'}">
              ${st.enabled ? '● เปิดใช้งานแล้ว' : '○ ยังไม่ได้ตั้งค่า'}
            </span>
          </div>
          <p style="font-size:11.5px;color:var(--ink-400);margin:0 0 12px">${meta.help}</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
            <div class="field" style="flex:1;min-width:200px;margin-bottom:0">
              <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">Client ID${key === 'facebook' ? ' (App ID)' : key === 'line' ? ' (Channel ID)' : ''}</label>
              <input id="social-${key}-id" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${clientId}" placeholder="ยังไม่ได้ตั้งค่า">
            </div>
            <div class="field" style="flex:1;min-width:200px;margin-bottom:0">
              <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">Client Secret${key === 'facebook' ? ' (App Secret)' : key === 'line' ? ' (Channel Secret)' : ''}</label>
              <input id="social-${key}-secret" type="password" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" placeholder="${st.enabled ? '•••••••• (ใส่ใหม่เพื่อเปลี่ยน)' : 'ยังไม่ได้ตั้งค่า'}">
            </div>
          </div>
          <div class="field" style="margin-bottom:0">
            <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">Callback / Redirect URI (คัดลอกไปตั้งค่าฝั่ง ${meta.label})</label>
            <div style="display:flex;gap:8px">
              <input readonly id="social-${key}-callback" style="flex:1;width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px;background:#F9F8FD;color:var(--ink-600);font-size:12.5px" value="${callbackUrl}">
              <button class="btn-outline" style="white-space:nowrap" onclick="copySocialCallback('${key}')">📋 คัดลอก</button>
            </div>
          </div>
        </div>`;
    };

    el.innerHTML = `
      <div class="p-head"><h3>Social Login</h3></div>
      <p style="font-size:12.5px;color:var(--ink-600);margin-top:0;line-height:1.6">
        ตั้งค่า Client ID/Secret ของแต่ละเจ้าที่นี่ — ปุ่ม Social Login หน้า Login ของลูกค้าจะใช้งานได้ทันทีหลังบันทึก ไม่ต้องแก้โค้ดหรือ redeploy
        เจ้าที่ยังไม่ได้ตั้งค่าจะแสดงเป็นปุ่มจางกดไม่ได้อัตโนมัติ
      </p>
      ${providerCard('google')}
      ${providerCard('facebook')}
      ${providerCard('line')}

      <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>URL หน้าเว็บลูกค้า (Frontend URL)</h3></div>
      <p style="font-size:11.5px;color:var(--ink-400);margin-top:0">ที่อยู่จริงของ customer/index.html — ใช้พาผู้ใช้กลับมาหลังล็อกอินด้วย Social เสร็จ เว้นว่างไว้จะใช้ค่าเริ่มต้นจาก .env (FRONTEND_URL)</p>
      <div class="field" style="margin-bottom:20px">
        <input id="social-frontend-url" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${s.oauth_frontend_url || ''}" placeholder="https://your-customer-app.vercel.app/index.html">
      </div>

      <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>โลโก้ที่แสดงบนหน้า Login</h3></div>
      <p style="font-size:11.5px;color:var(--ink-400);margin-top:0">ใช้โลโก้/ชื่อร้านเดียวกับที่ตั้งไว้ในแท็บ "แบรนด์ & การแสดงผล" — แก้ที่นี่หรือแท็บนั้นก็ได้ อัปเดตพร้อมกันทั้งคู่</p>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px">
        <div id="social-logo-preview" style="width:56px;height:56px;border-radius:12px;background:#F1EEFB;display:flex;align-items:center;justify-content:center;overflow:hidden;border:1.5px solid #E3DEF7">
          ${s.app_logo_url ? `<img src="${s.app_logo_url}" style="width:100%;height:100%;object-fit:cover">` : '<span style="font-size:10px;color:var(--ink-400)">ไม่มีโลโก้</span>'}
        </div>
        <button class="btn-outline" onclick="selectSettingsTab('branding')">🖼️ ไปตั้งค่าโลโก้/ชื่อร้าน</button>
      </div>

      <div style="border-top:1px solid #F1EEFB;padding-top:18px">
        <button class="btn" onclick="saveSocialLoginSettings()">บันทึกการตั้งค่า Social Login</button>
      </div>
    `;
  } else if (tab === 'team') {
    el.innerHTML = `
      <div class="p-head"><h3>ทีมงาน / สิทธิ์การใช้งาน</h3>${currentAdmin.isOwner ? `<a onclick="openTeamForm()">+ เพิ่มทีมงาน</a>` : ''}</div>
      ${!currentAdmin.isOwner ? `<p style="font-size:12px;color:var(--ink-400)">เฉพาะเจ้าของร้านเท่านั้นที่จัดการทีมงานและสิทธิ์การใช้งานได้ — ติดต่อเจ้าของร้านหากต้องการเพิ่ม/แก้ไขสิทธิ์</p>` : ''}
      <div id="team-list" style="margin-top:10px"></div>
    `;
    if (currentAdmin.isOwner) await loadTeamList();
    else {
      document.getElementById('team-list').innerHTML = `<div style="text-align:center;padding:30px;color:var(--ink-400)">ไม่มีสิทธิ์เข้าถึงส่วนนี้</div>`;
    }
  } else if (tab === 'ai') {
    let s = {};
    try { s = await api('/settings'); } catch (e) { showToastA(e.message); }
    const mode = s.call_mode || 'ai';
    const agentName = s.agent_name || 'เจ้าหน้าที่ฝ่ายบริการ';
    const agentTitle = s.agent_title || 'เจ้าหน้าที่ฝ่ายบริการลูกค้า';
    const agentGreeting = s.agent_greeting || 'ยินดีให้บริการค่ะ มีอะไรให้ช่วยเหลือสอบถามได้เลยนะคะ';
    const agentAvatarUrl = s.agent_avatar_url || '';
    let welcomeMsgs = [];
    try { welcomeMsgs = JSON.parse(s.chat_welcome_messages || '[]'); } catch (e) { welcomeMsgs = []; }
    if (!adminAiWelcomeDraft) adminAiWelcomeDraft = welcomeMsgs; // preserve in-progress edits across re-renders (e.g. after add/remove)
    welcomeMsgs = adminAiWelcomeDraft;
    let chatStats = [];
    try { chatStats = JSON.parse(s.chat_header_stats || '[]'); } catch (e) { chatStats = []; }
    while (chatStats.length < 3) chatStats.push({});
    chatStats = chatStats.slice(0, 3);
    const autoSwitch = s.auto_switch !== 'off';
    const skinTone = s.avatar_skin_tone || '#F0C8A0';
    const hairColor = s.avatar_hair_color || '#3A2A20';
    const uniformColor = s.avatar_uniform_color || '#6C3CE9';
    el.innerHTML = `
      <div class="p-head"><h3>โหมดวิดีโอคอล</h3></div>
      <p style="font-size:12.5px;color:var(--ink-600);line-height:1.6;margin-top:0">
        ทุกสายวิดีโอคอลคุยกับ <b>เจ้าหน้าที่จริง</b> เสมอ — ไม่ใช่แชทบอทอัตโนมัติ เลือกได้ว่าจะให้ลูกค้าเห็น
        <b>หน้ากล้องจริง</b> ของเจ้าหน้าที่ หรือใช้ <b>AI Avatar</b> สร้าง/เปลี่ยนหน้าที่แสดงผลแทนหน้าจริง
        เพื่อปกป้องความเป็นส่วนตัวของเจ้าหน้าที่ การตั้งค่านี้บันทึกที่เซิร์ฟเวอร์และมีผลกับลูกค้าทุกคนทันที
      </p>
      <div class="call-mode-switch" id="call-mode-switch">
        <button class="cms-opt ${mode==='real'?'active':''}" data-mode="real">
          <div class="cms-ico">🧑‍💼</div>
          <div class="cms-label">หน้าจริง</div>
          <div class="cms-sub">แสดงกล้องจริงของเจ้าหน้าที่</div>
        </button>
        <button class="cms-opt ${mode==='ai'?'active':''}" data-mode="ai">
          <div class="cms-ico">🤖</div>
          <div class="cms-label">AI Avatar</div>
          <div class="cms-sub">เจ้าหน้าที่จริง ใช้อวตารปิดบังหน้า</div>
        </button>
      </div>
      <div style="font-size:12px;color:var(--ink-400);margin:10px 0 20px" id="cms-current">
        โหมดปัจจุบัน: <b>${mode==='real' ? 'หน้าจริง' : 'AI Avatar'}</b>
      </div>
      <div class="field" style="margin-bottom:16px">
        <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">ชื่อเจ้าหน้าที่ (แสดงให้ลูกค้าเห็นตอนคอล)</label>
        <input id="ai-agent-name" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${agentName}">
      </div>

      <div class="p-head" style="margin-top:20px;border-top:1px solid #F1EEFB;padding-top:18px"><h3>โปรไฟล์เจ้าหน้าที่ในหน้าแชท</h3></div>
      <p style="font-size:12px;color:var(--ink-400);margin-top:0">รูป ชื่อ ตำแหน่ง และข้อความต้อนรับที่แสดงบนหัวหน้าแชทของลูกค้า</p>
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px">
        <div id="ai-agent-avatar-preview" style="width:60px;height:60px;border-radius:50%;overflow:hidden;background:#F1EEFB;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:24px">${agentAvatarUrl ? `<img src="${agentAvatarUrl}" style="width:100%;height:100%;object-fit:cover">` : '🧑‍💼'}</div>
        <div>
          <input type="file" id="ai-agent-avatar-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
          <button class="btn-outline" style="font-size:12px" onclick="document.getElementById('ai-agent-avatar-file').click()">📤 อัปโหลดรูปเจ้าหน้าที่</button>
        </div>
      </div>
      <div class="field" style="margin-bottom:12px">
        <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">ตำแหน่ง (ป้ายข้างชื่อ)</label>
        <input id="ai-agent-title" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${agentTitle}">
      </div>
      <div class="field" style="margin-bottom:16px">
        <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">ข้อความต้อนรับใต้ชื่อ</label>
        <input id="ai-agent-greeting" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${agentGreeting}">
      </div>

      <div class="p-head" style="margin-top:20px;border-top:1px solid #F1EEFB;padding-top:18px"><h3>ข้อความต้อนรับอัตโนมัติ (ส่งให้ลูกค้าตอนเปิดแชทครั้งแรก)</h3></div>
      <p style="font-size:12px;color:var(--ink-400);margin-top:0">เพิ่ม/ลบ/แก้ไขได้หลายข้อความ แต่ละข้อความแนบรูปภาพได้ (ไม่บังคับ) จะส่งเรียงตามลำดับให้ลูกค้าอัตโนมัติเมื่อเปิดแชทเป็นครั้งแรก</p>
      <div id="ai-welcome-msgs" style="display:flex;flex-direction:column;gap:10px;margin-bottom:12px">
        ${welcomeMsgs.map((m, i) => `
          <div class="ai-welcome-msg-item" style="border:1.5px solid #E3DEF7;border-radius:12px;padding:10px">
            <textarea data-idx="${i}" class="ai-wm-text" placeholder="ข้อความต้อนรับ" style="width:100%;border:1.5px solid #E3DEF7;border-radius:8px;padding:8px 10px;font-size:12.5px;font-family:inherit;min-height:60px;margin-bottom:8px">${m.text || ''}</textarea>
            <div style="display:flex;align-items:center;gap:8px">
              <div style="width:44px;height:44px;border-radius:8px;overflow:hidden;background:#F1EEFB;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--ink-400)">${m.imageUrl ? `<img src="${m.imageUrl}" style="width:100%;height:100%;object-fit:cover">` : 'ไม่มีรูป'}</div>
              <button class="ai-wm-upload-btn btn-outline" data-idx="${i}" style="font-size:11px;padding:7px 10px">📤 แนบรูป</button>
              <button class="ai-wm-remove" data-idx="${i}" style="margin-left:auto;width:26px;height:26px;border-radius:50%;background:#DC2626;color:white;border:none;font-size:11px;cursor:pointer;flex-shrink:0">✕</button>
            </div>
          </div>`).join('') || '<p style="font-size:12px;color:var(--ink-400)">ยังไม่มีข้อความต้อนรับ</p>'}
      </div>
      <input type="file" id="ai-wm-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
      <button class="btn-outline" onclick="addWelcomeMessage()">➕ เพิ่มข้อความต้อนรับ</button>

      <div class="p-head" style="margin-top:20px;border-top:1px solid #F1EEFB;padding-top:18px"><h3>สถิติในหน้าแชท (3 การ์ด)</h3></div>
      <p style="font-size:12px;color:var(--ink-400);margin-top:0">การ์ดตัวเลข 3 ใบใต้หัวข้อแชท เช่น จำนวนงาน/ยอดรอถอน/ยอดถอนสำเร็จ — ใส่ไอคอน (emoji) ป้ายชื่อ ตัวเลข และหน่วยได้เอง</p>
      <div id="ai-chat-stats" style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
        ${chatStats.map((s, i) => `
          <div style="border:1.5px solid #E3DEF7;border-radius:12px;padding:10px;display:grid;grid-template-columns:50px 1fr 1fr 1fr;gap:8px;align-items:center">
            <input data-idx="${i}" class="ai-cs-icon" placeholder="📋" value="${s.icon || ''}" style="border:1.5px solid #E3DEF7;border-radius:8px;padding:7px;font-size:14px;text-align:center">
            <input data-idx="${i}" class="ai-cs-label" placeholder="ป้ายชื่อ" value="${s.label || ''}" style="border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 9px;font-size:12px">
            <input data-idx="${i}" class="ai-cs-value" placeholder="ตัวเลข เช่น 4,871" value="${s.value || ''}" style="border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 9px;font-size:12px">
            <input data-idx="${i}" class="ai-cs-sub" placeholder="หน่วย เช่น งาน" value="${s.sub || ''}" style="border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 9px;font-size:12px">
          </div>`).join('')}
      </div>

      <div class="settings-row" style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-top:1px solid #F1EEFB">
        <span style="font-size:13px;font-weight:600">สลับเป็น AI Avatar อัตโนมัตินอกเวลาทำการ</span>
        <label style="position:relative;display:inline-block;width:42px;height:24px">
          <input type="checkbox" id="ai-auto-switch" ${autoSwitch?'checked':''} style="opacity:0;width:0;height:0">
          <span style="position:absolute;inset:0;background:${autoSwitch?'var(--purple-500)':'#D9D5EA'};border-radius:24px"></span>
          <span style="position:absolute;width:18px;height:18px;${autoSwitch?'right:3px':'left:3px'};top:3px;background:white;border-radius:50%"></span>
        </label>
      </div>

      <div class="p-head" style="margin-top:20px;border-top:1px solid #F1EEFB;padding-top:18px"><h3>รูปลักษณ์อวตาร AI</h3></div>
      <p style="font-size:12px;color:var(--ink-600);margin-top:0">อวตารขยับตามสีหน้าจริงของเจ้าหน้าที่แบบเรียลไทม์ — ปรับสีผิว สีผม และสีชุด ให้ตรงกับแบรนด์หรือเจ้าหน้าที่แต่ละคนได้</p>
      <div class="avatar-swatch-row">
        <div class="swatch-group">
          <span class="swatch-label">สีผิว</span>
          <div class="swatch-list" id="swatch-skin" data-key="avatar_skin_tone">
            ${['#F0C8A0', '#E0AC7A', '#C68642', '#8D5524', '#FFDAB3'].map(c => `<button class="swatch ${c===skinTone?'selected':''}" style="background:${c}" data-value="${c}"></button>`).join('')}
          </div>
        </div>
        <div class="swatch-group">
          <span class="swatch-label">สีผม</span>
          <div class="swatch-list" id="swatch-hair" data-key="avatar_hair_color">
            ${['#3A2A20', '#1C1C1C', '#6B4423', '#B87333', '#4A4A4A'].map(c => `<button class="swatch ${c===hairColor?'selected':''}" style="background:${c}" data-value="${c}"></button>`).join('')}
          </div>
        </div>
        <div class="swatch-group">
          <span class="swatch-label">สีชุด</span>
          <div class="swatch-list" id="swatch-uniform" data-key="avatar_uniform_color">
            ${['#6C3CE9', '#F0398C', '#22C55E', '#3B82F6', '#F59E0B'].map(c => `<button class="swatch ${c===uniformColor?'selected':''}" style="background:${c}" data-value="${c}"></button>`).join('')}
          </div>
        </div>
        <div class="avatar-preview-box">
          <video id="settings-avatar-source" autoplay playsinline muted style="display:none"></video>
          <canvas id="settings-avatar-preview" width="140" height="140"></canvas>
          <button class="btn-outline" style="margin-top:8px;font-size:11px;padding:7px 10px" onclick="previewAvatarAppearance()">🔄 ดูตัวอย่างจากกล้อง</button>
        </div>
      </div>

      <button class="btn" style="margin-top:16px" onclick="saveAiSettings()">บันทึกการตั้งค่า</button>
    `;
    document.querySelectorAll('.swatch-list').forEach((list) => {
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('.swatch');
        if (!btn) return;
        list.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });
    document.getElementById('call-mode-switch').addEventListener('click', async (e) => {
      const opt = e.target.closest('.cms-opt');
      if (!opt) return;
      const newMode = opt.dataset.mode;
      try {
        await api('/settings', { method: 'PATCH', body: { call_mode: newMode } });
        document.querySelectorAll('.cms-opt').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        document.getElementById('cms-current').innerHTML = `โหมดปัจจุบัน: <b>${newMode==='real' ? 'หน้าจริง' : 'AI Avatar'}</b>`;
        showToastA(newMode === 'real' ? 'เปลี่ยนเป็นโหมด "หน้าจริง" แล้ว' : 'เปลี่ยนเป็นโหมด "AI Avatar" แล้ว');
      } catch (err) { showToastA(err.message); }
    });

    // ---- agent avatar upload ----
    document.getElementById('ai-agent-avatar-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const url = await uploadBrandingImage(file);
        await api('/settings', { method: 'PATCH', body: { agent_avatar_url: url } });
        document.getElementById('ai-agent-avatar-preview').innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover">`;
        showToastA('อัปโหลดรูปเจ้าหน้าที่เรียบร้อยแล้ว');
      } catch (err) { showToastA(err.message); }
    });

    // ---- welcome messages: text edits, per-item image upload, remove ----
    document.querySelectorAll('.ai-wm-text').forEach((ta) => {
      ta.addEventListener('input', () => { adminAiWelcomeDraft[Number(ta.dataset.idx)].text = ta.value; });
    });
    let wmUploadIdx = null;
    document.querySelectorAll('.ai-wm-upload-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        wmUploadIdx = Number(btn.dataset.idx);
        document.getElementById('ai-wm-file').click();
      });
    });
    document.getElementById('ai-wm-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file || wmUploadIdx === null) return;
      try {
        const url = await uploadBrandingImage(file);
        adminAiWelcomeDraft[wmUploadIdx].imageUrl = url;
        selectSettingsTab('ai');
      } catch (err) { showToastA(err.message); }
    });
    document.getElementById('ai-welcome-msgs').addEventListener('click', (e) => {
      const btn = e.target.closest('.ai-wm-remove');
      if (!btn) return;
      adminAiWelcomeDraft.splice(Number(btn.dataset.idx), 1);
      selectSettingsTab('ai');
    });
  } else if (tab === 'notify') {
    let s = {};
    try { s = await api('/settings'); } catch (e) { showToastA(e.message); }
    let categoriesEnabled = {};
    try { categoriesEnabled = JSON.parse(s.notif_categories_enabled || '{}'); } catch (e) { categoriesEnabled = {}; }
    const CATEGORY_ROWS = [
      { key: 'order', label: 'คำสั่งซื้อ', desc: 'มีคำสั่งซื้อใหม่ / ลูกค้าสั่งซื้อสำเร็จ' },
      { key: 'payment', label: 'การชำระเงิน', desc: 'ยืนยันสลิป / เปลี่ยนสถานะการชำระเงิน' },
      { key: 'wallet', label: 'กระเป๋าเงิน (เติม/ถอน/โบนัส)', desc: 'เติมเงิน หักยอด คำขอถอนเงิน และผลอนุมัติ' },
      { key: 'shipping', label: 'การจัดส่ง / สถานะสินค้า', desc: 'อัปเดตสถานะคำสั่งซื้อระหว่างจัดส่ง' },
      { key: 'account_status', label: 'สถานะบัญชี', desc: 'แช่แข็ง / ปลดแช่แข็งบัญชีลูกค้า' },
      { key: 'ticket', label: 'งานแจ้งบริการ', desc: 'มีงานแจ้งใหม่ / อัปเดตสถานะงาน' },
      { key: 'coupon', label: 'คูปอง/โปรโมชั่น', desc: 'คูปองใหม่หรือโปรโมชั่นที่เกี่ยวข้อง' },
    ];
    el.innerHTML = `
      <div class="p-head"><h3>การแจ้งเตือน</h3></div>
      <p style="font-size:12.5px;color:var(--ink-600)">ทุกการแจ้งเตือนด้านล่างนี้ส่งเป็น <b>Push Notification ของเครื่อง</b> จริง — ขึ้นแจ้งเตือนที่โทรศัพท์/อุปกรณ์ได้แม้ปิดแอปหรือไม่ได้เปิดหน้าเว็บไว้ (คนละกลไกกับการอัปเดตแบบ real-time ในแอป ที่ทำงานเฉพาะตอนเปิดแอปค้างอยู่) ต้องให้ผู้ใช้อนุญาตการแจ้งเตือนของเบราว์เซอร์/อุปกรณ์ก่อนถึงจะได้รับ</p>
      <div class="settings-row" style="padding:12px 0;border-bottom:1px solid #F1EEFB;display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-size:13px;font-weight:600;display:block">แจ้งเตือนผ่านแอป (Push)</span>
          <span style="font-size:11px;color:var(--ink-400)" id="notify-push-status">กำลังตรวจสอบสถานะ...</span>
        </div>
        <label style="position:relative;display:inline-block;width:42px;height:24px;flex-shrink:0">
          <input type="checkbox" id="notify-push-toggle" style="opacity:0;width:0;height:0">
          <span id="notify-push-track" style="position:absolute;inset:0;background:#D9D5EA;border-radius:24px;transition:background .15s"></span>
          <span id="notify-push-knob" style="position:absolute;width:18px;height:18px;left:3px;top:3px;background:white;border-radius:50%;transition:left .15s"></span>
        </label>
      </div>
      <div class="settings-row" style="padding:12px 0;border-bottom:1px solid #F1EEFB;display:flex;justify-content:space-between;align-items:center;opacity:.55">
        <span style="font-size:13px">อีเมล</span><b style="font-size:11px;color:var(--ink-400);font-weight:700">ยังไม่รองรับ — ต้องต่อผู้ให้บริการอีเมล เช่น SendGrid</b>
      </div>
      <div class="settings-row" style="padding:12px 0;border-bottom:1px solid #F1EEFB;display:flex;justify-content:space-between;align-items:center;opacity:.55">
        <span style="font-size:13px">SMS</span><b style="font-size:11px;color:var(--ink-400);font-weight:700">ยังไม่รองรับ — ต้องต่อผู้ให้บริการ SMS เช่น Twilio</b>
      </div>

      <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px;margin-top:6px"><h3>หมวดหมู่การแจ้งเตือน</h3></div>
      <p style="font-size:12px;color:var(--ink-400);margin-top:0">เปิด/ปิดได้ทีละหมวด มีผลกับการแจ้งเตือนทั้งฝั่งหลังบ้าน (แอดมิน) และหน้าบ้าน (ลูกค้า) — ลูกค้าจะเห็นเฉพาะการแจ้งเตือนที่เกี่ยวกับตัวเองเท่านั้น</p>
      ${CATEGORY_ROWS.map(c => `
        <div class="settings-row" style="padding:12px 0;border-bottom:1px solid #F1EEFB;display:flex;justify-content:space-between;align-items:center">
          <div><span style="font-size:13px;font-weight:600;display:block">${c.label}</span><span style="font-size:11px;color:var(--ink-400)">${c.desc}</span></div>
          <label style="position:relative;display:inline-block;width:42px;height:24px;flex-shrink:0">
            <input type="checkbox" class="notif-cat-cb" data-key="${c.key}" ${categoriesEnabled[c.key] !== false ? 'checked' : ''} style="opacity:0;width:0;height:0">
            <span style="position:absolute;inset:0;background:${categoriesEnabled[c.key] !== false ? 'var(--purple-600)' : '#D9D5EA'};border-radius:24px;transition:background .15s" class="notif-cat-track"></span>
            <span style="position:absolute;width:18px;height:18px;${categoriesEnabled[c.key] !== false ? 'left:21px' : 'left:3px'};top:3px;background:white;border-radius:50%;transition:left .15s" class="notif-cat-knob"></span>
          </label>
        </div>
      `).join('')}
      <button class="btn" style="margin-top:16px" onclick="saveNotifCategories()">บันทึกการตั้งค่าหมวดหมู่</button>

      <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px;margin-top:22px"><h3>ข้อความแจ้งเตือน</h3></div>
      <p style="font-size:12px;color:var(--ink-400);margin-top:0">แก้ไขข้อความที่ลูกค้า/แอดมินจะเห็นในการแจ้งเตือนแต่ละแบบได้เอง — ใช้ตัวแปรในวงเล็บปีกกาแทนค่าที่เปลี่ยนไปในแต่ละครั้ง เช่น <code>{amount}</code> เดี๋ยวระบบแทนที่ให้อัตโนมัติ (ห้ามลบวงเล็บปีกกาหรือสะกดชื่อตัวแปรผิด ไม่งั้นจะไม่ถูกแทนค่า)</p>
      <div id="notif-tpl-list"></div>
      <button class="btn" style="margin-top:16px" onclick="saveNotifTemplates()">บันทึกข้อความแจ้งเตือน</button>
    `;
    renderNotifTemplateEditor(s);
    document.querySelectorAll('.notif-cat-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const track = cb.parentElement.querySelector('.notif-cat-track');
        const knob = cb.parentElement.querySelector('.notif-cat-knob');
        track.style.background = cb.checked ? 'var(--purple-600)' : '#D9D5EA';
        knob.style.left = cb.checked ? '21px' : '3px';
      });
    });
    await refreshNotifyPushToggle();
    document.getElementById('notify-push-toggle').addEventListener('change', onNotifyPushToggle);
  } else if (tab === 'pwa') {
    el.innerHTML = `
      <div class="p-head"><h3>PWA / แอปมือถือ</h3></div>
      <p style="font-size:12.5px;color:var(--ink-600);line-height:1.6">
        ระบบนี้รองรับการติดตั้งเป็นแอปบนมือถือผ่าน <b>Progressive Web App (PWA)</b> ใช้งานได้ทั้ง Android และ iOS
        โดยเปิดผ่านเบราว์เซอร์แล้วเลือก "เพิ่มไปยังหน้าจอโฮม" (Add to Home Screen) — ต้อง deploy บน HTTPS จริงเพื่อให้ Service Worker ทำงาน
      </p>
      <div class="channel-row"><div class="c-ico" style="background:#22C55E">✅</div><div class="c-name">Manifest.json</div><div class="c-val">พร้อมใช้งาน</div></div>
      <div class="channel-row"><div class="c-ico" style="background:#22C55E">✅</div><div class="c-name">Service Worker (Offline)</div><div class="c-val">พร้อมใช้งาน</div></div>
      <div class="channel-row"><div class="c-ico" style="background:#22C55E">✅</div><div class="c-name">ไอคอนแอป</div><div class="c-val">พร้อมใช้งาน</div></div>`;
  }
}

async function uploadBrandingImage(file) {
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!ALLOWED.includes(file.type)) throw new Error('รองรับเฉพาะไฟล์รูปภาพ JPG, PNG, WEBP หรือ GIF เท่านั้น');
  if (file.size > 5 * 1024 * 1024) throw new Error('ไฟล์รูปภาพต้องมีขนาดไม่เกิน 5MB');

  const form = new FormData();
  form.append('image', file);
  const res = await fetch(API_BASE + '/upload/image', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + getToken() },
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || 'อัปโหลดไม่สำเร็จ');
  return data.url;
}

async function saveSocialLoginSettings() {
  const body = {
    oauth_google_client_id: document.getElementById('social-google-id').value.trim(),
    oauth_google_client_secret: document.getElementById('social-google-secret').value.trim(),
    oauth_facebook_client_id: document.getElementById('social-facebook-id').value.trim(),
    oauth_facebook_client_secret: document.getElementById('social-facebook-secret').value.trim(),
    oauth_line_client_id: document.getElementById('social-line-id').value.trim(),
    oauth_line_client_secret: document.getElementById('social-line-secret').value.trim(),
    oauth_frontend_url: document.getElementById('social-frontend-url').value.trim(),
  };
  try {
    await api('/settings', { method: 'PATCH', body });
    showToastA('บันทึกการตั้งค่า Social Login เรียบร้อยแล้ว');
    renderSettings('social'); // re-render so status badges/placeholders reflect what was just saved
  } catch (err) { showToastA(err.message); }
}

function copySocialCallback(provider) {
  const input = document.getElementById('social-' + provider + '-callback');
  if (!input || !input.value) return;
  navigator.clipboard.writeText(input.value)
    .then(() => showToastA('คัดลอก Callback URL แล้ว'))
    .catch(() => { input.select(); showToastA('เลือกข้อความไว้ให้แล้ว กด Ctrl+C เพื่อคัดลอก'); });
}

/* ============ Home Page CMS (Settings > หน้าแรก) ============ */
// Kept as an in-memory draft while the admin is editing (banners/category tabs/shipping
// logos need image uploads mid-edit) — nothing is written to the server until "บันทึก".
let homepageDraft = null;
let adminAiWelcomeDraft = null; // in-memory draft of chat welcome messages, edited in the "ai" settings tab
let membershipDraft = null;
let profileMenuDraft = null;

// Keep in sync with PROFILE_MENU_DEFAULT in customer/app.js.
const PROFILE_MENU_TAB_DEFAULT = [
  { icon: '🧾', label: 'ข้อมูลส่วนตัว', target: 'personal-info' },
  { icon: '👛', label: 'กระเป๋าเงินของฉัน', target: 'wallet' },
  { icon: '📦', label: 'คำสั่งซื้อของฉัน', target: 'orders' },
  { icon: '🎁', label: 'ชวนเพื่อน รับรางวัล', target: 'referral' },
  { icon: '❓', label: 'ศูนย์ช่วยเหลือ', target: 'help-centre' },
  { icon: '🚪', label: 'ออกจากระบบ', target: 'logout', danger: true },
];

// Internal pages the admin can point a profile menu row at, plus a "custom URL" escape hatch.
const PROFILE_MENU_TARGET_OPTIONS = [
  { v: 'personal-info', label: 'ข้อมูลส่วนตัว' },
  { v: 'wallet', label: 'กระเป๋าเงินของฉัน' },
  { v: 'orders', label: 'คำสั่งซื้อของฉัน' },
  { v: 'referral', label: 'ชวนเพื่อน รับรางวัล' },
  { v: 'report', label: 'แจ้งปัญหาการใช้งาน' },
  { v: 'kb', label: 'คลังความรู้' },
  { v: 'announcements', label: 'ประกาศ/ข่าวสาร' },
  { v: 'help-centre', label: 'ศูนย์ช่วยเหลือ' },
  { v: 'bank-account', label: 'บัญชีถอนเงิน' },
  { v: 'withdraw', label: 'ถอนเงิน' },
  { v: 'shop', label: 'ร้านค้า (หน้าหลัก)' },
  { v: 'logout', label: 'ออกจากระบบ' },
  { v: '__url__', label: 'ลิงก์ภายนอก (URL) …' },
];

function safeParseArray(v) {
  try { const arr = JSON.parse(v || '[]'); return Array.isArray(arr) ? arr : []; } catch (e) { return []; }
}

const STAT_ICON_LABELS = { store: '🏬 ร้านค้า', tag: '🏷️ ป้ายราคา', star: '⭐ ดาว', users: '👥 ผู้ใช้งาน' };

function renderHomepageTab() {
  const el = document.getElementById('settings-content');
  const d = homepageDraft;

  el.innerHTML = `
    <div class="p-head"><h3>แบนเนอร์หน้าแรก</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">รูปแบนเนอร์ใหญ่ด้านบนสุดของหน้าแรก มีได้หลายรูป จะสลับแสดงอัตโนมัติทุก 3 วินาที</p>
    <div id="hp-banners" style="display:flex;flex-direction:column;gap:10px;margin-bottom:12px">
      ${d.banners.map((b, i) => `
        <div class="hp-banner-item" style="display:flex;gap:10px;align-items:center;border:1.5px solid #E3DEF7;border-radius:12px;padding:10px">
          <div style="width:90px;height:50px;border-radius:8px;overflow:hidden;background:#F1EEFB;flex-shrink:0;display:flex;align-items:center;justify-content:center">
            ${b.imageUrl ? `<img src="${b.imageUrl}" style="width:100%;height:100%;object-fit:cover">` : '<span style="font-size:10px;color:var(--ink-400)">ไม่มีรูป</span>'}
          </div>
          <input data-idx="${i}" class="hp-banner-link" placeholder="ลิงก์เมื่อกดแบนเนอร์ (ไม่บังคับ)" value="${b.linkUrl || ''}" style="flex:1;border:1.5px solid #E3DEF7;border-radius:8px;padding:8px 10px;font-size:12.5px">
          <button class="hp-banner-remove" data-idx="${i}" style="width:26px;height:26px;border-radius:50%;background:#DC2626;color:white;border:none;font-size:11px;cursor:pointer;flex-shrink:0">✕</button>
        </div>`).join('') || '<p style="font-size:12px;color:var(--ink-400)">ยังไม่มีแบนเนอร์</p>'}
    </div>
    <input type="file" id="hp-banner-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
    <button class="btn-outline" onclick="document.getElementById('hp-banner-file').click()">📤 เพิ่มแบนเนอร์</button>

    <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>รูปโปรโมชั่น 2 รูป (ใต้หมวดหมู่ทั่วไปในหน้าสินค้า)</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">การ์ดรูปภาพ 2 ใบเรียงกัน แสดงในหน้า "สินค้า" ใต้ส่วนหมวดหมู่ยอดนิยม/หมวดหมู่ทั่วไป</p>
    <div id="hp-promocards" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      ${d.promoCards.map((c, i) => `
        <div class="hp-promocard-item" style="border:1.5px solid #E3DEF7;border-radius:12px;padding:10px">
          <div style="width:100%;height:70px;border-radius:8px;overflow:hidden;background:#F1EEFB;margin-bottom:8px;display:flex;align-items:center;justify-content:center">
            ${c.imageUrl ? `<img src="${c.imageUrl}" style="width:100%;height:100%;object-fit:cover">` : '<span style="font-size:10px;color:var(--ink-400)">ไม่มีรูป</span>'}
          </div>
          <input data-idx="${i}" class="hp-promocard-title" placeholder="ชื่อการ์ด (สำรอง หากยังไม่มีรูป)" value="${c.title || ''}" style="width:100%;border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 9px;font-size:12px;margin-bottom:6px">
          <input data-idx="${i}" class="hp-promocard-link" placeholder="ลิงก์เมื่อกด (ไม่บังคับ)" value="${c.linkUrl || ''}" style="width:100%;border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 9px;font-size:12px;margin-bottom:6px">
          <button class="hp-promocard-upload-btn" data-idx="${i}" style="width:100%;border:1.5px solid #E3DEF7;border-radius:8px;padding:6px;font-size:11.5px;background:white;cursor:pointer">📤 อัปโหลดรูป</button>
        </div>`).join('')}
    </div>
    <input type="file" id="hp-promocard-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">

    <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>แถบสถิติ</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">ตัวเลข 4 ช่องใต้แบนเนอร์ (เช่น จำนวนร้านค้า, รีวิว) — แก้ไขได้ แต่จำนวนช่องคงที่ 4 ช่องตามดีไซน์</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px">
      ${d.stats.map((st, i) => `
        <div style="border:1.5px solid #E3DEF7;border-radius:12px;padding:10px">
          <select data-idx="${i}" class="hp-stat-icon" style="width:100%;border:1.5px solid #E3DEF7;border-radius:8px;padding:6px 8px;font-size:11.5px;margin-bottom:6px">
            ${Object.entries(STAT_ICON_LABELS).map(([k, label]) => `<option value="${k}" ${st.icon===k?'selected':''}>${label}</option>`).join('')}
          </select>
          <input data-idx="${i}" class="hp-stat-value" placeholder="ตัวเลข เช่น 5,000+" value="${st.value || ''}" style="width:100%;border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 9px;font-size:13px;font-weight:700;margin-bottom:6px">
          <input data-idx="${i}" class="hp-stat-label" placeholder="คำอธิบาย" value="${st.label || ''}" style="width:100%;border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 9px;font-size:12px">
        </div>`).join('')}
    </div>

    <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>แท็บหมวดหมู่ (แถบไอคอนใต้แบนเนอร์)</h3></div>
    <div id="hp-cattabs" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px">
      ${d.categoryTabs.map((c, i) => `
        <div class="hp-cattab-item" style="display:flex;align-items:center;gap:8px;border:1.5px solid #E3DEF7;border-radius:12px;padding:8px 10px">
          <div style="width:32px;height:32px;border-radius:8px;overflow:hidden;background:#F1EEFB;flex-shrink:0;display:flex;align-items:center;justify-content:center">
            ${c.iconUrl ? `<img src="${c.iconUrl}" style="width:100%;height:100%;object-fit:cover">` : '<span style="font-size:9px;color:var(--ink-400)">—</span>'}
          </div>
          <input data-idx="${i}" class="hp-cattab-label" value="${c.label || ''}" style="width:80px;border:1.5px solid #E3DEF7;border-radius:8px;padding:6px 8px;font-size:12px">
          <button class="hp-cattab-icon-btn" data-idx="${i}" title="เปลี่ยนไอคอน" style="width:26px;height:26px;border-radius:50%;background:#F1EEFB;border:none;font-size:11px;cursor:pointer">📤</button>
          <button class="hp-cattab-remove" data-idx="${i}" style="width:26px;height:26px;border-radius:50%;background:#DC2626;color:white;border:none;font-size:11px;cursor:pointer">✕</button>
        </div>`).join('') || '<p style="font-size:12px;color:var(--ink-400)">ยังไม่มีแท็บหมวดหมู่</p>'}
    </div>
    <input type="file" id="hp-cattab-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
    <button class="btn-outline" onclick="addHomepageCategoryTab()">➕ เพิ่มแท็บหมวดหมู่</button>

    <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>หมวดหมู่ยอดนิยม (ใต้แถบแฟลชเซล)</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">แถวปุ่มหมวดหมู่ให้ลูกค้ากดช้อปตามหมวดหมู่ — เลือกได้ว่าจะโชว์หมวดหมู่ไหนบ้างและเรียงลำดับตามที่เพิ่ม</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
      <div class="field" style="margin-bottom:0"><label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">หัวข้อ</label><input id="hp-popcats-title" placeholder="หมวดหมู่ยอดนิยม" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${d.popularCatsTitle}"></div>
      <div class="field" style="margin-bottom:0"><label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">คำอธิบาย</label><input id="hp-popcats-subtitle" placeholder="ช้อปตามหมวดหมู่ที่คนค้นหามากที่สุด" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${d.popularCatsSubtitle}"></div>
    </div>
    <div id="hp-popcats-list" style="display:flex;flex-wrap:wrap;gap:8px;margin:10px 0">
      ${d.popularCatIds.map((id, i) => {
        const cat = categoriesAdmin.find(c => c.id === id);
        return `<span style="display:flex;align-items:center;gap:6px;background:var(--paper);border:1.5px solid #E3DEF7;border-radius:20px;padding:6px 8px 6px 14px;font-size:12px;font-weight:700">${cat ? cat.icon + ' ' + cat.name : '(หมวดหมู่ถูกลบ)'}<button class="hp-popcat-remove" data-idx="${i}" style="width:20px;height:20px;border-radius:50%;background:#DC2626;color:white;border:none;font-size:9px;cursor:pointer;flex-shrink:0">✕</button></span>`;
      }).join('') || '<p style="font-size:12px;color:var(--ink-400);margin:0">ยังไม่ได้เลือกหมวดหมู่ — จะโชว์ 10 หมวดหมู่แรกโดยอัตโนมัติไปก่อน</p>'}
    </div>
    <div style="display:flex;gap:8px;margin-bottom:20px">
      <select id="hp-popcats-add" style="flex:1;border:1.5px solid #E3DEF7;border-radius:10px;padding:9px 12px;font-size:12.5px">
        <option value="">— เลือกหมวดหมู่เพื่อเพิ่ม —</option>
        ${categoriesAdmin.filter(c => !d.popularCatIds.includes(c.id)).map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('')}
      </select>
      <button class="btn-outline" onclick="addPopularCategoryPill()">➕ เพิ่ม</button>
    </div>

    <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>สินค้ายอดนิยม (จัดอันดับตามคะแนนรีวิว)</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">รายการสินค้าคำนวณอัตโนมัติจากคะแนนรีวิวเฉลี่ยสูงสุด — แก้ไขได้แค่หัวข้อ คำอธิบาย และจำนวนที่แสดง</p>
    <div style="display:grid;grid-template-columns:1fr 1fr 100px;gap:10px;margin-bottom:20px">
      <div class="field" style="margin-bottom:0"><label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">หัวข้อ</label><input id="hp-toprated-title" placeholder="สินค้ายอดนิยม" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${d.topRatedTitle}"></div>
      <div class="field" style="margin-bottom:0"><label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">คำอธิบาย</label><input id="hp-toprated-subtitle" placeholder="สินค้าที่ได้รับการรีวิวและคะแนนเฉลี่ยสูงสุด" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${d.topRatedSubtitle}"></div>
      <div class="field" style="margin-bottom:0"><label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">จำนวน</label><input id="hp-toprated-count" type="number" min="1" max="20" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${d.topRatedCount}"></div>
    </div>

    <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>แบนเนอร์ชวนช้อป (CTA)</h3></div>
    <div class="field" style="margin-bottom:14px">
      <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">หัวข้อ</label>
      <input id="hp-cta-title" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${d.ctaTitle}">
    </div>
    <div class="field" style="margin-bottom:20px">
      <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">คำอธิบาย</label>
      <input id="hp-cta-subtitle" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${d.ctaSubtitle}">
    </div>

    <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>เนื้อหาท้ายหน้า (SEO)</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">ข้อความยาวแสดงท้ายหน้าแรก ช่วยเรื่อง SEO — เว้นว่างได้ถ้าไม่ต้องการแสดง</p>
    <textarea id="hp-seo-html" rows="6" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:20px">${d.seoHtml}</textarea>

    <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>โลโก้บริการจัดส่ง</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">แสดงคู่กับโลโก้ช่องทางการชำระเงินท้ายหน้าแรก</p>
    <div id="hp-shipping-logos" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px">
      ${d.shippingLogos.map((p, i) => `
        <div class="hp-ship-item" data-idx="${i}" style="position:relative;width:72px;height:52px;border:1.5px solid #E3DEF7;border-radius:10px;overflow:hidden;background:white;display:flex;align-items:center;justify-content:center">
          <img src="${p.url}" style="max-width:100%;max-height:100%;object-fit:contain">
          <button class="hp-ship-remove" data-idx="${i}" style="position:absolute;top:-2px;right:-2px;width:18px;height:18px;border-radius:50%;background:#DC2626;color:white;border:none;font-size:10px;line-height:1;cursor:pointer">✕</button>
        </div>`).join('')}
    </div>
    <input type="file" id="hp-shipping-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
    <button class="btn-outline" onclick="document.getElementById('hp-shipping-file').click()">📤 เพิ่มโลโก้บริการจัดส่ง</button>

    <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>ข้อความแนะนำร้านค้า (ท้ายหน้าแรก)</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">หัวข้อใหญ่ + ย่อหน้าอธิบายร้านค้าหลายหัวข้อ แสดงเหนือส่วนเมนูลิงก์ท้ายหน้าแรก</p>
    <div class="field" style="margin-bottom:14px">
      <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">หัวข้อใหญ่</label>
      <input id="hp-footer-about-title" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px" value="${d.footerAboutTitle}">
    </div>
    <div id="hp-about-sections" style="display:flex;flex-direction:column;gap:10px;margin-bottom:12px">
      ${d.footerAboutSections.map((s, i) => `
        <div class="hp-about-item" style="border:1.5px solid #E3DEF7;border-radius:12px;padding:10px;position:relative">
          <input data-idx="${i}" class="hp-about-heading" placeholder="หัวข้อย่อย" value="${s.heading || ''}" style="width:100%;border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 9px;font-size:12.5px;font-weight:700;margin-bottom:6px">
          <textarea data-idx="${i}" class="hp-about-body" rows="2" placeholder="เนื้อหา" style="width:100%;border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 9px;font-size:12px">${s.body || ''}</textarea>
          <button class="hp-about-remove" data-idx="${i}" style="position:absolute;top:8px;right:8px;width:22px;height:22px;border-radius:50%;background:#DC2626;color:white;border:none;font-size:10px;cursor:pointer">✕</button>
        </div>`).join('') || '<p style="font-size:12px;color:var(--ink-400)">ยังไม่มีหัวข้อ</p>'}
    </div>
    <button class="btn-outline" onclick="addFooterAboutSection()">➕ เพิ่มหัวข้อ</button>

    <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>ป้ายวันแคมเปญ/โปรโมชั่นประจำเดือน</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">เช่น 2.2, 3.3, ... 12.12 — ติ๊ก "เด่น" เพื่อไฮไลต์ป้ายสีส้มแดง</p>
    <div id="hp-campaign-dates" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
      ${d.footerCampaignDates.map((c, i) => `
        <div class="hp-campaign-item" style="display:flex;align-items:center;gap:6px;border:1.5px solid #E3DEF7;border-radius:20px;padding:5px 8px 5px 12px">
          <input data-idx="${i}" class="hp-campaign-label" value="${c.label || ''}" style="width:52px;border:none;font-size:12px;font-weight:700;outline:none">
          <label style="font-size:10px;color:var(--ink-400);display:flex;align-items:center;gap:3px;cursor:pointer">
            <input type="checkbox" data-idx="${i}" class="hp-campaign-hl" ${c.highlight ? 'checked' : ''}> เด่น
          </label>
          <button class="hp-campaign-remove" data-idx="${i}" style="width:20px;height:20px;border-radius:50%;background:#DC2626;color:white;border:none;font-size:9px;cursor:pointer;flex-shrink:0">✕</button>
        </div>`).join('') || '<p style="font-size:12px;color:var(--ink-400)">ยังไม่มีป้ายแคมเปญ</p>'}
    </div>
    <button class="btn-outline" onclick="addFooterCampaignDate()">➕ เพิ่มป้ายแคมเปญ</button>

    <div class="p-head" style="border-top:1px solid #F1EEFB;padding-top:18px"><h3>คอลัมน์ลิงก์ท้ายหน้าแรก</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">เช่น "ศูนย์ช่วยเหลือ", "เกี่ยวกับเรา", "นโยบาย" — ปล่อยลิงก์ว่างได้ถ้าต้องการแค่แสดงข้อความ (ไม่ต้องกดได้)</p>
    <div id="hp-nav-cols" style="display:flex;flex-direction:column;gap:12px;margin-bottom:12px">
      ${d.footerNavColumns.map((col, ci) => `
        <div class="hp-navcol-item" style="border:1.5px solid #E3DEF7;border-radius:12px;padding:10px;position:relative">
          <input data-ci="${ci}" class="hp-navcol-title" placeholder="ชื่อคอลัมน์" value="${col.title || ''}" style="width:calc(100% - 30px);border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 9px;font-size:12.5px;font-weight:700;margin-bottom:8px">
          <button class="hp-navcol-remove" data-ci="${ci}" style="position:absolute;top:8px;right:8px;width:22px;height:22px;border-radius:50%;background:#DC2626;color:white;border:none;font-size:10px;cursor:pointer">✕</button>
          <div class="hp-navlink-list" data-ci="${ci}" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">
            ${(col.links || []).map((l, li) => `
              <div style="display:flex;gap:6px;align-items:center">
                <input data-ci="${ci}" data-li="${li}" class="hp-navlink-label" placeholder="ข้อความลิงก์" value="${l.label || ''}" style="flex:1;border:1.5px solid #E3DEF7;border-radius:8px;padding:6px 8px;font-size:11.5px">
                <input data-ci="${ci}" data-li="${li}" class="hp-navlink-url" placeholder="URL (ไม่บังคับ)" value="${l.url || ''}" style="flex:1;border:1.5px solid #E3DEF7;border-radius:8px;padding:6px 8px;font-size:11.5px">
                <button class="hp-navlink-remove" data-ci="${ci}" data-li="${li}" style="width:20px;height:20px;border-radius:50%;background:#DC2626;color:white;border:none;font-size:9px;cursor:pointer;flex-shrink:0">✕</button>
              </div>`).join('')}
          </div>
          <button class="hp-navlink-add btn-outline" data-ci="${ci}" style="font-size:11px;padding:6px 10px">➕ เพิ่มลิงก์</button>
        </div>`).join('') || '<p style="font-size:12px;color:var(--ink-400)">ยังไม่มีคอลัมน์</p>'}
    </div>
    <button class="btn-outline" onclick="addFooterNavColumn()">➕ เพิ่มคอลัมน์</button>

    <div style="margin-top:24px;border-top:1px solid #F1EEFB;padding-top:18px">
      <button class="btn" onclick="saveHomepageSettings()">บันทึกและแสดงผลในหน้าแรก</button>
    </div>
  `;

  // ---- banners ----
  document.getElementById('hp-banner-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadBrandingImage(file);
      homepageDraft.banners.push({ imageUrl: url, linkUrl: '' });
      renderHomepageTab();
    } catch (err) { showToastA(err.message); }
  });
  document.getElementById('hp-banners').addEventListener('click', (e) => {
    const btn = e.target.closest('.hp-banner-remove');
    if (!btn) return;
    homepageDraft.banners.splice(Number(btn.dataset.idx), 1);
    renderHomepageTab();
  });
  document.querySelectorAll('.hp-banner-link').forEach((inp) => {
    inp.addEventListener('input', () => { homepageDraft.banners[Number(inp.dataset.idx)].linkUrl = inp.value; });
  });

  // ---- promo image cards ----
  document.querySelectorAll('.hp-promocard-title').forEach((inp) => {
    inp.addEventListener('input', () => { homepageDraft.promoCards[Number(inp.dataset.idx)].title = inp.value; });
  });
  document.querySelectorAll('.hp-promocard-link').forEach((inp) => {
    inp.addEventListener('input', () => { homepageDraft.promoCards[Number(inp.dataset.idx)].linkUrl = inp.value; });
  });
  let promoCardUploadIdx = null;
  document.querySelectorAll('.hp-promocard-upload-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      promoCardUploadIdx = Number(btn.dataset.idx);
      document.getElementById('hp-promocard-file').click();
    });
  });
  document.getElementById('hp-promocard-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || promoCardUploadIdx === null) return;
    try {
      const url = await uploadBrandingImage(file);
      homepageDraft.promoCards[promoCardUploadIdx].imageUrl = url;
      renderHomepageTab();
    } catch (err) { showToastA(err.message); }
  });

  // ---- stats ----
  document.querySelectorAll('.hp-stat-icon').forEach((sel) => {
    sel.addEventListener('change', () => { homepageDraft.stats[Number(sel.dataset.idx)].icon = sel.value; });
  });
  document.querySelectorAll('.hp-stat-value').forEach((inp) => {
    inp.addEventListener('input', () => { homepageDraft.stats[Number(inp.dataset.idx)].value = inp.value; });
  });
  document.querySelectorAll('.hp-stat-label').forEach((inp) => {
    inp.addEventListener('input', () => { homepageDraft.stats[Number(inp.dataset.idx)].label = inp.value; });
  });

  // ---- category tabs ----
  document.querySelectorAll('.hp-cattab-label').forEach((inp) => {
    inp.addEventListener('input', () => { homepageDraft.categoryTabs[Number(inp.dataset.idx)].label = inp.value; });
  });
  document.querySelectorAll('.hp-cattab-icon-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const fileInput = document.getElementById('hp-cattab-file');
      fileInput.onchange = async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        try {
          const url = await uploadBrandingImage(file);
          homepageDraft.categoryTabs[idx].iconUrl = url;
          renderHomepageTab();
        } catch (err) { showToastA(err.message); }
      };
      fileInput.click();
    });
  });
  document.querySelectorAll('.hp-cattab-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      homepageDraft.categoryTabs.splice(Number(btn.dataset.idx), 1);
      renderHomepageTab();
    });
  });

  // ---- popular category pills ("หมวดหมู่ยอดนิยม" on the home page) ----
  document.getElementById('hp-popcats-title').addEventListener('input', (e) => { homepageDraft.popularCatsTitle = e.target.value; });
  document.getElementById('hp-popcats-subtitle').addEventListener('input', (e) => { homepageDraft.popularCatsSubtitle = e.target.value; });
  document.querySelectorAll('.hp-popcat-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      homepageDraft.popularCatIds.splice(Number(btn.dataset.idx), 1);
      renderHomepageTab();
    });
  });

  // ---- top-rated products ("สินค้ายอดนิยม" on the home page) ----
  document.getElementById('hp-toprated-title').addEventListener('input', (e) => { homepageDraft.topRatedTitle = e.target.value; });
  document.getElementById('hp-toprated-subtitle').addEventListener('input', (e) => { homepageDraft.topRatedSubtitle = e.target.value; });
  document.getElementById('hp-toprated-count').addEventListener('input', (e) => { homepageDraft.topRatedCount = e.target.value; });

  // ---- shipping logos ----
  document.getElementById('hp-shipping-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadBrandingImage(file);
      homepageDraft.shippingLogos.push({ url });
      renderHomepageTab();
    } catch (err) { showToastA(err.message); }
  });
  document.getElementById('hp-shipping-logos').addEventListener('click', (e) => {
    const btn = e.target.closest('.hp-ship-remove');
    if (!btn) return;
    homepageDraft.shippingLogos.splice(Number(btn.dataset.idx), 1);
    renderHomepageTab();
  });

  // ---- footer about sections ----
  document.querySelectorAll('.hp-about-heading').forEach((inp) => {
    inp.addEventListener('input', () => { homepageDraft.footerAboutSections[Number(inp.dataset.idx)].heading = inp.value; });
  });
  document.querySelectorAll('.hp-about-body').forEach((ta) => {
    ta.addEventListener('input', () => { homepageDraft.footerAboutSections[Number(ta.dataset.idx)].body = ta.value; });
  });
  document.getElementById('hp-about-sections').addEventListener('click', (e) => {
    const btn = e.target.closest('.hp-about-remove');
    if (!btn) return;
    homepageDraft.footerAboutSections.splice(Number(btn.dataset.idx), 1);
    renderHomepageTab();
  });

  // ---- footer campaign date pills ----
  document.querySelectorAll('.hp-campaign-label').forEach((inp) => {
    inp.addEventListener('input', () => { homepageDraft.footerCampaignDates[Number(inp.dataset.idx)].label = inp.value; });
  });
  document.querySelectorAll('.hp-campaign-hl').forEach((cb) => {
    cb.addEventListener('change', () => { homepageDraft.footerCampaignDates[Number(cb.dataset.idx)].highlight = cb.checked; });
  });
  document.getElementById('hp-campaign-dates').addEventListener('click', (e) => {
    const btn = e.target.closest('.hp-campaign-remove');
    if (!btn) return;
    homepageDraft.footerCampaignDates.splice(Number(btn.dataset.idx), 1);
    renderHomepageTab();
  });

  // ---- footer nav columns ----
  document.querySelectorAll('.hp-navcol-title').forEach((inp) => {
    inp.addEventListener('input', () => { homepageDraft.footerNavColumns[Number(inp.dataset.ci)].title = inp.value; });
  });
  document.getElementById('hp-nav-cols').addEventListener('click', (e) => {
    const removeCol = e.target.closest('.hp-navcol-remove');
    if (removeCol) { homepageDraft.footerNavColumns.splice(Number(removeCol.dataset.ci), 1); renderHomepageTab(); return; }
    const addLink = e.target.closest('.hp-navlink-add');
    if (addLink) {
      const ci = Number(addLink.dataset.ci);
      (homepageDraft.footerNavColumns[ci].links = homepageDraft.footerNavColumns[ci].links || []).push({ label: '', url: '' });
      renderHomepageTab();
      return;
    }
    const removeLink = e.target.closest('.hp-navlink-remove');
    if (removeLink) {
      const ci = Number(removeLink.dataset.ci), li = Number(removeLink.dataset.li);
      homepageDraft.footerNavColumns[ci].links.splice(li, 1);
      renderHomepageTab();
    }
  });
  document.querySelectorAll('.hp-navlink-label').forEach((inp) => {
    inp.addEventListener('input', () => { homepageDraft.footerNavColumns[Number(inp.dataset.ci)].links[Number(inp.dataset.li)].label = inp.value; });
  });
  document.querySelectorAll('.hp-navlink-url').forEach((inp) => {
    inp.addEventListener('input', () => { homepageDraft.footerNavColumns[Number(inp.dataset.ci)].links[Number(inp.dataset.li)].url = inp.value; });
  });
}

function addFooterAboutSection() {
  homepageDraft.footerAboutSections.push({ heading: 'หัวข้อใหม่', body: '' });
  renderHomepageTab();
}

function addFooterCampaignDate() {
  homepageDraft.footerCampaignDates.push({ label: '', highlight: false });
  renderHomepageTab();
}

function addFooterNavColumn() {
  homepageDraft.footerNavColumns.push({ title: 'คอลัมน์ใหม่', links: [] });
  renderHomepageTab();
}

function addHomepageCategoryTab() {
  homepageDraft.categoryTabs.push({ iconUrl: '', label: 'แท็บใหม่' });
  renderHomepageTab();
}

function addPopularCategoryPill() {
  const sel = document.getElementById('hp-popcats-add');
  const id = Number(sel.value);
  if (!id) return;
  homepageDraft.popularCatIds.push(id);
  renderHomepageTab();
}

async function saveHomepageSettings() {
  const d = homepageDraft;
  d.ctaTitle = document.getElementById('hp-cta-title').value.trim();
  d.ctaSubtitle = document.getElementById('hp-cta-subtitle').value.trim();
  d.seoHtml = document.getElementById('hp-seo-html').value;
  d.footerAboutTitle = document.getElementById('hp-footer-about-title').value.trim();
  d.popularCatsTitle = document.getElementById('hp-popcats-title').value.trim();
  d.popularCatsSubtitle = document.getElementById('hp-popcats-subtitle').value.trim();
  d.topRatedTitle = document.getElementById('hp-toprated-title').value.trim();
  d.topRatedSubtitle = document.getElementById('hp-toprated-subtitle').value.trim();
  d.topRatedCount = document.getElementById('hp-toprated-count').value.trim();
  try {
    await api('/settings', { method: 'PATCH', body: {
      home_banners: JSON.stringify(d.banners),
      promo_image_cards: JSON.stringify(d.promoCards),
      home_stats: JSON.stringify(d.stats),
      home_category_tabs: JSON.stringify(d.categoryTabs),
      home_cta_title: d.ctaTitle,
      home_cta_subtitle: d.ctaSubtitle,
      home_seo_html: d.seoHtml,
      shipping_logos: JSON.stringify(d.shippingLogos),
      home_popular_cats_title: d.popularCatsTitle,
      home_popular_cats_subtitle: d.popularCatsSubtitle,
      home_popular_cat_ids: JSON.stringify(d.popularCatIds),
      home_top_rated_title: d.topRatedTitle,
      home_top_rated_subtitle: d.topRatedSubtitle,
      home_top_rated_count: d.topRatedCount,
      footer_about_title: d.footerAboutTitle,
      footer_about_sections: JSON.stringify(d.footerAboutSections),
      footer_campaign_dates: JSON.stringify(d.footerCampaignDates),
      footer_nav_columns: JSON.stringify(d.footerNavColumns),
    } });
    showToastA('บันทึกหน้าแรกเรียบร้อยแล้ว ลูกค้าจะเห็นการเปลี่ยนแปลงทันที');
  } catch (err) { showToastA(err.message); }
}

/* ============ Customer Profile Page CMS (Settings > หน้าโปรไฟล์ลูกค้า) ============ */
// Manages profile_menu_items — the quick-link rows on the customer app's profile page
// (ข้อมูลส่วนตัว, กระเป๋าเงิน, ออกจากระบบ ฯลฯ). Everything here is addable/removable/
// editable: icon, label, and where it links to (an internal page or a custom URL).
// The rest of the profile page (personal-info card, footer nav/payment/shipping logos)
// reuses the exact same data as "หน้าแรก" above, so it's already managed from that tab.
function renderCustomerProfileTab() {
  const el = document.getElementById('settings-content');
  const items = profileMenuDraft;

  el.innerHTML = `
    <div class="p-head"><h3>เมนูลัดในหน้าโปรไฟล์ลูกค้า</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">รายการเมนูที่แสดงในหน้าโปรไฟล์ของลูกค้า (ใต้ข้อมูลส่วนตัว) — เพิ่ม ลบ แก้ไข หรือจัดลำดับได้อิสระ</p>
    <div id="pm-menu-items" style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
      ${items.map((it, i) => `
        <div class="pm-item" data-idx="${i}" style="border:1.5px solid #E3DEF7;border-radius:12px;padding:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <input data-idx="${i}" class="pm-icon" value="${it.icon || ''}" placeholder="🧾" style="width:44px;text-align:center;border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 4px;font-size:15px">
          <input data-idx="${i}" class="pm-label" value="${it.label || ''}" placeholder="ข้อความเมนู" style="flex:1;min-width:120px;border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 9px;font-size:12.5px;font-weight:700">
          <select data-idx="${i}" class="pm-target" style="border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 8px;font-size:12px">
            ${PROFILE_MENU_TARGET_OPTIONS.map(o => `<option value="${o.v}" ${(!PROFILE_MENU_TARGET_OPTIONS.some(x => x.v === it.target) && o.v === '__url__') || o.v === it.target ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
          <input data-idx="${i}" class="pm-url" value="${!PROFILE_MENU_TARGET_OPTIONS.some(x => x.v === it.target) ? (it.target || '') : ''}" placeholder="https://..." style="flex:1;min-width:140px;border:1.5px solid #E3DEF7;border-radius:8px;padding:7px 9px;font-size:12px;${PROFILE_MENU_TARGET_OPTIONS.some(x => x.v === it.target) ? 'display:none' : ''}">
          <label style="font-size:10.5px;color:var(--ink-400);display:flex;align-items:center;gap:3px;cursor:pointer">
            <input type="checkbox" data-idx="${i}" class="pm-danger" ${it.danger ? 'checked' : ''}> สีแดง (เช่น ออกจากระบบ)
          </label>
          <button class="pm-remove" data-idx="${i}" style="width:26px;height:26px;border-radius:50%;background:#DC2626;color:white;border:none;font-size:11px;cursor:pointer;flex-shrink:0">✕</button>
          <div style="width:100%;display:flex;gap:4px">
            <button class="pm-up" data-idx="${i}" ${i===0?'disabled':''} style="border:1.5px solid #E3DEF7;background:white;border-radius:6px;font-size:10px;padding:3px 8px;cursor:pointer">▲ ขึ้น</button>
            <button class="pm-down" data-idx="${i}" ${i===items.length-1?'disabled':''} style="border:1.5px solid #E3DEF7;background:white;border-radius:6px;font-size:10px;padding:3px 8px;cursor:pointer">▼ ลง</button>
          </div>
        </div>`).join('') || '<p style="font-size:12px;color:var(--ink-400)">ยังไม่มีเมนู — ลูกค้าจะเห็นเมนูเริ่มต้นจนกว่าจะเพิ่มที่นี่</p>'}
    </div>
    <button class="btn-outline" onclick="addProfileMenuItem()">➕ เพิ่มเมนู</button>

    <div style="margin-top:24px;border-top:1px solid #F1EEFB;padding-top:18px">
      <button class="btn" onclick="saveCustomerProfileSettings()">บันทึกและแสดงผลในหน้าโปรไฟล์</button>
    </div>
  `;

  el.querySelectorAll('.pm-icon').forEach(inp => inp.addEventListener('input', (e) => {
    profileMenuDraft[e.target.dataset.idx].icon = e.target.value;
  }));
  el.querySelectorAll('.pm-label').forEach(inp => inp.addEventListener('input', (e) => {
    profileMenuDraft[e.target.dataset.idx].label = e.target.value;
  }));
  el.querySelectorAll('.pm-danger').forEach(inp => inp.addEventListener('change', (e) => {
    profileMenuDraft[e.target.dataset.idx].danger = e.target.checked;
  }));
  el.querySelectorAll('.pm-target').forEach(sel => sel.addEventListener('change', (e) => {
    const i = e.target.dataset.idx;
    if (e.target.value === '__url__') {
      profileMenuDraft[i].target = '';
    } else {
      profileMenuDraft[i].target = e.target.value;
    }
    renderCustomerProfileTab();
  }));
  el.querySelectorAll('.pm-url').forEach(inp => inp.addEventListener('input', (e) => {
    profileMenuDraft[e.target.dataset.idx].target = e.target.value;
  }));
  el.querySelectorAll('.pm-remove').forEach(btn => btn.addEventListener('click', (e) => {
    profileMenuDraft.splice(e.target.dataset.idx, 1);
    renderCustomerProfileTab();
  }));
  el.querySelectorAll('.pm-up').forEach(btn => btn.addEventListener('click', (e) => {
    const i = Number(e.target.dataset.idx);
    if (i > 0) [profileMenuDraft[i - 1], profileMenuDraft[i]] = [profileMenuDraft[i], profileMenuDraft[i - 1]];
    renderCustomerProfileTab();
  }));
  el.querySelectorAll('.pm-down').forEach(btn => btn.addEventListener('click', (e) => {
    const i = Number(e.target.dataset.idx);
    if (i < profileMenuDraft.length - 1) [profileMenuDraft[i + 1], profileMenuDraft[i]] = [profileMenuDraft[i], profileMenuDraft[i + 1]];
    renderCustomerProfileTab();
  }));
}

function addProfileMenuItem() {
  profileMenuDraft.push({ icon: '🔗', label: 'เมนูใหม่', target: 'help-centre' });
  renderCustomerProfileTab();
}

async function saveCustomerProfileSettings() {
  try {
    await api('/settings', { method: 'PATCH', body: {
      profile_menu_items: JSON.stringify(profileMenuDraft),
    } });
    showToastA('บันทึกเมนูหน้าโปรไฟล์เรียบร้อยแล้ว ลูกค้าจะเห็นการเปลี่ยนแปลงทันที');
  } catch (err) { showToastA(err.message); }
}

/* ============ Membership: VIP tiers & referral reward ============ */
function renderMembershipTab() {
  const el = document.getElementById('settings-content');
  const d = membershipDraft;
  el.innerHTML = `
    <div class="p-head"><h3>ระดับสมาชิก (VIP)</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">
      กำหนดชื่อ ไอคอน และยอดใช้จ่ายสะสมขั้นต่ำของแต่ละระดับ — หน้าโปรไฟล์/กระเป๋าเงินของลูกค้าจะคำนวณระดับและแถบความคืบหน้าให้อัตโนมัติตามค่านี้
    </p>
    <div id="vip-tier-rows">
      ${d.tiers.map((t, i) => `
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <input class="vip-tier-icon" data-idx="${i}" value="${t.icon}" style="width:52px;text-align:center;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 6px">
          <input class="vip-tier-name" data-idx="${i}" value="${t.name}" placeholder="ชื่อระดับ" style="flex:1;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px">
          <input class="vip-tier-min" data-idx="${i}" type="number" value="${t.minSpend}" placeholder="ยอดใช้จ่ายขั้นต่ำ (บาท)" style="width:170px;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px">
          <button class="btn-outline vip-tier-remove" data-idx="${i}" style="padding:8px 10px">🗑️</button>
        </div>`).join('')}
    </div>
    <button class="btn-outline" onclick="addVipTier()">+ เพิ่มระดับสมาชิก</button>

    <div class="p-head" style="margin-top:22px;border-top:1px solid #F1EEFB;padding-top:18px"><h3>โปรแกรมแนะนำเพื่อน</h3></div>
    <p style="font-size:12px;color:var(--ink-400);margin-top:0">จำนวนเงินที่ลูกค้าได้รับเข้ากระเป๋าเงินทันทีเมื่อเพื่อนที่ใช้รหัสแนะนำสมัครสมาชิกสำเร็จ</p>
    <div class="field" style="max-width:220px">
      <label style="font-size:12px;font-weight:700;color:var(--ink-600);display:block;margin-bottom:6px">ยอดโบนัส (บาท)</label>
      <input id="mb-referral-reward" type="number" value="${d.referralReward}" style="width:100%;border:1.5px solid #E3DEF7;border-radius:10px;padding:10px 12px">
    </div>

    <div style="border-top:1px solid #F1EEFB;padding-top:18px;margin-top:20px">
      <button class="btn" onclick="saveMembershipSettings()">บันทึกการตั้งค่าสมาชิก</button>
    </div>
  `;

  document.querySelectorAll('.vip-tier-icon').forEach((inp) => {
    inp.addEventListener('input', () => { membershipDraft.tiers[Number(inp.dataset.idx)].icon = inp.value; });
  });
  document.querySelectorAll('.vip-tier-name').forEach((inp) => {
    inp.addEventListener('input', () => { membershipDraft.tiers[Number(inp.dataset.idx)].name = inp.value; });
  });
  document.querySelectorAll('.vip-tier-min').forEach((inp) => {
    inp.addEventListener('input', () => { membershipDraft.tiers[Number(inp.dataset.idx)].minSpend = Number(inp.value) || 0; });
  });
  document.querySelectorAll('.vip-tier-remove').forEach((btn) => {
    btn.addEventListener('click', () => { membershipDraft.tiers.splice(Number(btn.dataset.idx), 1); renderMembershipTab(); });
  });
}

function addVipTier() {
  membershipDraft.tiers.push({ name: 'ระดับใหม่', icon: '⭐', minSpend: 0 });
  renderMembershipTab();
}

async function saveMembershipSettings() {
  const d = membershipDraft;
  d.referralReward = document.getElementById('mb-referral-reward').value;
  // Keep tiers sorted by minSpend so the customer app's progress bar always makes sense.
  const tiers = [...d.tiers].sort((a, b) => a.minSpend - b.minSpend);
  try {
    await api('/settings', { method: 'PATCH', body: {
      vip_tiers: JSON.stringify(tiers),
      referral_reward: d.referralReward,
    } });
    showToastA('บันทึกการตั้งค่าสมาชิกเรียบร้อยแล้ว ลูกค้าจะเห็นการเปลี่ยนแปลงทันที');
  } catch (err) { showToastA(err.message); }
}

async function saveBrandingSettings() {
  const appName = document.getElementById('branding-app-name').value.trim();
  const logoPreview = document.getElementById('branding-logo-preview');
  const logoUrl = logoPreview.dataset.url !== undefined ? logoPreview.dataset.url : (logoPreview.querySelector('img')?.src || '');
  const homeLogoPreview = document.getElementById('branding-home-logo-preview');
  const homeLogoUrl = homeLogoPreview.dataset.url !== undefined ? homeLogoPreview.dataset.url : (homeLogoPreview.querySelector('img')?.src || '');
  const primaryColor = document.getElementById('branding-color-primary').value;
  const secondaryColor = document.getElementById('branding-color-secondary').value;
  const font = document.getElementById('branding-font').value;
  const promptpayId = document.getElementById('branding-promptpay-id').value.trim();
  const promptpayName = document.getElementById('branding-promptpay-name').value.trim();

  try {
    const updated = await api('/settings', { method: 'PATCH', body: {
      store_name: appName || 'Lazmall',
      app_logo_url: logoUrl,
      home_logo_url: homeLogoUrl,
      theme_primary_color: primaryColor,
      theme_secondary_color: secondaryColor,
      theme_font: font,
      promptpay_id: promptpayId,
      promptpay_name: promptpayName,
    } });
    applyAdminBranding(updated); // update this tab's own title/favicon immediately
    showToastA('บันทึกการตั้งค่าแบรนด์เรียบร้อยแล้ว');
  } catch (err) { showToastA(err.message); }
}

async function saveAiSettings() {
  const nameEl = document.getElementById('ai-agent-name');
  const autoEl = document.getElementById('ai-auto-switch');
  const titleEl = document.getElementById('ai-agent-title');
  const greetingEl = document.getElementById('ai-agent-greeting');
  const skinSel = document.querySelector('#swatch-skin .selected');
  const hairSel = document.querySelector('#swatch-hair .selected');
  const uniformSel = document.querySelector('#swatch-uniform .selected');
  const csIcons = document.querySelectorAll('.ai-cs-icon');
  const csLabels = document.querySelectorAll('.ai-cs-label');
  const csValues = document.querySelectorAll('.ai-cs-value');
  const csSubs = document.querySelectorAll('.ai-cs-sub');
  const STAT_COLORS = ['#3B82F6', '#F59E0B', '#16A34A'];
  const chatStats = Array.from(csIcons).map((_, i) => ({
    icon: csIcons[i].value.trim(), label: csLabels[i].value.trim(),
    value: csValues[i].value.trim(), sub: csSubs[i].value.trim(), color: STAT_COLORS[i] || '#3B82F6',
  })).filter(s => s.icon || s.label || s.value);
  try {
    await api('/settings', { method: 'PATCH', body: {
      agent_name: nameEl.value.trim() || 'เจ้าหน้าที่ฝ่ายบริการ',
      auto_switch: autoEl.checked ? 'on' : 'off',
      agent_title: (titleEl.value || '').trim(),
      agent_greeting: (greetingEl.value || '').trim(),
      chat_welcome_messages: JSON.stringify(adminAiWelcomeDraft.filter(m => m && (m.text || m.imageUrl))),
      chat_header_stats: JSON.stringify(chatStats),
      ...(skinSel ? { avatar_skin_tone: skinSel.dataset.value } : {}),
      ...(hairSel ? { avatar_hair_color: hairSel.dataset.value } : {}),
      ...(uniformSel ? { avatar_uniform_color: uniformSel.dataset.value } : {}),
    }});
    stopAvatarPreview();
    adminAiWelcomeDraft = null; // discard draft so the next visit to this tab re-loads the freshly saved data
    showToastA('บันทึกการตั้งค่าเรียบร้อยแล้ว');
  } catch (e) { showToastA(e.message); }
}

function addWelcomeMessage() {
  adminAiWelcomeDraft.push({ text: '', imageUrl: '' });
  selectSettingsTab('ai');
}

/* ============ Chart (simple SVG line chart, no libs) ============ */
function drawChart(svgId, data, labels) {
  const svg = document.getElementById(svgId);
  const w = 560, h = 190, pad = 30;
  const max = Math.max(...data, 1) * 1.2;
  const stepX = (w - pad * 2) / Math.max(data.length - 1, 1);
  const points = data.map((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (v / max) * (h - pad * 2);
    return [x, y];
  });
  const path = points.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ');
  const area = path + ` L${points[points.length-1][0]},${h-pad} L${points[0][0]},${h-pad} Z`;

  let gridLines = '';
  for (let i = 0; i <= 3; i++) {
    const y = pad + i * ((h - pad * 2) / 3);
    gridLines += `<line x1="${pad}" y1="${y}" x2="${w-pad}" y2="${y}" stroke="#F1EEFB" stroke-width="1"/>`;
  }
  const dots = points.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="#6C3CE9" stroke="white" stroke-width="2"><title>${labels && labels[i] ? labels[i] : ''}: ${data[i]}</title></circle>`).join('');

  svg.innerHTML = `
    <defs>
      <linearGradient id="grad-${svgId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#7C5CFC" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#7C5CFC" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${gridLines}
    <path d="${area}" fill="url(#grad-${svgId})"/>
    <path d="${path}" fill="none" stroke="#6C3CE9" stroke-width="2.5"/>
    ${dots}
  `;
}

/* ============ Toast ============ */
function showToastA(msg) {
  const t = document.getElementById('toast-a');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

// Short "ปี๊ด" beep played once per notification (new ticket/order, wallet/withdraw
// activity, etc.) while the admin panel is open — same as the customer app's, kept
// as a duplicate small helper rather than a shared import since admin and customer
// are separate static sites with no shared JS bundle.
function playNotifSoundA() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.16, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.28);
  } catch (e) { /* audio blocked/unavailable — non-critical */ }
}

/* ============ PWA register ============ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // updateViaCache:'none' stops the browser's own HTTP cache from serving a
    // stale sw.js, so every check below actually reaches the server.
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
      // Re-check for a new version whenever the tab regains focus, plus a
      // periodic safety-net check for long-lived open tabs.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {});
  });

  // Once a new service worker takes control, this tab's already-loaded
  // assets are stale — reload once, automatically, so admins see the update
  // immediately without ever needing to clear their cache.
  let swRefreshedA = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshedA) return;
    swRefreshedA = true;
    window.location.reload();
  });
}
