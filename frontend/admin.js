/* ============================================================
   ADMIN.JS
   Contains: Config, API client, TOTP, Auth flow, Admin panel,
             Shared utilities (toast, navigation, avatar menu)
   Loaded BEFORE app.js
   ============================================================ */


/* ============================================================
   SECTION 1 — CONFIGURATION & CONSTANTS
   API URL, durations, color palette
   ============================================================ */
const API = 'https://tradeedge-a5y0.onrender.com';

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
   SECTION 2 — GLOBAL STATE
   Tracks current user, impersonation, DOM refs
   ============================================================ */
let currentUser = null;
let impersonating = false;
let impersonateBackup = null;
let pendingLoginUser = null;

const DOM = {
  pages: document.querySelectorAll('.page'),
  navLinks: document.querySelectorAll('.nav-links a'),
  toast: document.getElementById('toast'),
  toastTitle: document.getElementById('toastTitle'),
  toastMessage: document.getElementById('toastMessage')
};


/* ============================================================
   SECTION 3 — API CLIENT
   Fetch wrapper with JWT auth header + error handling
   ============================================================ */
function getToken() { return localStorage.getItem('ta_token'); }
function setToken(t) { localStorage.setItem('ta_token', t); }
function getUser() {
  try { return JSON.parse(localStorage.getItem('ta_user') || 'null'); }
  catch { return null; }
}
function setUser(u) { localStorage.setItem('ta_user', JSON.stringify(u)); }
function clearSession() {
  localStorage.removeItem('ta_token');
  localStorage.removeItem('ta_user');
}

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
   SECTION 4 — TOTP (Google Authenticator compatible)
   Pure Web Crypto, no external libraries
   ============================================================ */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5)
    out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(str) {
  str = str.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const c of str) {
    const v = B32.indexOf(c);
    if (v === -1) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(bytes);
}

async function totpAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint32(4, counter, false);
  const ck = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', ck, buf));
  const off = sig[sig.length - 1] & 0x0f;
  const code = ((sig[off] & 0x7f) << 24) | ((sig[off+1] & 0xff) << 16)
             | ((sig[off+2] & 0xff) << 8)  | (sig[off+3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

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
  return base32Encode(bytes);
}


/* ============================================================
   SECTION 5 — PASSWORD GENERATOR
   Random strong password for new users
   ============================================================ */
function generateStrongPassword(len = 12) {
  const U = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const L = 'abcdefghjkmnpqrstuvwxyz';
  const D = '23456789';
  const S = '!@#$%&*';
  const all = U + L + D + S;
  let p = U[Math.random() * U.length | 0]
        + L[Math.random() * L.length | 0]
        + D[Math.random() * D.length | 0]
        + S[Math.random() * S.length | 0];
  while (p.length < len) p += all[Math.random() * all.length | 0];
  return p.split('').sort(() => Math.random() - 0.5).join('');
}

function fillRandomPassword() {
  document.getElementById('newPassword').value = generateStrongPassword();
  showToast('🎲 Generated', 'Strong password generated');
}


/* ============================================================
   SECTION 6 — TOAST NOTIFICATIONS
   Small popup at bottom-right
   ============================================================ */
let toastTimeout = null;

function showToast(title, message) {
  DOM.toastTitle.textContent = title || '✅ Success';
  DOM.toastMessage.textContent = message || 'Action completed';
  DOM.toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => DOM.toast.classList.remove('show'), 4000);
}

function hideToast() {
  DOM.toast.classList.remove('show');
  clearTimeout(toastTimeout);
}


/* ============================================================
   SECTION 7 — NAVIGATION
   Switch between pages (Screener / Portfolio / Users / Settings)
   ============================================================ */
function navigateTo(pageId) {
  DOM.navLinks.forEach(a => a.classList.toggle('active', a.dataset.page === pageId));
  DOM.pages.forEach(p => p.classList.toggle('active', p.id === 'page-' + pageId));

  // Page-specific loaders
  if (pageId === 'portfolio' && typeof loadPortfolio === 'function') loadPortfolio();
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
   SECTION 8 — AVATAR MENU
   Top-right dropdown (Change password / Logout)
   ============================================================ */
function toggleAvatarMenu(e) {
  e.stopPropagation();
  document.getElementById('avatarMenu').classList.toggle('open');
}
document.addEventListener('click', () =>
  document.getElementById('avatarMenu')?.classList.remove('open')
);

function openChangePassword() {
  document.getElementById('avatarMenu').classList.remove('open');
  document.getElementById('pwdError').textContent = 'Contact admin to reset your password.';
  document.getElementById('pwdModal').classList.add('open');
}
function closeChangePassword() {
  document.getElementById('pwdModal').classList.remove('open');
}
function savePassword() {
  document.getElementById('pwdError').textContent = 'Contact admin to reset your password.';
}


/* ============================================================
   SECTION 9 — LOGIN FLOW (password + TOTP)
   Step 1: username + password
   Step 2A: TOTP verify (returning users)
   Step 2B: TOTP setup (first-time users)
   ============================================================ */
function showLoginStep(step) {
  document.getElementById('loginStep1').style.display = step === 1 ? 'block' : 'none';
  document.getElementById('loginStep2Verify').style.display = step === 'verify' ? 'block' : 'none';
  document.getElementById('loginStep2Setup').style.display = step === 'setup' ? 'block' : 'none';
}

async function doLogin() {
  const input = document.getElementById('authUser').value.trim();
  const password = document.getElementById('authPass').value;
  const err = document.getElementById('authError');
  err.textContent = '';
  if (!input || !password) { err.textContent = 'Enter username and password'; return; }

  try {
    const r = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ input, password })
    });
    pendingLoginUser = r;

    if (r.needsSetup) {
      // First-time user → setup QR
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
      // Returning user → verify code
      document.getElementById('authTotp').value = '';
      document.getElementById('authTotpError').textContent = '';
      showLoginStep('verify');
      setTimeout(() => document.getElementById('authTotp').focus(), 100);
    }
  } catch (e) {
    if (e.data?.expired) {
      showExpired({ name: input, expiresAt: e.data.expiresAt });
      return;
    }
    err.textContent = e.message;
  }
}

async function verifyLoginTotp() {
  const code = document.getElementById('authTotp').value.trim();
  const err = document.getElementById('authTotpError');
  if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter 6 digits'; return; }
  if (!await verifyTotp(pendingLoginUser.totpSecret, code)) {
    err.textContent = 'Invalid code. Try again.';
    return;
  }
  await completeLogin({ username: pendingLoginUser.username });
}

async function confirmSetup() {
  const code = document.getElementById('setupCode').value.trim();
  const err = document.getElementById('setupError');
  if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter 6 digits'; return; }
  if (!await verifyTotp(pendingLoginUser.newSecret, code)) {
    err.textContent = 'Code did not match. Check your app and try again.';
    return;
  }
  await completeLogin({
    username: pendingLoginUser.username,
    totpSecret: pendingLoginUser.newSecret
  });
}

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
        setTimeout(() =>
          showToast('⚠️ Expiring Soon', `Expires in ${dl} day${dl === 1 ? '' : 's'}`), 500);
      }
    }
  } catch (e) {
    showToast('⚠️ Login Error', e.message);
  }
}

function cancelTotp() {
  pendingLoginUser = null;
  showLoginStep(1);
  document.getElementById('authUser').value = '';
  document.getElementById('authPass').value = '';
}


/* ============================================================
   SECTION 10 — LOGOUT & SCREEN SWITCHING
   showLogin / showExpired / showApp
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

  // Show/hide admin-only nav
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = (currentUser.role === 'admin' && !impersonating) ? '' : 'none';
  });

  // Avatar initials
  const initials = (currentUser.name || 'U')
    .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('avatarEl').textContent = initials;
  document.getElementById('avatarName').textContent = currentUser.name;
  document.getElementById('avatarRole').textContent = currentUser.role;

  // Impersonate banner
  if (impersonating) {
    document.body.classList.add('impersonating');
    document.getElementById('impersonateBanner').style.display = 'flex';
    document.getElementById('impersonateName').textContent = currentUser.name;
  } else {
    document.body.classList.remove('impersonating');
    document.getElementById('impersonateBanner').style.display = 'none';
  }

  // Preload admin data if admin
  if (currentUser.role === 'admin' && !impersonating) {
    renderKPIs();
    renderUsers();
    loadPrices();
    renderAudit();
  }

  navigateTo('screener');

  // Session heartbeat (every 30s)
  if (!window._expiryTimer) {
    window._expiryTimer = setInterval(async () => {
      if (!currentUser || impersonating) return;
      try {
        await api('/api/session-check');
      } catch (e) {
        if (e.status === 401) {
          showToast('⛔ Session Ended', e.message || 'Logged in on another device');
          setTimeout(logout, 1500);
        }
      }
    }, 30000);
  }
}


/* ============================================================
   SECTION 11 — TABS (admin panel tabs)
   Users / Bulk Import / Audit / Prices
   ============================================================ */
function switchTab(name, e) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  e.target.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'audit') renderAudit();
  if (name === 'prices') loadPrices();
}


/* ============================================================
   SECTION 12 — ADMIN: KPIs (dashboard stat boxes)
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
    const expired = users.filter(u =>
      u.expiresAt && new Date(u.expiresAt) < new Date()
    ).length;
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
   SECTION 13 — ADMIN: USERS TABLE & CRUD
   Render table, add/renew/delete/disable/reset users
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
    if (filter === 'active')
      list = list.filter(u => u.role !== 'admin' && !u.disabled && u.expiresAt && new Date(u.expiresAt) > new Date());
    if (filter === 'expiring')
      list = list.filter(u => u.expiresAt && (() => {
        const d = Math.ceil((new Date(u.expiresAt) - Date.now()) / 86400000);
        return d > 0 && d <= 7;
      })());
    if (filter === 'expired')
      list = list.filter(u => u.role !== 'admin' && u.expiresAt && new Date(u.expiresAt) < new Date());
    if (filter === 'disabled')
      list = list.filter(u => u.disabled);

    if (!list.length) {
      document.getElementById('usersTable').innerHTML =
        '<div style="text-align:center;padding:40px;color:var(--text-muted)">No users match filters.</div>';
      return;
    }

    const rows = list.map(u => {
      const dl = u.expiresAt
        ? Math.ceil((new Date(u.expiresAt) - Date.now()) / 86400000)
        : Infinity;
      let daysText, color;
      if (u.role === 'admin') { daysText = '—';         color = 'var(--text-muted)'; }
      else if (u.disabled)    { daysText = 'Disabled';  color = 'var(--text-muted)'; }
      else if (dl <= 0)       { daysText = 'Expired';   color = 'var(--text-muted)'; }
      else if (dl <= 7)       { daysText = `${dl} days`; color = 'var(--danger)'; }
      else if (dl <= 30)      { daysText = `${dl} days`; color = 'var(--warning)'; }
      else                    { daysText = `${dl} days`; color = 'var(--success)'; }

      const isAdmin = u.role === 'admin';
      return `<tr class="${u.disabled ? 'row-disabled' : ''}">
        <td><strong>${u.name}</strong>${u.mobile ? `<br><span style="font-size:11px;color:var(--text-muted)">📱 ${u.mobile}</span>` : ''}</td>
        <td>${u.username}</td>
        <td>${u.plan || '—'}</td>
        <td>${u.expiresAt ? String(u.expiresAt).slice(0, 10) : '—'}</td>
        <td style="color:${color};font-weight:600">${daysText}</td>
        <td class="actions-cell">
          ${isAdmin ? '<span style="color:var(--text-muted);font-size:11px">—</span>' : `
            <button class="btn btn-outline btn-sm" onclick="impersonate('${u.username}')">👁️ View</button>
            <button class="btn btn-primary btn-sm" onclick="renewUser('${u.username}')">Renew</button>
            <button class="btn btn-warn btn-sm" onclick="resetPassword('${u.username}')">🔑</button>
            <button class="btn btn-outline btn-sm" onclick="toggleDisable('${u.username}')">${u.disabled ? '✅' : '⏸️'}</button>
            <button class="btn btn-danger btn-sm" onclick="deleteUser('${u.username}')">🗑️</button>`}
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
    document.getElementById('usersTable').innerHTML =
      `<div style="color:var(--danger)">${e.message}</div>`;
  }
}

async function addUser() {
  const name = document.getElementById('newName').value.trim();
  const username = document.getElementById('newUsername').value.trim().toLowerCase();
  const mobile = document.getElementById('newMobile').value.replace(/\D/g, '') || null;
  const password = document.getElementById('newPassword').value;
  const plan = document.getElementById('newPlan').value;
  const durKey = document.getElementById('newDuration').value;

  if (!name || !username || !password) {
    showToast('⚠️ Missing Fields', 'Name, username, password required');
    return;
  }

  const days = DURATIONS[durKey].days;
  const d = new Date(); d.setDate(d.getDate() + days);
  const expiresAt = d.toISOString().split('T')[0];

  try {
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ name, username, mobile, password, plan, expiresAt })
    });
    document.getElementById('newName').value = '';
    document.getElementById('newUsername').value = '';
    document.getElementById('newMobile').value = '';
    document.getElementById('newPassword').value = '';
    renderUsers();
    renderKPIs();
    showToast('✅ User Created', `${name} · password: ${password}`);
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }
}

async function renewUser(username) {
  const choice = prompt(
    `Renew "${username}":\n1. 5 days\n2. 7 days\n3. 1 month\n4. 2 months\n` +
    `5. 3 months\n6. 6 months\n7. 1 year\n\nEnter 1-7:`
  );
  if (!choice) return;
  const map = { '1': 5, '2': 7, '3': 30, '4': 60, '5': 90, '6': 180, '7': 365 };
  const days = map[choice.trim()];
  if (!days) { showToast('⚠️ Invalid', 'Enter 1-7'); return; }

  try {
    await api(`/api/users/${username}/renew`, {
      method: 'POST',
      body: JSON.stringify({ days })
    });
    renderUsers();
    renderKPIs();
    showToast('✅ Renewed', `+${days} days`);
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }
}

async function deleteUser(username) {
  if (!confirm(`Delete user "${username}"?`)) return;
  try {
    await api(`/api/users/${username}`, { method: 'DELETE' });
    renderUsers();
    renderKPIs();
    showToast('🗑️ Deleted', username);
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }
}

async function toggleDisable(username) {
  try {
    await api(`/api/users/${username}/disable`, { method: 'POST' });
    renderUsers();
    showToast('✅ Done', 'Status updated');
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }
}

async function resetPassword(username) {
  if (!confirm(`Reset password + 2FA for "${username}"?`)) return;
  try {
    const r = await api(`/api/users/${username}/reset`, { method: 'POST' });
    showToast('🔑 Temp Password', `${username}: ${r.temp}`);
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }
}


/* ============================================================
   SECTION 14 — ADMIN: IMPERSONATE
   View app as another user (with banner + exit)
   ============================================================ */
async function impersonate(username) {
  if (!confirm(`View as "${username}"?`)) return;
  impersonateBackup = { user: currentUser, token: getToken() };
  impersonating = true;

  const all = await api('/api/users');
  const u = all.find(x => x.username === username);
  if (!u) return;

  currentUser = { ...currentUser, name: u.name, username: u.username, role: u.role };
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
   SECTION 15 — ADMIN: BULK IMPORT (CSV)
   ============================================================ */
function loadSampleCSV() {
  document.getElementById('csvInput').value =
`Ravi Kumar,ravi,pass123,Basic,1m,9876543210
Priya Sharma,priya,pass456,Pro,3m
Rahul Verma,rahul,demo123,Demo,5d`;
}

async function bulkImport() {
  const raw = document.getElementById('csvInput').value.trim();
  if (!raw) { showToast('⚠️ Empty', 'Paste CSV first'); return; }

  const lines = raw.split('\n').filter(l => l.trim());
  let ok = 0, fail = 0;
  const errors = [];

  for (const line of lines) {
    const p = line.split(',').map(s => s.trim());
    if (p.length < 5) { fail++; errors.push(`Bad format: ${line}`); continue; }

    const [name, username, password, plan, durCode, mobileRaw] = p;
    const dur = DURATIONS[durCode];
    if (!name || !username || !password || !dur) {
      fail++; errors.push(`Missing: ${line}`); continue;
    }

    const d = new Date(); d.setDate(d.getDate() + dur.days);
    const expiresAt = d.toISOString().split('T')[0];

    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          name,
          username: username.toLowerCase(),
          password,
          plan,
          expiresAt,
          mobile: (mobileRaw || '').replace(/\D/g, '') || null
        })
      });
      ok++;
    } catch (e) {
      fail++;
      errors.push(`${username}: ${e.message}`);
    }
  }

  renderUsers();
  renderKPIs();

  document.getElementById('importResult').innerHTML = `
    <div style="padding:14px 18px;background:${ok ? 'rgba(0,184,148,0.1)' : 'rgba(225,112,85,0.1)'};border-radius:10px">
      <strong>✅ ${ok} created</strong>${fail ? ` · <strong style="color:var(--danger)">${fail} failed</strong>` : ''}
      ${errors.length ? `<div style="margin-top:10px;font-size:12px;color:var(--text-muted)">${errors.slice(0, 5).map(e => `• ${e}`).join('<br>')}</div>` : ''}
    </div>`;
  if (ok) document.getElementById('csvInput').value = '';
  showToast('📥 Import Done', `${ok} created, ${fail} failed`);
}


/* ============================================================
   SECTION 16 — ADMIN: AUDIT LOG
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
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }
}


/* ============================================================
   SECTION 17 — ADMIN: PRICING
   ============================================================ */
async function loadPrices() {
  try {
    const p = await api('/api/prices');
    document.getElementById('priceDemo').value = p.Demo || 0;
    document.getElementById('priceBasic').value = p.Basic || 0;
    document.getElementById('pricePro').value = p.Pro || 0;
  } catch {}
}

async function savePrices() {
  const p = {
    Demo: +document.getElementById('priceDemo').value || 0,
    Basic: +document.getElementById('priceBasic').value || 0,
    Pro: +document.getElementById('pricePro').value || 0
  };
  try {
    await api('/api/prices', { method: 'PUT', body: JSON.stringify(p) });
    renderKPIs();
    showToast('✅ Saved', 'Plan prices updated');
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }
}


/* ============================================================
   SECTION 18 — ADMIN: EXPORT USERS AS CSV
   ============================================================ */
async function exportUsersCSV() {
  try {
    const users = await api('/api/users');
    const header = 'Name,Username,Mobile,Role,Plan,Expires,Status\n';
    const rows = users.map(u => {
      const status = u.disabled
        ? 'Disabled'
        : (u.expiresAt && new Date(u.expiresAt) < new Date() ? 'Expired' : 'Active');
      return [
        u.name, u.username, u.mobile || '-', u.role,
        u.plan || '-',
        u.expiresAt ? String(u.expiresAt).slice(0, 10) : '-',
        status
      ].join(',');
    }).join('\n');

    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `users_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('📥 Exported', `${users.length} users`);
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }
}


/* ============================================================
   SECTION 19 — BOOTSTRAP (auto-runs on page load)
   Checks for saved session; shows login or app
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
    } catch {
      clearSession();
    }
  }
  showLogin();
})();
