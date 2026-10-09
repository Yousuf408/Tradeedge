/* ============================================================
   server.js — TradeAlgo Pro backend  |  v3.2
   ============================================================

   - REST historical → open/high/low/close
   - FULL Quote (9:30:10 auto) → q15_* columns
   - 15:16 daily fetch → day_high/low/close + pivot
   - 9:15:30 BS fetch → then every 30s refresh (buy/sell + volume)
   - prevClose loaded from previous day's day_close
   - WS starts at 09:14:55 IST, stops at 15:30
   - LTP live via WS→SSE; BS via REST→SSE every 30s
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
  loginPlatform as loginREST,
  getCandlesForTokens,
  getCachedCandles,
  setCachedCandle,
  setCachedLTP,
  getCachedLTP,
  fetchAllClosingPrices,
  getSessionStatus as getSessionStatusREST,
  getFeedToken as getFeedTokenREST
} from './brokers/angelone/Angel_REST.js';

import {
  loginPlatform as loginQuote,
  fetchQuotesForTokens,
  getSessionStatus as getSessionStatusQuote,
  getFeedToken as getFeedTokenQuote
} from './brokers/angelone/Angel_Quote.js';

import {
  loginPlatform as loginBS,
  getSessionStatus as getSessionStatusBS,
  fetchBuySellForTokens
} from './brokers/angelone/Angel_BS.js';

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
  max: 20,
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

const NIFTY50_TOKEN = '99926000';
const ENTRY_CUTOFF_MINS = Number(process.env.ENTRY_CUTOFF_MINS || 885);

const STRATEGIES = {
  momentum: {
    id: 'momentum',
    name: 'Momentum',
    filters: { maxRangePct: 1.5, minPrice: 150, maxPrice: 3500 }
  },
  advance_orb: {
    id: 'advance_orb',
    name: 'Advance ORB',
    filters: { maxRangePct: 1.5, minPrice: 150, maxPrice: 3500 }
  }
};

const getStrategy = id => STRATEGIES[id] || STRATEGIES.momentum;

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
  d.getUTCDay() !== 0 && d.getUTCDay() !== 6 &&
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

function shouldStartWS() {
  const ist = getIST();
  if (!isTradingDay(ist)) return false;
  const secs = ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
  const start = 9 * 3600 + 14 * 60 + 55;
  const end   = 15 * 3600 + 30 * 60;
  return secs >= start && secs < end;
}

function countFilled(date) {
  const cached = getCachedCandles(STOCKS.map(s => s.token), date);
  return cached.filter(c => c.candle && !c.candle.error && Array.isArray(c.candle)).length;
}


/* ============================================================
   SECTION 4 — ORB STATE
   ============================================================ */
const orbState = new Map();

async function loadOrbStateFromDB(date) {
  try {
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      `SELECT token, low_broken, first_low_break_at, first_low_break_price,
              pullback_confirmed, first_pullback_at, first_pullback_price,
              entry_signal, first_entry_at, first_entry_price,
              target_hit, target_hit_at, sl_hit, sl_hit_at
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
        firstEntryAt: r.first_entry_at,
        firstLowBreakPrice: r.first_low_break_price != null ? +r.first_low_break_price : null,
        firstPullbackPrice: r.first_pullback_price != null ? +r.first_pullback_price : null,
        firstEntryPrice: r.first_entry_price != null ? +r.first_entry_price : null,
        targetHit: !!r.target_hit,
        targetHitAt: r.target_hit_at,
        slHit: !!r.sl_hit,
        slHitAt: r.sl_hit_at
      });
    }
    console.log(`🎯 Loaded ORB for ${rows.length} stocks`);
  } catch (e) { console.error('ORB load failed:', e.message); }
}

const getOrbState = (token, date) => orbState.get(`${token}_${date}`) || {
  lowBroken: false, pullbackConfirmed: false, entrySignal: false,
  firstLowBreakAt: null, firstPullbackAt: null, firstEntryAt: null,
  firstLowBreakPrice: null, firstPullbackPrice: null, firstEntryPrice: null,
  targetHit: false, targetHitAt: null, slHit: false, slHitAt: null
};


/* ============================================================
   SECTION 4.1 — PREV CLOSE
   ============================================================ */
const prevCloseCache = new Map();

async function loadPrevCloseFromDB() {
  try {
    const activeTokens = [...STOCKS.map(s => String(s.token)), NIFTY50_TOKEN];
    const today = getIST().toISOString().split('T')[0];
    const { rows } = await db.query(
      `SELECT DISTINCT ON (token) token, day_close
       FROM angel_15m_candle
       WHERE day_close IS NOT NULL
         AND token = ANY($1)
         AND date < $2
       ORDER BY token, date DESC`,
      [activeTokens, today]
    );
    for (const r of rows) prevCloseCache.set(String(r.token), +r.day_close);
    console.log(`💾 Loaded prevClose for ${rows.length} tokens (from day_close < ${today})`);
  } catch (e) { console.error('prevClose load failed:', e.message); }
}


/* ============================================================
   SECTION 4.2 — QUOTE H/L CACHE
   ============================================================ */
const quoteCache = new Map();

async function loadQuoteCacheFromDB() {
  try {
    const p = getScreenerPhase();
    if (!p.date) return;
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      `SELECT token, q15_high, q15_low, quote_fetched_at
       FROM angel_15m_candle
       WHERE date=$1 AND token = ANY($2) AND q15_high IS NOT NULL`,
      [p.date, activeTokens]
    );
    for (const r of rows) {
      quoteCache.set(String(r.token), {
        high: +r.q15_high,
        low: +r.q15_low,
        fetchedAt: r.quote_fetched_at
      });
    }
    console.log(`📊 Loaded quote H/L for ${rows.length} tokens from DB`);
  } catch (e) { console.error('quoteCache load failed:', e.message); }
}


/* ============================================================
   SECTION 4.2b — PIVOT CACHE
   ============================================================ */
const pivotCache = new Map();

async function loadLatestPivotFromDB() {
  try {
    const activeTokens = STOCKS.map(s => String(s.token));
    const today = getIST().toISOString().split('T')[0];
    const { rows } = await db.query(
      `SELECT DISTINCT ON (token) token, pivot
       FROM angel_15m_candle
       WHERE pivot IS NOT NULL
         AND token = ANY($1)
         AND date < $2
       ORDER BY token, date DESC`,
      [activeTokens, today]
    );
    for (const r of rows) pivotCache.set(String(r.token), +r.pivot);
    console.log(`📐 Loaded pivot for ${rows.length} tokens (from dates < ${today})`);
  } catch (e) { console.error('pivot load failed:', e.message); }
}


/* ============================================================
   SECTION 4.3 — BUY/SELL CACHE
   ============================================================ */
const bsCache = new Map();

async function loadBSCacheFromDB() {
  try {
    const p = getScreenerPhase();
    if (!p.date) return;
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      `SELECT token, buy_qty, sell_qty, ltp, volume, rank_no
       FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id=$2 AND token = ANY($3)`,
      [p.date, 'momentum', activeTokens]
    );
    for (const r of rows) {
      bsCache.set(String(r.token), {
        buyQty: r.buy_qty != null ? +r.buy_qty : null,
        sellQty: r.sell_qty != null ? +r.sell_qty : null,
        ltp: r.ltp != null ? +r.ltp : null,
        volume: r.volume != null ? +r.volume : null,
        rank: r.rank_no != null ? +r.rank_no : null
      });
    }
    console.log(`💹 Loaded buy/sell for ${rows.length} tokens from DB`);
  } catch (e) { console.error('BS cache load failed:', e.message); }
}


/* ============================================================
   SECTION 5 — WEBSOCKET + SSE + BATCHED LTP
   ============================================================ */
let wsStarted = false;

const LTP_FLUSH_MS = Number(process.env.LTP_FLUSH_MS || 300000);
const ltpWriteQueue = new Map();
let ltpWriteTimer = null;

function queueLtpWrite(token, ltp, date) {
  ltpWriteQueue.set(String(token), { ltp, date });
  if (ltpWriteTimer) return;
  ltpWriteTimer = setTimeout(flushLtpWrites, LTP_FLUSH_MS);
}

async function flushLtpWrites() {
  ltpWriteTimer = null;
  if (!ltpWriteQueue.size) return;
  const entries = [...ltpWriteQueue.entries()];
  ltpWriteQueue.clear();

  const byDate = new Map();
  for (const [token, { ltp, date }] of entries) {
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push([token, ltp]);
  }
  for (const [date, rows] of byDate) {
    const tokens = rows.map(r => r[0]);
    const prices = rows.map(r => r[1]);
    try {
      await db.query(
        `UPDATE angel_15m_candle AS c
         SET ltp = v.ltp, ltp_updated_at = NOW()
         FROM (SELECT unnest($1::text[]) AS token, unnest($2::numeric[]) AS ltp) AS v
         WHERE c.date = $3 AND c.token = v.token`,
        [tokens, prices, date]
      );
      console.log(`💾 LTP flushed: ${rows.length} tokens`);
    } catch (e) { console.error('LTP flush failed:', e.message); }
  }
}

process.on('SIGTERM', async () => { try { await flushLtpWrites(); } catch {} process.exit(0); });
process.on('SIGINT',  async () => { try { await flushLtpWrites(); } catch {} process.exit(0); });

/* ---- SSE ---- */
const sseClients = new Set();
let ssePending = new Map();
let sseFlushTimer = null;

function broadcastLTP(token, ltp) {
  if (!sseClients.size) return;
  ssePending.set(String(token), ltp);
  if (sseFlushTimer) return;
  sseFlushTimer = setTimeout(() => {
    sseFlushTimer = null;
    if (!ssePending.size) return;
    const payload = `data: ${JSON.stringify({ type: 'ltp', ticks: Object.fromEntries(ssePending) })}\n\n`;
    ssePending.clear();
    for (const c of sseClients) {
      try { c.res.write(payload); } catch { sseClients.delete(c); }
    }
  }, 100);
}

function broadcastORB(token, state) {
  if (!sseClients.size) return;
  const payload = `data: ${JSON.stringify({
    type: 'orb', token,
    state: {
      lowBroken: state.lowBroken, pullbackConfirmed: state.pullbackConfirmed, entrySignal: state.entrySignal,
      firstLowBreakAt: state.firstLowBreakAt, firstPullbackAt: state.firstPullbackAt, firstEntryAt: state.firstEntryAt,
      firstLowBreakPrice: state.firstLowBreakPrice, firstPullbackPrice: state.firstPullbackPrice, firstEntryPrice: state.firstEntryPrice,
      targetHit: state.targetHit, targetHitAt: state.targetHitAt, slHit: state.slHit, slHitAt: state.slHitAt
    }
  })}\n\n`;
  for (const c of sseClients) {
    try { c.res.write(payload); } catch { sseClients.delete(c); }
  }
}

function broadcastQuote(fetchedAt) {
  if (!sseClients.size) return;
  const payload = `data: ${JSON.stringify({
    type: 'quote', fetchedAt,
    quotes: Object.fromEntries([...quoteCache.entries()].map(([t, v]) => [t, { high: v.high, low: v.low, fetchedAt: v.fetchedAt }]))
  })}\n\n`;
  for (const c of sseClients) {
    try { c.res.write(payload); } catch { sseClients.delete(c); }
  }
}

function broadcastBS(fetchedAt) {
  if (!sseClients.size) return;
  const payload = `data: ${JSON.stringify({
    type: 'bs', fetchedAt,
    bs: Object.fromEntries([...bsCache.entries()].map(([t, v]) => [t, { buyQty: v.buyQty, sellQty: v.sellQty, ltp: v.ltp, volume: v.volume, rank: v.rank }]))
  })}\n\n`;
  for (const c of sseClients) {
    try { c.res.write(payload); } catch { sseClients.delete(c); }
  }
}

function handleTick(token, ltp) {
  if (!Number.isFinite(ltp) || ltp < 1 || ltp > 1000000) return;

  if (token === NIFTY50_TOKEN) {
    setCachedLTP(token, ltp);
    broadcastLTP(token, ltp);
    return;
  }

  setCachedLTP(token, ltp);
  broadcastLTP(token, ltp);

  const p = getScreenerPhase();
  if (p.phase !== 'ready' || !p.date) return;

  const candleArr = getCachedCandles([token], p.date)[0]?.candle;
  if (!Array.isArray(candleArr) || candleArr.length < 5) return;

  const low = +candleArr[3];
  const high = +candleArr[2];
  const key = `${token}_${p.date}`;
  const state = getOrbState(token, p.date);
  let changed = false;

  if (!state.lowBroken && ltp < low) {
    state.lowBroken = true;
    state.firstLowBreakAt = new Date().toISOString();
    state.firstLowBreakPrice = ltp;
    db.query(
      `UPDATE angel_15m_candle SET low_broken=true, first_low_break_at=NOW(), first_low_break_price=$3
       WHERE date=$1 AND token=$2 AND low_broken=false`,
      [p.date, token, ltp]
    ).catch(() => {});
    changed = true;
  }

  if (state.lowBroken && !state.pullbackConfirmed && ltp > low && ltp < high) {
    state.pullbackConfirmed = true;
    state.firstPullbackAt = new Date().toISOString();
    state.firstPullbackPrice = ltp;
    db.query(
      `UPDATE angel_15m_candle SET pullback_confirmed=true, first_pullback_at=NOW(), first_pullback_price=$3
       WHERE date=$1 AND token=$2 AND pullback_confirmed=false`,
      [p.date, token, ltp]
    ).catch(() => {});
    changed = true;
  }

  if (state.pullbackConfirmed && !state.entrySignal && ltp > high) {
    const ist = getIST();
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (mins < ENTRY_CUTOFF_MINS) {
      state.entrySignal = true;
      state.firstEntryAt = new Date().toISOString();
      state.firstEntryPrice = ltp;
      db.query(
        `UPDATE angel_15m_candle SET entry_signal=true, first_entry_at=NOW(), first_entry_price=$3
         WHERE date=$1 AND token=$2 AND entry_signal=false`,
        [p.date, token, ltp]
      ).catch(() => {});
      changed = true;
    }
  }

  if (state.entrySignal && !state.targetHit && !state.slHit) {
    const target = high * 1.01;
    if (ltp >= target) {
      state.targetHit = true;
      state.targetHitAt = new Date().toISOString();
      db.query(`UPDATE angel_15m_candle SET target_hit=true, target_hit_at=NOW() WHERE date=$1 AND token=$2 AND target_hit=false`,
        [p.date, token]).catch(() => {});
      changed = true;
    } else if (ltp <= low) {
      state.slHit = true;
      state.slHitAt = new Date().toISOString();
      db.query(`UPDATE angel_15m_candle SET sl_hit=true, sl_hit_at=NOW() WHERE date=$1 AND token=$2 AND sl_hit=false`,
        [p.date, token]).catch(() => {});
      changed = true;
    }
  }

  if (changed) { orbState.set(key, state); broadcastORB(token, state); }
  queueLtpWrite(token, ltp, p.date);
}

function startWebSocketForReadyPhase() {
  if (wsStarted) return;
  if (!shouldStartWS()) return;

  const restSession = getSessionStatusREST();
  const feedToken = restSession.loggedIn ? getFeedTokenREST() : getFeedTokenQuote();
  if (!feedToken) { console.log('⚠️  WS skipped — no feed token'); return; }

  const tokens = [...STOCKS.map(s => String(s.token)), NIFTY50_TOKEN];
  try {
    startWS({
      apiKey: process.env.ANGEL_API_KEY,
      clientCode: process.env.ANGEL_CLIENT_ID,
      feedToken, tokens, onTick: handleTick,
      onDisconnect: async (gapStart, gapEnd) => {
        console.log(`🔁 WS gap ${Math.round((gapEnd - gapStart) / 1000)}s — reconnecting`);
      }
    });
    wsStarted = true;
    console.log(`🔌 WS started for ${tokens.length} tokens`);
  } catch (e) { console.error('WS start failed:', e.message); }
}

function stopWebSocketIfNeeded() {
  if (!wsStarted) return;
  if (shouldStartWS()) return;

  stopWS();
  wsStarted = false;
  flushLtpWrites().catch(() => {});
  console.log('🔌 WS stopped');
}

setInterval(() => {
  if (shouldStartWS()) startWebSocketForReadyPhase();
  else stopWebSocketIfNeeded();
}, 5 * 1000);


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
    await db.query('INSERT INTO audit_log (actor, action, details, level) VALUES ($1,$2,$3,$4)',
      [actor, action, details, level]);
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

const generatePassword = (fullName, mobile) => {
  const first = (fullName || '').trim().split(/\s+/)[0] || 'User';
  const base = (first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()).replace(/[^A-Za-z]/g, '') || 'User';
  const last4 = (mobile || '').replace(/\D/g, '').slice(-4) || '0000';
  const sp = '!#%&*'[crypto.randomInt(5)];
  const rand = crypto.randomBytes(3).toString('hex').slice(0, 4);
  return `${base}@${last4}${sp}${rand}`;
};

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
  const code = ((sig[off] & 0x7f) << 24) | ((sig[off + 1] & 0xff) << 16)
             | ((sig[off + 2] & 0xff) << 8)  | (sig[off + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}
function verifyTotpServer(secret, input) {
  const step = Math.floor(Date.now() / 1000 / 30);
  return [step - 1, step, step + 1].some(c => totpAt(secret, c) === input);
}


/* ============================================================
   SECTION 7 — AUTH
   ============================================================ */
app.get('/', (req, res) => res.json({ ok: true, service: 'tradealgo-backend', mode: 'dual-rest-quote-bs' }));

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

  const pendingToken = jwt.sign({ username: user.username, purpose: 'login-pending' }, SECRET, { expiresIn: '5m' });
  res.json({
    ok: true, pendingToken, username: user.username, name: user.name,
    needsSetup: !user.totp_secret, hasTotp: !!user.totp_secret
  });
});

app.post('/api/complete-login', async (req, res) => {
  const { pendingToken, totpCode, totpSecret } = req.body;
  if (!pendingToken) return res.status(400).json({ error: 'Missing session token' });

  let payload;
  try { payload = jwt.verify(pendingToken, SECRET); }
  catch { return res.status(401).json({ error: 'Login session expired. Please sign in again.' }); }
  if (payload.purpose !== 'login-pending') return res.status(401).json({ error: 'Invalid session' });

  const { rows } = await db.query('SELECT * FROM users WHERE username=$1', [payload.username]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.disabled) return res.status(403).json({ error: 'Account disabled' });
  if (user.role !== 'admin' && user.expires_at && new Date(user.expires_at) < new Date()) {
    return res.status(403).json({ error: 'Subscription expired', expired: true, expiresAt: user.expires_at });
  }

  const code = String(totpCode || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter a 6-digit code' });

  if (!user.totp_secret) {
    if (!totpSecret || typeof totpSecret !== 'string') return res.status(400).json({ error: 'TOTP secret required for setup' });
    if (!verifyTotpServer(totpSecret, code)) {
      await log(user.username, 'TOTP_SETUP_FAILED', 'Bad code during setup', 'danger');
      return res.status(401).json({ error: 'Code did not match. Check your authenticator app.' });
    }
    await db.query('UPDATE users SET totp_secret=$1 WHERE username=$2', [totpSecret, user.username]);
    await log(user.username, 'TOTP_ENABLED', `User: ${user.username}`, 'success');
  } else {
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
    user: { name: user.name, username: user.username, role: user.role, plan: user.plan, expiresAt: user.expires_at, mobile: user.mobile, sessionId }
  });
});

app.get('/api/session-check', auth, async (req, res) => {
  const { rows } = await db.query('SELECT session_id, disabled, role, expires_at FROM users WHERE username=$1', [req.user.username]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'User gone' });
  if (user.disabled) return res.status(401).json({ error: 'Disabled' });
  if (user.session_id !== req.user.sessionId) return res.status(401).json({ error: 'Logged in elsewhere' });
  if (user.role !== 'admin' && user.expires_at && new Date(user.expires_at) < new Date()) return res.status(401).json({ error: 'Expired' });
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
  await db.query('UPDATE users SET password_hash=$1, session_id=$2 WHERE username=$3', [hash, newSessionId, req.user.username]);
  const token = jwt.sign({ username: user.username, role: user.role, sessionId: newSessionId }, SECRET, { expiresIn: '7h' });
  await log(req.user.username, 'PASSWORD_CHANGED', `User: ${req.user.username}`, 'success');
  res.json({ ok: true, token, sessionId: newSessionId });
});

app.put('/api/me', auth, async (req, res) => {
  const { name, mobile } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const cleanMobile = (mobile || '').replace(/\D/g, '') || null;
  try {
    if (cleanMobile) {
      const dup = await db.query('SELECT username FROM users WHERE mobile=$1 AND username<>$2', [cleanMobile, req.user.username]);
      if (dup.rows.length) return res.status(409).json({ error: 'Mobile already in use' });
    }
    await db.query('UPDATE users SET name=$1, mobile=$2 WHERE username=$3', [name.trim(), cleanMobile, req.user.username]);
    await log(req.user.username, 'PROFILE_UPDATED', `User: ${req.user.username}`, 'success');
    res.json({ ok: true, name: name.trim(), mobile: cleanMobile });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


/* ============================================================
   SECTION 10 — USERS CRUD
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
      `INSERT INTO users (name, username, mobile, password_hash, plan, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
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
    await db.query('UPDATE users SET name=$1, mobile=$2, plan=$3, role=$4 WHERE username=$5', [name, cleanMobile, plan, role, target]);
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
  await db.query('UPDATE users SET password_hash=$1, totp_secret=NULL, session_id=NULL WHERE username=$2', [hash, req.params.username]);
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
   SECTION 12 — TRADING HOLIDAYS
   ============================================================ */
app.get('/api/admin/holidays', auth, adminOnly, async (req, res) => {
  const { rows } = await db.query('SELECT date::text AS date, reason FROM trading_holidays ORDER BY date ASC');
  res.json(rows);
});

app.post('/api/admin/holidays', auth, adminOnly, async (req, res) => {
  const { date, reason } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
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
   SECTION 13 — SCREENER ROUTES + SSE
   ============================================================ */
app.get('/api/stocks', auth, (req, res) => res.json(STOCKS));

app.get('/api/broker/status', auth, (req, res) => {
  res.json({
    rest: getSessionStatusREST(),
    quote: getSessionStatusQuote(),
    bs: getSessionStatusBS()
  });
});

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
  const strategy = getStrategy(req.query.strategy || 'momentum');
  const p = getScreenerPhase();
  if (p.phase === 'closed')  return res.json({ ok: false, phase: 'closed' });
  if (p.phase === 'forming') return res.json({ ok: false, phase: 'forming' });

  const allCandles = getCachedCandles(STOCKS.map(s => s.token), p.date);
  const cachedTokens = allCandles
    .filter(c => Array.isArray(c.candle) && c.candle.length >= 5)
    .map(c => String(c.token));

  const passing = allCandles.filter(c => passesStrategy(c.candle, strategy));
  const passingTokens = new Set(passing.map(c => String(c.token)));
  const passingStocks = STOCKS.filter(s => passingTokens.has(String(s.token)));

  const quotes = {};
  for (const t of cachedTokens) {
    const q = quoteCache.get(t);
    if (q) quotes[t] = { high: q.high, low: q.low, fetchedAt: q.fetchedAt };
  }

  const allCached = allCandles.filter(c => Array.isArray(c.candle) && c.candle.length >= 5);

  res.json({
    ok: true, phase: p.phase, date: p.date,
    strategy: strategy.id, strategyName: strategy.name, filters: strategy.filters,
    filled: passing.length, total: STOCKS.length,
    cachedTokens, quotes,
    results: allCached, stocks: passingStocks
  });
});

app.get('/api/screener/stream', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).end();
  try { jwt.verify(token, SECRET); } catch { return res.status(401).end(); }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const client = { res };
  sseClients.add(client);
  console.log(`📡 SSE client connected (total: ${sseClients.size})`);

  res.write(`event: hello\ndata: {"ok":true}\n\n`);

  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(client);
    console.log(`📡 SSE client disconnected (total: ${sseClients.size})`);
  });
});

/* ---- REST 9:15 candle fetch ---- */
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
             low=EXCLUDED.low, close=EXCLUDED.close, volume=EXCLUDED.volume,
             updated_at=NOW()`,
          [p.date, r.token, SYM_BY_TOKEN[r.token] || '?', c[1], c[2], c[3], c[4], c[5] || 0]
        ).catch(() => {});
        if (!orbState.has(`${r.token}_${p.date}`)) {
          orbState.set(`${r.token}_${p.date}`, {
            lowBroken: false, pullbackConfirmed: false, entrySignal: false,
            firstLowBreakAt: null, firstPullbackAt: null, firstEntryAt: null,
            firstLowBreakPrice: null, firstPullbackPrice: null, firstEntryPrice: null,
            targetHit: false, targetHitAt: null, slHit: false, slHitAt: null
          });
        }
      }
    }
    console.log(`📊 REST fetch: ${results.length}/${tokens.length} candles`);
    res.json({ ok: true, date: p.date, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- FULL Quote fetch ---- */
app.post('/api/screener/fetch-quote-batch', auth, async (req, res) => {
  const { tokens } = req.body;
  if (!Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: 'tokens array required' });
  const p = getScreenerPhase();
  if (!p.date) return res.status(400).json({ error: 'No trading date' });

  try {
    const quotes = await fetchQuotesForTokens(tokens);
    const fetchedAt = new Date();
    const results = [];

    for (const q of quotes) {
      if (!q || !q.token) continue;
      if (!Number.isFinite(q.high) || !Number.isFinite(q.low) || q.high <= 0 || q.low <= 0) continue;

      const token = String(q.token);
      quoteCache.set(token, { high: q.high, low: q.low, fetchedAt });

      db.query(
        `INSERT INTO angel_15m_candle (date, token, sym, q15_open, q15_high, q15_low, q15_close, quote_fetched_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (date, token) DO UPDATE SET
           sym=EXCLUDED.sym,
           q15_open=EXCLUDED.q15_open, q15_high=EXCLUDED.q15_high,
           q15_low=EXCLUDED.q15_low, q15_close=EXCLUDED.q15_close,
           quote_fetched_at=EXCLUDED.quote_fetched_at, updated_at=NOW()`,
        [p.date, token, SYM_BY_TOKEN[token] || '?', q.open || q.low, q.high, q.low, q.ltp || q.high, fetchedAt]
      ).catch(() => {});

      setCachedCandle(token, p.date, [0, q.open || q.low, q.high, q.low, q.ltp || q.high, 0]);
      if (q.ltp) setCachedLTP(token, q.ltp);

      if (!orbState.has(`${token}_${p.date}`)) {
        orbState.set(`${token}_${p.date}`, {
          lowBroken: false, pullbackConfirmed: false, entrySignal: false,
          firstLowBreakAt: null, firstPullbackAt: null, firstEntryAt: null,
          firstLowBreakPrice: null, firstPullbackPrice: null, firstEntryPrice: null,
          targetHit: false, targetHitAt: null, slHit: false, slHitAt: null
        });
      }

      results.push({ token, open: q.open, high: q.high, low: q.low, close: q.ltp, prevClose: q.close });
    }

    broadcastQuote(fetchedAt);
    console.log(`📊 Quote fetch: ${results.length}/${tokens.length} processed`);
    res.json({ ok: true, date: p.date, fetchedAt, results });
  } catch (e) {
    console.error('fetch-quote-batch failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ---- LTP + ORB + quote + pivot + BS + rank ---- */
app.post('/api/screener/ltp', auth, async (req, res) => {
  const { tokens } = req.body;
  if (!Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: 'tokens array required' });
  const p = getScreenerPhase();
  if (!p.date) return res.json({ ok: true, results: [] });

  const serverTime = new Date().toISOString();
  const enriched = tokens.map(t => {
    const token = String(t);
    const state = getOrbState(token, p.date);
    const ltp = getCachedLTP(token);
    const prevClose = prevCloseCache.get(token) || null;
    const quote = quoteCache.get(token) || null;
    const pivot = pivotCache.get(token) || null;
    const bs = bsCache.get(token) || null;
    return {
      token, ltp, prevClose, pivot,
      buyQty: bs?.buyQty ?? null,
      sellQty: bs?.sellQty ?? null,
      bsVolume: bs?.volume ?? null,
      rank: bs?.rank ?? null,
      highQuote: quote?.high ?? null,
      lowQuote: quote?.low ?? null,
      quoteFetchedAt: quote?.fetchedAt ?? null,
      lowBroken: state.lowBroken,
      pullbackConfirmed: state.pullbackConfirmed,
      entrySignal: state.entrySignal,
      newLowAt: state.firstLowBreakAt,
      pullbackAt: state.firstPullbackAt,
      breakoutAt: state.firstEntryAt,
      lowBreakPrice: state.firstLowBreakPrice,
      pullbackPrice: state.firstPullbackPrice,
      entryPrice: state.firstEntryPrice,
      targetHit: state.targetHit,
      targetHitAt: state.targetHitAt,
      slHit: state.slHit,
      slHitAt: state.slHitAt,
      serverTime
    };
  });

  res.json({ ok: true, count: enriched.length, results: enriched });
});


/* ============================================================
   SECTION 14 — DAY H/L/C FETCH (15:16 IST) + PIVOT
   ============================================================ */
async function fetchDayHLC() {
  try {
    const p = getScreenerPhase();
    if (!p.date) return;
    const allTokens = STOCKS.map(s => String(s.token));
    console.log(`🔔 Fetching day H/L/C (Quote) for ${allTokens.length} stocks...`);

    const savedTokens = new Set();
    const t0 = Date.now();

    let quotes = await fetchQuotesForTokens(allTokens);
    for (const q of quotes) {
      if (!q || !q.token) continue;
      if (!Number.isFinite(q.high) || !Number.isFinite(q.low) || q.high <= 0 || q.low <= 0) continue;

      const token = String(q.token);
      const close = q.ltp || q.close;
      const pivot = (+q.high + +q.low + +close) / 3;

      db.query(
        `INSERT INTO angel_15m_candle (date, token, sym, day_high, day_low, day_close, pivot, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (date, token) DO UPDATE SET
           day_high=EXCLUDED.day_high,
           day_low=EXCLUDED.day_low,
           day_close=EXCLUDED.day_close,
           pivot=EXCLUDED.pivot,
           updated_at=NOW()`,
        [p.date, token, SYM_BY_TOKEN[token] || '?', q.high, q.low, close, pivot]
      ).catch(() => {});

      savedTokens.add(token);
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      const missing = allTokens.filter(t => !savedTokens.has(t));
      if (!missing.length) break;

      console.log(`🔁 Retry ${attempt}: ${missing.length} missing tokens...`);
      await new Promise(r => setTimeout(r, 1500));

      const retry = await fetchQuotesForTokens(missing);
      for (const q of retry) {
        if (!q || !q.token) continue;
        if (!Number.isFinite(q.high) || !Number.isFinite(q.low) || q.high <= 0 || q.low <= 0) continue;

        const token = String(q.token);
        const close = q.ltp || q.close;
        const pivot = (+q.high + +q.low + +close) / 3;

        db.query(
          `INSERT INTO angel_15m_candle (date, token, sym, day_high, day_low, day_close, pivot, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT (date, token) DO UPDATE SET
             day_high=EXCLUDED.day_high,
             day_low=EXCLUDED.day_low,
             day_close=EXCLUDED.day_close,
             pivot=EXCLUDED.pivot,
             updated_at=NOW()`,
          [p.date, token, SYM_BY_TOKEN[token] || '?', q.high, q.low, close, pivot]
        ).catch(() => {});

        savedTokens.add(token);
      }
    }

    await flushLtpWrites();
    const totalTime = Math.round((Date.now() - t0) / 1000);
    console.log(`✅ Day H/L/C: ${savedTokens.size}/${allTokens.length} saved in ${totalTime}s`);
  } catch (e) { console.error('Day H/L/C fetch failed:', e.message); }
}

app.post('/api/admin/force-day-hlc', auth, adminOnly, async (req, res) => {
  try {
    await fetchDayHLC();
    const p = getScreenerPhase();
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM angel_15m_candle WHERE date=$1 AND day_high IS NOT NULL`,
      [p.date]
    );
    res.json({ ok: true, date: p.date, saved: +rows[0].cnt, total: STOCKS.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function msUntilNext1516IST() {
  const ist = getIST();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const target = new Date(ist);
  target.setUTCHours(0, 0, 0, 0);
  target.setUTCMinutes(916);
  if (mins >= 916) target.setUTCDate(target.getUTCDate() + 1);
  const dow = target.getUTCDay();
  if (dow === 6) target.setUTCDate(target.getUTCDate() + 2);
  if (dow === 0) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - ist.getTime();
}

function scheduleDailyFetch() {
  const ms = msUntilNext1516IST();
  console.log(`⏰ Next daily H/L/C fetch in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => { await fetchDayHLC(); scheduleDailyFetch(); }, ms);
}


/* ============================================================
   SECTION 14.1 — AUTO QUOTE FETCH @ 09:30:10 IST
   ============================================================ */
async function autoFetchQuote() {
  try {
    if (!isTradingDay(getIST())) { console.log('📊 Auto-quote: non-trading day, skip'); return; }
    const p = getScreenerPhase();
    if (!p.date) { console.log('📊 Auto-quote: no trading date, skip'); return; }

    const allTokens = STOCKS.map(s => String(s.token));
    console.log(`📊 Auto-quote: fetching ${allTokens.length} tokens...`);
    const t0 = Date.now();

    const savedTokens = new Set();
    const fetchedAt = new Date();

    let quotes = await fetchQuotesForTokens(allTokens);
    for (const q of quotes) {
      if (!q || !q.token) continue;
      if (!Number.isFinite(q.high) || !Number.isFinite(q.low) || q.high <= 0 || q.low <= 0) continue;

      const token = String(q.token);
      quoteCache.set(token, { high: q.high, low: q.low, fetchedAt });

      db.query(
        `INSERT INTO angel_15m_candle (date, token, sym, q15_open, q15_high, q15_low, q15_close, quote_fetched_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (date, token) DO UPDATE SET
           sym=EXCLUDED.sym,
           q15_open=EXCLUDED.q15_open, q15_high=EXCLUDED.q15_high,
           q15_low=EXCLUDED.q15_low, q15_close=EXCLUDED.q15_close,
           quote_fetched_at=EXCLUDED.quote_fetched_at, updated_at=NOW()`,
        [p.date, token, SYM_BY_TOKEN[token] || '?', q.open || q.low, q.high, q.low, q.ltp || q.high, fetchedAt]
      ).catch(() => {});

      setCachedCandle(token, p.date, [0, q.open || q.low, q.high, q.low, q.ltp || q.high, 0]);
      if (q.ltp) setCachedLTP(token, q.ltp);

      if (!orbState.has(`${token}_${p.date}`)) {
        orbState.set(`${token}_${p.date}`, {
          lowBroken: false, pullbackConfirmed: false, entrySignal: false,
          firstLowBreakAt: null, firstPullbackAt: null, firstEntryAt: null,
          firstLowBreakPrice: null, firstPullbackPrice: null, firstEntryPrice: null,
          targetHit: false, targetHitAt: null, slHit: false, slHitAt: null
        });
      }
      savedTokens.add(token);
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      const missing = allTokens.filter(t => !savedTokens.has(t));
      if (!missing.length) break;

      console.log(`🔁 Auto-quote retry ${attempt}: ${missing.length} missing tokens...`);
      await new Promise(r => setTimeout(r, 1500));

      const retry = await fetchQuotesForTokens(missing);
      for (const q of retry) {
        if (!q || !q.token) continue;
        if (!Number.isFinite(q.high) || !Number.isFinite(q.low) || q.high <= 0 || q.low <= 0) continue;

        const token = String(q.token);
        quoteCache.set(token, { high: q.high, low: q.low, fetchedAt });

        db.query(
          `INSERT INTO angel_15m_candle (date, token, sym, q15_open, q15_high, q15_low, q15_close, quote_fetched_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (date, token) DO UPDATE SET
             sym=EXCLUDED.sym,
             q15_open=EXCLUDED.q15_open, q15_high=EXCLUDED.q15_high,
             q15_low=EXCLUDED.q15_low, q15_close=EXCLUDED.q15_close,
             quote_fetched_at=EXCLUDED.quote_fetched_at, updated_at=NOW()`,
          [p.date, token, SYM_BY_TOKEN[token] || '?', q.open || q.low, q.high, q.low, q.ltp || q.high, fetchedAt]
        ).catch(() => {});

        setCachedCandle(token, p.date, [0, q.open || q.low, q.high, q.low, q.ltp || q.high, 0]);
        if (q.ltp) setCachedLTP(token, q.ltp);

        savedTokens.add(token);
      }
    }

    broadcastQuote(fetchedAt);
    console.log(`✅ Auto-quote: ${savedTokens.size}/${allTokens.length} saved in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    console.error('Auto-quote failed:', e.message);
  }
}

function msUntilNext93010IST() {
  const ist = getIST();
  const daySecs = ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
  const target = 9 * 3600 + 30 * 60 + 10;
  let diffSecs = target - daySecs;
  if (diffSecs <= 0) diffSecs += 86400;
  for (let i = 0; i < 15; i++) {
    const candidate = new Date(ist.getTime() + diffSecs * 1000);
    if (isTradingDay(candidate)) break;
    diffSecs += 86400;
  }
  return diffSecs * 1000;
}

function scheduleQuoteAutoFetch() {
  const ms = msUntilNext93010IST();
  console.log(`⏰ Next auto-quote fetch in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => { await autoFetchQuote(); scheduleQuoteAutoFetch(); }, ms);
}


/* ============================================================
   SECTION 14.2 — BS FETCH (9:15:30 + 30s interval during market)
   ============================================================ */
let bsIntervalTimer = null;

async function autoFetchBS({ volumeOnly = false, silent = false } = {}) {
  try {
    if (!isTradingDay(getIST())) { if (!silent) console.log('💹 Auto-BS: non-trading day, skip'); return; }
    const p = getScreenerPhase();
    if (!p.date) { if (!silent) console.log('💹 Auto-BS: no trading date, skip'); return; }

    const allTokens = STOCKS.map(s => String(s.token));
    if (!silent) console.log(`💹 Auto-BS (${volumeOnly ? 'volume-only' : 'full'}): fetching ${allTokens.length} tokens...`);
    const t0 = Date.now();

    const fetchedAt = new Date();
    const results = await fetchBuySellForTokens(allTokens);

    for (const r of results) {
      if (volumeOnly) {
        if (!Number.isFinite(r.volume) || r.volume <= 0) continue;
        db.query(
          `UPDATE strategy_bs_snapshot SET volume=$1, fetched_at=NOW()
           WHERE date=$2 AND token=$3 AND strategy_id=$4`,
          [r.volume, p.date, r.token, 'momentum']
        ).catch(() => {});
        const existing = bsCache.get(String(r.token)) || {};
        existing.volume = r.volume;
        bsCache.set(String(r.token), existing);
      } else {
        bsCache.set(r.token, {
          buyQty: r.buyQty,
          sellQty: r.sellQty,
          ltp: r.ltp,
          volume: r.volume,
          rank: bsCache.get(String(r.token))?.rank ?? null
        });
        db.query(
          `INSERT INTO strategy_bs_snapshot (date, sym, token, strategy_id, buy_qty, sell_qty, ltp, volume, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (date, token, strategy_id) DO UPDATE SET
             sym=EXCLUDED.sym,
             buy_qty=EXCLUDED.buy_qty,
             sell_qty=EXCLUDED.sell_qty,
             ltp=EXCLUDED.ltp,
             volume=EXCLUDED.volume,
             fetched_at=EXCLUDED.fetched_at`,
          [p.date, SYM_BY_TOKEN[r.token] || '?', r.token, 'momentum', r.buyQty, r.sellQty, r.ltp, r.volume, fetchedAt]
        ).catch(() => {});
      }
    }

    broadcastBS(fetchedAt);
    if (!silent) console.log(`✅ Auto-BS (${volumeOnly ? 'volume' : 'full'}): ${results.length}/${allTokens.length} saved in ${Math.round((Date.now() - t0) / 1000)}s`);

    if (!volumeOnly) {
      await assignDailyRank(p.date);
    }
  } catch (e) {
    console.error('Auto-BS failed:', e.message);
  }
}

async function assignDailyRank(date) {
  try {
    const { rows: chk } = await db.query(
      `SELECT COUNT(*) AS cnt FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id=$2 AND rank_no IS NOT NULL`,
      [date, 'momentum']
    );
    if (+chk[0].cnt > 0) {
      console.log(`#️⃣ Rank already assigned for ${date} (${chk[0].cnt} tokens) — skipped`);
      return;
    }

    const rows = STOCKS.map(s => {
      const token = String(s.token);
      const ltp = getCachedLTP(token);
      const prevClose = prevCloseCache.get(token) || null;
      const changePct = (ltp && prevClose && prevClose > 0)
        ? ((ltp - prevClose) / prevClose) * 100
        : -Infinity;
      return { token, changePct };
    }).sort((a, b) => b.changePct - a.changePct);

    let assigned = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rank = i + 1;
      db.query(
        `UPDATE strategy_bs_snapshot SET rank_no=$1
         WHERE date=$2 AND token=$3 AND strategy_id=$4`,
        [rank, date, r.token, 'momentum']
      ).catch(() => {});

      const cached = bsCache.get(r.token) || {};
      cached.rank = rank;
      bsCache.set(r.token, cached);
      assigned++;
    }
    console.log(`#️⃣ Assigned rank 1..${assigned} for ${date}`);
  } catch (e) {
    console.error('Rank assign failed:', e.message);
  }
}

app.post('/api/admin/force-bs', auth, adminOnly, async (req, res) => {
  try {
    await autoFetchBS();
    const p = getScreenerPhase();
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id=$2 AND buy_qty IS NOT NULL`,
      [p.date, 'momentum']
    );
    res.json({ ok: true, date: p.date, saved: +rows[0].cnt, total: STOCKS.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---- 30s BS interval (9:15:30 → 15:30) ---- */
function startBSInterval() {
  if (bsIntervalTimer) return;
  bsIntervalTimer = setInterval(async () => {
    const ist = getIST();
    if (!isTradingDay(ist)) return;
    const secs = ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
    const end = 15 * 3600 + 30 * 60;
    if (secs >= end) {
      clearInterval(bsIntervalTimer);
      bsIntervalTimer = null;
      console.log('💹 BS 30s interval stopped (end of day)');
      return;
    }
    try {
      await autoFetchBS({ silent: true });
    } catch (e) {
      console.error('BS interval error:', e.message);
    }
  }, 30000);
  console.log('💹 BS 30s interval started');
}

function msUntilNext91530IST() {
  const ist = getIST();
  const daySecs = ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
  const target = 9 * 3600 + 15 * 60 + 30;
  let diffSecs = target - daySecs;
  if (diffSecs <= 0) diffSecs += 86400;
  for (let i = 0; i < 15; i++) {
    const candidate = new Date(ist.getTime() + diffSecs * 1000);
    if (isTradingDay(candidate)) break;
    diffSecs += 86400;
  }
  return diffSecs * 1000;
}

function scheduleBSAutoFetch() {
  const ms = msUntilNext91530IST();
  console.log(`⏰ Next auto-BS fetch in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => {
    await autoFetchBS();
    startBSInterval();
    scheduleBSAutoFetch();
  }, ms);
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
      `SELECT token, open, high, low, close, volume, ltp,
              q15_open, q15_high, q15_low, q15_close
       FROM angel_15m_candle WHERE date=$1 AND token = ANY($2)`,
      [p.date, activeTokens]
    );
    for (const r of rows) {
      if (r.high > 0 && r.low > 0) {
        setCachedCandle(r.token, p.date, [0, +r.open, +r.high, +r.low, +r.close, +r.volume]);
      } else if (r.q15_high > 0 && r.q15_low > 0) {
        setCachedCandle(r.token, p.date, [0, +r.q15_open, +r.q15_high, +r.q15_low, +r.q15_close, 0]);
      }
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
  console.log(`✅ Server on port ${PORT} (REST + Quote + BS)`);
  console.log(`📊 Strategies: Momentum (default) + Advance ORB`);
  console.log(`💾 LTP flush: ${LTP_FLUSH_MS / 1000}s`);
  console.log(`📈 NIFTY 50 token: ${NIFTY50_TOKEN}`);
  console.log(`🔌 WS window: 09:14:55 – 15:30:00 IST`);
  console.log(`💹 BS interval: 09:15:30 – 15:30:00 IST (every 30s)`);

  try {
    await loginREST();
    console.log('✅ [REST] session started');
  } catch (e) { console.error('⚠️  [REST] login failed:', e.message); }

  await new Promise(r => setTimeout(r, 4000));

  try {
    await loginQuote();
    console.log('✅ [Quote] session started');
  } catch (e) { console.error('⚠️  [Quote] login failed:', e.message); }

  await new Promise(r => setTimeout(r, 4000));

  try {
    await loginBS();
    console.log('✅ [BS] session started');
  } catch (e) { console.error('⚠️  [BS] login failed:', e.message); }

  await loadHolidaysFromDB();
  await loadScreenerCacheFromDB();
  await loadPrevCloseFromDB();
  await loadQuoteCacheFromDB();
  await loadLatestPivotFromDB();
  await loadBSCacheFromDB();

  const nowIST = getIST();
  const mins = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
  const secs = nowIST.getUTCHours() * 3600 + nowIST.getUTCMinutes() * 60 + nowIST.getUTCSeconds();
  const dow = nowIST.getUTCDay();

  if (dow >= 1 && dow <= 5 && mins >= 916 && mins <= 940) {
    console.log('🔔 Late startup — fetching day H/L/C');
    fetchDayHLC();
  }

  if (dow >= 1 && dow <= 5 && isTradingDay(nowIST) && mins >= 570 && mins <= 585) {
    const pQ = getScreenerPhase();
    if (pQ.date) {
      try {
        const { rows } = await db.query(
          'SELECT COUNT(*) AS cnt FROM angel_15m_candle WHERE date=$1 AND q15_high IS NOT NULL',
          [pQ.date]
        );
        if (+rows[0].cnt === 0) {
          console.log('🔔 Late startup — running auto-quote catch-up');
          autoFetchQuote().catch(e => console.error('catch-up failed:', e.message));
        } else {
          console.log(`✅ Today's quote already fetched (${rows[0].cnt} tokens)`);
        }
      } catch (e) { console.error('catch-up check failed:', e.message); }
    }
  }

  /* Late startup: BS — if within 9:15:30–15:30 window, start interval immediately */
  const bsStart = 9 * 3600 + 15 * 60 + 30;
  const bsEnd   = 15 * 3600 + 30 * 60;
  if (dow >= 1 && dow <= 5 && isTradingDay(nowIST) && secs >= bsStart && secs < bsEnd) {
    const pB = getScreenerPhase();
    if (pB.date) {
      try {
        const { rows } = await db.query(
          'SELECT COUNT(*) AS cnt FROM strategy_bs_snapshot WHERE date=$1 AND strategy_id=$2',
          [pB.date, 'momentum']
        );
        if (+rows[0].cnt === 0) {
          console.log('🔔 Late startup — running auto-BS catch-up');
          await autoFetchBS();
        } else {
          console.log(`✅ Today's BS already fetched (${rows[0].cnt} tokens)`);
        }
      } catch (e) { console.error('BS catch-up check failed:', e.message); }
    }
    console.log('🔔 Late startup — starting BS 30s interval');
    startBSInterval();
  }

  scheduleDailyFetch();
  scheduleQuoteAutoFetch();
  scheduleBSAutoFetch();

  console.log('ℹ️  Ready — Momentum (default) + Advance ORB');
  console.log('ℹ️  Schedule: WS@9:14:55 | BS@9:15:30 (then every 30s) | Quote@9:30:10 | HLC@15:16');
});
