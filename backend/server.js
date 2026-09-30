import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { login as angelLogin, getCandles as angelCandles } from './brokers/angelone/Angel_REST.js';

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000
});

const SECRET = process.env.JWT_SECRET;
const __dir = dirname(fileURLToPath(import.meta.url));
const STOCKS = JSON.parse(readFileSync(join(__dir, 'brokers/angelone/Angel_nifty500.json'), 'utf8'));
const platformTokens = {};  // { username: jwtToken } — in-memory, clears on restart

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

async function log(actor, action, details = '', level = 'info') {
  try {
    await db.query(
      'INSERT INTO audit_log (actor, action, details, level) VALUES ($1,$2,$3,$4)',
      [actor, action, details, level]
    );
  } catch {}
}

/* ============ HELPERS: auto-generate username/password ============ */
async function generateUsername(fullName, mobile) {
  const first = (fullName || '').trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const last4 = (mobile || '').replace(/\D/g, '').slice(-4);
  const base = (first || 'user') + last4;
  let candidate = base;
  let i = 1;
  while (true) {
    const { rows } = await db.query('SELECT 1 FROM users WHERE username=$1', [candidate]);
    if (!rows.length) return candidate;
    candidate = base + i;
    i++;
  }
}

function generatePassword(fullName, mobile) {
  const first = (fullName || '').trim().split(/\s+/)[0];
  const cap = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  const last4 = (mobile || '').replace(/\D/g, '').slice(-4);
  return `${cap}@${last4}!`;
}

/* ============ TOTP VERIFY ============ */
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
  return Buffer.from(bytes);
}

function totpAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(counter, 4);
  const hmac = crypto.createHmac('sha1', key);
  hmac.update(buf);
  const sig = hmac.digest();
  const off = sig[sig.length - 1] & 0x0f;
  const code = ((sig[off] & 0x7f) << 24) | ((sig[off+1] & 0xff) << 16)
             | ((sig[off+2] & 0xff) << 8)  | (sig[off+3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function verifyTotpServer(secret, input) {
  const step = Math.floor(Date.now() / 1000 / 30);
  for (const c of [step - 1, step, step + 1]) {
    if (totpAt(secret, c) === input) return true;
  }
  return false;
}

app.get('/', (req, res) => res.json({ ok: true, service: 'tradealgo-backend' }));

/* ============ AUTH ============ */

app.post('/api/login', async (req, res) => {
  const { input, password } = req.body;
  const clean = (input || '').trim().toLowerCase();
  if (!clean || !password) return res.status(400).json({ error: 'Missing fields' });

  const digits = clean.replace(/\D/g, '');
  const { rows } = await db.query(
    "SELECT * FROM users WHERE username=$1 OR (mobile=$2 AND $2 <> '')",
    [clean, digits.length >= 10 ? digits : '__none__']
  );
  const user = rows[0];
  const lockKey = user?.username || clean;

  const lock = await db.query('SELECT * FROM login_attempts WHERE username=$1', [lockKey]);
  if (lock.rows[0]?.locked_until > new Date()) {
    const mins = Math.ceil((new Date(lock.rows[0].locked_until) - Date.now()) / 60000);
    return res.status(429).json({ error: `Too many attempts. Try in ${mins} min.` });
  }

  if (!user || !await bcrypt.compare(password, user.password_hash)) {
    const c = (lock.rows[0]?.count || 0) + 1;
    if (c >= 3) {
      await db.query(
        "INSERT INTO login_attempts (username, count, locked_until) VALUES ($1, 0, NOW() + INTERVAL '15 minutes') ON CONFLICT (username) DO UPDATE SET count=0, locked_until=NOW() + INTERVAL '15 minutes'",
        [lockKey]
      );
    } else {
      await db.query(
        "INSERT INTO login_attempts (username, count) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET count=$2",
        [lockKey, c]
      );
    }
    await log(lockKey, 'LOGIN_FAILED', `Input: ${clean}`, 'danger');
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  await db.query('DELETE FROM login_attempts WHERE username=$1', [lockKey]);

  if (user.disabled) return res.status(403).json({ error: 'Account disabled' });
  if (user.role !== 'admin' && user.expires_at && new Date(user.expires_at) < new Date()) {
    return res.status(403).json({ error: 'Subscription expired', expired: true, expiresAt: user.expires_at });
  }

  res.json({
    ok: true,
    username: user.username,
    name: user.name,
    role: user.role,
    hasTotp: !!user.totp_secret,
    needsSetup: !user.totp_secret,
    totpSecret: user.totp_secret || null
  });
});

app.post('/api/complete-login', async (req, res) => {
  const { username, totpSecret } = req.body;
  const { rows } = await db.query('SELECT * FROM users WHERE username=$1', [username]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (totpSecret && !user.totp_secret) {
    await db.query('UPDATE users SET totp_secret=$1 WHERE username=$2', [totpSecret, username]);
    await log(username, 'TOTP_ENABLED', `User: ${username}`, 'success');
  }

  const sessionId = crypto.randomUUID();
  await db.query('UPDATE users SET session_id=$1, last_active=NOW() WHERE username=$2', [sessionId, username]);

  const token = jwt.sign({ username, role: user.role, sessionId }, SECRET, { expiresIn: '7h' });
  await log(username, 'LOGIN_SUCCESS', `User: ${username}`, 'success');

  res.json({
    ok: true,
    token,
    user: {
      name: user.name,
      username: user.username,
      role: user.role,
      plan: user.plan,
      expiresAt: user.expires_at,
      mobile: user.mobile,
      sessionId
    }
  });
});

app.get('/api/session-check', auth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT session_id, disabled, role, expires_at FROM users WHERE username=$1',
    [req.user.username]
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'User gone' });
  if (user.disabled) return res.status(401).json({ error: 'Disabled' });
  if (user.session_id !== req.user.sessionId) return res.status(401).json({ error: 'Logged in elsewhere' });
  if (user.role !== 'admin' && user.expires_at && new Date(user.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Expired' });
  }
  res.json({ ok: true });
});

app.post('/api/logout', auth, async (req, res) => {
  await log(req.user.username, 'LOGOUT', `User: ${req.user.username}`, 'info');
  res.json({ ok: true });
});

/* ============ FORGOT PASSWORD ============ */
app.post('/api/forgot-password/check', async (req, res) => {
  const { input } = req.body;
  const clean = (input || '').trim().toLowerCase();
  if (!clean) return res.status(400).json({ error: 'Enter username or mobile' });

  const digits = clean.replace(/\D/g, '');
  const { rows } = await db.query(
    "SELECT username, name, totp_secret, disabled FROM users WHERE username=$1 OR (mobile=$2 AND $2 <> '')",
    [clean, digits.length >= 10 ? digits : '__none__']
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'No account found' });
  if (user.disabled) return res.status(403).json({ error: 'Account disabled — contact admin' });
  if (!user.totp_secret) return res.status(400).json({ error: 'No 2FA set up — contact admin' });

  res.json({ ok: true, username: user.username, name: user.name });
});

app.post('/api/forgot-password/reset', async (req, res) => {
  const { input, totpCode, newPassword } = req.body;
  const clean = (input || '').trim().toLowerCase();
  if (!clean || !totpCode || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });

  const digits = clean.replace(/\D/g, '');
  const { rows } = await db.query(
    "SELECT * FROM users WHERE username=$1 OR (mobile=$2 AND $2 <> '')",
    [clean, digits.length >= 10 ? digits : '__none__']
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'No account found' });
  if (user.disabled) return res.status(403).json({ error: 'Account disabled' });
  if (!user.totp_secret) return res.status(400).json({ error: 'No 2FA set up — contact admin' });

  if (!verifyTotpServer(user.totp_secret, String(totpCode).trim())) {
    await log(user.username, 'FORGOT_PASSWORD_FAILED', 'Bad TOTP', 'danger');
    return res.status(401).json({ error: 'Invalid code' });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await db.query(
    'UPDATE users SET password_hash=$1, session_id=NULL WHERE username=$2',
    [hash, user.username]
  );
  await log(user.username, 'PASSWORD_RESET_SELF', `User: ${user.username}`, 'warn');

  res.json({ ok: true });
});

/* ============ CHANGE PASSWORD ============ */
app.post('/api/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be 6+ characters' });

  const { rows } = await db.query('SELECT * FROM users WHERE username=$1', [req.user.username]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) {
    await log(req.user.username, 'PASSWORD_CHANGE_FAILED', 'Wrong current password', 'danger');
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  const newSessionId = crypto.randomUUID();

  await db.query(
    'UPDATE users SET password_hash=$1, session_id=$2 WHERE username=$3',
    [hash, newSessionId, req.user.username]
  );

  const token = jwt.sign(
    { username: user.username, role: user.role, sessionId: newSessionId },
    SECRET,
    { expiresIn: '7h' }
  );

  await log(req.user.username, 'PASSWORD_CHANGED', `User: ${req.user.username}`, 'success');
  res.json({ ok: true, token, sessionId: newSessionId });
});

/* ============ SELF PROFILE ============ */
app.put('/api/me', auth, async (req, res) => {
  const { name, mobile } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const cleanMobile = (mobile || '').replace(/\D/g, '') || null;

  try {
    if (cleanMobile) {
      const dup = await db.query(
        'SELECT username FROM users WHERE mobile=$1 AND username<>$2',
        [cleanMobile, req.user.username]
      );
      if (dup.rows.length) return res.status(409).json({ error: 'Mobile already in use' });
    }

    await db.query(
      'UPDATE users SET name=$1, mobile=$2 WHERE username=$3',
      [name.trim(), cleanMobile, req.user.username]
    );
    await log(req.user.username, 'PROFILE_UPDATED', `User: ${req.user.username}`, 'success');
    res.json({ ok: true, name: name.trim(), mobile: cleanMobile });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============ USERS (admin) ============ */

app.get('/api/users', auth, adminOnly, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, name, username, mobile, role, plan, expires_at AS "expiresAt",
            disabled, last_active AS "lastActive", created_at AS "createdAt"
     FROM users ORDER BY created_at DESC`
  );
  res.json(rows);
});

/* Create user (auto-generate username + password) */
app.post('/api/users', auth, adminOnly, async (req, res) => {
  let { name, mobile, password, plan, expiresAt } = req.body;

  if (!name || !mobile) return res.status(400).json({ error: 'Name and mobile required' });
  const cleanMobile = String(mobile).replace(/\D/g, '');
  if (cleanMobile.length < 10) return res.status(400).json({ error: 'Mobile must be 10 digits' });

  const username = await generateUsername(name, cleanMobile);
  if (!password) password = generatePassword(name, cleanMobile);
  const hash = await bcrypt.hash(password, 10);

  try {
    await db.query(
      `INSERT INTO users (name, username, mobile, password_hash, plan, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [name.trim(), username, cleanMobile, hash, plan || 'Demo', expiresAt]
    );
    await log(req.user.username, 'USER_CREATED', `${name} (@${username})`, 'success');
    res.json({ ok: true, username, password, mobile: cleanMobile });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Mobile already registered' });
    res.status(500).json({ error: e.message });
  }
});

/* Edit user (admin updates name, mobile, plan, role) */
app.put('/api/users/:username', auth, adminOnly, async (req, res) => {
  const target = req.params.username;
  const { name, mobile, plan, role } = req.body;

  const existing = await db.query('SELECT username FROM users WHERE username=$1', [target]);
  if (!existing.rows.length) return res.status(404).json({ error: 'User not found' });

  const cleanMobile = mobile ? String(mobile).replace(/\D/g, '') : null;

  try {
    if (cleanMobile) {
      const dup = await db.query(
        'SELECT username FROM users WHERE mobile=$1 AND username<>$2',
        [cleanMobile, target]
      );
      if (dup.rows.length) return res.status(409).json({ error: 'Mobile already in use' });
    }

    await db.query(
      'UPDATE users SET name=$1, mobile=$2, plan=$3, role=$4 WHERE username=$5',
      [name, cleanMobile, plan, role, target]
    );
    await log(req.user.username, 'USER_UPDATED', `${target}`, 'success');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Renew (add days — negative allowed for reducing) */
app.post('/api/users/:username/renew', auth, adminOnly, async (req, res) => {
  const { days } = req.body;
  await db.query(
    `UPDATE users SET expires_at = GREATEST(COALESCE(expires_at, CURRENT_DATE), CURRENT_DATE) + ($1 || ' days')::interval WHERE username=$2`,
    [days, req.params.username]
  );
  await log(req.user.username, 'USER_RENEWED', `${req.params.username} ${days > 0 ? '+' : ''}${days}d`, 'success');
  res.json({ ok: true });
});

/* Set exact expiry date */
app.post('/api/users/:username/set-expiry', auth, adminOnly, async (req, res) => {
  const { expiresAt } = req.body;
  if (!expiresAt) return res.status(400).json({ error: 'expiresAt required' });
  await db.query(
    'UPDATE users SET expires_at=$1 WHERE username=$2',
    [expiresAt, req.params.username]
  );
  await log(req.user.username, 'USER_EXPIRY_SET', `${req.params.username} → ${expiresAt}`, 'success');
  res.json({ ok: true });
});

/* Reset password + 2FA */
app.post('/api/users/:username/reset', auth, adminOnly, async (req, res) => {
  const { rows } = await db.query('SELECT name, mobile FROM users WHERE username=$1', [req.params.username]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'User not found' });

  const temp = generatePassword(u.name, u.mobile || '0000');
  const hash = await bcrypt.hash(temp, 10);
  await db.query(
    'UPDATE users SET password_hash=$1, totp_secret=NULL, session_id=NULL WHERE username=$2',
    [hash, req.params.username]
  );
  await log(req.user.username, 'PASSWORD_RESET', req.params.username, 'warn');
  res.json({ ok: true, temp });
});

/* Toggle disable */
app.post('/api/users/:username/disable', auth, adminOnly, async (req, res) => {
  await db.query(
    'UPDATE users SET disabled = NOT disabled, session_id = NULL WHERE username=$1',
    [req.params.username]
  );
  res.json({ ok: true });
});

/* Delete */
app.delete('/api/users/:username', auth, adminOnly, async (req, res) => {
  await db.query('DELETE FROM users WHERE username=$1', [req.params.username]);
  await log(req.user.username, 'USER_DELETED', req.params.username, 'danger');
  res.json({ ok: true });
});

/* ============ AUDIT ============ */
app.get('/api/audit', auth, adminOnly, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
  res.json(rows);
});

app.delete('/api/audit', auth, adminOnly, async (req, res) => {
  await db.query('DELETE FROM audit_log');
  res.json({ ok: true });
});

/* ============ PRICES ============ */
app.get('/api/prices', auth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM prices');
  const out = {};
  rows.forEach(r => out[r.plan] = r.amount);
  res.json(out);
});

app.put('/api/prices', auth, adminOnly, async (req, res) => {
  const { Demo, Pro } = req.body;
  await db.query('UPDATE prices SET amount=$1 WHERE plan=$2', [Demo || 0, 'Demo']);
  await db.query('UPDATE prices SET amount=$1 WHERE plan=$2', [Pro || 0, 'Pro']);
  res.json({ ok: true });
});

/* ============ STOCK LIST ============ */
app.get('/api/stocks', auth, (req, res) => {
  res.json(STOCKS);
});

/* ============ BROKER: PLATFORM LOGIN ============ */
app.post('/api/broker/login', auth, async (req, res) => {
  const { clientId, mpin, totp } = req.body;
  const apiKey = process.env.ANGEL_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Platform API key not set' });
  if (!clientId || !mpin || !totp) return res.status(400).json({ error: 'Missing fields' });

  try {
    const r = await angelLogin({ apiKey, clientId, mpin, totp });
    if (!r.status || !r.data?.jwtToken) {
      return res.status(401).json({ error: r.message || 'Login failed' });
    }
    platformTokens[req.user.username] = r.data.jwtToken;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============ SCREENER: 9:15 CANDLES ============ */
app.post('/api/screener/fetch-915', auth, async (req, res) => {
  const jwtToken = platformTokens[req.user.username];
  if (!jwtToken) return res.status(401).json({ error: 'Connect broker first' });

  const apiKey = process.env.ANGEL_API_KEY;
  const { tokens } = req.body;
  if (!Array.isArray(tokens) || !tokens.length) {
    return res.status(400).json({ error: 'tokens array required' });
  }

  const today = new Date().toISOString().split('T')[0];
  const from = `${today} 09:15`;
  const to = `${today} 09:16`;   // 9:16 workaround for Angel One 9:15 bug

  const results = [];
  for (const token of tokens) {
    try {
      const r = await angelCandles({
        apiKey, jwtToken,
        exchange: 'NSE',
        token: String(token),
        interval: 'FIFTEEN_MINUTE',
        from, to
      });
      if (r.status && r.data?.length) {
        results.push({ token: String(token), candle: r.data[0] });
      } else {
        results.push({ token: String(token), error: 'no data' });
      }
    } catch (e) {
      results.push({ token: String(token), error: e.message });
    }
    await new Promise(r => setTimeout(r, 400));  // 3 req/sec rate limit
  }

  res.json({ ok: true, count: results.length, results });
});

/* ============ START ============ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
