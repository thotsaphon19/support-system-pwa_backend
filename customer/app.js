/* ============ Config & API helper ============ */
const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.API_BASE) || 'http://localhost:4000/api';
const SOCKET_URL = (window.APP_CONFIG && window.APP_CONFIG.SOCKET_URL) || 'http://localhost:4000';

function getToken() { return localStorage.getItem('supportsys_token'); }
function setToken(t) { localStorage.setItem('supportsys_token', t); }
function clearToken() { localStorage.removeItem('supportsys_token'); }
function getRefreshToken() { return localStorage.getItem('supportsys_refresh_token'); }
function setRefreshToken(t) { localStorage.setItem('supportsys_refresh_token', t); }
function clearRefreshToken() { localStorage.removeItem('supportsys_refresh_token'); }

// Access tokens are short-lived (15m). When one expires mid-session, silently trade the
// refresh token for a new pair and retry the request once — the user never has to log in
// again as long as the refresh token itself is still valid (30 days by default).
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
    doLogout();
  }
  if (!res.ok) throw new Error((data && data.error) || 'เกิดข้อผิดพลาด (' + res.status + ')');
  return data;
}

/* ============ App state ============ */
let currentUser = null;
let currentView = 'login';
let pendingProductSearch = ''; // carries a search term typed on หน้าหลัก's top bar over to the products page
let socket = null;

let tickets = [];
let faq = [];
let announcements = [];
let chatMessages = [];
let settings = { call_mode: 'ai', agent_name: 'เจ้าหน้าที่ฝ่ายบริการ', auto_switch: 'on' };

/* ============ App branding (name / logo / theme / payment logos) ============ */
const FONT_STACKS = {
  'Noto Sans Thai': "'Noto Sans Thai', -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, sans-serif",
  'Sarabun': "'Sarabun', -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, sans-serif",
  'Prompt': "'Prompt', -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, sans-serif",
  'Kanit': "'Kanit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, sans-serif",
  'Mitr': "'Mitr', -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, sans-serif",
  'IBM Plex Sans Thai': "'IBM Plex Sans Thai', -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, sans-serif",
};

function applyBranding(s) {
  if (!s) return;
  const root = document.documentElement.style;

  if (s.theme_primary_color) {
    root.setProperty('--purple-600', s.theme_primary_color);
    root.setProperty('--purple-500', s.theme_primary_color);
    root.setProperty('--brand-primary', s.theme_primary_color);
  }
  if (s.theme_secondary_color) {
    root.setProperty('--pink-500', s.theme_secondary_color);
    root.setProperty('--brand-secondary', s.theme_secondary_color);
  }
  if (s.theme_font && FONT_STACKS[s.theme_font]) {
    let link = document.getElementById('branding-font-link');
    if (!link) {
      link = document.createElement('link');
      link.id = 'branding-font-link';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(s.theme_font)}:wght@400;600;700;800&display=swap`;
    root.setProperty('--app-font', FONT_STACKS[s.theme_font]);
    document.body.style.fontFamily = 'var(--app-font)';
  }
  if (s.store_name) {
    document.title = s.store_name;
    document.querySelectorAll('.brand-name-dynamic').forEach(el => { el.textContent = s.store_name; });
  }
  if (s.app_logo_url) {
    document.querySelectorAll('.brand-logo-dynamic').forEach(el => {
      el.classList.add('has-logo-img'); // drops the placeholder border/background — see style.css
      el.innerHTML = `<img src="${s.app_logo_url}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
    });
  }
  // Shop-page header logo: independent from the login-screen logo above, so a store
  // can brand its storefront header differently than its login/splash screen. Falls
  // back to the app logo if no dedicated home-page logo has been uploaded yet.
  const homeLogoUrl = s.home_logo_url || s.app_logo_url;
  if (homeLogoUrl) {
    document.querySelectorAll('.brand-logo-home-dynamic').forEach(el => {
      el.classList.add('has-logo-img');
      el.innerHTML = `<img src="${homeLogoUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
    });
  }
  // Browser tab icon (favicon) + address-bar icon — falls back to the default app icon
  // if no logo has been uploaded yet, or if it was removed.
  const faviconEl = document.getElementById('app-favicon');
  if (faviconEl) {
    faviconEl.removeAttribute('type'); // let the browser sniff it from the Content-Type header
    faviconEl.href = s.app_logo_url || 'icons/icon-192.png';
  }
  let paymentLogos = [];
  try { paymentLogos = JSON.parse(s.payment_logos || '[]'); } catch (e) { paymentLogos = []; }
  if (paymentLogos.length) {
    const html = paymentLogos.map(p => `<div class="sf-badge sf-badge-img"><img src="${p.url}" alt="payment"></div>`).join('');
    ['sf-payment-badges', 'sf-payment-badges-p', 'pf-sf-payment-badges', 'sf-payment-badges-w', 'sf-payment-badges-t'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });
  }
}

async function loadPublicBranding() {
  try {
    const s = await api('/settings/public');
    applyBranding(s);
  } catch (e) { /* keep defaults */ }
}

/* ============ Shop (Lazmall) state ============ */
let shopProducts = [];
let shopCategories = [];
let selectedCategoryId = null;
let currentProductDetail = null;
let productDetailQty = 1;
let cartData = { items: [], total: 0, itemCount: 0 };
let ordersCache = [];

let callTimerInterval = null;
let callSeconds = 0;
let muted = false;
let speakerOn = true;
let callModeActive = 'ai';

/* ============ WebRTC state ============ */
// Falls back to STUN-only if the backend has no TURN configured or the request fails —
// calls will still work on most networks, just not ones with strict NAT/firewall rules.
async function getIceServers() {
  try {
    const data = await api('/turn-credentials');
    return data.iceServers;
  } catch (e) {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}
let pc = null;
let localStream = null;
let callActive = false;
let pendingIncomingCall = null;

/* ============ Bootstrap ============ */
// Parses the #social_login&token=...&refresh=..., #social_referral_required&draft=...,
// or #social_error&message=... fragment the backend redirects back to after a
// Google/Facebook/LINE login finishes. Returns true if it handled a social-login
// redirect (caller should stop its own bootstrap there).
function consumeSocialLoginRedirect() {
  const hash = window.location.hash || '';
  if (!hash.startsWith('#social_login') && !hash.startsWith('#social_error') && !hash.startsWith('#social_referral_required')) return false;

  const params = new URLSearchParams(hash.slice(1));
  // Strip the fragment from the URL so a page refresh doesn't replay it.
  history.replaceState(null, '', window.location.pathname + window.location.search);

  if (hash.startsWith('#social_error')) {
    showSystemAlert(params.get('message') || 'เข้าสู่ระบบไม่สำเร็จ', { type: 'error' });
    return true;
  }

  if (hash.startsWith('#social_referral_required')) {
    // Brand-new sign-up via LINE/Google/Facebook — the account isn't created yet.
    // Ask for a friend referral code once, then finish the sign-up.
    openSocialReferralGate(params.get('draft'));
    return true;
  }

  const token = params.get('token');
  const refresh = params.get('refresh');
  if (token && refresh) {
    setToken(token);
    setRefreshToken(refresh);
  }
  return true;
}

/* ============ Social sign-up referral gate (first login only) ============ */
let socialDraftToken = null;
function openSocialReferralGate(draftToken) {
  if (!draftToken) {
    showSystemAlert('เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่', { type: 'error' });
    go('login');
    return;
  }
  socialDraftToken = draftToken;
  document.getElementById('social-referral-code').value = '';
  document.getElementById('social-referral-error').style.display = 'none';
  document.getElementById('social-referral-overlay').style.display = 'flex';
}
function cancelSocialReferral() {
  socialDraftToken = null;
  document.getElementById('social-referral-overlay').style.display = 'none';
  go('login');
}
async function submitSocialReferral() {
  const referralCode = document.getElementById('social-referral-code').value.trim();
  const errEl = document.getElementById('social-referral-error');
  errEl.style.display = 'none';
  if (!referralCode) {
    errEl.textContent = 'กรุณากรอกรหัสแนะนำเพื่อน';
    errEl.style.display = 'block';
    return;
  }
  try {
    const data = await api('/auth/social/complete', { method: 'POST', body: { draftToken: socialDraftToken, referralCode } });
    setToken(data.token);
    setRefreshToken(data.refreshToken);
    currentUser = data.user;
    socialDraftToken = null;
    document.getElementById('social-referral-overlay').style.display = 'none';
    await afterLogin();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

const SOCIAL_PROVIDER_LABELS = { google: 'Google', facebook: 'Facebook', line: 'LINE' };
let socialLoginStatus = {};

function startSocialLogin(provider) {
  const st = socialLoginStatus[provider];
  if (!st || !st.enabled) {
    showSystemAlert('ยังไม่เปิดใช้งานการเข้าสู่ระบบด้วย ' + (SOCIAL_PROVIDER_LABELS[provider] || provider) + ' กรุณาติดต่อผู้ดูแลระบบ', { type: 'error' });
    return;
  }
  window.location.href = API_BASE + '/auth/' + provider;
}

// Fetches which social providers are actually configured server-side (Admin > Settings >
// Social Login). Buttons always look the same (no greyed-out state) — startSocialLogin()
// above checks this before navigating, so an unconfigured button shows a clear message
// instead of the browser bouncing off to a dead end. Once an admin finishes configuring a
// provider, the very next page load (this function re-running) picks it up automatically.
async function applySocialLoginAvailability() {
  try {
    socialLoginStatus = await api('/auth/social/status');
  } catch (e) {
    socialLoginStatus = {};
  }
}

/* ============ System alert modal (success/error popups) ============ */
let systemAlertOnOk = null;
function showSystemAlert(message, opts = {}) {
  const { type = 'success', title = 'แจ้งเตือนระบบ', onOk = null } = opts;
  document.getElementById('system-alert-title').textContent = title;
  document.getElementById('system-alert-message').textContent = message;
  const iconEl = document.getElementById('system-alert-icon');
  iconEl.className = 'system-alert-icon' + (type === 'error' ? ' error' : '');
  iconEl.innerHTML = type === 'error'
    ? '<svg width="34" height="34" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'
    : '<svg width="38" height="38" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  systemAlertOnOk = typeof onOk === 'function' ? onOk : null;
  document.getElementById('system-alert-overlay').style.display = 'flex';
}
function closeSystemAlert() {
  document.getElementById('system-alert-overlay').style.display = 'none';
  const cb = systemAlertOnOk;
  systemAlertOnOk = null;
  if (cb) cb();
}

window.addEventListener('DOMContentLoaded', async () => {
  loadPublicBranding();
  buildBottomNav();
  applySocialLoginAvailability();
  setupChatImageUploader();

  const cameFromSocialLogin = consumeSocialLoginRedirect();

  const token = getToken();
  if (token) {
    try {
      currentUser = await api('/auth/me');
      await afterLogin();
      return;
    } catch (e) {
      clearToken();
      if (cameFromSocialLogin) showSystemAlert('เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่', { type: 'error' });
    }
  }
  go('login');
});

/* ============ Login ============ */
async function doLogin() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  try {
    const data = await api('/auth/login', { method: 'POST', body: { username, password } });
    setToken(data.token);
    setRefreshToken(data.refreshToken);
    currentUser = data.user;
    await afterLogin();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

/* ============ Register (multi-step wizard: name/username → password → referral) ============ */
let regStep = 1;
const REG_TOTAL_STEPS = 3;

function openRegisterForm() {
  regStep = 1;
  ['reg-name', 'reg-username', 'reg-password', 'reg-password-confirm', 'reg-referral'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  regRenderStep();
  go('register');
}

// Shows the current step's fields, updates the "ขั้นตอนที่ X/3" label + % + progress bar
// fill, and swaps the primary button's label to "สมัครสมาชิก" on the final step.
function regRenderStep() {
  for (let i = 1; i <= REG_TOTAL_STEPS; i++) {
    const el = document.getElementById('reg-step-' + i);
    if (el) el.style.display = i === regStep ? 'block' : 'none';
  }
  const percent = Math.round((regStep / REG_TOTAL_STEPS) * 100);
  document.getElementById('reg-step-label').textContent = `ขั้นตอนที่ ${regStep}/${REG_TOTAL_STEPS}`;
  document.getElementById('reg-step-percent').textContent = `${percent}%`;
  document.getElementById('reg-progress-fill').style.width = percent + '%';
  document.getElementById('reg-next-btn').textContent = regStep === REG_TOTAL_STEPS ? 'สมัครสมาชิก' : 'ต่อไป';
  document.getElementById('reg-back-btn').style.display = regStep === 1 ? 'none' : 'block';
  const errEl = document.getElementById('reg-error');
  errEl.style.display = 'none';
  errEl.textContent = '';
}

function regShowError(msg) {
  const errEl = document.getElementById('reg-error');
  errEl.textContent = msg;
  errEl.style.display = 'block';
}

// Validates only the fields on the step being left, so an error in step 2 doesn't block
// the user from seeing step 1 again etc.
function regValidateStep(step) {
  if (step === 1) {
    const name = document.getElementById('reg-name').value.trim();
    const username = document.getElementById('reg-username').value.trim();
    if (!name) { regShowError('กรุณากรอกชื่อและนามสกุล'); return false; }
    if (!username) { regShowError('กรุณากรอกชื่อผู้ใช้หรือเบอร์โทร'); return false; }
    return true;
  }
  if (step === 2) {
    const pw = document.getElementById('reg-password').value;
    const pw2 = document.getElementById('reg-password-confirm').value;
    if (pw.length < 6) { regShowError('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร'); return false; }
    if (pw !== pw2) { regShowError('รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน'); return false; }
    return true;
  }
  return true;
}

function regNext() {
  if (!regValidateStep(regStep)) return;
  if (regStep < REG_TOTAL_STEPS) {
    regStep++;
    regRenderStep();
  } else {
    doRegister();
  }
}

function regBack() {
  if (regStep <= 1) return;
  regStep--;
  regRenderStep();
}

async function doRegister() {
  const name = document.getElementById('reg-name').value.trim();
  const usernameRaw = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const referralCode = document.getElementById('reg-referral').value.trim();

  if (!referralCode) { regShowError('กรุณากรอกรหัสแนะนำเพื่อนก่อนสมัครสมาชิก'); return; }

  // Step 1's single field doubles as "username or phone" per the design — if what was
  // typed looks like a Thai mobile number, save it as the phone number too so it still
  // shows up correctly on the profile page later.
  const looksLikePhone = /^0\d{8,9}$/.test(usernameRaw);

  try {
    const data = await api('/auth/register', {
      method: 'POST',
      body: {
        name,
        username: usernameRaw,
        password,
        phone: looksLikePhone ? usernameRaw : undefined,
        referralCode,
      },
    });
    setToken(data.token);
    setRefreshToken(data.refreshToken);
    currentUser = data.user;
    await afterLogin();
  } catch (e) {
    // Jump back to whichever step the error actually concerns instead of stranding the
    // user on step 3 with a message about a field they can no longer see.
    if (/ชื่อผู้ใช้/.test(e.message)) { regStep = 1; regRenderStep(); }
    else if (/รหัสแนะนำ/.test(e.message)) { regStep = 3; regRenderStep(); }
    regShowError(e.message);
  }
}

async function afterLogin() {
  connectSocket();
  try { settings = await api('/settings'); applyBranding(settings); updateReferralRewardLabels(); } catch (e) { /* keep defaults */ }
  subscribeToPush().catch(() => { /* push is optional — never block the app on it */ });
  showSystemAlert('เข้าสู่ระบบสำเร็จ', { onOk: () => go('shop') });
}

// Keeps the "ชวนเพื่อน รับ ฿X" tiles (profile page + wallet page) showing the
// actual configured reward amount (settings.referral_reward — editable by admin,
// see routes/settings.js), instead of a hardcoded number that could drift out of
// sync with what customers actually receive.
function updateReferralRewardLabels() {
  const amount = Number(settings.referral_reward) || 50;
  ['pf-referral-reward-label', 'wallet-referral-reward-label'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = `ชวนเพื่อน รับ ฿${amount.toLocaleString()}`;
  });
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

function doLogout() {
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
  currentUser = null;
  go('login');
}

/* ============ Realtime (Socket.io) ============ */
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io(SOCKET_URL, { auth: { token: getToken() } });

  socket.on('chat:message', ({ message }) => {
    chatMessages.push(message);
    if (currentView === 'chat') renderChat();
    else showToast('ข้อความใหม่จากแอดมิน');
  });

  socket.on('ticket:update', (t) => {
    const idx = tickets.findIndex(x => x.id === t.id);
    if (idx >= 0) tickets[idx] = t; else tickets.unshift(t);
    if (currentView === 'history') renderHistory();
    if (currentView === 'report') renderReportList();
  });

  socket.on('settings:update', (s) => { settings = s; applyBranding(s); updateReferralRewardLabels(); });

  // New store-wide announcement posted by the admin — bump the badge live rather
  // than waiting for the next page load. If the customer already has the
  // notifications list open, refresh it in place too.
  socket.on('store-notification:new', () => {
    loadStoreNotifBadge();
    if (currentView === 'store-notifications') loadStoreNotifications();
    playNotifSound();
  });

  // Fired when an admin credits/debits this customer's wallet from the back office
  // (top-up, commission, bonus, or a deduction) — refreshes the balance live if the
  // customer already has the wallet page open, and always shows a toast.
  socket.on('wallet:update', ({ walletBalance, transaction }) => {
    if (currentView === 'wallet') loadWallet();
    if (currentView === 'profile') loadProfile();
    if (transaction && transaction.amount != null) {
      const amt = Number(transaction.amount);
      const sign = amt >= 0 ? '+' : '';
      showToast(`💰 ${transaction.description || 'ยอดเงินมีการปรับปรุง'} (${sign}฿${amt.toLocaleString()})`);
      playNotifSound();
    }
  });

  // Fired when an admin freezes this account — force an immediate logout rather
  // than waiting for the (short-lived) access token to expire on its own.
  socket.on('account:frozen', ({ message }) => {
    showToast(message || 'บัญชีของคุณถูกระงับการใช้งานชั่วคราว');
    playNotifSound();
    doLogout();
  });

  // Any personal/transactional notification (order, payment, shipping, ticket
  // update — wallet and account-status ones already get their own toast above via
  // wallet:update / account:frozen, so skip those here to avoid a duplicate toast;
  // this still refreshes the badge/list for them).
  socket.on('notification:new', (n) => {
    loadStoreNotifBadge();
    if (currentView === 'store-notifications') loadStoreNotifications();
    if (n.category !== 'wallet' && n.category !== 'account_status') {
      showToast(`${n.icon || '🔔'} ${n.title}`);
      playNotifSound();
    }
  });
  socket.on('order:update', (o) => {
    const i = ordersCache.findIndex(x => x.id === o.id);
    if (i >= 0) ordersCache[i] = o;
    if (currentView === 'orders') loadOrders();
    if (currentView === 'order-success' && document.getElementById('order-success-id').textContent.includes(o.id)) {
      renderOrderPaymentBox(document.getElementById('order-success-payment'), o);
    }
    if (o.payment_status === 'ชำระเงินแล้ว') showToast(`✅ ยืนยันการชำระเงินคำสั่งซื้อ ${o.id} แล้ว`);
  });

  socket.on('webrtc:incoming', ({ mode, from }) => {
    pendingIncomingCall = { mode, fromName: from.name };
    showIncomingCallBannerC(from.name);
  });
  socket.on('webrtc:offer', ({ sdp }) => {
    if (pendingIncomingCall) pendingIncomingCall.sdp = sdp;
  });

  socket.on('connect_error', async (err) => {
    if (err.message === 'unauthorized' && getRefreshToken()) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        socket.auth.token = getToken();
        socket.connect();
      }
    }
    /* otherwise backend is offline — app still usable read-only via last fetch */
  });
}

/* ============ Navigation ============ */
async function go(viewName) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById('view-' + viewName);
  if (el) el.classList.add('active');
  currentView = viewName;

  try {
    if (viewName === 'chat') await loadChat();
    if (viewName === 'report') await loadReportList();
    if (viewName === 'kb') await loadKB();
    if (viewName === 'announcements') await loadAnnouncements();
    if (viewName === 'history') await loadHistory();
    if (viewName === 'shop') await loadShop();
    if (viewName === 'products') await loadProducts();
    if (viewName === 'cart') await loadCart();
    if (viewName === 'checkout') await loadCheckout();
    if (viewName === 'orders') await loadOrders();
    if (viewName === 'wallet') await loadWallet();
    if (viewName === 'profile') await loadProfile();
    if (viewName === 'personal-info') await loadPersonalInfo();
    if (viewName === 'referral') await loadReferral();
    if (viewName === 'store-notifications') await loadStoreNotifications();
    if (viewName === 'bank-account') await loadBankAccount();
    if (viewName === 'withdraw') await loadWithdraw();
    if (viewName === 'topup') await loadTopup();
    if (viewName === 'help-centre') renderHelpTopics();
  } catch (e) {
    showToast(e.message || 'ไม่สามารถโหลดข้อมูลได้');
  }

  buildBottomNav();
  buildShopBottomNav();
  buildShopStickyNav();
  window.scrollTo(0, 0);
}

// Swaps the last item of the shop's sticky nav between "เข้าสู่ระบบ" (logged out)
// and "โปรไฟล์" (logged in) so it always reflects the current auth state.
function buildShopStickyNav() {
  const btn = document.getElementById('ssn-auth-item');
  if (!btn) return;
  btn.textContent = currentUser ? 'โปรไฟล์' : 'เข้าสู่ระบบ';
  btn.classList.toggle('active', currentView === 'profile');
}

// Shared bottom nav for the shop/home page and the profile page — both are top-level
// destinations a logged-in customer bounces between, so they share one nav bar with the
// "active" tab following currentView.
function buildShopBottomNav() {
  const icoHeart = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.9a5.4 5.4 0 0 0-7.6 0L12 6.1l-1.2-1.2a5.4 5.4 0 0 0-7.6 7.6l1.2 1.2L12 21.3l7.6-7.6 1.2-1.2a5.4 5.4 0 0 0 0-7.6z"/></svg>';
  const icoStore = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 4 4h16l1 5.5"/><path d="M3 9.5a2.2 2.2 0 0 0 4.4 0 2.2 2.2 0 0 0 4.4 0 2.2 2.2 0 0 0 4.4 0 2.2 2.2 0 0 0 4.4 0"/><path d="M4.5 9.7V20h15V9.7"/><path d="M9.5 20v-6h5v6"/></svg>';
  const icoChat = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9.5a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1.5a4 4 0 0 1-4 4h-.5l-2.3 2.1v-2.1H13a4 4 0 0 1-4-4v-1.5z"/><path d="M9 15a4 4 0 0 1-4-4H4a3.3 3.3 0 0 0-.8 2"/></svg>';
  const icoDoc = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5h8.5L19 7v14.5H6z"/><line x1="9" y1="10" x2="15.5" y2="10"/><line x1="9" y1="13.5" x2="15.5" y2="13.5"/><line x1="9" y1="17" x2="13" y2="17"/></svg>';
  const icoPerson = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 20.5c0-4.1 3.6-7.2 8-7.2s8 3.1 8 7.2"/></svg>';
  const items = [
    { v: 'shop', ico: icoHeart, label: 'หน้าหลัก' },
    { v: 'products', ico: icoStore, label: 'สินค้า' },
    { v: 'chat', ico: icoChat, label: 'แชทซัพพอต' },
    { v: 'withdraw', ico: icoDoc, label: 'ถอนเงิน' },
    { v: 'profile', ico: icoPerson, label: 'โปรไฟล์' },
  ];
  const html = items.map(it => `<button class="nav-btn ${currentView === it.v ? 'active' : ''}" onclick="go('${it.v}')"><span class="n-ico">${it.ico}</span>${it.label}</button>`).join('');
  ['bottom-nav-shop', 'bottom-nav-products', 'bottom-nav-profile', 'bottom-nav-withdraw', 'bottom-nav-topup'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
}

// Shared bottom nav for the report/kb/history support sub-pages.
function buildBottomNav() {
  const navHtml = (active) => `
    <button class="nav-btn" onclick="go('shop')"><span class="n-ico">🏠</span>หน้าหลัก</button>
    <button class="nav-btn ${active==='report'?'active':''}" onclick="go('report')"><span class="n-ico">📝</span>แจ้งปัญหา</button>
    <button class="nav-btn ${active==='kb'?'active':''}" onclick="go('kb')"><span class="n-ico">📚</span>คลังความรู้</button>
    <button class="nav-btn ${active==='history'?'active':''}" onclick="go('history')"><span class="n-ico">🕘</span>ประวัติ</button>
  `;
  ['report','kb','history'].forEach(v => {
    const elx = document.getElementById('bottom-nav-' + v);
    if (elx) elx.innerHTML = navHtml(v);
  });
}

const STATUS_META = {
  'รอดำเนินการ': { cls: 'status-wait', color: '#F0398C', icon: '📝' },
  'กำลังดำเนินการ': { cls: 'status-progress', color: '#F59E0B', icon: '⏳' },
  'เสร็จสิ้น': { cls: 'status-done', color: '#22C55E', icon: '✅' },
};

function emptyHtml(msg) {
  return `<div class="empty-state"><div class="e-ico">📭</div>${msg}</div>`;
}

function ticketCardHtml(t) {
  const meta = STATUS_META[t.status] || STATUS_META['รอดำเนินการ'];
  return `
    <div class="ticket-card" onclick="openTicket('${t.id}')">
      <div class="ticon" style="background:${meta.color}">${meta.icon}</div>
      <div class="tbody">
        <div class="ttitle">${t.title}</div>
        <div class="tmeta">${t.id} • ${formatDate(t.updated_at)}</div>
      </div>
      <span class="status-chip ${meta.cls}">${t.status}</span>
    </div>`;
}

function faqItemHtml(f) {
  return `<div class="faq-item" onclick='openFaqAlert(${f.id})'><span>${f.title}</span><span class="plus">+</span></div>`;
}
async function openFaqAlert(id) {
  try {
    const article = await api('/kb/' + id);
    alert(article.title + '\n\n' + article.body);
  } catch (e) { showToast(e.message); }
}

async function openTicket(id) {
  try {
    const t = await api('/tickets/' + id);
    document.getElementById('td-title').textContent = t.id;
    const meta = STATUS_META[t.status] || STATUS_META['รอดำเนินการ'];
    document.getElementById('td-body').innerHTML = `
      <div class="ticket-card" style="cursor:default">
        <div class="ticon" style="background:${meta.color}">${meta.icon}</div>
        <div class="tbody">
          <div class="ttitle">${t.title}</div>
          <div class="tmeta">อัปเดตล่าสุด ${formatDate(t.updated_at)}</div>
        </div>
        <span class="status-chip ${meta.cls}">${t.status}</span>
      </div>
      <div class="section-head"><h2>รายละเอียด</h2></div>
      <div class="kb-card"><p>${t.description || '-'}</p></div>
      <div class="section-head"><h2>ข้อมูลเพิ่มเติม</h2></div>
      <div class="kb-card">
        <p>ช่องทาง: ${t.channel} • ความเร่งด่วน: ${t.priority}</p>
        <p style="margin-top:8px">สถานะปัจจุบัน: <b>${t.status}</b> — เจ้าหน้าที่กำลังตรวจสอบคำร้องของคุณ หากมีข้อมูลเพิ่มเติมสามารถแชทสอบถามได้ทันที</p>
      </div>
      <button class="btn-secondary" onclick="go('chat')">แชทสอบถามเรื่องนี้</button>
    `;
    go('ticket-detail');
  } catch (e) { showToast(e.message); }
}

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

/* ============ Chat ============ */
async function loadChat() {
  renderChatHeader();
  const data = await api('/chat/me');
  chatMessages = data.messages;
  renderChat();
}

// Populates the chat header (agent photo, name, role badge, greeting) from
// Admin > ตั้งค่า > โหมดวิดีโอคอล. Falls back to sensible defaults if unset.
function renderChatHeader() {
  const nameEl = document.getElementById('chat-agent-name');
  const titleEl = document.getElementById('chat-agent-title');
  const greetEl = document.getElementById('chat-agent-greeting');
  const avatarEl = document.getElementById('chat-agent-avatar');
  if (nameEl) nameEl.textContent = settings.agent_name || 'เจ้าหน้าที่ฝ่ายบริการ';
  if (titleEl) titleEl.textContent = settings.agent_title || 'เจ้าหน้าที่ฝ่ายบริการลูกค้า';
  if (greetEl) greetEl.textContent = settings.agent_greeting || 'ยินดีให้บริการค่ะ มีอะไรให้ช่วยเหลือสอบถามได้เลยนะคะ';
  if (avatarEl) avatarEl.innerHTML = settings.agent_avatar_url ? `<img src="${escapeHtml(settings.agent_avatar_url)}" alt="">` : '🎧';
  renderChatStats();
}

// The quick-stat pills row under the chat header (Admin > ตั้งค่า > โหมดวิดีโอคอล >
// สถิติในหน้าแชท) has been removed from the customer-facing chat page per request.
// Kept as a no-op (instead of deleting entirely) so the admin setting/data stays
// intact and this can be re-enabled later without touching admin code.
function renderChatStats() {
  const el = document.getElementById('chat-stats-row');
  if (!el) return;
  el.style.display = 'none';
  el.innerHTML = '';
}

function renderChat() {
  const el = document.getElementById('chat-messages');
  const agentAvatarHtml = settings.agent_avatar_url
    ? `<img src="${escapeHtml(settings.agent_avatar_url)}" alt="">`
    : '🎧';

  // Welcome message(s) (Admin > ตั้งค่า > โหมดวิดีโอคอล > ข้อความต้อนรับอัตโนมัติ) are shown
  // as fixed messages pinned to the top of the chat every time it's opened — rendered here
  // directly from settings rather than stored in the database, so they always appear
  // regardless of how much real conversation history exists.
  let welcomeMsgs = [];
  try { welcomeMsgs = JSON.parse(settings.chat_welcome_messages || '[]'); } catch (e) { welcomeMsgs = []; }
  const welcomeHtml = welcomeMsgs.filter(m => m && (m.text || m.imageUrl)).map(m => `
    <div class="msg-row them">
      <div class="msg-avatar">${agentAvatarHtml}</div>
      <div>
        <div class="msg-bubble">
          ${m.imageUrl ? `<img class="msg-image" src="${escapeHtml(m.imageUrl)}" alt="">` : ''}
          ${m.text ? escapeHtml(m.text) : ''}
        </div>
      </div>
    </div>`).join('');

  const historyHtml = chatMessages.map(m => `
    <div class="msg-row ${m.sender_role === 'customer' ? 'me' : 'them'}">
      <div class="msg-avatar">${m.sender_role === 'customer' ? '🙂' : agentAvatarHtml}</div>
      <div>
        <div class="msg-bubble">
          ${m.image_url ? `<img class="msg-image" src="${escapeHtml(m.image_url)}" alt="">` : ''}
          ${m.text ? escapeHtml(m.text) : ''}
        </div>
        <span class="msg-time">${formatTime(m.created_at)}</span>
      </div>
    </div>`).join('');

  const combined = welcomeHtml + historyHtml;
  el.innerHTML = combined || emptyHtml('เริ่มการสนทนากับแอดมินได้เลย');
  el.scrollTop = el.scrollHeight;
}

function formatTime(iso) {
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d)) return '';
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

// Renders a product's real photo when one is set (image_url), falling back to the emoji
// icon only when no photo has been uploaded for that product yet.
function productMediaHtml(p, opts) {
  const icon = (p && p.icon) || '📦';
  const name = escapeHtml((p && p.name) || '');
  const eager = opts && opts.eager;
  if (p && p.image_url) {
    // Card grids lazy-load (there can be dozens off-screen); the product-detail hero
    // image is the first thing the user is looking at, so load it eagerly and flag it
    // high-priority so the browser fetches/decodes it right away instead of queuing it
    // behind lower-priority requests.
    const loadingAttr = eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
    return `<img class="prod-photo" src="${escapeHtml(p.image_url)}" alt="${name}" ${loadingAttr} decoding="async" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><span class="prod-fallback-icon" style="display:none">${icon}</span>`;
  }
  return `<span class="prod-fallback-icon">${icon}</span>`;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function sendMsg() {
  const input = document.getElementById('chat-text');
  const text = input.value.trim();
  if (!text || !socket) return;
  socket.emit('chat:send', { text });
  input.value = '';
}

// Wires the 📎 attach button: picks an image, uploads it to /upload/chat-image, then
// sends it as a chat message (with no text) so it shows up as an image bubble for both
// the customer and the admin viewing the conversation.
function setupChatImageUploader() {
  const input = document.getElementById('chat-image-input');
  if (!input) return;
  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const MAX_SIZE = 5 * 1024 * 1024;
    const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!ALLOWED.includes(file.type)) { showToast('รองรับเฉพาะไฟล์รูปภาพ JPG, PNG, WEBP หรือ GIF เท่านั้น'); input.value = ''; return; }
    if (file.size > MAX_SIZE) { showToast('ไฟล์ต้องมีขนาดไม่เกิน 5MB'); input.value = ''; return; }
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
      if (socket) socket.emit('chat:send', { imageUrl: data.url });
    } catch (err) {
      showToast(err.message || 'ส่งรูปภาพไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      input.value = '';
    }
  });
}

/* ============ Incoming call (admin-initiated) ============ */
function showIncomingCallBannerC(name) {
  document.getElementById('icbc-name').textContent = name || 'เจ้าหน้าที่ฝ่ายบริการ';
  document.getElementById('incoming-call-banner-c').style.display = 'flex';
}
function hideIncomingCallBannerC() {
  document.getElementById('incoming-call-banner-c').style.display = 'none';
}
function rejectIncomingCall() {
  if (socket) socket.emit('webrtc:reject', {});
  pendingIncomingCall = null;
  hideIncomingCallBannerC();
}
async function acceptIncomingCall() {
  const offer = pendingIncomingCall;
  hideIncomingCallBannerC();
  if (!offer || !offer.sdp) { showToast('ไม่พบสายเรียกเข้า (อาจถูกยกเลิกแล้ว)'); return; }

  go('call');
  callSeconds = 0;
  muted = false; speakerOn = true;
  callActive = false;
  document.getElementById('call-mute-btn').textContent = '🎙️';
  document.getElementById('call-speaker-btn').textContent = '🔊';
  document.getElementById('call-tag-text').textContent = 'กำลังเชื่อมต่อ...';
  document.getElementById('call-agent-name').textContent = offer.fromName || settings.agent_name || 'เจ้าหน้าที่ฝ่ายบริการ';
  document.getElementById('remote-video-fallback').style.display = 'flex';
  document.getElementById('remote-waiting-text').textContent = 'กำลังเชื่อมต่อสาย...';
  document.getElementById('remote-video-frame').classList.toggle('mode-ai', offer.mode === 'ai');
  document.getElementById('remote-video-frame').classList.toggle('mode-real', offer.mode !== 'ai');
  document.getElementById('live-badge').style.display = 'none';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    showToast('ไม่สามารถเข้าถึงกล้อง/ไมโครโฟนได้');
    if (socket) socket.emit('webrtc:reject', {});
    go('chat');
    return;
  }
  document.getElementById('call-local-video').srcObject = localStream;

  pc = new RTCPeerConnection({ iceServers: await getIceServers() });
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate && socket) socket.emit('webrtc:ice-candidate', { candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    document.getElementById('call-remote-video').srcObject = e.streams[0];
    document.getElementById('remote-video-fallback').style.display = 'none';
    document.getElementById('live-badge').style.display = 'flex';
  };
  pc.onconnectionstatechange = () => {
    if (pc && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')) {
      showToast('การเชื่อมต่อสายหลุด');
      cleanupCall();
      go('chat');
    }
  };

  setupCallSocketHandlers();

  await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc:answer', { sdp: answer.sdp });
  callActive = true;

  document.getElementById('call-tag-text').textContent = 'สายกำลังใช้งาน';
  updateCallTimer();
  callTimerInterval = setInterval(() => { callSeconds++; updateCallTimer(); }, 1000);
}

/* ============ WebRTC video call (real peer-to-peer, signaled via Socket.io) ============ */
function setupCallSocketHandlers() {
  if (!socket) return;
  socket.on('webrtc:answer', async ({ sdp }) => {
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp });
    callActive = true;
    document.getElementById('call-tag-text').textContent = 'สายกำลังใช้งาน';
  });
  socket.on('webrtc:ice-candidate', async ({ candidate }) => {
    if (!pc || !candidate) return;
    try { await pc.addIceCandidate(candidate); } catch (e) { /* ignore late/duplicate candidates */ }
  });
  socket.on('webrtc:rejected', () => {
    showToast('ไม่มีเจ้าหน้าที่รับสายในขณะนี้');
    cleanupCall();
    go('chat');
  });
  socket.on('webrtc:ended', () => {
    showToast('อีกฝ่ายวางสายแล้ว');
    cleanupCall();
    go('chat');
  });
}

async function startCall() {
  go('call');
  callSeconds = 0;
  muted = false; speakerOn = true;
  callActive = false;
  document.getElementById('call-mute-btn').textContent = '🎙️';
  document.getElementById('call-speaker-btn').textContent = '🔊';
  document.getElementById('call-tag-text').textContent = 'กำลังโทรออก...';
  document.getElementById('call-agent-name').textContent = settings.agent_name || 'เจ้าหน้าที่ฝ่ายบริการ';
  document.getElementById('remote-video-fallback').style.display = 'flex';
  document.getElementById('remote-waiting-text').textContent = 'กำลังโทรออก รอเจ้าหน้าที่รับสาย...';
  document.getElementById('remote-video-frame').classList.toggle('mode-ai', settings.call_mode === 'ai');
  document.getElementById('remote-video-frame').classList.toggle('mode-real', settings.call_mode !== 'ai');
  document.getElementById('live-badge').style.display = 'none';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    showToast('ไม่สามารถเข้าถึงกล้อง/ไมโครโฟนได้ — ตรวจสอบสิทธิ์การใช้งาน');
    go('chat');
    return;
  }
  document.getElementById('call-local-video').srcObject = localStream;

  pc = new RTCPeerConnection({ iceServers: await getIceServers() });
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate && socket) socket.emit('webrtc:ice-candidate', { candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    const remoteVideo = document.getElementById('call-remote-video');
    remoteVideo.srcObject = e.streams[0];
    document.getElementById('remote-video-fallback').style.display = 'none';
    document.getElementById('live-badge').style.display = 'flex';
  };
  pc.onconnectionstatechange = () => {
    if (pc && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')) {
      showToast('การเชื่อมต่อสายหลุด');
      cleanupCall();
      go('chat');
    }
  };

  setupCallSocketHandlers();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc:call', { mode: settings.call_mode });
  socket.emit('webrtc:offer', { sdp: offer.sdp });

  updateCallTimer();
  callTimerInterval = setInterval(() => { callSeconds++; updateCallTimer(); }, 1000);
}

function updateCallTimer() {
  const m = Math.floor(callSeconds / 60).toString().padStart(2, '0');
  const s = (callSeconds % 60).toString().padStart(2, '0');
  document.getElementById('call-timer').textContent = `${m}:${s}`;
}
function toggleMute() {
  muted = !muted;
  document.getElementById('call-mute-btn').textContent = muted ? '🔇' : '🎙️';
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !muted);
}
function toggleSpeaker() {
  speakerOn = !speakerOn;
  document.getElementById('call-speaker-btn').textContent = speakerOn ? '🔊' : '🔈';
  const remoteVideo = document.getElementById('call-remote-video');
  if (remoteVideo) remoteVideo.muted = !speakerOn;
}
function cleanupCall() {
  clearInterval(callTimerInterval);
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (pc) { pc.close(); pc = null; }
  callActive = false;
  if (socket) {
    socket.off('webrtc:answer');
    socket.off('webrtc:ice-candidate');
    socket.off('webrtc:rejected');
    socket.off('webrtc:ended');
  }
}
function endCall() {
  if (socket) socket.emit('webrtc:end', {});
  const durationText = document.getElementById('call-timer').textContent;
  cleanupCall();
  showToast('วางสายแล้ว');
  chatMessages.push({ sender_role: 'admin', text: `📞 สายวิดีโอคอลสิ้นสุดแล้ว (${durationText})`, created_at: new Date().toISOString() });
  go('chat');
}

/* ============ Report issue ============ */
async function loadReportList() {
  tickets = await api('/tickets');
  renderReportList();
}
function renderReportList() {
  const el = document.getElementById('report-list');
  el.innerHTML = tickets.map(ticketCardHtml).join('') || emptyHtml('ยังไม่มีรายการแจ้งปัญหา');
}

async function submitReport() {
  const title = document.getElementById('rf-title').value.trim();
  const desc = document.getElementById('rf-desc').value.trim();
  if (!title || !desc) { showToast('กรุณากรอกหัวข้อและรายละเอียด'); return; }
  const priority = document.querySelector('#rf-priority .selected').dataset.v;
  const channel = document.getElementById('rf-channel').value;
  try {
    await api('/tickets', { method: 'POST', body: { title, description: desc, priority, channel } });
    document.getElementById('rf-title').value = '';
    document.getElementById('rf-desc').value = '';
    showToast('ส่งเรื่องแจ้งปัญหาเรียบร้อยแล้ว');
    go('report');
  } catch (e) { showToast(e.message); }
}

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('chip-opt')) {
    e.target.parentElement.querySelectorAll('.chip-opt').forEach(c => c.classList.remove('selected'));
    e.target.classList.add('selected');
  }
});

/* ============ Knowledge base ============ */
async function loadKB() {
  faq = await api('/kb');
  renderKB();
}
function renderKB() {
  const q = (document.getElementById('kb-search').value || '').toLowerCase();
  const el = document.getElementById('kb-list');
  const filtered = faq.filter(f => f.title.toLowerCase().includes(q) || f.body.toLowerCase().includes(q));
  if (!filtered.length) { el.innerHTML = emptyHtml('ไม่พบผลลัพธ์ที่ค้นหา'); return; }
  el.innerHTML = filtered.map(f => `
    <div class="kb-card" style="cursor:pointer" onclick="openFaqAlert(${f.id})">
      <span class="kb-tag">${f.tag}</span>
      <h3>${f.title}</h3>
      <p>${f.body.slice(0, 70)}...</p>
    </div>`).join('');
}

/* ============ Announcements ============ */
async function loadAnnouncements() {
  announcements = await api('/announcements');
  renderAnnouncements();
}
function renderAnnouncements() {
  const el = document.getElementById('ann-list');
  el.innerHTML = announcements.map(a => `
    <div class="ann-card">
      <div class="ann-ico">${a.icon}</div>
      <div>
        <h4>${a.title}</h4>
        <p>${a.body}</p>
        <time>${formatDate(a.created_at)}</time>
      </div>
    </div>`).join('') || emptyHtml('ยังไม่มีประกาศ');
  document.getElementById('ann-badge').style.display = 'none';
}

/* ============ History ============ */
async function loadHistory() {
  tickets = await api('/tickets');
  renderHistory();
}
function renderHistory() {
  const el = document.getElementById('history-list');
  el.innerHTML = tickets.map(ticketCardHtml).join('') || emptyHtml('ยังไม่มีประวัติการแจ้ง');
}

/* ============ Shop (Lazmall) ============ */
function discountPct(price, compare) {
  if (!compare || compare <= price) return null;
  return Math.round((1 - price / compare) * 100);
}

function scrollShopTo(sectionId) {
  const el = document.getElementById(sectionId);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setStickyNavActive(btn) {
  const nav = document.getElementById('shop-sticky-nav');
  if (!nav) return;
  nav.querySelectorAll('.ssn-item').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// Shared banner/stats/tabs/popular-products/footer content — identical on both หน้าหลัก
// (view-shop) and the สินค้า catalog page (view-products), driven by the same Admin >
// ตั้งค่า data, so editing it in one place updates both pages.
async function renderSharedHomeContent() {
  if (!shopCategories.length && !shopProducts.length) {
    [shopCategories, shopProducts] = await Promise.all([api('/categories'), api('/products')]);
  }
  renderHomeHeroBanner();
  renderHomeStats();
  renderHomeCategoryTabs();
  renderHomeCTA();
  renderHomeFooterExtras();
  renderPopularProductRows();
  renderPromoImageGrid();
  loadFlashSale();
  loadStoreNotifBadge();
  await refreshCartBadge();
}

async function loadShop() {
  await renderSharedHomeContent();
}

// Dedicated "สินค้า" tab — same banner/menu/footer as หน้าหลัก, plus the full
// searchable/filterable catalog underneath.
async function loadProducts() {
  await renderSharedHomeContent();
  renderCategories();
  if (pendingProductSearch) {
    document.getElementById('shop-search').value = pendingProductSearch;
    pendingProductSearch = '';
  }
  renderProducts();
}

/* ============ Home page content (CMS-managed from Admin > Settings > หน้าแรก) ============ */
/* Same data is shown on both หน้าหลัก (view-shop) and the สินค้า catalog page (view-products) —
   each renderer below writes to both sets of ids so the two pages always stay in sync with
   whatever the admin edits in Settings. */
let heroBannerRotateInterval = null;
function renderHomeHeroBanner() {
  const containers = document.querySelectorAll('.home-hero-banner');
  if (!containers.length) return;
  let banners = [];
  try { banners = JSON.parse(settings.home_banners || '[]'); } catch (e) { banners = []; }
  banners = banners.filter(b => b && b.imageUrl);

  if (heroBannerRotateInterval) { clearInterval(heroBannerRotateInterval); heroBannerRotateInterval = null; }
  if (!banners.length) return; // keep the default gradient banner already in the HTML

  let idx = 0;
  containers.forEach(el => {
    el.innerHTML = `<a class="home-hero-banner-link" href="${banners[0].linkUrl || '#'}" target="${banners[0].linkUrl ? '_blank' : '_self'}" rel="noopener noreferrer"><img class="home-hero-banner-img" src="${banners[0].imageUrl}" alt=""></a>`;
  });
  if (banners.length > 1) {
    heroBannerRotateInterval = setInterval(() => {
      idx = (idx + 1) % banners.length;
      const imgs = document.querySelectorAll('.home-hero-banner-img');
      const links = document.querySelectorAll('.home-hero-banner-link');
      if (!imgs.length) { clearInterval(heroBannerRotateInterval); return; }
      imgs.forEach(img => { img.src = banners[idx].imageUrl; });
      links.forEach(link => { link.href = banners[idx].linkUrl || '#'; link.target = banners[idx].linkUrl ? '_blank' : '_self'; });
    }, 3000);
  }
}

const HOME_STAT_ICONS = {
  store: '<path d="M5 3h14v18H5z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 21v-6h6v6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  tag: '<path d="M20.6 12.6 12 21.2 2.8 12 2.8 2.8 12 2.8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor"/>',
  star: '<path d="m12 2.5 2.9 6 6.6.9-4.8 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5-4.8-4.6 6.6-.9Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  users: '<circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 20a6 6 0 0 1 12 0M16 4.2a3.2 3.2 0 0 1 0 6.6M21 20a6 6 0 0 0-4-5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};
function renderHomeStats() {
  let stats = [];
  try { stats = JSON.parse(settings.home_stats || '[]'); } catch (e) { stats = []; }
  const html = stats.map(s => `
    <div class="home-stat">
      <div class="home-stat-ico"><svg viewBox="0 0 24 24">${HOME_STAT_ICONS[s.icon] || HOME_STAT_ICONS.star}</svg></div>
      <div>
        <b>${s.value || ''}</b>
        <span>${s.label || ''}</span>
      </div>
    </div>`).join('');
  ['home-stats-row', 'home-stats-row-p'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
}

function renderHomeCategoryTabs() {
  let tabs = [];
  try { tabs = JSON.parse(settings.home_category_tabs || '[]'); } catch (e) { tabs = []; }
  const html = tabs.map((t, i) => `
    <button class="home-cat-tab ${i === 0 ? 'active' : ''}" data-idx="${i}">
      <div class="home-cat-tab-ico">${t.iconUrl ? `<img src="${t.iconUrl}" alt="">` : (t.emoji || '🏷️')}</div>
      <span>${t.label || ''}</span>
    </button>`).join('');
  ['home-cat-tabs', 'home-cat-tabs-p'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
    el.querySelectorAll('.home-cat-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.home-cat-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });
}

// Two large promo image cards shown under หมวดหมู่ทั่วไป (Admin > ตั้งค่า > หน้าแรก).
// Falls back to a plain gradient placeholder per card until the admin uploads an image.
function renderPromoImageGrid() {
  let cards = [];
  try { cards = JSON.parse(settings.promo_image_cards || '[]'); } catch (e) { cards = []; }
  while (cards.length < 2) cards.push({});
  const html = cards.slice(0, 2).map(c => {
    const inner = c.imageUrl
      ? `<img src="${c.imageUrl}" alt="">`
      : `<div class="promo-img-placeholder">${c.title || 'โปรโมชั่นพิเศษ'}</div>`;
    return c.linkUrl
      ? `<a class="promo-img-card" href="${c.linkUrl}" target="_blank" rel="noopener noreferrer">${inner}</a>`
      : `<div class="promo-img-card">${inner}</div>`;
  }).join('');
  document.querySelectorAll('.promo-image-grid').forEach(el => { el.innerHTML = html; });
}

function renderHomeCTA() {
  const title = settings.home_cta_title || '';
  const subtitle = settings.home_cta_subtitle || '';
  const html = (!title && !subtitle) ? '' : `
    <h3>${title}</h3>
    <p>${subtitle}</p>
    <button onclick="go('products')">🛒 เริ่มช้อปเลย →</button>
  `;
  ['home-cta', 'home-cta-p'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
}

function renderHomeFooterExtras() {
  const seoText = (settings.home_seo_html || '').trim();
  ['home-seo-text', 'home-seo-text-p'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (seoText) { el.textContent = seoText; el.style.display = 'block'; } else { el.style.display = 'none'; }
  });

  let shippingLogos = [];
  try { shippingLogos = JSON.parse(settings.shipping_logos || '[]'); } catch (e) { shippingLogos = []; }
  if (shippingLogos.length) {
    const html = shippingLogos.map(p => `<div class="sf-badge sf-badge-img"><img src="${p.url}" alt="shipping"></div>`).join('');
    ['sf-shipping-badges', 'sf-shipping-badges-p'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });
  }

  const year = new Date().getFullYear() + 543; // Thai Buddhist year, matches the rest of the app's date conventions
  ['sf-copyright-year', 'sf-copyright-year-p'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = year;
  });

  let aboutSections = [];
  try { aboutSections = JSON.parse(settings.footer_about_sections || '[]'); } catch (e) { aboutSections = []; }
  const aboutHtml = `
    ${settings.footer_about_title ? `<h4 class="sf-about-title">${settings.footer_about_title}</h4>` : ''}
    ${aboutSections.map(s => `<div class="sf-about-section"><h5>${s.heading || ''}</h5><p>${s.body || ''}</p></div>`).join('')}
  `;
  ['sf-about-block', 'sf-about-block-p'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = aboutHtml;
  });

  let campaignDates = [];
  try { campaignDates = JSON.parse(settings.footer_campaign_dates || '[]'); } catch (e) { campaignDates = []; }
  const campaignHtml = campaignDates.map(c => `<span class="sf-campaign-pill${c.highlight ? ' hl' : ''}">${c.label || ''}</span>`).join('');
  ['sf-campaign-row', 'sf-campaign-row-p'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = campaignHtml;
    el.style.display = campaignDates.length ? 'flex' : 'none';
  });

  let navColumns = [];
  try { navColumns = JSON.parse(settings.footer_nav_columns || '[]'); } catch (e) { navColumns = []; }
  const navHtml = navColumns.map(col => `
    <div class="sf-col">
      <h4>${col.title || ''}</h4>
      ${(col.links || []).map(l => l.url
        ? `<a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.label || ''}</a>`
        : `<a>${l.label || ''}</a>`).join('')}
    </div>`).join('');
  ['sf-nav-cols', 'sf-nav-cols-p', 'sf-nav-cols-w', 'sf-nav-cols-t'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = navHtml;
  });
}

// Formats a raw count as the short "9K+" style shown under each product thumb,
// matching the compact stat style used across the storefront's card grids.
function formatCountShort(n) {
  n = Number(n) || 0;
  if (n >= 1000) return Math.floor(n / 1000) + 'K+';
  return String(n);
}

function ratedProductCardHtml(p) {
  const disc = p.flash_active ? Math.round((1 - p.flash_price / p.price) * 100) : discountPct(p.price, p.compare_at_price);
  const price = p.flash_active ? p.flash_price : p.price;
  const compare = p.flash_active ? p.price : p.compare_at_price;
  return `
    <div class="rated-product-card" onclick="openProduct(${p.id})">
      <div class="rpc-image">
        ${disc ? `<span class="rpc-badge">-${disc}%</span>` : ''}
        ${productMediaHtml(p)}
        <span class="rpc-rating">⭐ ${(Number(p.rating) || 0).toFixed(1)}</span>
      </div>
      <div class="rpc-name">${p.name}</div>
      <div class="rpc-price-row">
        <span class="rpc-price">${price.toLocaleString()} ฿</span>
        ${compare ? `<span class="rpc-old">${compare.toLocaleString()} ฿</span>` : ''}
      </div>
    </div>`;
}

// "หมวดหมู่ยอดนิยม" — a browsable row of category pills. Admin picks which categories
// appear (and in what order) via Admin > ตั้งค่า > หน้าแรก > หมวดหมู่ยอดนิยม; falls back to
// the first 10 real categories so the section isn't empty before an admin configures it.
function popularCategoryPillsHtml() {
  let ids = [];
  try { ids = JSON.parse(settings.home_popular_cat_ids || '[]'); } catch (e) { ids = []; }
  let cats = ids.map(id => shopCategories.find(c => c.id === id)).filter(Boolean);
  if (!cats.length) cats = shopCategories.filter(c => c.name !== 'ทั่วไป').slice(0, 10);
  if (!cats.length) return '';

  const title = settings.home_popular_cats_title || 'หมวดหมู่ยอดนิยม';
  const subtitle = settings.home_popular_cats_subtitle || 'ช้อปตามหมวดหมู่ที่คนค้นหามากที่สุด';
  return `
    <div class="section-block">
      <div class="section-block-head">
        <div class="sb-head-left">
          <span class="sb-ico sb-ico-blue">📊</span>
          <div><h3>${title}</h3><p>${subtitle}</p></div>
        </div>
      </div>
      <div class="popular-cat-pills">
        ${cats.map(c => `<button class="cat-pill" onclick="selectCategory(${c.id})">${c.name}</button>`).join('')}
      </div>
    </div>`;
}

// "สินค้ายอดนิยม" — the highest-rated active products, ranked by average review score
// (then review count, then units sold as tie-breakers). No manual picking needed: as
// customers leave reviews the list updates itself, same as how Flash Sale is driven
// purely by each product's flash_price/flash_ends_at rather than a manual list.
function topRatedProductsHtml() {
  if (!shopProducts.length) return '';
  const count = Number(settings.home_top_rated_count) || 8;
  const list = [...shopProducts]
    .sort((a, b) => (b.rating - a.rating) || (b.review_count - a.review_count) || (b.sold_count - a.sold_count))
    .slice(0, count);
  if (!list.length) return '';

  const title = settings.home_top_rated_title || 'สินค้ายอดนิยม';
  const subtitle = settings.home_top_rated_subtitle || 'สินค้าที่ได้รับการรีวิวและคะแนนเฉลี่ยสูงสุด';
  return `
    <div class="section-block">
      <div class="section-block-head">
        <div class="sb-head-left">
          <span class="sb-ico sb-ico-gold">⭐</span>
          <div><h3>${title}</h3><p>${subtitle}</p></div>
        </div>
        <button class="sb-view-all" onclick="go('products')">ดูทั้งหมด ›</button>
      </div>
      <div class="rated-product-row">${list.map(ratedProductCardHtml).join('')}</div>
    </div>`;
}

function renderPopularProductRows() {
  const html = popularCategoryPillsHtml() + topRatedProductsHtml();
  ['popular-products-section', 'popular-products-section-p'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
}

let flashCountdownInterval = null;
async function loadFlashSale() {
  try {
    const items = await api('/products/flash-sale');
    const containers = ['flash-sale-section', 'flash-sale-section-p'].map(id => document.getElementById(id)).filter(Boolean);
    if (flashCountdownInterval) clearInterval(flashCountdownInterval);
    if (!items.length) { containers.forEach(el => { el.innerHTML = ''; }); return; }

    const ringColors = ['#EA580C', '#16A34A', '#CA8A04', '#2563EB', '#7C3AED', '#0D9488'];

    const html = `
      <div class="flash-banner">
        <div class="fb-left">
          <div class="fb-ico">⚡</div>
          <div>
            <div class="fb-title">FLASH SALE</div>
            <div class="fb-sub">ดีลเด็ด จำกัดเวลา</div>
          </div>
        </div>
        <button class="fb-view-all" onclick="this.closest('.flash-banner').parentElement.scrollIntoView({behavior:'smooth'})">ดูทั้งหมด ›</button>
      </div>
      <div class="flash-product-row">
        ${items.map((p, i) => {
          const disc = Math.round((1 - p.flash_price / p.price) * 100);
          const lowStock = p.stock > 0 && p.stock <= 5;
          const ringColor = ringColors[i % ringColors.length];
          return `
          <div class="flash-product-card" onclick="openProduct(${p.id})">
            <div class="fp-icon">
              <div class="fp-seller-badge"><span class="fp-seller-avatar">🏪</span><span>หน้าร้าน</span></div>
              ${lowStock ? `<span class="fp-stock-tag">↺ เหลือ ${p.stock} ชิ้น</span>` : ''}
              ${productMediaHtml(p)}
              <span class="fp-disc-tag">-${disc}%</span>
              <div class="fp-ring" style="--pct:${Math.min(disc,100)};--ring-color:${ringColor}">${Math.min(disc,100)}%</div>
            </div>
            <div class="fp-name">${p.name}</div>
            <div class="fp-price-row"><span class="fp-price">${p.flash_price.toLocaleString()} ฿</span><span class="fp-old-price">${p.price.toLocaleString()} ฿</span></div>
            <div class="fp-bottom-row">
              <span class="fp-countdown" data-ends="${p.flash_ends_at}">⏱ --:--:--</span>
              <button class="fp-buy-btn" onclick="event.stopPropagation();openProduct(${p.id})">จองเลย</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    `;
    containers.forEach(el => { el.innerHTML = html; });

    const updateCountdown = () => {
      const cards = document.querySelectorAll('.fp-countdown');
      if (!cards.length) { clearInterval(flashCountdownInterval); return; }
      let anyActive = false;
      cards.forEach(c => {
        const endsAt = new Date(c.dataset.ends).getTime();
        const diff = endsAt - Date.now();
        if (diff <= 0) { c.textContent = '⏱ หมดเวลา'; return; }
        anyActive = true;
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        c.textContent = `⏱ ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      });
      if (!anyActive) { clearInterval(flashCountdownInterval); loadFlashSale(); }
    };
    updateCountdown();
    flashCountdownInterval = setInterval(updateCountdown, 1000);
  } catch (e) { /* non-critical */ }
}

/* ============ Mega menu ============ */
async function openMegaMenu() {
  const tree = await api('/categories?tree=true');
  const el = document.getElementById('mega-menu-list');
  el.innerHTML = tree.map(c => `
    <div class="mega-cat-item" onclick="selectCategory(${c.id});closeMegaMenu()">${c.icon} ${c.name}</div>
    ${c.children.map(sub => `<div class="mega-subcat-item" onclick="selectCategory(${sub.id});closeMegaMenu()">${sub.icon} ${sub.name}</div>`).join('')}
  `).join('');
  document.getElementById('mega-menu-overlay').style.display = 'flex';
}
function closeMegaMenu() {
  document.getElementById('mega-menu-overlay').style.display = 'none';
}

/* ============ Store notifications ============ */
// Badge shows the real unread count (announcements posted since this user last
// opened the list — see GET /store-notifications/unread-count), not just "any
// announcements exist" — so it correctly disappears once read and reappears
// only when something genuinely new comes in.
async function loadStoreNotifBadge() {
  try {
    const [storeRes, personalRes] = await Promise.all([
      api('/store-notifications/unread-count'),
      api('/notifications/unread-count'),
    ]);
    const count = (storeRes.count || 0) + (personalRes.count || 0);
    ['store-notif-badge', 'store-notif-badge2'].forEach(id => {
      const badge = document.getElementById(id);
      if (!badge) return;
      if (count > 0) { badge.textContent = count > 99 ? '99+' : count; badge.style.display = 'block'; }
      else { badge.style.display = 'none'; }
    });
  } catch (e) { /* non-critical */ }
}
// Merges the two feeds — store-wide broadcast announcements (store_notifications,
// admin-authored marketing/info posts) and this customer's own personal/
// transactional alerts (notifications table — order, payment, wallet, shipping,
// account status, ticket updates) — into a single chronological list, since both
// live on the same "แจ้งเตือน" screen from the customer's point of view.
async function loadStoreNotifications() {
  const [storeItems, personalItems] = await Promise.all([
    api('/store-notifications'),
    api('/notifications'),
  ]);
  const merged = [
    ...storeItems.map(n => ({ ...n, _kind: 'store' })),
    ...personalItems.map(n => ({ ...n, _kind: 'personal' })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const el = document.getElementById('store-notif-body');
  if (!merged.length) { el.innerHTML = emptyHtml('ยังไม่มีการแจ้งเตือน'); return; }
  el.innerHTML = merged.map(n => `
    <div class="store-notif-card">
      <div class="snc-ico">${n.icon || '🔔'}</div>
      <div><h4>${escapeHtml(n.title)}</h4><p>${escapeHtml(n.body || '')}</p><time>${formatDate(n.created_at)}</time></div>
    </div>`).join('');
  // Opening this list is how the customer "reads" both feeds — clears both badges
  // server-side (persists across reloads/sessions) as well as in the UI right away.
  try { await Promise.all([
    api('/store-notifications/mark-seen', { method: 'POST' }),
    api('/notifications/mark-seen', { method: 'POST' }),
  ]); } catch (e) { /* non-critical */ }
  ['store-notif-badge', 'store-notif-badge2'].forEach(id => {
    const badge = document.getElementById(id);
    if (badge) badge.style.display = 'none';
  });
}

function renderCategories() {
  const el = document.getElementById('cat-scroll');
  if (!el) return;
  const allChip = `<div class="cat-chip ${selectedCategoryId === null ? 'active' : ''}" onclick="selectCategory(null)"><div class="cc-ico">🗂️</div><span>ทั้งหมด</span></div>`;
  const chips = shopCategories.map(c => `
    <div class="cat-chip ${selectedCategoryId === c.id ? 'active' : ''}" onclick="selectCategory(${c.id})">
      <div class="cc-ico">${c.icon}</div><span>${c.name}</span>
    </div>`).join('');
  el.innerHTML = allChip + chips;
}

// Sets the active category filter. If called from off the products page (e.g. the
// mega menu opened from หน้าหลัก), navigates to the dedicated products page first —
// go('products') then applies the filter via loadProducts(), which reads selectedCategoryId.
function selectCategory(id) {
  selectedCategoryId = id;
  if (currentView === 'products') {
    renderCategories();
    renderProducts();
  } else {
    go('products');
  }
}

// Camera icon next to search — opens the device's photo picker. Does NOT do real image
// recognition (that needs a proper vision/ML backend, which is out of scope here) — it's
// an honest placeholder that lets the person pick a photo, then tells them the feature
// isn't wired up to actual visual search yet, rather than silently doing nothing or
// pretending to return real results.
function openVisualSearch() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.onchange = () => {
    if (input.files && input.files[0]) {
      showToast('ฟีเจอร์ค้นหาด้วยรูปภาพยังอยู่ระหว่างพัฒนา ลองค้นหาด้วยข้อความแทนได้ค่ะ');
    }
  };
  input.click();
}

function renderProducts() {
  const q = (document.getElementById('shop-search').value || '').toLowerCase();
  let list = shopProducts;
  if (selectedCategoryId !== null) list = list.filter(p => p.category_id === selectedCategoryId);
  if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));

  const el = document.getElementById('product-grid');
  if (!list.length) { el.innerHTML = emptyHtml('ไม่พบสินค้าที่ค้นหา'); return; }
  el.innerHTML = list.map(p => {
    const disc = p.flash_active
      ? Math.round((1 - p.flash_price / p.price) * 100)
      : discountPct(p.price, p.compare_at_price);
    return `
    <div class="product-card" onclick="openProduct(${p.id})">
      <div class="pc-image">${p.flash_active ? `<span class="pc-flash-badge">⚡-${disc}%</span>` : (disc ? `<span class="pc-discount">-${disc}%</span>` : '')}${productMediaHtml(p)}</div>
      <div class="pc-body">
        <div class="pc-name">${p.name}</div>
        <div class="pc-price-row">
          <span class="pc-price">฿${p.effective_price.toLocaleString()}</span>
          ${p.flash_active ? `<span class="pc-compare">฿${p.price.toLocaleString()}</span>` : (p.compare_at_price ? `<span class="pc-compare">฿${p.compare_at_price.toLocaleString()}</span>` : '')}
        </div>
        <div class="pc-meta"><span>⭐ ${p.rating} (${p.review_count || 0}+)</span></div>
      </div>
    </div>`;
  }).join('');
}

async function openProduct(id) {
  productDetailQty = 1;
  // Product cards on the home/list pages are built from `shopProducts`, which already
  // has everything the detail view needs (name, price, image, description, stock...).
  // Render from that cached copy immediately so the screen switches instantly on tap,
  // instead of sitting frozen while we wait on a network round trip.
  const cached = shopProducts.find(p => p.id === id);
  if (cached) {
    currentProductDetail = cached;
    renderProductDetail();
    go('product-detail');
    try {
      const fresh = await api('/products/' + id);
      // Keep the in-memory record accurate for stock checks / cart / buy-now, but skip
      // re-rendering so nothing visibly flickers if the user is already looking at it.
      if (currentProductDetail && currentProductDetail.id === id) currentProductDetail = fresh;
    } catch (e) { /* non-critical: keep showing the cached copy */ }
    return;
  }

  // No cached copy (e.g. a deep link straight to a product) — show a skeleton instead
  // of a blank/frozen screen while the real data loads.
  document.getElementById('product-detail-body').innerHTML = productDetailSkeletonHtml();
  go('product-detail');
  try {
    currentProductDetail = await api('/products/' + id);
    renderProductDetail();
  } catch (e) {
    document.getElementById('product-detail-body').innerHTML = emptyHtml('ไม่พบสินค้านี้ หรือถูกลบไปแล้ว');
  }
}

function productDetailSkeletonHtml() {
  return `
    <div class="pd-image skel-block"></div>
    <div class="skel-line" style="width:70%;height:20px;margin-top:16px"></div>
    <div class="skel-line" style="width:35%;height:26px;margin-top:10px"></div>
    <div class="skel-line" style="width:90%;height:13px;margin-top:16px"></div>
    <div class="skel-line" style="width:60%;height:13px;margin-top:8px"></div>
  `;
}

function renderProductDetail() {
  const p = currentProductDetail;
  const disc = p.flash_active ? Math.round((1 - p.flash_price / p.price) * 100) : discountPct(p.price, p.compare_at_price);
  document.getElementById('product-detail-body').innerHTML = `
    <div class="pd-image">${productMediaHtml(p, { eager: true })}</div>
    <h1 class="pd-name">${p.name}</h1>
    ${p.flash_active ? `<div class="flash-banner" style="margin:0 0 12px"><div class="fb-title">⚡ ราคาแฟลชเซล</div><div class="flash-timer" id="pd-flash-countdown">--:--:--</div></div>` : ''}
    <div class="pd-price-row">
      <span class="pd-price">฿${p.effective_price.toLocaleString()}</span>
      ${p.flash_active ? `<span class="pd-compare">฿${p.price.toLocaleString()}</span>` : (p.compare_at_price ? `<span class="pd-compare">฿${p.compare_at_price.toLocaleString()}</span>` : '')}
      ${disc ? `<span class="pd-discount-badge">ลด ${disc}%</span>` : ''}
    </div>
    <div class="pd-meta-row"><span>⭐ ${p.rating} (${p.review_count || 0} รีวิว)</span><span>ขายแล้ว ${p.sold_count} ชิ้น</span><span>คงเหลือ ${p.stock} ชิ้น</span></div>
    <p class="pd-desc">${p.description || '-'}</p>
    <div class="pd-qty-row">
      <span style="font-size:13px;font-weight:700">จำนวน</span>
      <div class="qty-stepper">
        <button onclick="changeProductQty(-1)">−</button>
        <span id="pd-qty">1</span>
        <button onclick="changeProductQty(1)">+</button>
      </div>
    </div>
    <div class="pd-actions">
      <button class="btn-secondary" onclick="addToCart(${p.id})">🛒 เพิ่มลงตะกร้า</button>
      <button class="btn-primary" onclick="buyNow(${p.id})">ซื้อเลย</button>
    </div>
    <div class="section-head"><h2>รีวิวจากลูกค้า</h2></div>
    <div id="pd-reviews-list">กำลังโหลด...</div>
  `;
  loadProductReviews(p.id);
  if (p.flash_active) startProductDetailCountdown(p.flash_ends_at);
}

let pdFlashCountdownInterval = null;
function startProductDetailCountdown(endsAtStr) {
  if (pdFlashCountdownInterval) clearInterval(pdFlashCountdownInterval);
  const endsAt = new Date(endsAtStr).getTime();
  const update = () => {
    const diff = endsAt - Date.now();
    const el = document.getElementById('pd-flash-countdown');
    if (!el) { clearInterval(pdFlashCountdownInterval); return; }
    if (diff <= 0) { el.textContent = 'หมดเวลา'; clearInterval(pdFlashCountdownInterval); return; }
    const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
    el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  };
  update();
  pdFlashCountdownInterval = setInterval(update, 1000);
}

async function loadProductReviews(productId) {
  try {
    const reviews = await api('/reviews/product/' + productId);
    const el = document.getElementById('pd-reviews-list');
    if (!el) return;
    if (!reviews.length) { el.innerHTML = emptyHtml('ยังไม่มีรีวิวสำหรับสินค้านี้'); return; }
    el.innerHTML = reviews.map(r => `
      <div class="review-item">
        <div class="ri-head"><span class="ri-name">${r.customer_name}</span><span class="ri-stars">${'⭐'.repeat(r.rating)}</span></div>
        ${r.comment ? `<div class="ri-comment">${r.comment}</div>` : ''}
        <div class="ri-date">${formatDate(r.created_at)}</div>
      </div>`).join('');
  } catch (e) { /* non-critical */ }
}

function changeProductQty(delta) {
  productDetailQty = Math.max(1, Math.min(currentProductDetail.stock, productDetailQty + delta));
  document.getElementById('pd-qty').textContent = productDetailQty;
}

async function addToCart(productId, silent) {
  try {
    cartData = await api('/cart', { method: 'POST', body: { productId, quantity: productDetailQty || 1 } });
    updateCartBadgeUI();
    if (!silent) showToast('เพิ่มลงตะกร้าแล้ว 🛒');
  } catch (e) { showToast(e.message); }
}

async function buyNow(productId) {
  await addToCart(productId, true);
  go('checkout');
}

async function refreshCartBadge() {
  try { cartData = await api('/cart'); updateCartBadgeUI(); } catch (e) { /* ignore */ }
}
function updateCartBadgeUI() {
  ['cart-badge', 'cart-badge2', 'cart-badge3'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = cartData.itemCount;
    el.style.display = cartData.itemCount > 0 ? 'flex' : 'none';
  });
}

async function loadCart() {
  cartData = await api('/cart');
  updateCartBadgeUI();
  const el = document.getElementById('cart-body');
  if (!cartData.items.length) {
    el.innerHTML = emptyHtml('ตะกร้าสินค้าว่างเปล่า');
    return;
  }
  el.innerHTML = cartData.items.map(item => `
    <div class="cart-item">
      <div class="ci-image">${productMediaHtml(item)}</div>
      <div class="ci-body">
        <div class="ci-name">${item.name}</div>
        <div class="ci-price">฿${item.price.toLocaleString()}</div>
      </div>
      <div class="qty-stepper">
        <button onclick="updateCartQty(${item.product_id}, ${item.quantity - 1})">−</button>
        <span>${item.quantity}</span>
        <button onclick="updateCartQty(${item.product_id}, ${item.quantity + 1})">+</button>
      </div>
      <button class="ci-remove" onclick="updateCartQty(${item.product_id}, 0)">🗑️</button>
    </div>
  `).join('') + `
    <div class="cart-summary-bar">
      <div class="cs-total"><div class="cs-label">ยอดรวม</div><div class="cs-value">฿${cartData.total.toLocaleString()}</div></div>
      <button class="btn-primary" onclick="go('checkout')">ชำระเงิน</button>
    </div>
  `;
}

async function updateCartQty(productId, qty) {
  try {
    cartData = await api('/cart/' + productId, { method: 'PATCH', body: { quantity: qty } });
    updateCartBadgeUI();
    loadCart();
  } catch (e) { showToast(e.message); }
}

let checkoutCoupon = null;
let checkoutPaymentMethod = 'กระเป๋าเงิน';
let checkoutShippingMethod = 'ส่งด่วน';

async function loadCheckout() {
  const [cart, wallet] = await Promise.all([api('/cart'), api('/wallet')]);
  cartData = cart;
  if (!cart.items.length) { go('cart'); return; }
  checkoutCoupon = null;

  renderCheckout(cart, wallet);
}

function renderCheckout(cart, wallet) {
  const discount = checkoutCoupon ? checkoutCoupon.discount : 0;
  const total = Math.max(0, cart.total - discount);
  const payingByWallet = checkoutPaymentMethod === 'กระเป๋าเงิน';
  const sufficient = !payingByWallet || wallet.walletBalance >= total;

  document.getElementById('checkout-body').innerHTML = `
    <div class="checkout-section">
      <h3>รายการสินค้า (${cart.itemCount} ชิ้น)</h3>
      ${cart.items.map(i => `<div class="checkout-row"><span>${i.icon} ${i.name} x${i.quantity}${i.flash_active ? ' ⚡' : ''}</span><span>฿${(i.effective_price*i.quantity).toLocaleString()}</span></div>`).join('')}
    </div>

    <div class="checkout-section">
      <h3>โค้ดส่วนลด</h3>
      ${checkoutCoupon ? `
        <div class="coupon-applied"><span>🎟️ ${checkoutCoupon.code} — ลด ฿${checkoutCoupon.discount.toLocaleString()}</span><a onclick="removeCoupon()">ลบ</a></div>
      ` : `
        <div class="coupon-input-row">
          <input type="text" id="coupon-code-input" placeholder="กรอกโค้ดส่วนลด" style="text-transform:uppercase">
          <button class="btn-secondary" style="width:auto;padding:11px 16px" onclick="applyCoupon()">ใช้โค้ด</button>
        </div>
      `}
    </div>

    <div class="checkout-section">
      <h3>บริการขนส่ง</h3>
      <div class="payment-method-list">
        ${['ส่งด่วน', 'Kerry Express', 'DHL', 'Flash Express', 'J&T Express'].map(m => `
          <div class="payment-method-opt ${checkoutShippingMethod === m ? 'selected' : ''}" onclick="selectShippingMethod('${m}')">
            <span>${m === 'ส่งด่วน' ? '🚚' : m === 'Kerry Express' ? '📦' : m === 'DHL' ? '✈️' : m === 'Flash Express' ? '⚡' : '🛵'} ${m}</span>
            ${checkoutShippingMethod === m ? '<span>✓</span>' : ''}
          </div>
        `).join('')}
      </div>
    </div>

    <div class="checkout-section">
      <h3>ช่องทางชำระเงิน</h3>
      <div class="payment-method-list">
        ${['กระเป๋าเงิน', 'บัตรเครดิต/เดบิต', 'โอนเงินผ่านธนาคาร'].map(m => `
          <div class="payment-method-opt ${checkoutPaymentMethod === m ? 'selected' : ''}" onclick="selectPaymentMethod('${m}')">
            <span>${m === 'กระเป๋าเงิน' ? '👛' : m === 'บัตรเครดิต/เดบิต' ? '💳' : '🏦'} ${m}</span>
            ${checkoutPaymentMethod === m ? '<span>✓</span>' : ''}
          </div>
        `).join('')}
      </div>
      ${payingByWallet ? `
        <div class="wallet-mini ${sufficient ? '' : 'insufficient'}" style="margin-top:10px">
          <div>
            <div style="font-size:11px;color:var(--ink-400)">ยอดคงเหลือในกระเป๋าเงิน</div>
            <div style="font-weight:800">฿${wallet.walletBalance.toLocaleString()}</div>
          </div>
          ${sufficient ? '<span style="font-size:20px">✅</span>' : `<button class="btn-secondary" style="width:auto;padding:8px 14px" onclick="go('wallet')">เติมเงิน</button>`}
        </div>
      ` : `<p style="font-size:11.5px;color:var(--ink-400);margin:10px 0 0">ระบบจะแจ้งเตือนให้ยืนยันการชำระเงินหลังสั่งซื้อ (สาธิตเท่านั้น ยังไม่เชื่อมช่องทางชำระเงินจริง)</p>`}
    </div>

    <div class="checkout-section">
      <div class="checkout-row"><span>ยอดรวมสินค้า</span><span>฿${cart.total.toLocaleString()}</span></div>
      ${discount > 0 ? `<div class="checkout-row" style="color:var(--success)"><span>ส่วนลด</span><span>-฿${discount.toLocaleString()}</span></div>` : ''}
      <div class="checkout-row total"><span>ยอดชำระทั้งหมด</span><span>฿${total.toLocaleString()}</span></div>
    </div>

    <button class="btn-primary" ${sufficient ? '' : 'disabled style="opacity:.5"'} onclick="confirmOrder()">ยืนยันการสั่งซื้อ</button>
  `;
}

async function applyCoupon() {
  const code = document.getElementById('coupon-code-input').value.trim();
  if (!code) return;
  try {
    const result = await api('/coupons/validate', { method: 'POST', body: { code, subtotal: cartData.total } });
    checkoutCoupon = result;
    const wallet = await api('/wallet');
    renderCheckout(cartData, wallet);
    showToast('ใช้โค้ดส่วนลดสำเร็จ');
  } catch (e) { showToast(e.message); }
}
async function removeCoupon() {
  checkoutCoupon = null;
  const wallet = await api('/wallet');
  renderCheckout(cartData, wallet);
}
async function selectPaymentMethod(method) {
  checkoutPaymentMethod = method;
  const wallet = await api('/wallet');
  renderCheckout(cartData, wallet);
}
async function selectShippingMethod(method) {
  checkoutShippingMethod = method;
  const wallet = await api('/wallet');
  renderCheckout(cartData, wallet);
}

async function confirmOrder() {
  try {
    const order = await api('/orders', {
      method: 'POST',
      body: {
        couponCode: checkoutCoupon ? checkoutCoupon.code : undefined,
        paymentMethod: checkoutPaymentMethod,
        shippingMethod: checkoutShippingMethod,
      },
    });
    cartData = { items: [], total: 0, itemCount: 0 };
    checkoutCoupon = null;
    checkoutPaymentMethod = 'กระเป๋าเงิน';
    checkoutShippingMethod = 'ส่งด่วน';
    updateCartBadgeUI();
    document.getElementById('order-success-id').textContent =
      `หมายเลขคำสั่งซื้อ: ${order.id}` + (order.payment_status === 'รอตรวจสอบการชำระเงิน' ? ' • รอตรวจสอบการชำระเงิน' : '');
    go('order-success');
    renderOrderPaymentBox(document.getElementById('order-success-payment'), order);
  } catch (e) { showToast(e.message); }
}

async function renderOrderPaymentBox(container, order) {
  if (!container) return;
  if (order.payment_status !== 'รอตรวจสอบการชำระเงิน') { container.innerHTML = ''; return; }

  if (order.payment_slip_url) {
    container.innerHTML = `
      <div class="checkout-section" style="text-align:left;margin-bottom:16px">
        <div style="font-size:13px;font-weight:700;color:var(--success)">✅ ส่งสลิปการโอนเงินแล้ว</div>
        <p style="font-size:12px;color:var(--ink-400);margin:6px 0 0">รอแอดมินตรวจสอบและยืนยันการชำระเงิน</p>
      </div>`;
    return;
  }

  container.innerHTML = `<p style="font-size:12px;color:var(--ink-400)">กำลังสร้าง QR พร้อมเพย์...</p>`;
  let qr;
  try {
    qr = await api(`/orders/${order.id}/promptpay-qr`);
  } catch (e) {
    container.innerHTML = `<div class="checkout-section" style="text-align:left"><p style="font-size:12.5px;color:var(--danger);margin:0">${e.message}</p></div>`;
    return;
  }

  const qrBoxId = 'ppqr-' + order.id;
  const fileId = 'slipfile-' + order.id;
  container.innerHTML = `
    <div class="checkout-section" style="text-align:center">
      <h3 style="text-align:center">สแกน QR พร้อมเพย์เพื่อชำระเงิน</h3>
      <div id="${qrBoxId}" style="display:flex;justify-content:center;margin:12px 0"></div>
      <div style="font-size:20px;font-weight:800;color:var(--purple-600)">฿${Number(qr.amount).toLocaleString()}</div>
      ${qr.merchantName ? `<div style="font-size:12px;color:var(--ink-400);margin-top:2px">${qr.merchantName}</div>` : ''}
      <p style="font-size:11.5px;color:var(--ink-400);margin:12px 0 14px">เปิดแอปธนาคารแล้วสแกน QR นี้เพื่อโอนเงิน จากนั้นอัปโหลดสลิปด้านล่างเพื่อแจ้งชำระเงิน</p>
      <input type="file" id="${fileId}" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
      <button class="btn-primary" onclick="document.getElementById('${fileId}').click()">📤 อัปโหลดสลิปการโอนเงิน</button>
      <div id="slipstatus-${order.id}" style="font-size:12px;margin-top:8px"></div>
    </div>`;

  // eslint-disable-next-line no-undef
  new QRCode(document.getElementById(qrBoxId), { text: qr.payload, width: 220, height: 220 });

  document.getElementById(fileId).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('slipstatus-' + order.id);
    statusEl.textContent = 'กำลังอัปโหลด...';
    statusEl.style.color = 'var(--ink-400)';
    try {
      const form = new FormData();
      form.append('image', file);
      const res = await fetch(API_BASE + '/upload/payment-slip', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: form,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || 'อัปโหลดไม่สำเร็จ');

      const updated = await api(`/orders/${order.id}/slip`, { method: 'POST', body: { url: data.url } });
      renderOrderPaymentBox(container, updated);
      showToast('ส่งสลิปการโอนเงินแล้ว รอแอดมินตรวจสอบ');
    } catch (err) {
      statusEl.textContent = err.message || 'อัปโหลดไม่สำเร็จ กรุณาลองใหม่';
      statusEl.style.color = 'var(--danger)';
    }
  });
}

async function loadOrders() {
  const orders = await api('/orders');
  const el = document.getElementById('orders-body');
  if (!orders.length) { el.innerHTML = emptyHtml('ยังไม่มีคำสั่งซื้อ'); return; }
  el.innerHTML = orders.map(o => {
    const pending = o.payment_status === 'รอตรวจสอบการชำระเงิน';
    return `
    <div class="order-card">
      <div class="oc-head"><span class="oc-id">${o.id}</span><span class="oc-status">${o.status}</span></div>
      <div class="oc-items">${o.items.map(i => `${i.product_icon} ${i.product_name} x${i.quantity}`).join(', ')}</div>
      <div class="oc-total">฿${o.total.toLocaleString()} ${pending ? '<span class="oc-payment-pending">รอตรวจสอบการชำระเงิน</span>' : ''}</div>
      ${pending ? `
        <button class="btn-secondary" style="width:auto;padding:8px 14px;margin-top:8px" onclick="togglePayOrder('${o.id}')" id="paybtn-${o.id}">💳 ชำระเงิน</button>
        <div id="paybox-${o.id}" style="display:none;margin-top:10px"></div>
      ` : ''}
    </div>
  `;
  }).join('') + `<div class="section-head"><h2>สินค้าที่รอรีวิว</h2></div><div id="reviewable-list">กำลังโหลด...</div>`;
  ordersCache = orders;
  loadReviewablePrompt();
}

async function togglePayOrder(id) {
  const box = document.getElementById('paybox-' + id);
  if (!box) return;
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  box.style.display = 'block';
  const order = (ordersCache || []).find(o => o.id === id) || await api('/orders/' + id);
  renderOrderPaymentBox(box, order);
}

async function loadReviewablePrompt() {
  try {
    const items = await api('/reviews/reviewable');
    const el = document.getElementById('reviewable-list');
    if (!el) return;
    if (!items.length) { el.innerHTML = emptyHtml('ไม่มีสินค้าที่รอรีวิว'); return; }
    el.innerHTML = items.slice(0, 5).map(i => `
      <div class="reviewable-card">
        <span>${i.product_icon} ${i.product_name}</span>
        <button class="btn-secondary" style="width:auto;padding:8px 14px" onclick="openReviewForm(${i.product_id}, '${i.order_id}', '${i.product_name.replace(/'/g,"")}')">ให้คะแนน</button>
      </div>`).join('');
  } catch (e) { /* non-critical */ }
}

let reviewFormProduct = null;
function openReviewForm(productId, orderId, productName) {
  reviewFormProduct = { productId, orderId };
  document.getElementById('review-form-title').textContent = 'รีวิว: ' + productName;
  document.getElementById('review-rating-input').value = '5';
  document.querySelectorAll('.review-star').forEach((s, i) => s.classList.toggle('selected', i < 5));
  document.getElementById('review-comment-input').value = '';
  document.getElementById('review-form-overlay').style.display = 'flex';
}
function closeReviewForm() { document.getElementById('review-form-overlay').style.display = 'none'; }
function setReviewStars(n) {
  document.getElementById('review-rating-input').value = n;
  document.querySelectorAll('.review-star').forEach((s, i) => s.classList.toggle('selected', i < n));
}
async function submitReview() {
  if (!reviewFormProduct) return;
  const rating = Number(document.getElementById('review-rating-input').value);
  const comment = document.getElementById('review-comment-input').value.trim();
  try {
    await api('/reviews', { method: 'POST', body: { productId: reviewFormProduct.productId, orderId: reviewFormProduct.orderId, rating, comment } });
    closeReviewForm();
    showToast('ขอบคุณสำหรับรีวิว!');
    loadReviewablePrompt();
  } catch (e) { showToast(e.message); }
}

async function loadWallet() {
  const wallet = await api('/wallet');
  document.getElementById('wallet-balance').textContent = '฿' + wallet.walletBalance.toLocaleString();
  document.getElementById('wallet-points').textContent = wallet.pointsBalance.toLocaleString() + ' ⭐';

  document.getElementById('wsc-topup').textContent = '฿' + wallet.stats.totalTopup.toLocaleString();
  document.getElementById('wsc-withdrawn').textContent = '฿' + wallet.stats.totalWithdrawn.toLocaleString();
  document.getElementById('wsc-pending').textContent = '฿' + wallet.stats.pendingWithdrawal.toLocaleString();
  document.getElementById('wsc-vip-ico').textContent = wallet.vip.icon;
  document.getElementById('wsc-vip-level').textContent = wallet.vip.name;

  try {
    const account = await api('/bank-account/me');
    document.getElementById('bank-account-summary').textContent = account
      ? `${account.bank_name} • ${account.account_number.slice(-4).padStart(account.account_number.length, '•')}`
      : 'ยังไม่ได้ผูกบัญชี — แตะเพื่อผูกบัญชี';
  } catch (e) { /* non-critical */ }

  const el = document.getElementById('wallet-tx-list');
  renderWalletTxList(el, wallet.transactions);
}

// Shared renderer for a list of wallet transactions — used on both the standalone
// wallet page and inline on the profile page (see loadProfile below).
function renderWalletTxList(el, transactions) {
  if (!el) return;
  if (!transactions || !transactions.length) { el.innerHTML = emptyHtml('ยังไม่มีประวัติธุรกรรม'); return; }
  el.innerHTML = transactions.map(tx => {
    const isPositive = tx.amount > 0 || tx.type === 'points_earned';
    const amountText = tx.type === 'points_earned' ? `+${tx.points} แต้ม` : `${tx.amount > 0 ? '+' : ''}฿${tx.amount.toLocaleString()}`;
    return `
    <div class="wallet-tx-row">
      <div><div class="wtx-desc">${escapeHtml(tx.description || '')}</div><div class="wtx-date">${formatDate(tx.created_at)}</div></div>
      <div class="wtx-amount ${isPositive ? 'positive' : 'negative'}">${amountText}</div>
    </div>`;
  }).join('');
}

function renderVipBadge(vip, elId = 'vip-badge-row') {
  const el = document.getElementById(elId);
  if (!el) return;
  const progressPct = vip.nextTier ? Math.min(100, (vip.totalSpend / vip.nextTier.minSpend) * 100) : 100;
  el.innerHTML = `
    <div class="vip-badge-card">
      <div>
        <div class="vb-tier"><span class="vb-icon">${vip.icon}</span> ${vip.name}</div>
        <div class="vb-progress">${vip.nextTier ? `อีก ฿${vip.nextTier.remaining.toLocaleString()} ถึงระดับ ${vip.nextTier.name}` : 'ระดับสูงสุดแล้ว!'}</div>
        <div class="vip-progress-bar"><div class="vip-progress-bar-fill" style="width:${progressPct}%"></div></div>
      </div>
    </div>`;
}

/* ============ Profile avatar — text initial only, no photo upload ============ */
// Rendering is centralized here so both places the avatar appears (the profile overview
// and the standalone "แก้ไขข้อมูล" page) always stay in sync.
function renderAllAvatars() {
  const user = currentUser || {};
  const pf = document.getElementById('pf-pi-avatar-circle');
  if (pf) pf.textContent = escapeHtml(user.username || user.name || '?');
  const pi = document.getElementById('pi-avatar-circle');
  if (pi) pi.textContent = escapeHtml((user.username || user.name || '?').charAt(0).toUpperCase());
}

/* ============ Profile overview ============ */
async function loadProfile() {
  const [wallet, me] = await Promise.all([api('/wallet'), api('/auth/me')]);
  currentUser = { ...(currentUser || {}), ...me };
  document.getElementById('pf-wallet-balance').textContent = '฿' + wallet.walletBalance.toLocaleString();
  document.getElementById('pf-vip-chip').textContent = `${wallet.vip.icon} ${wallet.vip.name}`;
  document.getElementById('pf-wsc-topup').textContent = '฿' + wallet.stats.totalTopup.toLocaleString();
  document.getElementById('pf-wsc-withdrawn').textContent = '฿' + wallet.stats.totalWithdrawn.toLocaleString();
  document.getElementById('pf-wsc-points').textContent = '฿' + (wallet.stats.pendingWithdrawal || 0).toLocaleString();
  document.getElementById('pf-wsc-vip-ico').textContent = wallet.vip.icon;
  document.getElementById('pf-wsc-vip-level').textContent = wallet.vip.name;
  renderWalletTxList(document.getElementById('pf-wallet-tx-list'), wallet.transactions);

  // Personal-info card, shown inline on the profile page itself (see also the
  // standalone "แก้ไขข้อมูล" page at view-personal-info, which shares the same data).
  renderAllAvatars();
  document.getElementById('pf-pi-vip-tag').textContent = `VIP ${wallet.vip.level}`;
  document.getElementById('pf-pi-username').textContent = me.username || '-';
  document.getElementById('pf-pi-phone').textContent = me.phone || 'ไม่พบข้อมูลในระบบ';
  document.getElementById('pf-pi-referral-code').textContent = me.referral_code || '-';
  document.getElementById('pf-pi-referred-by').textContent = me.referred_by_code || 'ไม่มี';
  try {
    const account = await api('/bank-account/me');
    const summary = account
      ? `${account.bank_name} • ${account.account_number.slice(-4).padStart(account.account_number.length, '•')}`
      : null;
    const btn = document.getElementById('pf-pi-bank-btn');
    if (btn) btn.textContent = summary || 'ผูกบัญชี';
    const tile = document.getElementById('pf-bank-account-summary');
    if (tile) tile.textContent = summary || 'ยังไม่ได้ผูกบัญชี — แตะเพื่อผูกบัญชี';
  } catch (e) { /* non-critical */ }

  renderProfileMenu();
  renderProfileFooterExtras();
}

// The quick-link menu list on the profile page (ข้อมูลส่วนตัว, กระเป๋าเงิน, ออกจากระบบ ฯลฯ).
// Fully managed from Admin > ตั้งค่า > หน้าโปรไฟล์ลูกค้า via the `profile_menu_items`
// setting — admins can add, remove, reorder, relabel, or re-icon every row. Falls back
// to a sensible default list if the admin hasn't configured anything yet.
const PROFILE_MENU_DEFAULT = [
  { icon: '🧾', label: 'ข้อมูลส่วนตัว', target: 'personal-info' },
  { icon: '👛', label: 'กระเป๋าเงินของฉัน', target: 'wallet' },
  { icon: '📦', label: 'คำสั่งซื้อของฉัน', target: 'orders' },
  { icon: '🎁', label: 'ชวนเพื่อน รับรางวัล', target: 'referral' },
  { icon: '❓', label: 'ศูนย์ช่วยเหลือ', target: 'help-centre' },
  { icon: '🚪', label: 'ออกจากระบบ', target: 'logout', danger: true },
];

function renderProfileMenu() {
  const el = document.getElementById('pf-menu-list');
  if (!el) return;
  let items = [];
  try { items = JSON.parse(settings.profile_menu_items || '[]'); } catch (e) { items = []; }
  if (!Array.isArray(items) || !items.length) items = PROFILE_MENU_DEFAULT;

  el.innerHTML = items.map(it => `
    <div class="settings-row" data-target="${(it.target || '').replace(/"/g, '&quot;')}" data-url="${(it.url || '').replace(/"/g, '&quot;')}">
      <div class="left"${it.danger ? ' style="color:var(--danger)"' : ''}>${it.icon || '•'} ${it.label || ''}</div>
      <span>${it.target === 'logout' ? '' : '›'}</span>
    </div>`).join('');

  el.querySelectorAll('.settings-row').forEach((row) => {
    row.addEventListener('click', () => {
      const target = row.dataset.target;
      const url = row.dataset.url;
      if (target === 'logout') { doLogout(); return; }
      if (target) { go(target); return; }
      if (url) { window.open(url, '_blank', 'noopener,noreferrer'); }
    });
  });
}

// Footer block (about text, campaign pills, nav-link columns, payment/shipping logos)
// on the profile page — mirrors renderHomeFooterExtras() but targets the pf-sf-* elements
// on the profile page. Same CMS data (Admin > ตั้งค่า > หน้าแรก), shown in two places.
function renderProfileFooterExtras() {
  let paymentLogos = [];
  try { paymentLogos = JSON.parse(settings.payment_logos || '[]'); } catch (e) { paymentLogos = []; }
  const payEl = document.getElementById('pf-sf-payment-badges');
  if (payEl && paymentLogos.length) payEl.innerHTML = paymentLogos.map(p => `<div class="sf-badge sf-badge-img"><img src="${p.url}" alt="payment"></div>`).join('');

  let shippingLogos = [];
  try { shippingLogos = JSON.parse(settings.shipping_logos || '[]'); } catch (e) { shippingLogos = []; }
  const shipEl = document.getElementById('pf-sf-shipping-badges');
  if (shipEl && shippingLogos.length) shipEl.innerHTML = shippingLogos.map(p => `<div class="sf-badge sf-badge-img"><img src="${p.url}" alt="shipping"></div>`).join('');

  const yrEl = document.getElementById('pf-sf-copyright-year');
  if (yrEl) yrEl.textContent = new Date().getFullYear() + 543;

  const aboutEl = document.getElementById('pf-sf-about-block');
  if (aboutEl) {
    let aboutSections = [];
    try { aboutSections = JSON.parse(settings.footer_about_sections || '[]'); } catch (e) { aboutSections = []; }
    aboutEl.innerHTML = `
      ${settings.footer_about_title ? `<h4 class="sf-about-title">${settings.footer_about_title}</h4>` : ''}
      ${aboutSections.map(s => `<div class="sf-about-section"><h5>${s.heading || ''}</h5><p>${s.body || ''}</p></div>`).join('')}
    `;
  }

  const campaignEl = document.getElementById('pf-sf-campaign-row');
  if (campaignEl) {
    let campaignDates = [];
    try { campaignDates = JSON.parse(settings.footer_campaign_dates || '[]'); } catch (e) { campaignDates = []; }
    campaignEl.innerHTML = campaignDates.map(c => `<span class="sf-campaign-pill${c.highlight ? ' hl' : ''}">${c.label || ''}</span>`).join('');
    campaignEl.style.display = campaignDates.length ? 'flex' : 'none';
  }

  const navEl = document.getElementById('pf-sf-nav-cols');
  if (navEl) {
    let navColumns = [];
    try { navColumns = JSON.parse(settings.footer_nav_columns || '[]'); } catch (e) { navColumns = []; }
    navEl.innerHTML = navColumns.map(col => `
      <div class="sf-col">
        <h4>${col.title || ''}</h4>
        ${(col.links || []).map(l => l.url
          ? `<a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.label || ''}</a>`
          : `<a>${l.label || ''}</a>`).join('')}
      </div>`).join('');
  }
}

/* ============ Personal info ============ */
async function loadPersonalInfo() {
  const me = await api('/auth/me');
  const wallet = await api('/wallet');
  currentUser = { ...(currentUser || {}), ...me };

  renderAllAvatars();
  document.getElementById('pi-vip-tag').textContent = `VIP ${wallet.vip.level}`;
  document.getElementById('pi-username').textContent = me.username || '-';
  document.getElementById('pi-name').textContent = me.name || '-';
  document.getElementById('pi-phone').textContent = me.phone || 'ไม่พบข้อมูลในระบบ';
  document.getElementById('pi-joined').textContent = me.created_at ? formatDate(me.created_at) : 'ไม่พบข้อมูลในระบบ';
  document.getElementById('pi-referral-code').textContent = me.referral_code || '-';
  document.getElementById('pi-referred-by').textContent = me.referred_by_code || 'ไม่มี';

  try {
    const account = await api('/bank-account/me');
    const btn = document.getElementById('pi-bank-btn');
    btn.textContent = account ? `${account.bank_name} • ${account.account_number.slice(-4).padStart(account.account_number.length, '•')}` : 'ผูกบัญชี';
  } catch (e) { /* non-critical */ }
}

/* ============ Top-up ============ */
async function loadTopup() {
  renderHomeFooterExtras(); // populates this page's footer nav columns/payment badges too
  const wallet = await api('/wallet');
  const topups = (wallet.transactions || []).filter(t => t.type === 'topup');
  const body = document.getElementById('topup-history-body');
  body.innerHTML = topups.length ? topups.map(t => `
    <div class="tht-row">
      <span>${t.description || 'เติมเงิน'}</span>
      <span>฿${Number(t.amount).toLocaleString()}</span>
      <span>#${String(t.id).padStart(6, '0')}</span>
      <span>-</span>
      <span>สำเร็จ</span>
    </div>`).join('') : `<div class="topup-history-empty">ยังไม่มีประวัติการเติมเงิน</div>`;
}

async function topupWallet() {
  const amountStr = prompt('ระบุจำนวนเงินที่ต้องการเติม (บาท):', '500');
  if (!amountStr) return;
  const amount = Number(amountStr);
  if (!amount || amount <= 0) { showToast('จำนวนเงินไม่ถูกต้อง'); return; }
  try {
    await api('/wallet/topup', { method: 'POST', body: { amount } });
    showToast(`เติมเงิน ฿${amount.toLocaleString()} สำเร็จ`);
    loadWallet();
  } catch (e) { showToast(e.message); }
}

/* ============ Bank account ============ */
const THAI_BANKS_GROUPED = [
  { group: null, banks: ['พร้อมเพย์'] },
  { group: 'ธนาคารพาณิชย์', banks: ['ไทยพาณิชย์', 'กสิกรไทย', 'กรุงเทพ', 'กรุงไทย', 'ทีเอ็มบีธนชาต', 'กรุงศรีอยุธยา', 'เกียรตินาคินภัทร', 'ซีไอเอ็มบีไทย', 'ยูโอบี', 'ทหารไทยธนชาต', 'แลนด์ แอนด์ เฮ้าส์'] },
  { group: 'ธนาคารของรัฐ', banks: ['ออมสิน', 'ธ.ก.ส.', 'อาคารสงเคราะห์', 'เพื่อการส่งออกและนำเข้าแห่งประเทศไทย', 'พัฒนาวิสาหกิจขนาดกลางและขนาดย่อมแห่งประเทศไทย', 'อิสลามแห่งประเทศไทย'] },
];
function bankSelectOptionsHtml(selected) {
  return '<option value="">-- เลือกธนาคาร --</option>' + THAI_BANKS_GROUPED.map(g => {
    const opts = g.banks.map(b => `<option value="${b}" ${b === selected ? 'selected' : ''}>${b}</option>`).join('');
    return g.group ? `<optgroup label="${g.group}">${opts}</optgroup>` : opts;
  }).join('');
}

async function loadBankAccount() {
  const account = await api('/bank-account/me');
  const el = document.getElementById('bank-account-body');
  if (account) {
    el.innerHTML = `
      <div class="bank-account-card">
        <div class="ba-bank">🏦 ${account.bank_name}</div>
        <div class="ba-number">${account.account_number.replace(/(\d{3})(\d+)(\d{3})/, '$1-•••••-$3')}</div>
        <div class="ba-name">ชื่อบัญชี: ${account.account_name}</div>
      </div>
      <button class="btn-secondary" onclick="openBankForm(true)">แก้ไขบัญชี</button>
      <button class="btn-secondary" style="margin-top:8px;color:var(--danger);border-color:var(--danger)" onclick="unlinkBankAccount()">ลบบัญชีนี้</button>
    `;
  } else {
    el.innerHTML = `
      <div class="empty-state"><div class="e-ico">🏦</div>ยังไม่ได้ผูกบัญชีธนาคาร<br>ต้องผูกบัญชีก่อนจึงจะถอนเงินได้</div>
      <button class="btn-primary" onclick="openBankForm(false)">+ ผูกบัญชีธนาคาร</button>
    `;
  }
}

function openBankForm(isEdit) {
  document.getElementById('bank-account-body').innerHTML = `
    <div class="field"><label>ธนาคาร</label><select id="ba-bank-select">${bankSelectOptionsHtml()}</select></div>
    <div class="field"><label>ชื่อบัญชี</label><input id="ba-name-input" placeholder="ชื่อ-นามสกุลตามบัญชีธนาคาร"></div>
    <div class="field"><label>เลขที่บัญชี</label><input id="ba-number-input" placeholder="ตัวเลข 10-15 หลัก" inputmode="numeric"></div>
    <div id="bank-form-error" style="display:none;color:var(--danger);font-size:12px;font-weight:600;margin-bottom:10px"></div>
    <button class="btn-primary" onclick="submitBankAccount()">บันทึกบัญชีธนาคาร</button>
    <button class="btn-secondary" style="margin-top:8px" onclick="loadBankAccount()">ยกเลิก</button>
  `;
}
async function submitBankAccount() {
  const bankName = document.getElementById('ba-bank-select').value;
  const accountName = document.getElementById('ba-name-input').value.trim();
  const accountNumber = document.getElementById('ba-number-input').value.trim();
  const errEl = document.getElementById('bank-form-error');
  errEl.style.display = 'none';
  try {
    await api('/bank-account', { method: 'POST', body: { bankName, accountName, accountNumber } });
    showToast('ผูกบัญชีธนาคารสำเร็จ');
    loadBankAccount();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}
async function unlinkBankAccount() {
  if (!confirm('ลบบัญชีธนาคารนี้ใช่หรือไม่? คุณจะถอนเงินไม่ได้จนกว่าจะผูกบัญชีใหม่')) return;
  try {
    await api('/bank-account', { method: 'DELETE' });
    showToast('ลบบัญชีธนาคารแล้ว');
    loadBankAccount();
  } catch (e) { showToast(e.message); }
}

/* ============ Withdraw ============ */
async function loadWithdraw() {
  renderHomeFooterExtras(); // populates this page's footer nav columns/payment badges too
  const [account, wallet, withdrawals] = await Promise.all([
    api('/bank-account/me'), api('/wallet'), api('/bank-account/withdrawals'),
  ]);
  const el = document.getElementById('withdraw-body');

  if (!account) {
    el.innerHTML = `
      <div class="withdraw-warning-card">
        <div class="ww-icon">⚠️</div>
        <div>
          <div class="ww-title">ยังไม่ได้ผูกบัญชีธนาคาร</div>
          <div class="ww-text">กรุณาผูกบัญชีธนาคารก่อนทำการถอนเงิน</div>
          <button class="ww-btn" onclick="openBankLinkModal()">ผูกบัญชีธนาคาร</button>
        </div>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="withdraw-balance-card">
      <div>
        <div class="wb-label">ยอดเงินที่ถอนได้</div>
        <div class="wb-amount">฿${wallet.walletBalance.toLocaleString()}</div>
      </div>
      <div class="wb-icon">฿</div>
    </div>
    <div class="field"><label>จำนวนเงินที่ต้องการถอน (ขั้นต่ำ ฿100)</label><input id="withdraw-amount-input" type="number" placeholder="0"></div>
    <p style="font-size:11.5px;color:var(--ink-400);margin:-6px 0 14px">โอนเข้าบัญชี ${account.bank_name} • ${account.account_number.replace(/(\d{3})(\d+)(\d{3})/, '$1-•••••-$3')} <a style="color:var(--purple-600);font-weight:700;cursor:pointer" onclick="openBankLinkModal()">เปลี่ยนบัญชี</a></p>
    <button class="btn-primary" onclick="submitWithdrawal()">ยืนยันการถอนเงิน</button>

    <div class="section-head"><h2>ประวัติการถอนเงิน</h2></div>
    ${withdrawals.length ? withdrawals.map(w => `
      <div class="withdraw-row">
        <div><div style="font-weight:700;font-size:13px">฿${w.amount.toLocaleString()}</div><div style="font-size:10.5px;color:var(--ink-400)">${formatDate(w.created_at)}</div></div>
        <span class="wr-status ${w.status === 'รอดำเนินการ' ? 'pending' : w.status === 'โอนเงินแล้ว' ? 'done' : 'rejected'}">${w.status}</span>
      </div>`).join('') : emptyHtml('ยังไม่มีประวัติการถอนเงิน')}
  `;
}
async function submitWithdrawal() {
  const amount = Number(document.getElementById('withdraw-amount-input').value);
  if (!amount || amount < 100) { showToast('จำนวนเงินต้องมากกว่า ฿100'); return; }
  try {
    await api('/bank-account/withdraw', { method: 'POST', body: { amount } });
    showToast('ส่งคำขอถอนเงินสำเร็จ รอการตรวจสอบ');
    loadWithdraw();
  } catch (e) { showToast(e.message); }
}

/* ---- Bank-link modal (used on the ถอนเงิน page, matches the reference popup design) ---- */
function openBankLinkModal() {
  document.getElementById('bl-bank-select').innerHTML = bankSelectOptionsHtml();
  document.getElementById('bl-number-input').value = '';
  document.getElementById('bl-name-input').value = '';
  document.getElementById('bl-error').style.display = 'none';
  document.getElementById('bank-link-modal-overlay').style.display = 'flex';
}
function closeBankLinkModal() {
  document.getElementById('bank-link-modal-overlay').style.display = 'none';
}
async function saveBankLinkModal() {
  const bankName = document.getElementById('bl-bank-select').value;
  const accountNumber = document.getElementById('bl-number-input').value.trim();
  const accountName = document.getElementById('bl-name-input').value.trim();
  const errEl = document.getElementById('bl-error');
  errEl.style.display = 'none';
  if (!bankName || !accountNumber || !accountName) {
    errEl.textContent = 'กรุณากรอกข้อมูลให้ครบ';
    errEl.style.display = 'block';
    return;
  }
  try {
    await api('/bank-account', { method: 'POST', body: { bankName, accountName, accountNumber } });
    closeBankLinkModal();
    showToast('ผูกบัญชีธนาคารสำเร็จ');
    loadWithdraw();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

/* ============ Help Centre ============ */
const HELP_TOPICS = [
  { title: 'วิธีการสั่งซื้อสินค้า', body: 'เลือกสินค้าที่ต้องการ กดเพิ่มลงตะกร้าหรือซื้อเลย จากนั้นยืนยันที่อยู่จัดส่งและช่องทางชำระเงินในหน้าเช็คเอาท์' },
  { title: 'ตรวจสอบสถานะคำสั่งซื้อได้อย่างไร', body: 'ไปที่เมนู "คำสั่งซื้อของฉัน" ในหน้าร้านค้า จะเห็นสถานะล่าสุดของทุกคำสั่งซื้อ' },
  { title: 'วิธีถอนเงินจากกระเป๋าเงิน', body: 'ผูกบัญชีธนาคารในเมนูกระเป๋าเงินก่อน จากนั้นกด "ถอนเงิน" และกรอกจำนวนที่ต้องการ ทีมงานจะดำเนินการภายใน 1-2 วันทำการ' },
  { title: 'ใช้โค้ดส่วนลดอย่างไร', body: 'กรอกโค้ดในช่อง "โค้ดส่วนลด" ตอนเช็คเอาท์ ระบบจะคำนวณส่วนลดให้อัตโนมัติหากโค้ดยังไม่หมดอายุและตรงเงื่อนไข' },
  { title: 'นโยบายการคืนสินค้า', body: 'สามารถแจ้งปัญหาสินค้าผ่านเมนูแชทกับทีมงานได้ภายใน 7 วันหลังได้รับสินค้า' },
];
function renderHelpTopics() {
  const q = (document.getElementById('help-search').value || '').toLowerCase();
  const list = HELP_TOPICS.filter(t => t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q));
  document.getElementById('help-topics-list').innerHTML = list.map(t => `
    <div class="help-topic-item"><h4>${t.title}</h4><p>${t.body}</p></div>`).join('') || emptyHtml('ไม่พบหัวข้อที่ค้นหา');
}

/* ============ Referral / affiliate ============ */
async function loadReferral() {
  try {
    const data = await api('/referrals/me');
    document.getElementById('referral-code-display').textContent = data.referralCode;
    document.getElementById('referral-count').textContent = data.referralCount;
    document.getElementById('referral-earned').textContent = '฿' + data.totalEarned.toLocaleString();
    const el = document.getElementById('referral-list');
    if (!data.referrals.length) { el.innerHTML = emptyHtml('ยังไม่มีเพื่อนที่แนะนำ'); return; }
    el.innerHTML = data.referrals.map(r => `
      <div class="reviewable-card">
        <span>👤 ${r.referred_name}</span>
        <span style="color:var(--success);font-weight:800">+฿${r.reward_amount.toLocaleString()}</span>
      </div>`).join('');
  } catch (e) { showToast(e.message); }
}

function shareReferralCode() {
  const code = document.getElementById('referral-code-display').textContent;
  const text = `มาช้อปที่ Lazmall กับฉันสิ! ใช้รหัสแนะนำเพื่อน "${code}" ตอนสมัครสมาชิก แล้วเราทั้งคู่จะได้รับรางวัล 🎁`;
  if (navigator.share) {
    navigator.share({ title: 'Lazmall', text }).catch(() => {});
  } else {
    navigator.clipboard.writeText(text).then(() => showToast('คัดลอกข้อความแชร์แล้ว')).catch(() => showToast('รหัสของคุณคือ: ' + code));
  }
}

/* ============ Toast ============ */
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// Short "ปี๊ด" beep played once per notification (wallet update, order/ticket
// status change, new store announcement, etc.) while the app is open — generated
// with the Web Audio API so no extra sound file needs to ship with the app.
// Browsers block audio before the user has interacted with the page at all, so
// this silently no-ops on the very first load if that hasn't happened yet.
function playNotifSound() {
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

/* ============ PWA service worker ============ */
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
  // assets are stale — reload once, automatically, so the customer sees the
  // update immediately without ever needing to clear their cache.
  let swRefreshed = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshed) return;
    swRefreshed = true;
    window.location.reload();
  });
}
