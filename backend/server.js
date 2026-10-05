/* ============================================================
   server.js — TradeAlgo Pro backend

   STRUCTURE:
    §1  Imports
    §2  Config (env, DB, stock list, strategy)
    §3  Time / phases / holidays
    §4  ORB state (memory + DB sync)
    §5  WebSocket manager (tick → stages)
    §6  Middleware + helpers
    §7  Auth routes
    §8  Forgot password
    §9  Change password + profile
    §10 Users CRUD (admin)
    §11 Audit + prices
    §12 Trading holidays (admin)
    §13 Screener routes
    §14 Closing prices (15:34 IST)
    §15 DB cache loader
    §16 Start

   DATA FLOW:
    9:15 fetch → candles cached (memory + DB)
                ↓
    WS subscribes to all active tokens
                ↓
    Every tick → update ORB stages + LTP in DB
                ↓
    Client polls /api/screener/ltp → gets stage data
                ↓
    15:30 → WS stops
    15:34 → closing prices saved

   SECURITY (v1.1):
    - /api/login returns a short-lived pendingToken (5 min JWT)
      instead of leaking the user's totp_secret.
    - /api/complete-login verifies TOTP on the SERVER before
      issuing the session JWT. Client-side verification alone
      is not trusted.
    - Generated passwords now include a random suffix.
   ============================================================ */

import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  loginPlatform,
  getCandlesForTokens,
  getCachedCandles,
  setCachedCandle,
  setCachedLTP,
  getCachedLTP,
  getLTPForTokens,
  fetchAllClosingPrices,
  getSessionStatus,
  getFeedToken
} from './brokers/angelone/Angel_REST.js';
import { startWS, stopWS, getWSStatus } from './brokers/angelone/Angel_WS.js';

dotenv.config();


/* ============================================================
   SECTION 2 — CONFIG
   ============================================================ */
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

const ALL_STOCKS = JSON.parse(
  readFileSync(join(__dir, 'brokers/angelone/Angel_nifty500.json'), 'utf8')
);
const STOCKS = ALL_STOCKS.filter(s => !s.disabled);
console.log(`📋 Stocks: ${STOCKS.length} active / ${ALL_STOCKS.length} total`);

const SYM_BY_TOKEN = {};
STOCKS.forEach(s => { SYM_BY_TOKEN[String(s.token)] = s.sym; });

/* ---- Strategy config — add new strategies here ---- */
const STRATEGIES = {
  advance_orb: {
    id: 'advance_orb',
    name: 'Advance ORB',
    filters: { maxRangePct: 1.5, minPrice: 150, maxPrice: 3500 }
  }
};

const getStrategy = id => STRATEGIES[id] || STRATEGIES.advance_orb;

function passesStrategy(candle, strategy) {
  if (!Array.isArray(candle) || candle.length < 5) return false;
  const high = +candle[2], low = +candle[3], close = +candle[4];
  if (low <= 0 || high <= low) return false;
  const rangePct = ((high - low) / low) * 100;
  const f = strategy.filters;
  return rangePct <= f.maxRangePct && close >= f.minPrice && close <= f.maxPrice;
}


/* ============================================================
   SECTION 3 — TIME / PHASES / HOLIDAYS
   ============================================================ */
const getIST = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5).toISOString().split('T')[0];

let holidaySet = new Set();

async function loadHolidaysFromDB() {
  try {
    const { rows } = await db.query('SELECT date::text AS d FROM trading_holidays');
    holidaySet = new Set(rows.map(r => r.d));
    console.log(`📅 Loaded ${holidaySet.size} holidays`);
  } catch (e) { console.error('Holiday load failed:', e.message); }
}

const isHoliday = s => holidaySet.has(s);
const isTradingDay = d =>
  d.getUTCDay() !== 0 &&
  d.getUTCDay() !== 6 &&
  !isHoliday(d.toISOString().split('T')[0]);

function getPreviousTradingDay(dateObj) {
  const d = new Date(dateObj);
  for (let i = 0; i < 15; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (isTradingDay(d)) return d.toISOString().split('T')[0];
  }
  return d.toISOString().split('T')[0];
}

function getScreenerPhase() {
  const ist = getIST();
  const today = ist.toISOString().split('T')[0];
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();

  if (!isTradingDay(ist)) return { phase: 'weekend', date: getPreviousTradingDay(ist) };
  if (mins < 555) return { phase: 'closed' };
  if (mins < 570) return { phase: 'forming' };
  return { phase: 'ready', date: today };
}

function countFilled(date) {
  const cached = getCachedCandles(STOCKS.map(s => s.token), date);
  return cached.filter(c => c.candle && !c.candle.error && Array.isArray(c.candle)).length;
}


/* ============================================================
   SECTION 4 — ORB STATE (memory + DB)
   ============================================================ */
const orbState = new Map();

async function loadOrbStateFromDB(date) {
  try {
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      `SELECT token, low_broken, first_low_break_at, pullback_confirmed, first_pullback_at,
              entry_signal, first_entry_at
       FROM angel_15m_candle WHERE date=$1 AND token = ANY($2)`,
      [date, activeTokens]
    );
    for (const r of rows) {
      orbState.set(`${r.token}_${date}`, {
        lowBroken: !!r.low_broken,
        pullbackConfirmed: !!r.pullback_confirmed,
        entrySignal: !!r.entry_signal,
        firstLowBreakAt: r.first_low_break_at,
        firstPullbackAt: r.first_pullback_at,
        firstEntryAt: r.first_entry_at
      });
    }
    console.log(`🎯 Loaded ORB for ${rows.length} stocks`);
  } catch (e) { console.error('ORB load failed:', e.message); }
}

const getOrbState = (token, date) => orbState.get(`${token}_${date}`) || {
  lowBroken: false, pullbackConfirmed: false, entrySignal: false,
  firstLowBreakAt: null, firstPullbackAt: null, firstEntryAt: null
};


/* ============================================================
   SECTION 5 — WEBSOCKET MANAGER
   Live tick → updates ORB stages + LTP in real time
   ============================================================ */
let wsStarted = false;
let wsConnectedTokens = 0;

/* Called for every tick from WebSocket */
function handleTick(token, ltp) {
  const p = getScreenerPhase();
  if (p.phase !== 'ready' || !p.date) return;

  const candleArr = getCachedCandles([token], p.date)[0]?.candle;
  if (!Array.isArray(candleArr) || candleArr.length < 5) return;

  const low = +candleArr[3];
  const high = +candleArr[2];
  const key = `${token}_${p.date}`;
  const state = getOrbState(token, p.date);
  let changed = false;

  /* Stage 1 — Low broken */
  if (!state.lowBroken && ltp < low) {
    state.lowBroken = true;
    state.firstLowBreakAt = new Date().toISOString();
    db.query(
      `UPDATE angel_15m_candle SET low_broken=true, first_low_break_at=NOW()
       WHERE date=$1 AND token=$2 AND low_broken=false`,
      [p.date, token]
    ).catch(() => {});
    changed = true;
  }

  /* Stage 2 — Pullback confirmed (price returned inside range) */
  if (state.lowBroken && !state.pullbackConfirmed && ltp > low && ltp < high) {
    state.pullbackConfirmed = true;
    state.firstPullbackAt = new Date().toISOString();
    db.query(
      `UPDATE angel_15m_candle SET pullback_confirmed=true, first_pullback_at=NOW()
       WHERE date=$1 AND token=$2 AND pullback_confirmed=false`,
      [p.date, token]
    ).catch(() => {});
    changed = true;
  }

  /* Stage 3 — Entry (high broken after pullback) */
  if (state.pullbackConfirmed && !state.entrySignal && ltp > high) {
    state.entrySignal = true;
    state.firstEntryAt = new Date().toISOString();
    db.query(
      `UPDATE angel_15m_candle SET entry_signal=true, first_entry_at=NOW()
       WHERE date=$1 AND token=$2 AND entry_signal=false`,
      [p.date, token]
    ).catch(() => {});
    changed = true;
  }

  if (changed) orbState.set(key, state);

  /* Always update LTP */
  setCachedLTP(token, ltp);
  db.query(
    `UPDATE angel_15m_candle SET ltp=$1, ltp_updated_at=NOW() WHERE date=$2 AND token=$3`,
    [ltp, p.date, token]
  ).catch(() => {});
}

/* Start WS after 9:15 fetch is done and phase is 'ready' */
function startWebSocketForReadyPhase() {
  if (wsStarted) return;
  const p = getScreenerPhase();
  if (p.phase !== 'ready' || !p.date) return;

  const session = getSessionStatus();
  if (!session.loggedIn) return;

  const feedToken = getFeedToken();
  if (!feedToken) { console.log('⚠️  WS skipped — no feed token'); return; }

  const tokens = STOCKS.map(s => String(s.token));

  try {
    startWS({
      apiKey: process.env.ANGEL_API_KEY,
      clientCode: process.env.ANGEL_CLIENT_ID,
      feedToken,
      tokens,
      onTick: handleTick,
      onDisconnect: async (gapStart, gapEnd) => {
        const gapSec = Math.round((gapEnd - gapStart) / 1000);
        console.log(`🔁 WS gap ${gapSec}s — reconnecting`);
      }
    });
    wsStarted = true;
    wsConnectedTokens = tokens.length;
    console.log(`🔌 WS started for ${tokens.length} tokens`);
  } catch (e) {
    console.error('WS start failed:', e.message);
  }
}

function stopWebSocketIfNeeded() {
  if (!wsStarted) return;
  const ist = getIST();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const dow = ist.getUTCDay();

  // Stop after 15:30 or on non-trading days
  if (dow === 0 || dow === 6 || !isTradingDay(ist) || mins >= 930) {
    stopWS();
    wsStarted = false;
    wsConnectedTokens = 0;
    console.log('🔌 WS stopped');
  }
}

/* Watchdog: start/stop WS every 60s based on phase */
setInterval(() => {
  const p = getScreenerPhase();
  if (p.phase === 'ready') startWebSocketForReadyPhase();
  else stopWebSocketIfNeeded();
}, 60 * 1000);


/* ============================================================
   SECTION 6 — MIDDLEWARE + HELPERS
   ============================================================ */
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
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

async function generateUsername(fullName, mobile) {
  const first = (fullName || '').trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const last4 = (mobile || '').replace(/\D/g, '').slice(-4);
  const base = (first || 'user') + last4;
  let candidate = base, i = 1;
  while (true) {
    const { rows } = await db.query('SELECT 1 FROM users WHERE username=$1', [candidate]);
    if (!rows.length) return candidate;
    candidate = base + i++;
  }
}

/* ---- Password generator (v1.1 — random suffix) ----
   Format:  {Name}@{last4}{special}{rand4}
   Example: Ravi@3210#a7b2
   Entropy: ~24 bits of randomness on top of user-known info. */
const generatePassword = (fullName, mobile) => {
  const first = (fullName || '').trim().split(/\s+/)[0] || 'User';
  const base = (first.charAt(0).toUpperCase() + first.slice(1).toLowerCase())
    .replace(/[^A-Za-z]/g, '') || 'User';
  const last4 = (mobile || '').replace(/\D/g, '').slice(-4) || '0000';
  const specials = '!#%&*';
  const sp = specials[crypto.randomInt(specials.length)];
  const rand = crypto.randomBytes(3).toString('hex').slice(0, 4);
  return `${base}@${last4}${sp}${rand}`;
};

/* ---- TOTP verification (server-side) ---- */
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
  return [step - 1, step, step + 1].some(c => totpAt(secret, c) === input);
}


/* ============================================================
   SECTION 7 — AUTH ROUTES
   ============================================================ */
app.get('/', (req, res) => res.json({ ok: true, service: 'tradealgo-backend' }));

/* ---- POST /api/login ----------------------------------------
   Step 1 of 2. Verifies password + account state, then returns
   a short-lived pendingToken. Does NOT leak the user's totp_secret.
   Does NOT issue a session token (that's /api/complete-login). */
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
      await db.query("INSERT INTO login_attempts (username, count, locked_until) VALUES ($1,0,NOW()+INTERVAL '15 minutes') ON CONFLICT (username) DO UPDATE SET count=0, locked_until=NOW()+INTERVAL '15 minutes'", [lockKey]);
    } else {
      await db.query("INSERT INTO login_attempts (username, count) VALUES ($1,$2) ON CONFLICT (username) DO UPDATE SET count=$2", [lockKey, c]);
    }
    await log(lockKey, 'LOGIN_FAILED', `Input: ${clean}`, 'danger');
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  await db.query('DELETE FROM login_attempts WHERE username=$1', [lockKey]);

  if (user.disabled) return res.status(403).json({ error: 'Account disabled' });
  if (user.role !== 'admin' && user.expires_at && new Date(user.expires_at) < new Date()) {
    return res.status(403).json({ error: 'Subscription expired', expired: true, expiresAt: user.expires_at });
  }

  /* Issue short-lived pending token — client must come back to
     /api/complete-login with a server-verifiable TOTP code. */
  const pendingToken = jwt.sign(
    { username: user.username, purpose: 'login-pending' },
    SECRET,
    { expiresIn: '5m' }
  );

  res.json({
    ok: true,
    pendingToken,
    username: user.username,
    name: user.name,
    needsSetup: !user.totp_secret,
    hasTotp: !!user.totp_secret
    /* NOTE: totp_secret is intentionally NOT returned */
  });
});

/* ---- POST /api/complete-login -------------------------------
   Step 2 of 2. Requires the pendingToken from /api/login.
   Verifies the 6-digit TOTP code against the SERVER-HELD secret
   before issuing the session JWT.
   - Existing user: send { pendingToken, totpCode }
   - First-time setup: send { pendingToken, totpSecret, totpCode } */
app.post('/api/complete-login', async (req, res) => {
  const { pendingToken, totpCode, totpSecret } = req.body;

  if (!pendingToken) return res.status(400).json({ error: 'Missing session token' });

  let payload;
  try {
    payload = jwt.verify(pendingToken, SECRET);
  } catch {
    return res.status(401).json({ error: 'Login session expired. Please sign in again.' });
  }
  if (payload.purpose !== 'login-pending') {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const { rows } = await db.query('SELECT * FROM users WHERE username=$1', [payload.username]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.disabled) return res.status(403).json({ error: 'Account disabled' });
  if (user.role !== 'admin' && user.expires_at && new Date(user.expires_at) < new Date()) {
    return res.status(403).json({ error: 'Subscription expired', expired: true, expiresAt: user.expires_at });
  }

  const code = String(totpCode || '').trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter a 6-digit code' });
  }

  if (!user.totp_secret) {
    /* ---- First-time setup: user is submitting a new secret ---- */
    if (!totpSecret || typeof totpSecret !== 'string') {
      return res.status(400).json({ error: 'TOTP secret required for setup' });
    }
    if (!verifyTotpServer(totpSecret, code)) {
      await log(user.username, 'TOTP_SETUP_FAILED', 'Bad code during setup', 'danger');
      return res.status(401).json({ error: 'Code did not match. Check your authenticator app.' });
    }
    await db.query('UPDATE users SET totp_secret=$1 WHERE username=$2', [totpSecret, user.username]);
    await log(user.username, 'TOTP_ENABLED', `User: ${user.username}`, 'success');
  } else {
    /* ---- Existing user: verify against stored secret ---- */
    if (!verifyTotpServer(user.totp_secret, code)) {
      await log(user.username, 'LOGIN_TOTP_FAILED', 'Bad TOTP code', 'danger');
      return res.status(401).json({ error: 'Invalid code' });
    }
  }

  const sessionId = crypto.randomUUID();
  await db.query('UPDATE users SET session_id=$1, last_active=NOW() WHERE username=$2', [sessionId, user.username]);

  const token = jwt.sign({ username: user.username, role: user.role, sessionId }, SECRET, { expiresIn: '7h' });
  await log(user.username, 'LOGIN_SUCCESS', `User: ${user.username}`, 'success');

  res.json({
    ok: true, token,
    user: {
      name: user.name, username: user.username, role: user.role,
      plan: user.plan, expiresAt: user.expires_at, mobile: user.mobile, sessionId
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


/* ============================================================
   SECTION 8 — FORGOT PASSWORD
   ============================================================ */
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
  if (user.disabled) return res.status(403).json({ error: 'Account disabled' });
  if (!user.totp_secret) return res.status(400).json({ error: 'No 2FA set up' });
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
  if (!user.totp_secret) return res.status(400).json({ error: 'No 2FA set up' });

  if (!verifyTotpServer(user.totp_secret, String(totpCode).trim())) {
    await log(user.username, 'FORGOT_PASSWORD_FAILED', 'Bad TOTP', 'danger');
    return res.status(401).json({ error: 'Invalid code' });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await db.query('UPDATE users SET password_hash=$1, session_id=NULL WHERE username=$2', [hash, user.username]);
  await log(user.username, 'PASSWORD_RESET_SELF', `User: ${user.username}`, 'warn');
  res.json({ ok: true });
});


/* ============================================================
   SECTION 9 — CHANGE PASSWORD + PROFILE
   ============================================================ */
app.post('/api/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be 6+ characters' });

  const { rows } = await db.query('SELECT * FROM users WHERE username=$1', [req.user.username]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!await bcrypt.compare(currentPassword, user.password_hash)) {
    await log(req.user.username, 'PASSWORD_CHANGE_FAILED', 'Wrong current password', 'danger');
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  const newSessionId = crypto.randomUUID();
  await db.query('UPDATE users SET password_hash=$1, session_id=$2 WHERE username=$3',
    [hash, newSessionId, req.user.username]);

  const token = jwt.sign(
    { username: user.username, role: user.role, sessionId: newSessionId },
    SECRET, { expiresIn: '7h' }
  );
  await log(req.user.username, 'PASSWORD_CHANGED', `User: ${req.user.username}`, 'success');
  res.json({ ok: true, token, sessionId: newSessionId });
});

app.put('/api/me', auth, async (req, res) => {
  const { name, mobile } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const cleanMobile = (mobile || '').replace(/\D/g, '') || null;

  try {
    if (cleanMobile) {
      const dup = await db.query('SELECT username FROM users WHERE mobile=$1 AND username<>$2',
        [cleanMobile, req.user.username]);
      if (dup.rows.length) return res.status(409).json({ error: 'Mobile already in use' });
    }
    await db.query('UPDATE users SET name=$1, mobile=$2 WHERE username=$3',
      [name.trim(), cleanMobile, req.user.username]);
    await log(req.user.username, 'PROFILE_UPDATED', `User: ${req.user.username}`, 'success');
    res.json({ ok: true, name: name.trim(), mobile: cleanMobile });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


/* ============================================================
   SECTION 10 — USERS CRUD (admin)
   ============================================================ */
app.get('/api/users', auth, adminOnly, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, name, username, mobile, role, plan, expires_at AS "expiresAt",
            disabled, last_active AS "lastActive", created_at AS "createdAt"
     FROM users ORDER BY created_at DESC`
  );
  res.json(rows);
});

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

app.put('/api/users/:username', auth, adminOnly, async (req, res) => {
  const target = req.params.username;
  const { name, mobile, plan, role } = req.body;
  const existing = await db.query('SELECT username FROM users WHERE username=$1', [target]);
  if (!existing.rows.length) return res.status(404).json({ error: 'User not found' });

  const cleanMobile = mobile ? String(mobile).replace(/\D/g, '') : null;
  try {
    if (cleanMobile) {
      const dup = await db.query('SELECT username FROM users WHERE mobile=$1 AND username<>$2', [cleanMobile, target]);
      if (dup.rows.length) return res.status(409).json({ error: 'Mobile already in use' });
    }
    await db.query('UPDATE users SET name=$1, mobile=$2, plan=$3, role=$4 WHERE username=$5',
      [name, cleanMobile, plan, role, target]);
    await log(req.user.username, 'USER_UPDATED', `${target}`, 'success');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:username/renew', auth, adminOnly, async (req, res) => {
  const { days } = req.body;
  await db.query(
    `UPDATE users SET expires_at = GREATEST(COALESCE(expires_at, CURRENT_DATE), CURRENT_DATE) + ($1 || ' days')::interval WHERE username=$2`,
    [days, req.params.username]
  );
  await log(req.user.username, 'USER_RENEWED', `${req.params.username} ${days > 0 ? '+' : ''}${days}d`, 'success');
  res.json({ ok: true });
});

app.post('/api/users/:username/set-expiry', auth, adminOnly, async (req, res) => {
  const { expiresAt } = req.body;
  if (!expiresAt) return res.status(400).json({ error: 'expiresAt required' });
  await db.query('UPDATE users SET expires_at=$1 WHERE username=$2', [expiresAt, req.params.username]);
  await log(req.user.username, 'USER_EXPIRY_SET', `${req.params.username} → ${expiresAt}`, 'success');
  res.json({ ok: true });
});

app.post('/api/users/:username/reset', auth, adminOnly, async (req, res) => {
  const { rows } = await db.query('SELECT name, mobile FROM users WHERE username=$1', [req.params.username]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'User not found' });

  const temp = generatePassword(u.name, u.mobile || '0000');
  const hash = await bcrypt.hash(temp, 10);
  await db.query('UPDATE users SET password_hash=$1, totp_secret=NULL, session_id=NULL WHERE username=$2',
    [hash, req.params.username]);
  await log(req.user.username, 'PASSWORD_RESET', req.params.username, 'warn');
  res.json({ ok: true, temp });
});

app.post('/api/users/:username/disable', auth, adminOnly, async (req, res) => {
  await db.query('UPDATE users SET disabled = NOT disabled, session_id = NULL WHERE username=$1', [req.params.username]);
  res.json({ ok: true });
});

app.delete('/api/users/:username', auth, adminOnly, async (req, res) => {
  await db.query('DELETE FROM users WHERE username=$1', [req.params.username]);
  await log(req.user.username, 'USER_DELETED', req.params.username, 'danger');
  res.json({ ok: true });
});


/* ============================================================
   SECTION 11 — AUDIT + PRICES
   ============================================================ */
app.get('/api/audit', auth, adminOnly, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
  res.json(rows);
});

app.delete('/api/audit', auth, adminOnly, async (req, res) => {
  await db.query('DELETE FROM audit_log');
  res.json({ ok: true });
});

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


/* ============================================================
   SECTION 12 — TRADING HOLIDAYS (admin)
   ============================================================ */
app.get('/api/admin/holidays', auth, adminOnly, async (req, res) => {
  const { rows } = await db.query('SELECT date::text AS date, reason FROM trading_holidays ORDER BY date ASC');
  res.json(rows);
});

app.post('/api/admin/holidays', auth, adminOnly, async (req, res) => {
  const { date, reason } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  }
  try {
    await db.query(
      'INSERT INTO trading_holidays (date, reason) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET reason=EXCLUDED.reason',
      [date, reason || null]
    );
    await loadHolidaysFromDB();
    await log(req.user.username, 'HOLIDAY_ADDED', `${date} — ${reason || ''}`, 'success');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/holidays/:date', auth, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM trading_holidays WHERE date=$1', [req.params.date]);
    await loadHolidaysFromDB();
    await log(req.user.username, 'HOLIDAY_REMOVED', req.params.date, 'warn');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


/* ============================================================
   SECTION 13 — SCREENER ROUTES
   ============================================================ */
app.get('/api/stocks', auth, (req, res) => res.json(STOCKS));
app.get('/api/broker/status', auth, (req, res) => res.json(getSessionStatus()));
app.get('/api/ws/status', auth, (req, res) => res.json(getWSStatus()));

app.get('/api/strategies', auth, (req, res) => {
  res.json(Object.values(STRATEGIES).map(s => ({ id: s.id, name: s.name, filters: s.filters })));
});

app.get('/api/screener/status', auth, (req, res) => {
  const p = getScreenerPhase();
  res.json({
    phase: p.phase, date: p.date || null,
    filled: p.date ? countFilled(p.date) : 0, total: STOCKS.length,
    ws: getWSStatus()
  });
});

app.get('/api/screener/data', auth, (req, res) => {
  const strategy = getStrategy(req.query.strategy || 'advance_orb');
  const p = getScreenerPhase();
  if (p.phase === 'closed')  return res.json({ ok: false, phase: 'closed' });
  if (p.phase === 'forming') return res.json({ ok: false, phase: 'forming' });

  const allCandles = getCachedCandles(STOCKS.map(s => s.token), p.date);
  const passing = allCandles.filter(c => passesStrategy(c.candle, strategy));
  const passingTokens = new Set(passing.map(c => String(c.token)));
  const passingStocks = STOCKS.filter(s => passingTokens.has(String(s.token)));

  res.json({
    ok: true, phase: p.phase, date: p.date,
    strategy: strategy.id, strategyName: strategy.name, filters: strategy.filters,
    filled: passing.length, total: STOCKS.length,
    results: passing, stocks: passingStocks
  });
});

app.post('/api/screener/fetch-batch', auth, async (req, res) => {
  const { tokens } = req.body;
  if (!Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: 'tokens array required' });
  const p = getScreenerPhase();
  if (p.phase !== 'ready' && p.phase !== 'weekend') {
    return res.status(400).json({ error: `Cannot fetch in phase: ${p.phase}` });
  }

  try {
    const results = await getCandlesForTokens(tokens, p.date);
    for (const r of results) {
      const c = r.candle;
      if (Array.isArray(c) && c.length >= 5) {
        db.query(
          `INSERT INTO angel_15m_candle (date, token, sym, open, high, low, close, volume, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (date, token) DO UPDATE SET
             sym=EXCLUDED.sym, open=EXCLUDED.open, high=EXCLUDED.high,
             low=EXCLUDED.low, close=EXCLUDED.close, volume=EXCLUDED.volume, updated_at=NOW()`,
          [p.date, r.token, SYM_BY_TOKEN[r.token] || '?', c[1], c[2], c[3], c[4], c[5] || 0]
        ).catch(() => {});
        if (!orbState.has(`${r.token}_${p.date}`)) {
          orbState.set(`${r.token}_${p.date}`, {
            lowBroken: false, pullbackConfirmed: false, entrySignal: false,
            firstLowBreakAt: null, firstPullbackAt: null, firstEntryAt: null
          });
        }
      }
    }
    res.json({ ok: true, date: p.date, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Client polls this — reads from memory, no API calls */
app.post('/api/screener/ltp', auth, async (req, res) => {
  const { tokens } = req.body;
  if (!Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: 'tokens array required' });
  const p = getScreenerPhase();
  if (!p.date) return res.json({ ok: true, results: [] });

  const serverTime = new Date().toISOString();
  const enriched = tokens.map(t => {
    const token = String(t);
    const state = getOrbState(token, p.date);
    const ltp = getCachedLTP(token);          /* ← fix #4: was hardcoded null */
    return {
      token,
      ltp,                                     /* ← live price from memory cache */
      lowBroken: state.lowBroken,
      pullbackConfirmed: state.pullbackConfirmed,
      entrySignal: state.entrySignal,
      newLowAt: state.firstLowBreakAt,
      pullbackAt: state.firstPullbackAt,
      breakoutAt: state.firstEntryAt,
      serverTime
    };
  });

  res.json({ ok: true, count: enriched.length, results: enriched });
});


/* ============================================================
   SECTION 14 — CLOSING PRICES (15:34 IST)
   ============================================================ */
async function fetchClosingPrices() {
  try {
    const p = getScreenerPhase();
    if (!p.date) return;
    const tokens = STOCKS.map(s => s.token);
    console.log(`🔔 Fetching closing prices for ${tokens.length} stocks...`);

    const { ok, failed } = await fetchAllClosingPrices(tokens, p.date);
    for (const r of ok) {
      setCachedLTP(r.token, r.price);
      db.query(`UPDATE angel_15m_candle SET ltp=$1, ltp_updated_at=NOW() WHERE date=$2 AND token=$3`,
        [r.price, p.date, r.token]).catch(() => {});
    }
    console.log(`✅ Closing prices: ${ok.length}/${tokens.length} (failed: ${failed.length})`);
  } catch (e) { console.error('Closing fetch failed:', e.message); }
}

app.post('/api/admin/force-ltp', auth, adminOnly, async (req, res) => {
  try {
    const p = getScreenerPhase();
    if (!p.date) return res.status(400).json({ error: 'No trading date' });
    const tokens = STOCKS.map(s => s.token);
    const { ok, failed } = await fetchAllClosingPrices(tokens, p.date);
    let saved = 0;
    for (const r of ok) {
      saved++;
      setCachedLTP(r.token, r.price);
      await db.query(`UPDATE angel_15m_candle SET ltp=$1, ltp_updated_at=NOW() WHERE date=$2 AND token=$3`,
        [r.price, p.date, r.token]);
    }
    res.json({ ok: true, saved, failed: failed.length, total: tokens.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function msUntilNext1534IST() {
  const ist = getIST();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const target = new Date(ist);
  target.setUTCHours(0, 0, 0, 0);
  target.setUTCMinutes(934);
  if (mins >= 934) target.setUTCDate(target.getUTCDate() + 1);
  const dow = target.getUTCDay();
  if (dow === 6) target.setUTCDate(target.getUTCDate() + 2);
  if (dow === 0) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - ist.getTime();
}

function scheduleClosingFetch() {
  const ms = msUntilNext1534IST();
  console.log(`⏰ Next closing fetch in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => { await fetchClosingPrices(); scheduleClosingFetch(); }, ms);
}


/* ============================================================
   SECTION 15 — DB CACHE LOADER
   ============================================================ */
async function loadScreenerCacheFromDB() {
  try {
    const p = getScreenerPhase();
    if (!p.date) return;
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      'SELECT token, open, high, low, close, volume, ltp FROM angel_15m_candle WHERE date=$1 AND token = ANY($2)',
      [p.date, activeTokens]
    );
    for (const r of rows) {
      setCachedCandle(r.token, p.date, [0, +r.open, +r.high, +r.low, +r.close, +r.volume]);
      if (r.ltp) setCachedLTP(r.token, r.ltp);
    }
    console.log(`📦 Loaded ${rows.length} candles for ${p.date}`);
    await loadOrbStateFromDB(p.date);
  } catch (e) { console.error('DB load failed:', e.message); }
}


/* ============================================================
   SECTION 16 — START
   ============================================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server on port ${PORT}`);
  console.log(`📊 Strategy: ${STRATEGIES.advance_orb.name}`);

  try {
    await loginPlatform();
    console.log('✅ Angel One session started');
  } catch (e) { console.error('⚠️  Angel login failed:', e.message); }

  await loadHolidaysFromDB();
  await loadScreenerCacheFromDB();

  // Late startup — if server restarts after 15:34 on a weekday, fetch closing now
  const nowIST = getIST();
  const mins = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
  const dow = nowIST.getUTCDay();
  if (dow >= 1 && dow <= 5 && mins >= 934 && mins <= 960) {
    console.log('🔔 Late startup — fetching closing prices');
    fetchClosingPrices();
  }
  scheduleClosingFetch();

  console.log('ℹ️  Ready — manual fetch + live WS');
});
