/* ============================================================
   ADMIN.JS  —  v1.1
   Config, API, TOTP, Auth, Admin panel, Profile, WhatsApp, Modals

   CHANGELOG v1.1 (2026-10-05):
    - Section 1: API URL auto-detects localhost vs production
    - Section 12: Login flow now uses pendingToken + server-side
      TOTP verification. Client no longer trusts its own TOTP check.
      Compatible with server.js v1.1.
   ============================================================ */

/* ============================================================
   SECTION 1 — CONFIG
   ============================================================ */
/* API URL auto-detects environment:
   - localhost / 127.0.0.1 / *.local → http://localhost:3000
   - everything else                 → production (Render)
   To override, set window.TRADEALGO_API before this script loads. */
const API = window.TRADEALGO_API || (() => {
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) {
    return 'http://localhost:3000';
  }
  return 'https://tradeedge-a5y0.onrender.com';
})();

const APP_URL = 'https://yousuf408.github.io/Tradeedge/frontend/';
const GREEN = 'var(--success)';
const RED = 'var(--danger)';

const DURATIONS = {
  '5d':  { label: '5 days',   days: 5 },
  '7d':  { label: '7 days',   days: 7 },
  '1m':  { label: '1 month',  days: 30 },
  '2m':  { label: '2 months', days: 60 },
  '3m':  { label: '3 months', days: 90 },
  '6m':  { label: '6 months', days: 180 },
  '1y':  { label: '1 year',   days: 365 }
};


/* ============================================================
   SECTION 2 — STATE
   ============================================================ */
let currentUser = null;
let impersonating = false;
let impersonateBackup = null;
let pendingLoginUser = null;
let pendingForgotUser = null;
let editingUsername = null;
let renewingUsername = null;
let renewDelta = 0;

const DOM = {
  pages: document.querySelectorAll('.page'),
  navLinks: document.querySelectorAll('.nav-links a'),
  toast: document.getElementById('toast'),
  toastTitle: document.getElementById('toastTitle'),
  toastMessage: document.getElementById('toastMessage')
};


/* ============================================================
   SECTION 3 — API CLIENT
   ============================================================ */
const getToken = () => localStorage.getItem('ta_token');
const setToken = t => localStorage.setItem('ta_token', t);
const getUser = () => { try { return JSON.parse(localStorage.getItem('ta_user') || 'null'); } catch { return null; } };
const setUser = u => localStorage.setItem('ta_user', JSON.stringify(u));
const clearSession = () => { localStorage.removeItem('ta_token'); localStorage.removeItem('ta_user'); };

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { ...opts, headers });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}


/* ============================================================
   SECTION 4 — TOTP
   (local helpers kept for QR generation; verification is now
    done on the server. Do not rely on these for auth.)
   ============================================================ */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(str) {
  str = str.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const c of str) {
    const v = B32.indexOf(c);
    if (v === -1) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(bytes);
}

async function totpAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint32(4, counter, false);
  const ck = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', ck, buf));
  const off = sig[sig.length - 1] & 0x0f;
  const code = ((sig[off] & 0x7f) << 24) | ((sig[off+1] & 0xff) << 16)
             | ((sig[off+2] & 0xff) << 8)  | (sig[off+3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

/* Kept for optional client-side pre-check. NOT used for auth decisions. */
async function verifyTotp(secret, input) {
  const step = Math.floor(Date.now() / 1000 / 30);
  for (const c of [step - 1, step, step + 1]) {
    if (await totpAt(secret, c) === input) return true;
  }
  return false;
}

function generateSecret() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}


/* ============================================================
   SECTION 5 — CREDENTIALS CACHE (24h, for WhatsApp sharing)
   ============================================================ */
function cacheCredentials(username, password, name, mobile) {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem('ta_cred_cache') || '{}'); } catch {}
  cache[username] = { password, name, mobile, ts: Date.now() };
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const k in cache) if (cache[k].ts < cutoff) delete cache[k];
  localStorage.setItem('ta_cred_cache', JSON.stringify(cache));
}

function getCachedCredentials(username) {
  try {
    const cache = JSON.parse(localStorage.getItem('ta_cred_cache') || '{}');
    return cache[username] || null;
  } catch { return null; }
}


/* ============================================================
   SECTION 6 — TOAST
   ============================================================ */
let toastTimeout = null;

function showToast(title, message) {
  DOM.toastTitle.textContent = title || '✅ Success';
  DOM.toastMessage.textContent = message || 'Action completed';
  DOM.toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => DOM.toast.classList.remove('show'), 5000);
}

function hideToast() {
  DOM.toast.classList.remove('show');
  clearTimeout(toastTimeout);
}


/* ============================================================
   SECTION 7 — MODAL HELPERS
   ============================================================ */
function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
  document.getElementById('avatarMenu')?.classList.remove('open');
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAllModals();
});

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeAllModals();
  });
});


/* ============================================================
   SECTION 8 — NAVIGATION
   ============================================================ */
function navigateTo(pageId) {
  DOM.navLinks.forEach(a => a.classList.toggle('active', a.dataset.page === pageId));
  DOM.pages.forEach(p => p.classList.toggle('active', p.id === 'page-' + pageId));

  if (pageId === 'portfolio' && typeof loadPortfolio === 'function') loadPortfolio();
  if (pageId === 'screener' && typeof initScreener === 'function') initScreener();
  if (pageId === 'settings') loadProfileForm();
  if (pageId === 'users' && currentUser?.role === 'admin' && !impersonating) {
    renderKPIs();
    renderUsers();
    renderAudit();
  }
}

DOM.navLinks.forEach(link => link.addEventListener('click', e => {
  e.preventDefault();
  const p = link.getAttribute('data-page');
  if (p) navigateTo(p);
}));


/* ============================================================
   SECTION 9 — AVATAR MENU
   ============================================================ */
function toggleAvatarMenu(e) {
  e.stopPropagation();
  document.getElementById('avatarMenu').classList.toggle('open');
}
document.addEventListener('click', () =>
  document.getElementById('avatarMenu')?.classList.remove('open')
);


/* ============================================================
   SECTION 10 — CHANGE PASSWORD
   ============================================================ */
function openChangePassword() {
  closeAllModals();
  document.getElementById('pwdCurrent').value = '';
  document.getElementById('pwdNew').value = '';
  document.getElementById('pwdConfirm').value = '';
  document.getElementById('pwdError').textContent = '';
  document.getElementById('pwdModal').classList.add('open');
  setTimeout(() => document.getElementById('pwdCurrent').focus(), 100);
}

async function savePassword() {
  const cur = document.getElementById('pwdCurrent').value;
  const nw  = document.getElementById('pwdNew').value;
  const cf  = document.getElementById('pwdConfirm').value;
  const err = document.getElementById('pwdError');
  err.textContent = '';

  if (!cur || !nw || !cf) { err.textContent = 'All fields required'; return; }
  if (nw.length < 6)      { err.textContent = 'Password must be 6+ characters'; return; }
  if (nw !== cf)          { err.textContent = 'Passwords do not match'; return; }
  if (nw === cur)         { err.textContent = 'Must differ from current'; return; }

  try {
    const r = await api('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: cur, newPassword: nw })
    });
    if (r.token) {
      setToken(r.token);
      const u = getUser();
      if (u) { u.sessionId = r.sessionId; setUser(u); }
    }
    closeAllModals();
    showToast('✅ Updated', 'Password changed. Other devices logged out.');
  } catch (e) {
    err.textContent = e.message;
  }
}


/* ============================================================
   SECTION 11 — MY PROFILE
   ============================================================ */
function openMyProfile() {
  closeAllModals();
  navigateTo('settings');
  setTimeout(() => document.getElementById('profileName')?.focus(), 200);
}

function loadProfileForm() {
  if (!currentUser) return;
  document.getElementById('profileName').value = currentUser.name || '';
  document.getElementById('profileMobile').value = currentUser.mobile || '';
  document.getElementById('profileUsername').value = currentUser.username || '';
  document.getElementById('profileRole').value = (currentUser.role || '').toUpperCase();
}

async function saveProfile() {
  const name = document.getElementById('profileName').value.trim();
  const mobile = document.getElementById('profileMobile').value.trim();

  if (!name) { showToast('⚠️ Missing', 'Name is required'); return; }
  if (mobile && mobile.replace(/\D/g, '').length < 10) {
    showToast('⚠️ Invalid', 'Mobile must be 10 digits'); return;
  }

  try {
    const r = await api('/api/me', {
      method: 'PUT',
      body: JSON.stringify({ name, mobile })
    });
    currentUser.name = r.name;
    currentUser.mobile = r.mobile;
    setUser(currentUser);
    updateUserPill();
    showToast('✅ Saved', 'Profile updated');
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }
}

function updateUserPill() {
  const pill = document.getElementById('userPillName');
  if (pill) pill.textContent = currentUser?.name || 'User';
  const an = document.getElementById('avatarName');
  if (an) an.textContent = currentUser?.name || '—';
  const ar = document.getElementById('avatarRole');
  if (ar) ar.textContent = currentUser?.role || '—';
}


/* ============================================================
   SECTION 12 — LOGIN FLOW  (v1.1 — pendingToken + server TOTP)
   ============================================================ */
function showLoginStep(step) {
  document.getElementById('loginStep1').style.display = step === 1 ? 'block' : 'none';
  document.getElementById('loginStep2Verify').style.display = step === 'verify' ? 'block' : 'none';
  document.getElementById('loginStep2Setup').style.display = step === 'setup' ? 'block' : 'none';
  document.getElementById('forgotStep1').style.display = 'none';
  document.getElementById('forgotStep2').style.display = 'none';
}

/* Step 1 — password only. Server returns pendingToken (5 min)
   plus needsSetup flag. No TOTP secret is ever sent to client. */
async function doLogin() {
  const input = document.getElementById('authUser').value.trim();
  const password = document.getElementById('authPass').value;
  const err = document.getElementById('authError');
  err.textContent = '';
  if (!input || !password) { err.textContent = 'Enter credentials'; return; }

  try {
    const r = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ input, password })
    });

    if (!r.pendingToken) {
      err.textContent = 'Login failed. Please try again.';
      return;
    }

    pendingLoginUser = {
      pendingToken: r.pendingToken,
      username: r.username,
      name: r.name,
      needsSetup: r.needsSetup,
      newSecret: null
    };

    if (r.needsSetup) {
      /* First-time 2FA setup — generate secret locally, show QR,
         but the code is verified by the SERVER on submit. */
      const secret = generateSecret();
      pendingLoginUser.newSecret = secret;
      const uri = `otpauth://totp/TradeAlgo:${r.username}?secret=${secret}&issuer=TradeAlgo`;
      document.getElementById('setupQR').src =
        `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(uri)}`;
      document.getElementById('setupSecret').value = secret;
      document.getElementById('setupCode').value = '';
      document.getElementById('setupError').textContent = '';
      showLoginStep('setup');
      setTimeout(() => document.getElementById('setupCode').focus(), 100);
    } else {
      document.getElementById('authTotp').value = '';
      document.getElementById('authTotpError').textContent = '';
      showLoginStep('verify');
      setTimeout(() => document.getElementById('authTotp').focus(), 100);
    }
  } catch (e) {
    if (e.data?.expired) { showExpired({ name: input, expiresAt: e.data.expiresAt }); return; }
    err.textContent = e.message;
  }
}

/* Step 2a — existing user enters 6-digit code.
   Server verifies against stored secret; no local check. */
async function verifyLoginTotp() {
  const code = document.getElementById('authTotp').value.trim();
  const err = document.getElementById('authTotpError');
  err.textContent = '';
  if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter 6 digits'; return; }
  if (!pendingLoginUser?.pendingToken) {
    err.textContent = 'Session expired. Please sign in again.';
    showLoginStep(1);
    return;
  }

  await completeLogin({
    pendingToken: pendingLoginUser.pendingToken,
    totpCode: code
  });
}

/* Step 2b — first-time setup. Send secret + code to server.
   Server verifies code against newSecret, then stores it. */
async function confirmSetup() {
  const code = document.getElementById('setupCode').value.trim();
  const err = document.getElementById('setupError');
  err.textContent = '';
  if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter 6 digits'; return; }
  if (!pendingLoginUser?.pendingToken || !pendingLoginUser?.newSecret) {
    err.textContent = 'Session expired. Please sign in again.';
    showLoginStep(1);
    return;
  }

  await completeLogin({
    pendingToken: pendingLoginUser.pendingToken,
    totpSecret: pendingLoginUser.newSecret,
    totpCode: code
  });
}

/* Step 3 — exchange verified pending login for a session JWT. */
async function completeLogin(payload) {
  try {
    const r = await api('/api/complete-login', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    setToken(r.token);
    setUser(r.user);
    currentUser = r.user;
    pendingLoginUser = null;
    showLoginStep(1);
    showApp();

    if (r.user.role !== 'admin' && r.user.expiresAt) {
      const dl = Math.ceil((new Date(r.user.expiresAt) - Date.now()) / 86400000);
      if (dl <= 7) {
        setTimeout(() => showToast('⚠️ Expiring Soon', `Expires in ${dl} day${dl === 1 ? '' : 's'}`), 500);
      }
    }
  } catch (e) {
    /* Route the error back to whichever step is showing */
    if (pendingLoginUser?.needsSetup) {
      document.getElementById('setupError').textContent = e.message;
    } else {
      document.getElementById('authTotpError').textContent = e.message;
      if (e.status === 401 && /expired|session/i.test(e.message)) {
        /* Pending token expired — send user back to step 1 */
        setTimeout(() => { cancelTotp(); }, 1500);
      }
    }
  }
}

function cancelTotp() {
  pendingLoginUser = null;
  showLoginStep(1);
  document.getElementById('authUser').value = '';
  document.getElementById('authPass').value = '';
}


/* ============================================================
   SECTION 13 — FORGOT PASSWORD  (unchanged — server verifies)
   ============================================================ */
function showForgotStep(step) {
  document.getElementById('loginStep1').style.display = 'none';
  document.getElementById('loginStep2Verify').style.display = 'none';
  document.getElementById('loginStep2Setup').style.display = 'none';
  document.getElementById('forgotStep1').style.display = step === 1 ? 'block' : 'none';
  document.getElementById('forgotStep2').style.display = step === 2 ? 'block' : 'none';
  if (step === 1) {
    document.getElementById('forgotError').textContent = '';
    setTimeout(() => document.getElementById('forgotInput').focus(), 100);
  } else {
    document.getElementById('forgotError2').textContent = '';
  }
}

async function forgotCheck() {
  const input = document.getElementById('forgotInput').value.trim();
  const err = document.getElementById('forgotError');
  err.textContent = '';
  if (!input) { err.textContent = 'Enter username or mobile'; return; }

  try {
    const r = await api('/api/forgot-password/check', {
      method: 'POST',
      body: JSON.stringify({ input })
    });
    pendingForgotUser = { input, username: r.username, name: r.name };
    document.getElementById('forgotUserLabel').textContent = `Reset for ${r.name} (${r.username})`;
    document.getElementById('forgotTotp').value = '';
    document.getElementById('forgotNew').value = '';
    document.getElementById('forgotConfirm').value = '';
    showForgotStep(2);
  } catch (e) {
    err.textContent = e.message;
  }
}

async function forgotReset() {
  const totp = document.getElementById('forgotTotp').value.trim();
  const nw   = document.getElementById('forgotNew').value;
  const cf   = document.getElementById('forgotConfirm').value;
  const err  = document.getElementById('forgotError2');
  err.textContent = '';

  if (!/^\d{6}$/.test(totp)) { err.textContent = 'Enter 6-digit code'; return; }
  if (nw.length < 6)         { err.textContent = 'Password must be 6+ characters'; return; }
  if (nw !== cf)             { err.textContent = 'Passwords do not match'; return; }
  if (!pendingForgotUser)    { err.textContent = 'Session lost, retry'; return; }

  try {
    await api('/api/forgot-password/reset', {
      method: 'POST',
      body: JSON.stringify({
        input: pendingForgotUser.input,
        totpCode: totp,
        newPassword: nw
      })
    });
    pendingForgotUser = null;
    showLoginStep(1);
    document.getElementById('authUser').value = '';
    document.getElementById('authPass').value = '';
    showToast('✅ Password Reset', 'Login with your new password');
  } catch (e) {
    err.textContent = e.message;
  }
}


/* ============================================================
   SECTION 14 — LOGOUT & SCREENS
   ============================================================ */
function logout() {
  const token = getToken();
  if (token) api('/api/logout', { method: 'POST' }).catch(() => {});
  currentUser = null;
  impersonating = false;
  impersonateBackup = null;
  clearSession();
  document.body.classList.remove('impersonating');
  document.getElementById('impersonateBanner').style.display = 'none';
  document.getElementById('authUser').value = '';
  document.getElementById('authPass').value = '';
  document.getElementById('authError').textContent = '';
  showLoginStep(1);
  navigateTo('screener');
  showLogin();
}

function showLogin() {
  document.body.classList.add('logged-out');
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('expiredScreen').style.display = 'none';
}

function showExpired(user) {
  document.body.classList.add('logged-out');
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('expiredScreen').style.display = 'flex';
  document.getElementById('expiredMsg').innerHTML =
    `Hi <strong>${user.name}</strong>, your subscription expired on ` +
    `<strong>${user.expiresAt}</strong>.<br>Please contact admin to renew.`;
}

function showApp() {
  document.body.classList.remove('logged-out');
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('expiredScreen').style.display = 'none';

  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = (currentUser.role === 'admin' && !impersonating) ? '' : 'none';
  });

  updateUserPill();

  if (impersonating) {
    document.body.classList.add('impersonating');
    document.getElementById('impersonateBanner').style.display = 'flex';
    document.getElementById('impersonateName').textContent = currentUser.name;
  } else {
    document.body.classList.remove('impersonating');
    document.getElementById('impersonateBanner').style.display = 'none';
  }

  if (currentUser.role === 'admin' && !impersonating) {
    renderKPIs(); renderUsers(); loadPrices(); renderAudit();
  }
  navigateTo('screener');

  if (!window._expiryTimer) {
    window._expiryTimer = setInterval(async () => {
      if (!currentUser || impersonating) return;
      try { await api('/api/session-check'); }
      catch (e) {
        if (e.status === 401) {
          showToast('⛔ Session Ended', e.message || 'Logged in elsewhere');
          setTimeout(logout, 1500);
        }
      }
    }, 30000);
  }
}


/* ============================================================
   SECTION 15 — TABS
   ============================================================ */
function switchTab(name, e) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  e.target.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'audit') renderAudit();
  if (name === 'prices') loadPrices();
  if (name === 'holidays') renderHolidays();
}


/* ============================================================
   SECTION 16 — ADMIN: KPIs
   ============================================================ */
async function renderKPIs() {
  try {
    const users = (await api('/api/users')).filter(u => u.role !== 'admin');
    const prices = await api('/api/prices');
    const total = users.length;
    const activeToday = users.filter(u =>
      u.lastActive && new Date(u.lastActive).toDateString() === new Date().toDateString()
    ).length;
    const expiring = users.filter(u => {
      if (!u.expiresAt) return false;
      const d = Math.ceil((new Date(u.expiresAt) - Date.now()) / 86400000);
      return d > 0 && d <= 7;
    }).length;
    const expired = users.filter(u => u.expiresAt && new Date(u.expiresAt) < new Date()).length;
    const mrr = users
      .filter(u => u.expiresAt && new Date(u.expiresAt) > new Date() && !u.disabled)
      .reduce((s, u) => s + (prices[u.plan] || 0), 0);

    document.getElementById('adminKPIs').innerHTML = `
      <div class="stat-box"><div class="label">👥 Total Users</div><div class="value">${total}</div><div class="sub">All registered</div></div>
      <div class="stat-box"><div class="label">🟢 Active Today</div><div class="value">${activeToday}</div><div class="sub green">Logged in today</div></div>
      <div class="stat-box"><div class="label">⏰ Expiring (7d)</div><div class="value">${expiring}</div><div class="sub warn">Renew soon</div></div>
      <div class="stat-box"><div class="label">🔴 Expired</div><div class="value">${expired}</div><div class="sub red">Need renewal</div></div>
      <div class="stat-box"><div class="label">💰 MRR</div><div class="value">₹${mrr.toLocaleString()}</div><div class="sub green">Monthly revenue</div></div>`;
  } catch {}
}


/* ============================================================
   SECTION 17 — ADMIN: USERS TABLE
   ============================================================ */
async function renderUsers() {
  const search = (document.getElementById('userSearch')?.value || '').toLowerCase();
  const filter = document.getElementById('userFilter')?.value || 'all';

  try {
    let list = await api('/api/users');

    if (search) {
      list = list.filter(u =>
        u.name.toLowerCase().includes(search) ||
        u.username.includes(search) ||
        (u.mobile || '').includes(search)
      );
    }
    const now = Date.now();
    const dleft = e => e ? Math.ceil((new Date(e) - now) / 86400000) : Infinity;
    if (filter === 'active')   list = list.filter(u => u.role !== 'admin' && !u.disabled && dleft(u.expiresAt) > 0);
    if (filter === 'expiring') list = list.filter(u => { const d = dleft(u.expiresAt); return d > 0 && d <= 7; });
    if (filter === 'expired')  list = list.filter(u => u.role !== 'admin' && dleft(u.expiresAt) <= 0);
    if (filter === 'disabled') list = list.filter(u => u.disabled);

    if (!list.length) {
      document.getElementById('usersTable').innerHTML =
        '<div style="text-align:center;padding:40px;color:var(--text-muted)">No users match filters.</div>';
      return;
    }

    const rows = list.map(u => {
      const dl = dleft(u.expiresAt);
      let daysText, color;
      if (u.role === 'admin') { daysText = '—';         color = 'var(--text-muted)'; }
      else if (u.disabled)    { daysText = 'Disabled';  color = 'var(--text-muted)'; }
      else if (dl <= 0)       { daysText = 'Expired';   color = 'var(--text-muted)'; }
      else if (dl <= 7)       { daysText = `${dl} days`; color = 'var(--danger)'; }
      else if (dl <= 30)      { daysText = `${dl} days`; color = 'var(--warning)'; }
      else                    { daysText = `${dl} days`; color = 'var(--success)'; }

      const isAdmin = u.role === 'admin';
      return `<tr class="${u.disabled ? 'row-disabled' : ''}">
        <td>
          <strong>${u.name}</strong>
          ${isAdmin ? '<span style="font-size:10px;background:#6C5CE7;color:#fff;padding:2px 6px;border-radius:6px;margin-left:6px">ADMIN</span>' : ''}
          ${u.mobile ? `<br><span style="font-size:11px;color:var(--text-muted)">📱 ${u.mobile}</span>` : ''}
        </td>
        <td>${u.username}</td>
        <td>${u.plan || '—'}</td>
        <td>${u.expiresAt ? String(u.expiresAt).slice(0, 10) : '—'}</td>
        <td style="color:${color};font-weight:600">${daysText}</td>
        <td class="actions-cell">
          ${isAdmin ? '<span style="color:var(--text-muted);font-size:11px">—</span>' : `
            <button class="btn btn-outline btn-sm" onclick="impersonate('${u.username}')">👁️ View</button>
            <button class="btn btn-outline btn-sm" onclick="openEditUser('${u.username}')">✏️ Edit</button>
            <button class="btn btn-primary btn-sm" onclick="openRenew('${u.username}')">🔄 Renew</button>
            <button class="btn btn-warn btn-sm" onclick="resetPassword('${u.username}')">🔑 Reset</button>
            <button class="btn btn-outline btn-sm" onclick="toggleDisable('${u.username}')">${u.disabled ? '✅ Enable' : '⏸️ Disable'}</button>
            <button class="btn btn-success btn-sm" onclick="openWhatsApp('${u.username}')">📱 WhatsApp</button>
            <button class="btn btn-danger btn-sm" onclick="deleteUser('${u.username}')">🗑️ Delete</button>`}
        </td>
      </tr>`;
    }).join('');

    document.getElementById('usersTable').innerHTML = `
      <table class="table-modern">
        <thead><tr>
          <th>Name</th><th>Username</th><th>Plan</th><th>Expires</th>
          <th>Days Left</th><th>Actions</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } catch (e) {
    document.getElementById('usersTable').innerHTML = `<div style="color:var(--danger)">${e.message}</div>`;
  }
}


/* ============================================================
   SECTION 18 — ADMIN: CREATE USER
   ============================================================ */
async function addUser() {
  const name = document.getElementById('newName').value.trim();
  const mobile = document.getElementById('newMobile').value.replace(/\D/g, '');
  const plan = document.getElementById('newPlan').value;
  const durKey = document.getElementById('newDuration').value;

  if (!name || !mobile) { showToast('⚠️ Missing Fields', 'Name and mobile required'); return; }
  if (mobile.length < 10) { showToast('⚠️ Invalid Mobile', 'Enter 10-digit mobile'); return; }

  const days = DURATIONS[durKey].days;
  const d = new Date(); d.setDate(d.getDate() + days);
  const expiresAt = d.toISOString().split('T')[0];

  try {
    const r = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ name, mobile, plan, expiresAt })
    });
    cacheCredentials(r.username, r.password, name, mobile);
    document.getElementById('newName').value = '';
    document.getElementById('newMobile').value = '';
    renderUsers();
    renderKPIs();

    const box = document.getElementById('tab-users');
    let banner = document.getElementById('credBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'credBanner';
      box.querySelector('.panel-glass').after(banner);
    }
    banner.innerHTML = `
      <div style="padding:16px 20px;background:rgba(0,184,148,0.08);border-radius:12px;margin-bottom:20px;border:1px solid rgba(0,184,148,0.2)">
        <div style="font-weight:700;margin-bottom:8px">✅ Credentials for ${name}</div>
        <div style="font-size:13px;line-height:1.9">
          <strong>Username:</strong> <code style="background:#fff;padding:2px 8px;border-radius:6px">${r.username}</code><br>
          <strong>Password:</strong> <code style="background:#fff;padding:2px 8px;border-radius:6px">${r.password}</code>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-success btn-sm" onclick="openWhatsApp('${r.username}')">📱 Send via WhatsApp</button>
          <button class="btn btn-outline btn-sm" onclick="document.getElementById('credBanner').remove()">✕ Close</button>
        </div>
      </div>`;
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }
}


/* ============================================================
   SECTION 19 — ADMIN: EDIT USER
   ============================================================ */
async function openEditUser(username) {
  try {
    const all = await api('/api/users');
    const u = all.find(x => x.username === username);
    if (!u) return;

    editingUsername = username;
    document.getElementById('editUserSub').textContent = `Editing ${u.username}`;
    document.getElementById('editName').value = u.name || '';
    document.getElementById('editMobile').value = u.mobile || '';
    document.getElementById('editPlan').value = u.plan || 'Demo';
    document.getElementById('editRole').value = u.role || 'user';
    document.getElementById('editError').textContent = '';
    document.getElementById('editUserModal').classList.add('open');
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }
}

function closeEditUser() {
  document.getElementById('editUserModal').classList.remove('open');
  editingUsername = null;
}

async function saveEditUser() {
  if (!editingUsername) return;
  const name = document.getElementById('editName').value.trim();
  const mobile = document.getElementById('editMobile').value.trim();
  const plan = document.getElementById('editPlan').value;
  const role = document.getElementById('editRole').value;
  const err = document.getElementById('editError');
  err.textContent = '';

  if (!name) { err.textContent = 'Name is required'; return; }
  if (mobile && mobile.replace(/\D/g, '').length < 10) {
    err.textContent = 'Mobile must be 10 digits'; return;
  }

  try {
    await api(`/api/users/${editingUsername}`, {
      method: 'PUT',
      body: JSON.stringify({ name, mobile, plan, role })
    });
    closeEditUser();
    renderUsers();
    renderKPIs();
    showToast('✅ Saved', 'User updated');
  } catch (e) {
    err.textContent = e.message;
  }
}


/* ============================================================
   SECTION 20 — ADMIN: RENEW MODAL
   ============================================================ */
async function openRenew(username) {
  try {
    const all = await api('/api/users');
    const u = all.find(x => x.username === username);
    if (!u) return;

    renewingUsername = username;
    renewDelta = 0;
    document.getElementById('renewSub').textContent = `Adjusting ${u.name} (${u.username})`;
    document.getElementById('renewCurrent').textContent =
      u.expiresAt ? String(u.expiresAt).slice(0, 10) : 'No expiry';

    document.querySelectorAll('#renewAddChips .chip, #renewSubChips .chip').forEach(c => c.classList.remove('active'));
    document.getElementById('renewCustomDate').value = '';
    document.getElementById('renewError').textContent = '';

    window._renewBase = u.expiresAt ? new Date(u.expiresAt) : new Date();
    updateRenewPreview();

    document.getElementById('renewModal').classList.add('open');
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }
}

function closeRenew() {
  document.getElementById('renewModal').classList.remove('open');
  renewingUsername = null;
  renewDelta = 0;
}

document.querySelectorAll('#renewAddChips .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const days = +chip.dataset.days;
    renewDelta += days;
    chip.classList.add('active');
    document.getElementById('renewCustomDate').value = '';
    updateRenewPreview();
  });
});

document.querySelectorAll('#renewSubChips .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const days = +chip.dataset.days;
    renewDelta -= days;
    chip.classList.add('active');
    document.getElementById('renewCustomDate').value = '';
    updateRenewPreview();
  });
});

document.getElementById('renewCustomDate')?.addEventListener('change', () => {
  document.querySelectorAll('#renewAddChips .chip, #renewSubChips .chip').forEach(c => c.classList.remove('active'));
  renewDelta = 0;
  updateRenewPreview();
});

function updateRenewPreview() {
  const custom = document.getElementById('renewCustomDate').value;
  const preview = document.getElementById('renewPreview');

  if (custom) {
    preview.textContent = custom;
    return;
  }
  if (!renewDelta) {
    preview.textContent = 'No change';
    return;
  }
  const base = new Date(window._renewBase);
  base.setDate(base.getDate() + renewDelta);
  preview.textContent = base.toISOString().split('T')[0];
}

async function saveRenew() {
  if (!renewingUsername) return;
  const err = document.getElementById('renewError');
  const custom = document.getElementById('renewCustomDate').value;
  err.textContent = '';

  if (!custom && renewDelta === 0) {
    err.textContent = 'Pick a duration or date';
    return;
  }

  try {
    if (custom) {
      await api(`/api/users/${renewingUsername}/set-expiry`, {
        method: 'POST',
        body: JSON.stringify({ expiresAt: custom })
      });
      showToast('✅ Updated', `Expiry set to ${custom}`);
    } else {
      await api(`/api/users/${renewingUsername}/renew`, {
        method: 'POST',
        body: JSON.stringify({ days: renewDelta })
      });
      showToast('✅ Updated', `${renewDelta > 0 ? '+' : ''}${renewDelta} days`);
    }
    closeRenew();
    renderUsers();
    renderKPIs();
  } catch (e) {
    err.textContent = e.message;
  }
}


/* ============================================================
   SECTION 21 — ADMIN: DELETE / DISABLE / RESET
   ============================================================ */
async function deleteUser(username) {
  if (!confirm(`Delete user "${username}"?`)) return;
  try {
    await api(`/api/users/${username}`, { method: 'DELETE' });
    renderUsers(); renderKPIs();
    showToast('🗑️ Deleted', username);
  } catch (e) { showToast('⚠️ Error', e.message); }
}

async function toggleDisable(username) {
  try {
    await api(`/api/users/${username}/disable`, { method: 'POST' });
    renderUsers();
    showToast('✅ Done', 'Status updated');
  } catch (e) { showToast('⚠️ Error', e.message); }
}

async function resetPassword(username) {
  if (!confirm(`Reset password + 2FA for "${username}"?`)) return;
  try {
    const r = await api(`/api/users/${username}/reset`, { method: 'POST' });
    const cred = getCachedCredentials(username);
    cacheCredentials(username, r.temp, cred?.name || username, cred?.mobile || '');
    renderUsers();
    showToast('🔑 New Password', `${username}: ${r.temp}`);
  } catch (e) { showToast('⚠️ Error', e.message); }
}


/* ============================================================
   SECTION 22 — WHATSAPP SHARING
   ============================================================ */
async function openWhatsApp(username) {
  let cred = getCachedCredentials(username);

  if (!cred || !cred.password) {
    if (!confirm(`No password cached for "${username}".\n\nReset password now and share?`)) return;
    try {
      const r = await api(`/api/users/${username}/reset`, { method: 'POST' });
      const all = await api('/api/users');
      const u = all.find(x => x.username === username);
      cacheCredentials(username, r.temp, u?.name || username, u?.mobile || '');
      cred = { password: r.temp, name: u?.name || username, mobile: u?.mobile || '' };
      renderUsers();
      showToast('🔑 Reset Done', `New password: ${r.temp}`);
    } catch (e) {
      showToast('⚠️ Error', e.message);
      return;
    }
  }

  const mobile = (cred.mobile || '').replace(/\D/g, '');
  if (mobile.length < 10) { showToast('⚠️ No Mobile', 'User has no mobile number'); return; }

  const msg =
`Hi ${cred.name}, your TradeAlgo Pro account is ready!

Login: ${APP_URL}
Username: ${username}
Password: ${cred.password}

Please change your password after your first login.`;

  window.open(`https://wa.me/91${mobile}?text=${encodeURIComponent(msg)}`, '_blank');
}


/* ============================================================
   SECTION 23 — ADMIN: IMPERSONATE
   ============================================================ */
async function impersonate(username) {
  if (!confirm(`View as "${username}"?`)) return;
  impersonateBackup = { user: currentUser, token: getToken() };
  impersonating = true;
  const all = await api('/api/users');
  const u = all.find(x => x.username === username);
  if (!u) return;
  currentUser = { ...currentUser, name: u.name, username: u.username, role: u.role, mobile: u.mobile };
  showApp();
  showToast('👁️ Viewing', `As ${u.name}`);
}

function exitImpersonate() {
  if (!impersonateBackup) { logout(); return; }
  impersonating = false;
  currentUser = impersonateBackup.user;
  impersonateBackup = null;
  showApp();
  showToast('✅ Exited', 'Back to admin');
}


/* ============================================================
   SECTION 24 — ADMIN: BULK IMPORT USERS
   ============================================================ */
function loadSampleCSV() {
  document.getElementById('csvInput').value =
`Ravi Kumar,9876543210,1m
Priya Sharma,9876543211,3m
Rahul Verma,9876543212,5d`;
}

async function bulkImport() {
  const raw = document.getElementById('csvInput').value.trim();
  if (!raw) { showToast('⚠️ Empty', 'Paste CSV first'); return; }

  const lines = raw.split('\n').filter(l => l.trim());
  const created = [];
  let fail = 0;
  const errors = [];

  for (const line of lines) {
    const p = line.split(',').map(s => s.trim());
    if (p.length < 3) { fail++; errors.push(`Bad format: ${line}`); continue; }

    const [name, mobileRaw, durCode] = p;
    const mobile = (mobileRaw || '').replace(/\D/g, '');
    const dur = DURATIONS[durCode];
    if (!name || mobile.length < 10 || !dur) { fail++; errors.push(`Invalid: ${line}`); continue; }

    const d = new Date(); d.setDate(d.getDate() + dur.days);
    const expiresAt = d.toISOString().split('T')[0];

    try {
      const r = await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({ name, mobile, plan: 'Pro', expiresAt })
      });
      cacheCredentials(r.username, r.password, name, mobile);
      created.push({ name, mobile, username: r.username, password: r.password });
    } catch (e) {
      fail++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  renderUsers();
  renderKPIs();

  document.getElementById('importResult').innerHTML = `
    <div style="padding:16px 20px;background:${created.length ? 'rgba(0,184,148,0.08)' : 'rgba(225,112,85,0.08)'};border-radius:12px;border:1px solid ${created.length ? 'rgba(0,184,148,0.2)' : 'rgba(225,112,85,0.2)'}">
      <strong>✅ ${created.length} created</strong>${fail ? ` · <strong style="color:var(--danger)">${fail} failed</strong>` : ''}
      ${errors.length ? `<div style="margin-top:10px;font-size:12px;color:var(--text-muted)">${errors.slice(0, 5).map(e => `• ${e}`).join('<br>')}</div>` : ''}
      ${created.length ? `<div style="margin-top:14px"><button class="btn btn-primary btn-sm" onclick="downloadCredentials()">📥 Download Credentials CSV</button></div>` : ''}
    </div>`;

  if (created.length) {
    window._lastImportCreds = created;
    document.getElementById('csvInput').value = '';
  }
  showToast('📥 Import Done', `${created.length} created, ${fail} failed`);
}

function downloadCredentials() {
  const creds = window._lastImportCreds || [];
  if (!creds.length) return;
  const header = 'Name,Mobile,Username,Password\n';
  const rows = creds.map(c => [c.name, c.mobile, c.username, c.password].join(',')).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `credentials_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📥 Downloaded', `${creds.length} credentials`);
}


/* ============================================================
   SECTION 25 — ADMIN: AUDIT LOG
   ============================================================ */
async function renderAudit() {
  const box = document.getElementById('auditLog');
  if (!box) return;
  try {
    const rows = await api('/api/audit');
    if (!rows.length) {
      box.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">No activity yet.</div>';
      return;
    }
    const badgeFor = lvl =>
      ({ success: 'badge-success', danger: 'badge-danger', warn: 'badge-warn' }[lvl] || 'badge-info');
    box.innerHTML = rows.map(e => `
      <div class="audit-row">
        <div class="audit-time">${new Date(e.created_at).toLocaleString()}</div>
        <div class="audit-actor">${e.actor}</div>
        <div class="audit-action"><span class="audit-badge ${badgeFor(e.level)}">${e.action}</span></div>
        <div class="audit-details">${e.details || ''}</div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div style="color:var(--danger)">${e.message}</div>`;
  }
}

async function clearAudit() {
  if (!confirm('Clear entire audit log?')) return;
  try {
    await api('/api/audit', { method: 'DELETE' });
    renderAudit();
    showToast('🗑️ Cleared', 'Audit log cleared');
  } catch (e) { showToast('⚠️ Error', e.message); }
}


/* ============================================================
   SECTION 26 — ADMIN: PRICING
   ============================================================ */
async function loadPrices() {
  try {
    const p = await api('/api/prices');
    document.getElementById('priceDemo').value = p.Demo || 0;
    document.getElementById('pricePro').value = p.Pro || 0;
  } catch {}
}

async function savePrices() {
  const p = {
    Demo: +document.getElementById('priceDemo').value || 0,
    Pro: +document.getElementById('pricePro').value || 0
  };
  try {
    await api('/api/prices', { method: 'PUT', body: JSON.stringify(p) });
    renderKPIs();
    showToast('✅ Saved', 'Plan prices updated');
  } catch (e) { showToast('⚠️ Error', e.message); }
}


/* ============================================================
   SECTION 27 — ADMIN: EXPORT USERS CSV
   ============================================================ */
async function exportUsersCSV() {
  try {
    const users = await api('/api/users');
    const header = 'Name,Username,Mobile,Role,Plan,Expires,Status\n';
    const rows = users.map(u => {
      const status = u.disabled ? 'Disabled'
        : (u.expiresAt && new Date(u.expiresAt) < new Date() ? 'Expired' : 'Active');
      return [u.name, u.username, u.mobile || '-', u.role, u.plan || '-',
        u.expiresAt ? String(u.expiresAt).slice(0, 10) : '-', status].join(',');
    }).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `users_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('📥 Exported', `${users.length} users`);
  } catch (e) { showToast('⚠️ Error', e.message); }
}


/* ============================================================
   SECTION 28 — ADMIN: TRADING HOLIDAYS (bulk management)
   ============================================================ */
async function renderHolidays() {
  const box = document.getElementById('holidaysTable');
  if (!box) return;
  try {
    const rows = await api('/api/admin/holidays');
    if (!rows.length) {
      box.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">No holidays yet. Add above.</div>';
      return;
    }
    box.innerHTML = `
      <table class="table-modern">
        <thead><tr>
          <th style="width:40px"><input type="checkbox" id="hCheckAll" onclick="toggleAllHolidayChecks(this.checked)" /></th>
          <th>Date</th>
          <th>Day</th>
          <th>Reason</th>
          <th>Action</th>
        </tr></thead>
        <tbody>${rows.map(h => {
          const day = new Date(h.date + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'long' });
          return `<tr>
            <td><input type="checkbox" class="holiday-check" value="${h.date}" /></td>
            <td><strong>${h.date}</strong></td>
            <td>${day}</td>
            <td>${h.reason || '—'}</td>
            <td><button class="btn btn-danger btn-sm" onclick="deleteHoliday('${h.date}')">🗑️</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  } catch (e) {
    box.innerHTML = `<div style="color:var(--danger)">${e.message}</div>`;
  }
}

function toggleAllHolidayChecks(checked) {
  document.querySelectorAll('.holiday-check').forEach(c => c.checked = checked);
}

async function bulkAddHolidays() {
  const raw = document.getElementById('holidayBulkInput').value.trim();
  if (!raw) { showToast('⚠️ Empty', 'Paste holiday list first'); return; }

  const lines = raw.split('\n').filter(l => l.trim());
  let ok = 0, fail = 0;
  const errors = [];

  const btn = event?.target;
  const orig = btn?.textContent;
  if (btn) { btn.textContent = '⏳ Adding...'; btn.disabled = true; }

  for (const line of lines) {
    const [datePart, ...reasonParts] = line.split(',');
    const date = (datePart || '').trim();
    const reason = reasonParts.join(',').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      fail++; errors.push(`Bad date: ${line}`); continue;
    }
    try {
      await api('/api/admin/holidays', {
        method: 'POST',
        body: JSON.stringify({ date, reason })
      });
      ok++;
    } catch (e) { fail++; errors.push(`${date}: ${e.message}`); }
  }

  if (btn) { btn.textContent = orig; btn.disabled = false; }

  document.getElementById('holidayResult').innerHTML = `
    <div style="padding:14px 18px;background:${ok ? 'rgba(0,184,148,0.1)' : 'rgba(225,112,85,0.1)'};border-radius:10px">
      <strong>✅ ${ok} added/updated</strong>${fail ? ` · <strong style="color:var(--danger)">${fail} failed</strong>` : ''}
      ${errors.length ? `<div style="margin-top:10px;font-size:12px;color:var(--text-muted)">${errors.slice(0,5).map(e => `• ${e}`).join('<br>')}</div>` : ''}
    </div>`;

  if (ok) document.getElementById('holidayBulkInput').value = '';
  renderHolidays();
  showToast('📥 Holidays', `${ok} added, ${fail} failed`);
}

async function loadCurrentHolidaysIntoInput() {
  try {
    const rows = await api('/api/admin/holidays');
    document.getElementById('holidayBulkInput').value =
      rows.map(h => `${h.date},${h.reason || ''}`).join('\n');
    showToast('📄 Loaded', `${rows.length} holidays in editor`);
  } catch (e) { showToast('⚠️ Error', e.message); }
}

function loadSampleHolidays() {
  document.getElementById('holidayBulkInput').value =
`2026-01-26,Republic Day
2026-02-26,Mahashivratri
2026-03-04,Holi
2026-03-21,Id-Ul-Fitr
2026-04-01,Annual Bank Closing
2026-04-03,Good Friday
2026-04-14,Dr. Ambedkar Jayanti
2026-05-01,Maharashtra Day
2026-05-28,Bakri Id
2026-08-15,Independence Day
2026-08-26,Ganesh Chaturthi
2026-10-02,Gandhi Jayanti
2026-10-20,Diwali Laxmi Puja
2026-10-21,Diwali Balipratipada
2026-11-24,Guru Nanak Jayanti
2026-12-25,Christmas`;
  showToast('📋 Sample', '2026 list loaded — click Add / Update');
}

async function deleteHoliday(date) {
  if (!confirm(`Remove holiday ${date}?`)) return;
  try {
    await api(`/api/admin/holidays/${date}`, { method: 'DELETE' });
    renderHolidays();
    showToast('🗑️ Removed', date);
  } catch (e) { showToast('⚠️ Error', e.message); }
}

async function deleteSelectedHolidays() {
  const checked = [...document.querySelectorAll('.holiday-check:checked')].map(c => c.value);
  if (!checked.length) { showToast('⚠️ None Selected', 'Tick holidays to remove'); return; }
  if (!confirm(`Remove ${checked.length} holiday(s)?`)) return;

  let ok = 0;
  for (const date of checked) {
    try { await api(`/api/admin/holidays/${date}`, { method: 'DELETE' }); ok++; }
    catch {}
  }
  renderHolidays();
  showToast('🗑️ Removed', `${ok} holiday(s) deleted`);
}

async function deleteAllHolidays() {
  if (!confirm('Remove ALL holidays? This cannot be undone.')) return;
  try {
    const rows = await api('/api/admin/holidays');
    let ok = 0;
    for (const h of rows) {
      try { await api(`/api/admin/holidays/${h.date}`, { method: 'DELETE' }); ok++; }
      catch {}
    }
    renderHolidays();
    showToast('🗑️ Cleared', `${ok} holidays removed`);
  } catch (e) { showToast('⚠️ Error', e.message); }
}


/* ============================================================
   SECTION 29 — BOOTSTRAP
   ============================================================ */
(async function initAuth() {
  const token = getToken();
  const u = getUser();
  if (token && u) {
    try {
      await api('/api/session-check');
      currentUser = u;
      showApp();
      return;
    } catch { clearSession(); }
  }
  showLogin();
})();


/* ============================================================
   SECTION 30 — PASSWORD TOGGLE HELPER
   ============================================================ */
function toggleAuthPwd(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'HIDE';
  } else {
    input.type = 'password';
    btn.textContent = 'SHOW';
  }
}
