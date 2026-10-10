/* ============================================================
   server.js — TradeAlgo Pro backend  |  v4.2
   - Self-collect minute closes from BS ticks
   - Sliding window RSI (prev day + today)
   - Auto pre-market fetch @ 9:13:30
   ============================================================ */

import express from 'express';
import cors from 'cors';
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

import { registerAdminRoutes } from './admin.js';

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

const TOKEN_BY_SYM = {};
STOCKS.forEach(s => {
  const key = String(s.sym).toUpperCase().trim().replace(/-EQ$|-BE$|-BL$|-BZ$/, '');
  TOKEN_BY_SYM[key] = String(s.token);
});

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
  if (mins < 555) return { phase: 'closed',  date: getPreviousTradingDay(ist) };
  if (mins < 570) return { phase: 'forming', date: today };
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
    console.log(`💾 Loaded prevClose for ${rows.length} tokens`);
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
    console.log(`📊 Loaded quote H/L for ${rows.length} tokens`);
  } catch (e) { console.error('quoteCache load failed:', e.message); }
}


/* ============================================================
   SECTION 4.3 — PIVOT CACHE
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
    console.log(`📐 Loaded pivot for ${rows.length} tokens`);
  } catch (e) { console.error('pivot load failed:', e.message); }
}


/* ============================================================
   SECTION 4.4 — BUY/SELL CACHE + RSI + MINUTE SELF-COLLECT
   ============================================================ */
const bsCache = new Map();
const prevClosesCache = new Map();
const todayCloses = new Map();     // token -> [completed minute closes today, incl. premarket]
const minuteBuffer = new Map();    // token -> { minuteKey, ts, close }

function computeRSI(closes14) {
  if (!Array.isArray(closes14) || closes14.length !== 14) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i < closes14.length; i++) {
    const d = closes14[i] - closes14[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const n = closes14.length - 1;
  const avgGain = gains / n;
  const avgLoss = losses / n;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

/* Build 14 closes using sliding window: prev day + today */
function buildCloses14(token) {
  const todayArr = todayCloses.get(String(token)) || [];
  if (todayArr.length >= 14) return todayArr.slice(-14);

  const prevArr = prevClosesCache.get(String(token)) || [];
  const needed = 14 - todayArr.length;
  if (prevArr.length < needed) return null;

  const prevSlice = prevArr.slice(-needed).map(x => x.close);
  return [...prevSlice, ...todayArr];
}

/* Update minute buffer; returns flushed previous-minute data if minute changed */
function updateMinuteBuffer(token, ltp) {
  if (!Number.isFinite(ltp) || ltp <= 0) return null;
  const ist = getIST();
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  const minuteKey = `${hh}:${mm}`;

  ist.setUTCSeconds(0, 0);
  const ts = ist.toISOString().replace('Z', '+05:30');

  const key = String(token);
  const existing = minuteBuffer.get(key);
  if (!existing) {
    minuteBuffer.set(key, { minuteKey, ts, close: ltp });
    return null;
  }
  if (existing.minuteKey === minuteKey) {
    existing.close = ltp;
    return null;
  }
  const flushed = { ts: existing.ts, close: existing.close };
  minuteBuffer.set(key, { minuteKey, ts, close: ltp });
  return flushed;
}

async function bulkFlushMinuteChanges(changes, date) {
  if (!changes.length) return;
  const tokens = changes.map(c => String(c.token));
  const closes = changes.map(c => Number(c.close));
  const tss    = changes.map(c => c.ts);
  try {
    await db.query(
      `UPDATE strategy_bs_snapshot AS s
       SET min_1_close = COALESCE(s.min_1_close, ARRAY[]::numeric[]) || v.close_val,
           min_1_ts    = COALESCE(s.min_1_ts,    ARRAY[]::timestamptz[]) || v.ts_val
       FROM unnest($1::text[], $2::numeric[], $3::timestamptz[])
         AS v(token, close_val, ts_val)
       WHERE s.date = $4 AND s.token = v.token AND s.strategy_id = 'momentum'`,
      [tokens, closes, tss, date]
    );
    // Mirror to in-memory todayCloses
    for (const c of changes) {
      const key = String(c.token);
      const arr = todayCloses.get(key) || [];
      arr.push(Number(c.close));
      todayCloses.set(key, arr);
    }
  } catch (e) { console.error('Minute bulk flush failed:', e.message); }
}

async function loadBSCacheFromDB() {
  try {
    const p = getScreenerPhase();
    if (!p.date) return;
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      `SELECT token, buy_qty, sell_qty, ltp, volume, rank_no, preopen_price, preopen_at, day_open, rsi
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
        rank: r.rank_no != null ? +r.rank_no : null,
        preopenPrice: r.preopen_price != null ? +r.preopen_price : null,
        preopenAt: r.preopen_at,
        dayOpen: r.day_open != null ? +r.day_open : null,
        rsi: r.rsi != null ? +r.rsi : null
      });
    }
    console.log(`💹 Loaded buy/sell for ${rows.length} tokens`);
  } catch (e) { console.error('BS cache load failed:', e.message); }
}

async function loadPrevClosesFromDB() {
  try {
    const prevDate = getPreviousTradingDay(getIST());
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      `SELECT token, min_1_close, min_1_ts FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND min_1_close IS NOT NULL
         AND token = ANY($2)`,
      [prevDate, activeTokens]
    );
    prevClosesCache.clear();
    for (const r of rows) {
      if (Array.isArray(r.min_1_close) && r.min_1_close.length >= 13) {
        const closes = r.min_1_close.map(c => +c);
        const ts = Array.isArray(r.min_1_ts) ? r.min_1_ts : [];
        prevClosesCache.set(String(r.token), closes.map((c, i) => ({ ts: ts[i] || null, close: c })));
      }
    }
    console.log(`📈 Loaded prev closes for ${prevClosesCache.size} tokens (from ${prevDate})`);
  } catch (e) { console.error('prevCloses load failed:', e.message); }
}

async function loadTodayClosesFromDB() {
  try {
    const today = getIST().toISOString().split('T')[0];
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      `SELECT token, min_1_close FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND min_1_close IS NOT NULL
         AND token = ANY($2)`,
      [today, activeTokens]
    );
    todayCloses.clear();
    for (const r of rows) {
      if (Array.isArray(r.min_1_close) && r.min_1_close.length > 0) {
        todayCloses.set(String(r.token), r.min_1_close.map(c => +c));
      }
    }
    console.log(`📊 Loaded today closes for ${todayCloses.size} tokens`);
  } catch (e) { console.error('todayCloses load failed:', e.message); }
}

/* Recompute RSI for all stocks that have 14+ closes in min_1_close */
async function recomputeAllRSI(date) {
  try {
    const { rows } = await db.query(
      `SELECT token, min_1_close FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND min_1_close IS NOT NULL
         AND array_length(min_1_close, 1) >= 14`,
      [date]
    );
    let count = 0;
    for (const r of rows) {
      const closes = r.min_1_close.map(Number);
      const last14 = closes.slice(-14);
      const rsi = computeRSI(last14);
      if (rsi == null) continue;
      const v = +rsi.toFixed(2);
      try {
        await db.query(
          `UPDATE strategy_bs_snapshot SET rsi=$1 WHERE date=$2 AND token=$3 AND strategy_id='momentum'`,
          [v, date, r.token]
        );
        const existing = bsCache.get(String(r.token)) || {};
        existing.rsi = v;
        bsCache.set(String(r.token), existing);
        count++;
      } catch {}
    }
    console.log(`🧪 recomputeAllRSI: ${count} stocks updated for ${date}`);
  } catch (e) { console.error('recomputeAllRSI failed:', e.message); }
}


/* ============================================================
   SECTION 4.5 — NSE PRE-OPEN FETCHER
   ============================================================ */
const NSE_PREOPEN_PAGE = 'https://www.nseindia.com/market-data/pre-open-market-cm-and-emerge-market';
const NSE_PREOPEN_API  = 'https://www.nseindia.com/api/market-data-pre-open?key=ALL';
const NSE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchPreopenRaw() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const homeRes = await fetch(NSE_PREOPEN_PAGE, {
      headers: {
        'User-Agent': NSE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: controller.signal
    });

    let cookieStr = '';
    try {
      const setCookies = homeRes.headers.getSetCookie ? homeRes.headers.getSetCookie() : [];
      if (setCookies.length) cookieStr = setCookies.map(c => c.split(';')[0]).join('; ');
      else {
        const raw = homeRes.headers.get('set-cookie') || '';
        cookieStr = raw.split(/,(?=[^;]+=[^;]+)/).map(c => c.split(';')[0]).join('; ');
      }
    } catch {}

    const apiRes = await fetch(NSE_PREOPEN_API, {
      headers: {
        'User-Agent': NSE_UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': NSE_PREOPEN_PAGE,
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookieStr
      },
      signal: controller.signal
    });

    if (!apiRes.ok) throw new Error(`NSE API HTTP ${apiRes.status}`);
    return await apiRes.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parsePreopen(json) {
  const items = (json && json.data) || [];
  const nseMap = new Map();

  for (const item of items) {
    const meta = item.metadata || {};
    const detail = (item.detail && item.detail.preOpenMarket) || {};
    const nseSym = String(meta.symbol || '').toUpperCase().trim();
    if (!nseSym) continue;

    const price = detail.finalPrice ?? meta.lastPrice ?? detail.IEP ?? null;
    if (!Number.isFinite(price) || price <= 0) continue;

    const key = nseSym.replace(/-EQ$|-BE$|-BL$|-BZ$/, '');
    nseMap.set(key, +price);
  }

  const matched = [];
  const missingSyms = [];
  for (const s of STOCKS) {
    const key = String(s.sym).toUpperCase().trim().replace(/-EQ$|-BE$|-BL$|-BZ$/, '');
    const price = nseMap.get(key);
    if (price == null) { missingSyms.push(s.sym); continue; }
    matched.push({ token: String(s.token), sym: s.sym, price });
  }

  return { matched, unmatchedSyms: missingSyms, nseTotal: items.length };
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

function sseSend(payload) {
  for (const c of sseClients) {
    try { c.res.write(payload); } catch { sseClients.delete(c); }
  }
}

function broadcastLTP(token, ltp) {
  if (!sseClients.size) return;
  ssePending.set(String(token), ltp);
  if (sseFlushTimer) return;
  sseFlushTimer = setTimeout(() => {
    sseFlushTimer = null;
    if (!ssePending.size) return;
    const payload = `data: ${JSON.stringify({ type: 'ltp', ticks: Object.fromEntries(ssePending) })}\n\n`;
    ssePending.clear();
    sseSend(payload);
  }, 100);
}

function broadcastORB(token, state) {
  if (!sseClients.size) return;
  sseSend(`data: ${JSON.stringify({
    type: 'orb', token,
    state: {
      lowBroken: state.lowBroken, pullbackConfirmed: state.pullbackConfirmed, entrySignal: state.entrySignal,
      firstLowBreakAt: state.firstLowBreakAt, firstPullbackAt: state.firstPullbackAt, firstEntryAt: state.firstEntryAt,
      firstLowBreakPrice: state.firstLowBreakPrice, firstPullbackPrice: state.firstPullbackPrice, firstEntryPrice: state.firstEntryPrice,
      targetHit: state.targetHit, targetHitAt: state.targetHitAt, slHit: state.slHit, slHitAt: state.slHitAt
    }
  })}\n\n`);
}

function broadcastQuote(fetchedAt) {
  if (!sseClients.size) return;
  sseSend(`data: ${JSON.stringify({
    type: 'quote', fetchedAt,
    quotes: Object.fromEntries([...quoteCache.entries()].map(([t, v]) => [t, { high: v.high, low: v.low, fetchedAt: v.fetchedAt }]))
  })}\n\n`);
}

function broadcastBS(fetchedAt) {
  if (!sseClients.size) return;
  sseSend(`data: ${JSON.stringify({
    type: 'bs', fetchedAt,
    bs: Object.fromEntries([...bsCache.entries()].map(([t, v]) => [t, {
      buyQty: v.buyQty, sellQty: v.sellQty, ltp: v.ltp,
      volume: v.volume, rank: v.rank,
      preopenPrice: v.preopenPrice ?? null,
      dayOpen: v.dayOpen ?? null,
      rsi: v.rsi ?? null
    }]))
  })}\n\n`);
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


/* ============================================================
   SECTION 7 — SCREENER ROUTES (public)
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
  if (p.phase === 'closed' && !p.date)  return res.json({ ok: false, phase: 'closed' });
  if (!p.date) return res.json({ ok: false, phase: p.phase });

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

app.post('/api/screener/fetch-batch', auth, async (req, res) => {
  const { tokens } = req.body;
  if (!Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: 'tokens array required' });
  const p = getScreenerPhase();
  if (p.phase !== 'ready' && p.phase !== 'weekend' && p.phase !== 'forming') {
    return res.status(400).json({ error: `Cannot fetch in phase: ${p.phase}` });
  }
  if (!p.date) return res.status(400).json({ error: 'No date available' });

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
      preopenPrice: bs?.preopenPrice ?? null,
      dayOpen: bs?.dayOpen ?? null,
      rsi: bs?.rsi ?? null,
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
   SECTION 8 — DAY H/L/C FETCH (15:16 IST)
   ============================================================ */
async function fetchDayHLC() {
  try {
    const p = getScreenerPhase();
    if (!p.date) { console.log('❌ [HLC] No date'); return; }
    const allTokens = STOCKS.map(s => String(s.token));
    console.log(`🔔 [HLC] Fetching day H/L/C for ${allTokens.length} stocks...`);

    const savedTokens = new Set();
    const t0 = Date.now();
    const dbErrors = [];

    const quotes = await fetchQuotesForTokens(allTokens);
    if (!quotes || !quotes.length) { console.log('❌ [HLC] Angel returned 0'); return; }

    for (const q of quotes) {
      if (!q || !q.token) continue;
      if (!Number.isFinite(q.high) || !Number.isFinite(q.low) || q.high <= 0 || q.low <= 0) continue;

      const token = String(q.token);
      const close = q.ltp || q.close;
      const pivot = (+q.high + +q.low + +close) / 3;

      try {
        await db.query(
          `INSERT INTO angel_15m_candle (date, token, sym, day_high, day_low, day_close, pivot, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT (date, token) DO UPDATE SET
             day_high=EXCLUDED.day_high,
             day_low=EXCLUDED.day_low,
             day_close=EXCLUDED.day_close,
             pivot=EXCLUDED.pivot,
             updated_at=NOW()`,
          [p.date, token, SYM_BY_TOKEN[token] || '?', q.high, q.low, close, pivot]
        );
        savedTokens.add(token);
      } catch (e) { dbErrors.push(`${token}: ${e.message}`); }
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      const missing = allTokens.filter(t => !savedTokens.has(t));
      if (!missing.length) break;

      await new Promise(r => setTimeout(r, 1500));
      const retry = await fetchQuotesForTokens(missing);
      for (const q of retry) {
        if (!q || !q.token) continue;
        if (!Number.isFinite(q.high) || !Number.isFinite(q.low) || q.high <= 0 || q.low <= 0) continue;

        const token = String(q.token);
        const close = q.ltp || q.close;
        const pivot = (+q.high + +q.low + +close) / 3;

        try {
          await db.query(
            `INSERT INTO angel_15m_candle (date, token, sym, day_high, day_low, day_close, pivot, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
             ON CONFLICT (date, token) DO UPDATE SET
               day_high=EXCLUDED.day_high,
               day_low=EXCLUDED.day_low,
               day_close=EXCLUDED.day_close,
               pivot=EXCLUDED.pivot,
               updated_at=NOW()`,
            [p.date, token, SYM_BY_TOKEN[token] || '?', q.high, q.low, close, pivot]
          );
          savedTokens.add(token);
        } catch (e) { dbErrors.push(`${token}: ${e.message}`); }
      }
    }

    if (dbErrors.length) console.log(`❌ [HLC] DB errors (first 5):`, dbErrors.slice(0, 5));
    await flushLtpWrites();
    console.log(`✅ Day H/L/C: ${savedTokens.size}/${allTokens.length} saved in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) { console.error('❌ Day H/L/C fetch failed:', e); }
}


/* ============================================================
   SECTION 9 — AUTO QUOTE FETCH @ 09:30:10 IST
   ============================================================ */
async function autoFetchQuote() {
  try {
    if (!isTradingDay(getIST())) { console.log('📊 Auto-quote: non-trading day'); return; }
    const p = getScreenerPhase();
    if (!p.date) return;

    const allTokens = STOCKS.map(s => String(s.token));
    console.log(`📊 Auto-quote: fetching ${allTokens.length} tokens...`);
    const t0 = Date.now();

    const savedTokens = new Set();
    const fetchedAt = new Date();

    const quotes = await fetchQuotesForTokens(allTokens);
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

    broadcastQuote(fetchedAt);
    console.log(`✅ Auto-quote: ${savedTokens.size}/${allTokens.length} saved in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) { console.error('Auto-quote failed:', e.message); }
}


/* ============================================================
   SECTION 10 — AUTO PRE-OPEN @ 9:13:30 IST
   ============================================================ */
async function autoFetchPreopen() {
  try {
    if (!isTradingDay(getIST())) return;
    console.log('🌅 Auto-preopen @9:13:30 starting...');
    const json = await fetchPreopenRaw();
    const { matched, unmatchedSyms, nseTotal } = parsePreopen(json);
    const fetchedAt = new Date();
    const today = getIST().toISOString().split('T')[0];

    let saved = 0;
    for (const m of matched) {
      const existing = bsCache.get(m.token) || {};
      bsCache.set(m.token, { ...existing, preopenPrice: m.price, preopenAt: fetchedAt });

      // Only init todayCloses with premarket if empty
      const key = String(m.token);
      if (!todayCloses.has(key) || todayCloses.get(key).length === 0) {
        todayCloses.set(key, [m.price]);
      }

      try {
        await db.query(
          `INSERT INTO strategy_bs_snapshot
             (date, sym, token, strategy_id, preopen_price, preopen_at, min_1_close, min_1_ts, fetched_at)
           VALUES ($1, $2, $3, 'momentum', $4, $5, ARRAY[$4]::numeric[], ARRAY[$5]::timestamptz[], NOW())
           ON CONFLICT (date, token, strategy_id) DO UPDATE SET
             preopen_price = EXCLUDED.preopen_price,
             preopen_at = EXCLUDED.preopen_at`,
          [today, m.sym, m.token, m.price, fetchedAt]
        );
        saved++;
      } catch {}
    }
    console.log(`✅ Auto-preopen: NSE=${nseTotal}, matched=${matched.length}, saved=${saved}, unmatched=${unmatchedSyms.length}`);
  } catch (e) { console.error('Auto-preopen failed:', e.message); }
}


/* ============================================================
   SECTION 11 — BS FETCH (9:15:00 + 30s interval) + MINUTE SELF-COLLECT
   ============================================================ */
let bsIntervalTimer = null;

async function autoFetchBS({ volumeOnly = false, silent = false } = {}) {
  try {
    if (!isTradingDay(getIST())) { if (!silent) console.log('💹 Auto-BS: non-trading day'); return; }
    const p = getScreenerPhase();
    if (!p.date) { if (!silent) console.log('❌ [BS] No date'); return; }

    const allTokens = STOCKS.map(s => String(s.token));
    if (!silent) console.log(`💹 Auto-BS: fetching ${allTokens.length} tokens...`);
    const t0 = Date.now();

    const fetchedAt = new Date();
    const results = await fetchBuySellForTokens(allTokens);
    if (!results || !results.length) {
      if (!silent) console.log('❌ [BS] Angel returned 0');
      return;
    }

    const dbErrors = [];
    const minuteChanges = [];

    for (const r of results) {
      if (volumeOnly) {
        if (!Number.isFinite(r.volume) || r.volume <= 0) continue;
        try {
          await db.query(
            `UPDATE strategy_bs_snapshot SET volume=$1, fetched_at=NOW()
             WHERE date=$2 AND token=$3 AND strategy_id=$4`,
            [r.volume, p.date, r.token, 'momentum']
          );
        } catch (e) { dbErrors.push(`${r.token}: ${e.message}`); }
        const existing = bsCache.get(String(r.token)) || {};
        existing.volume = r.volume;
        bsCache.set(String(r.token), existing);
      } else {
        const existing = bsCache.get(String(r.token)) || {};

        // RSI compute — sliding window (today first, then prev day)
        let rsi = existing.rsi ?? null;
        if (rsi == null) {
          const closes14 = buildCloses14(r.token);
          if (closes14) rsi = computeRSI(closes14);
        }

        bsCache.set(String(r.token), {
          buyQty: r.buyQty,
          sellQty: r.sellQty,
          ltp: r.ltp,
          volume: r.volume,
          dayOpen: r.dayOpen ?? existing.dayOpen ?? null,
          rank: existing.rank ?? null,
          preopenPrice: existing.preopenPrice ?? null,
          preopenAt: existing.preopenAt ?? null,
          rsi
        });

        // Minute self-collect
        const flushed = updateMinuteBuffer(r.token, r.ltp);
        if (flushed) minuteChanges.push({ token: String(r.token), ts: flushed.ts, close: flushed.close });

        try {
          await db.query(
            `INSERT INTO strategy_bs_snapshot (date, sym, token, strategy_id, buy_qty, sell_qty, ltp, volume, day_open, rsi, fetched_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (date, token, strategy_id) DO UPDATE SET
               sym=EXCLUDED.sym,
               buy_qty=EXCLUDED.buy_qty,
               sell_qty=EXCLUDED.sell_qty,
               ltp=EXCLUDED.ltp,
               volume=EXCLUDED.volume,
               day_open=COALESCE(EXCLUDED.day_open, strategy_bs_snapshot.day_open),
               rsi=COALESCE(EXCLUDED.rsi, strategy_bs_snapshot.rsi),
               fetched_at=EXCLUDED.fetched_at`,
            [p.date, SYM_BY_TOKEN[r.token] || '?', r.token, 'momentum', r.buyQty, r.sellQty, r.ltp, r.volume, r.dayOpen ?? null, rsi, fetchedAt]
          );
        } catch (e) { dbErrors.push(`${r.token}: ${e.message}`); }
      }
    }

    // Flush minute changes (bulk) + mirror to todayCloses
    if (minuteChanges.length) {
      await bulkFlushMinuteChanges(minuteChanges, p.date);
      if (!silent) console.log(`💾 Minute flush: ${minuteChanges.length} tokens`);
    }

    if (dbErrors.length) console.log(`❌ [BS] DB errors (first 5):`, dbErrors.slice(0, 5));

    broadcastBS(fetchedAt);
    if (!silent) console.log(`✅ Auto-BS: ${results.length}/${allTokens.length} in ${Math.round((Date.now() - t0) / 1000)}s`);

    if (!volumeOnly) await assignDailyRank(p.date);
  } catch (e) { console.error('Auto-BS failed:', e.message); }
}

async function assignDailyRank(date) {
  try {
    const { rows: chk } = await db.query(
      `SELECT COUNT(*) AS cnt FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id=$2 AND rank_no IS NOT NULL`,
      [date, 'momentum']
    );
    if (+chk[0].cnt > 0) { console.log(`#️⃣ Rank already assigned for ${date}`); return; }

    const rows = STOCKS.map(s => {
      const token = String(s.token);
      const ltp = getCachedLTP(token);
      const prevClose = prevCloseCache.get(token) || null;
      const changePct = (ltp && prevClose && prevClose > 0) ? ((ltp - prevClose) / prevClose) * 100 : -Infinity;
      return { token, changePct };
    }).sort((a, b) => b.changePct - a.changePct);

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rank = i + 1;
      db.query(
        `UPDATE strategy_bs_snapshot SET rank_no=$1 WHERE date=$2 AND token=$3 AND strategy_id=$4`,
        [rank, date, r.token, 'momentum']
      ).catch(() => {});
      const cached = bsCache.get(r.token) || {};
      cached.rank = rank;
      bsCache.set(r.token, cached);
    }
    console.log(`#️⃣ Assigned rank 1..${rows.length} for ${date}`);
  } catch (e) { console.error('Rank assign failed:', e.message); }
}

async function flushFinalMinuteBuffer() {
  const p = getScreenerPhase();
  if (!p.date) return;
  const changes = [];
  for (const [token, buf] of minuteBuffer.entries()) {
    if (buf && Number.isFinite(buf.close)) changes.push({ token, ts: buf.ts, close: buf.close });
  }
  minuteBuffer.clear();
  if (changes.length) {
    await bulkFlushMinuteChanges(changes, p.date);
    console.log(`💾 Final minute flush: ${changes.length} tokens`);
  }
}


/* ============================================================
   SECTION 12 — SCHEDULERS
   ============================================================ */
function msUntil(targetHour, targetMin, dayOffsetIfPassed = 1) {
  const ist = getIST();
  const secs = ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
  const target = targetHour * 3600 + targetMin * 60;
  let diff = target - secs;
  if (diff <= 0) diff += dayOffsetIfPassed * 86400;
  for (let i = 0; i < 15; i++) {
    const candidate = new Date(ist.getTime() + diff * 1000);
    if (isTradingDay(candidate)) break;
    diff += 86400;
  }
  return diff * 1000;
}

function scheduleDailyHLC() {
  const ms = msUntil(15, 16);
  console.log(`⏰ Next HLC fetch in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => { await fetchDayHLC(); scheduleDailyHLC(); }, ms);
}

function scheduleQuoteAutoFetch() {
  const ms = msUntil(9, 30, 1) + 10000;
  console.log(`⏰ Next auto-quote in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => { await autoFetchQuote(); scheduleQuoteAutoFetch(); }, ms);
}

function schedulePreopenFetch() {
  const ms = msUntil(9, 13, 1) + 30000;
  console.log(`⏰ Next auto-preopen in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => {
    await autoFetchPreopen();
    schedulePreopenFetch();
  }, ms);
}

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
      console.log('💹 BS interval stopped (EOD)');
      return;
    }
    try { await autoFetchBS({ silent: true }); } catch (e) { console.error('BS interval error:', e.message); }
  }, 30000);
  console.log('💹 BS 30s interval started');
}

function scheduleBSAutoFetch() {
  const ms = msUntil(9, 15);
  console.log(`⏰ Next auto-BS in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => {
    await autoFetchBS();
    startBSInterval();
    scheduleBSAutoFetch();
  }, ms);
}

function scheduleFinalFlush() {
  const ms = msUntil(15, 31);
  console.log(`⏰ Next final minute flush in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => {
    await flushFinalMinuteBuffer();
    scheduleFinalFlush();
  }, ms);
}

function scheduleMorningPreload() {
  const ms = msUntil(9, 0);
  console.log(`⏰ Next morning preload in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => {
    await loadPrevClosesFromDB();
    await loadTodayClosesFromDB();
    const today = getIST().toISOString().split('T')[0];
    await recomputeAllRSI(today);
    scheduleMorningPreload();
  }, ms);
}


/* ============================================================
   SECTION 13 — DB CACHE LOADER
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
   REGISTER ADMIN ROUTES
   ============================================================ */
registerAdminRoutes(app, {
  db, SECRET,
  auth, adminOnly, log,
  getIST, getPreviousTradingDay, getScreenerPhase,
  STOCKS, bsCache,
  fetchDayHLC, autoFetchBS,
  fetchPreopenRaw, parsePreopen,
  computeRSI: (prev13, current) => computeRSI([...prev13, current]),
  loadHolidaysFromDB
});


/* ============================================================
   SECTION 14 — START
   ============================================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server on port ${PORT} — v4.2 (self-collect + sliding RSI)`);
  console.log(`📊 Strategies: Momentum + Advance ORB`);
  console.log(`💾 LTP flush: ${LTP_FLUSH_MS / 1000}s`);

  try { await loginREST(); console.log('✅ [REST] session'); } catch (e) { console.error('⚠️ [REST] login failed:', e.message); }
  await new Promise(r => setTimeout(r, 4000));
  try { await loginQuote(); console.log('✅ [Quote] session'); } catch (e) { console.error('⚠️ [Quote] login failed:', e.message); }
  await new Promise(r => setTimeout(r, 4000));
  try { await loginBS(); console.log('✅ [BS] session'); } catch (e) { console.error('⚠️ [BS] login failed:', e.message); }

  await loadHolidaysFromDB();
  await loadScreenerCacheFromDB();
  await loadPrevCloseFromDB();
  await loadQuoteCacheFromDB();
  await loadLatestPivotFromDB();
  await loadBSCacheFromDB();
  await loadPrevClosesFromDB();
  await loadTodayClosesFromDB();

  // Auto-compute RSI for stocks that already have 14+ closes today
  const todayDate = getIST().toISOString().split('T')[0];
  await recomputeAllRSI(todayDate);

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
        }
      } catch (e) { console.error('catch-up failed:', e.message); }
    }
  }

  const bsStart = 9 * 3600 + 15 * 60;
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
        }
      } catch (e) { console.error('BS catch-up failed:', e.message); }
    }
    console.log('🔔 Late startup — starting BS 30s interval');
    startBSInterval();
  }

  scheduleDailyHLC();
  scheduleQuoteAutoFetch();
  schedulePreopenFetch();
  scheduleBSAutoFetch();
  scheduleFinalFlush();
  scheduleMorningPreload();

  console.log('ℹ️  Schedule: WS@9:14:55 | Preopen@9:13:30 | BS@9:15 (30s) | Quote@9:30 | HLC@15:16 | FinalFlush@15:31 | Preload@9:00');
});
