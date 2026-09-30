import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';

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

/* ============ CHANGE PASSWORD ============ */
app.post('/api/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be 6+ characters' });
  }

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

  // Issue a new token bound to the new sessionId so THIS device stays logged in
  const token = jwt.sign(
    { username: user.username, role: user.role, sessionId: newSessionId },
    SECRET,
    { expiresIn: '7h' }
  );

  await log(req.user.username, 'PASSWORD_CHANGED', `User: ${req.user.username}`, 'success');

  res.json({ ok: true, token, sessionId: newSessionId });
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

app.post('/api/users', auth, adminOnly, async (req, res) => {
  const { name, username, mobile, password, plan, expiresAt } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Missing fields' });
  const hash = await bcrypt.hash(password, 10);
  try {
    await db.query(
      'INSERT INTO users (name, username, mobile, password_hash, plan, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [name, username.toLowerCase(), mobile || null, hash, plan, expiresAt]
    );
    await log(req.user.username, 'USER_CREATED', `${name} (@${username})`, 'success');
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username or mobile already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users/:username/renew', auth, adminOnly, async (req, res) => {
  const { days } = req.body;
  await db.query(
    `UPDATE users SET expires_at = GREATEST(COALESCE(expires_at, CURRENT_DATE), CURRENT_DATE) + ($1 || ' days')::interval WHERE username=$2`,
    [days, req.params.username]
  );
  await log(req.user.username, 'USER_RENEWED', `${req.params.username} +${days}d`, 'success');
  res.json({ ok: true });
});

app.post('/api/users/:username/reset', auth, adminOnly, async (req, res) => {
  const temp = 'Tmp' + Math.random().toString(36).slice(2, 8);
  const hash = await bcrypt.hash(temp, 10);
  await db.query(
    'UPDATE users SET password_hash=$1, totp_secret=NULL, session_id=NULL WHERE username=$2',
    [hash, req.params.username]
  );
  await log(req.user.username, 'PASSWORD_RESET', req.params.username, 'warn');
  res.json({ ok: true, temp });
});

app.post('/api/users/:username/disable', auth, adminOnly, async (req, res) => {
  await db.query(
    'UPDATE users SET disabled = NOT disabled, session_id = NULL WHERE username=$1',
    [req.params.username]
  );
  res.json({ ok: true });
});

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
  const { Demo, Basic, Pro } = req.body;
  await db.query('UPDATE prices SET amount=$1 WHERE plan=$2', [Demo, 'Demo']);
  await db.query('UPDATE prices SET amount=$1 WHERE plan=$2', [Basic, 'Basic']);
  await db.query('UPDATE prices SET amount=$1 WHERE plan=$2', [Pro, 'Pro']);
  res.json({ ok: true });
});

/* ============ START ============ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
