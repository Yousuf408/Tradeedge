/* ============================================================
   server.js — TradeAlgo Pro backend  |  v5.4
   v5.1: Margin service JWT fallback
   v5.2: BS upsert writes day_high/low/close/prev_close;
   v5.3: prev_close hardening —
         - BS-first read sirf TODAY ki row se (purani `date <=` query 9:15 se pehle
           yesterday-wala prev_close utha leti thi = galat change%)
         - 9:15 ke pehle BS upsert ke baad prevCloseCache sync (din me ek baar)
         - Momentum change% / rank / chips sab ka source = BS table prev_close
         prevCloseCache from Angel q.close;
         Momentum 15m-independent; pivot load removed
   v5.4: NEW admin route — Angel REST 1-min + 5-min candle backfill
         Overwrites ws_1min_close, ws_5min_close (and ts/volume)
         + RSI recompute. Guarded against concurrent runs..
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
  getFeedToken as getFeedTokenREST,
  getJwt as getJwtREST
} from './brokers/angelone/Angel_REST.js';

import {
  loginPlatform as loginQuote,
  fetchQuotesForTokens,
  getSessionStatus as getSessionStatusQuote,
  getFeedToken as getFeedTokenQuote,
  getJwt as getJwtQuote
} from './brokers/angelone/Angel_Quote.js';

import {
  loginPlatform as loginBS,
  getSessionStatus as getSessionStatusBS,
  fetchBuySellForTokens,
  getJwt as getJwtBS
} from './brokers/angelone/Angel_BS.js';

import { startWS, stopWS, getWSStatus } from './brokers/angelone/Angel_WS.js';

import {
  initAutoTrader, onChipLock, onTickPos, loadOpenPositions, getPositions
} from './autoTrader.js';   // v4.9.3: auto buy/SL/target module

import { registerAdminRoutes } from './admin.js';

import {
  initMarginService,
  refreshMargins,
  getLeverage,
  getMarginInfo,
  computeMaxQty,
  shouldRefresh,
  loadCachedMargins,
  getMarginStatus
} from './brokers/margin.js';

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

const STRATEGIES = {
  momentum: {
    id: 'momentum',
    name: 'Momentum',
    filters: { maxRangePct: 1.5, minPrice: 150, maxPrice: 3500 }
  },
};

const getStrategy = id => STRATEGIES[id] || STRATEGIES.momentum;



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
   SECTION 4.1 — PREV CLOSE (BS-first)
   ============================================================ */
const prevCloseCache = new Map();

async function loadPrevCloseFromDB() {
  try {
    const activeTokens = [...STOCKS.map(s => String(s.token)), NIFTY50_TOKEN];
    const latestDate = getIST().toISOString().split('T')[0];

    const { rows: bsRows } = await db.query(
      `SELECT DISTINCT ON (token) token, prev_close
       FROM strategy_bs_snapshot
       WHERE prev_close IS NOT NULL
         AND token = ANY($1)
         AND date = $2
       ORDER BY token, date DESC`,
      [activeTokens, latestDate]
    );

    if (bsRows.length) {
      for (const r of bsRows) prevCloseCache.set(String(r.token), +r.prev_close);
      console.log(`💾 prevClose (BS source): ${bsRows.length} tokens`);
      return;
    }

    const { rows: mRows } = await db.query(
      `SELECT DISTINCT ON (token) token, day_close
       FROM angel_15m_candle
       WHERE day_close IS NOT NULL
         AND token = ANY($1)
         AND date < $2
       ORDER BY token, date DESC`,
      [activeTokens, latestDate]
    );
    for (const r of mRows) prevCloseCache.set(String(r.token), +r.day_close);
    console.log(`💾 prevClose (15m fallback): ${mRows.length} tokens`);
  } catch (e) { console.error('prevClose load failed:', e.message); }
}




/* ============================================================
   SECTION 4.4 — BUY/SELL CACHE + RSI + MINUTE SELF-COLLECT
   ============================================================ */
const bsCache = new Map();
const prevClosesCache = new Map();
const todayCloses = new Map();
const minuteBuffer = new Map();

const RSI_SOURCE = process.env.RSI_SOURCE || 'ws';
const wsPrevCloses = new Map();
const wsTodayCloses = new Map();
const rsiState = new Map();

const chipList = new Map();
let chipDate = null;

function computeRSI(prevCloses, currentClose) {
  if (!Array.isArray(prevCloses) || prevCloses.length < 13) return null;
  if (!Number.isFinite(currentClose) || currentClose <= 0) return null;

  const closes = [...prevCloses, currentClose];
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const n = closes.length - 1;
  const avgGain = gains / n;
  const avgLoss = losses / n;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function computeRSIFromArray(closes14) {
  if (!Array.isArray(closes14) || closes14.length !== 14) return null;
  return computeRSI(closes14.slice(0, 13), closes14[13]);
}

function computeRSIWilderState(closes) {
  if (!Array.isArray(closes) || closes.length < 15) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= 14;
  avgLoss /= 14;
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * 13 + gain) / 14;
    avgLoss = (avgLoss * 13 + loss) / 14;
  }
  const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  return { rsi, avgGain, avgLoss, prevClose: closes[closes.length - 1] };
}

function computeRSIWilder(closes) {
  const st = computeRSIWilderState(closes);
  return st ? st.rsi : null;
}

function buildCloses14(token) {
  const todayArr = todayCloses.get(String(token)) || [];
  if (todayArr.length >= 14) return todayArr.slice(-14);

  const prevArr = prevClosesCache.get(String(token)) || [];
  const needed = 14 - todayArr.length;
  if (prevArr.length < needed) return null;

  const prevSlice = prevArr.slice(-needed).map(x => x.close);
  return [...prevSlice, ...todayArr];
}

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

  const tokens1 = [], closes1 = [], tss1 = [];
  const tokens5 = [], closes5 = [], tss5 = [];

  for (const c of changes) {
    const close = Number(c.close);
    tokens1.push(String(c.token));
    closes1.push(close);
    tss1.push(c.ts);

    const minute = new Date(c.ts).getUTCMinutes();
    if (minute % 5 === 4) {
      tokens5.push(String(c.token));
      closes5.push(close);
      tss5.push(c.ts);
    }
  }

  try {
    await db.query(
      `UPDATE strategy_bs_snapshot AS s
       SET min_1_close = COALESCE(s.min_1_close, ARRAY[]::numeric[]) || v.close_val,
           min_1_ts    = COALESCE(s.min_1_ts,    ARRAY[]::timestamptz[]) || v.ts_val
       FROM unnest($1::text[], $2::numeric[], $3::timestamptz[])
         AS v(token, close_val, ts_val)
       WHERE s.date = $4 AND s.token = v.token AND s.strategy_id = 'momentum'`,
      [tokens1, closes1, tss1, date]
    );

    if (tokens5.length) {
      await db.query(
        `UPDATE strategy_bs_snapshot AS s
         SET min_5_close = COALESCE(s.min_5_close, ARRAY[]::numeric[]) || v.close_val,
             min_5_ts    = COALESCE(s.min_5_ts,    ARRAY[]::timestamptz[]) || v.ts_val
         FROM unnest($1::text[], $2::numeric[], $3::timestamptz[])
           AS v(token, close_val, ts_val)
         WHERE s.date = $4 AND s.token = v.token AND s.strategy_id = 'momentum'`,
        [tokens5, closes5, tss5, date]
      );
    }

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

async function recomputeAllRSI(date) {
  if (RSI_SOURCE === 'ws') return recomputeRSIFromWS(date);
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
      const rsi = computeRSIFromArray(last14);
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

async function loadPrevWSClosesFromDB() {
  try {
    const activeTokens = STOCKS.map(s => String(s.token));
    const today = getIST().toISOString().split('T')[0];
    const { rows } = await db.query(
      `SELECT token, ws_1min_close
       FROM strategy_bs_snapshot
       WHERE strategy_id='momentum' AND ws_1min_close IS NOT NULL
         AND array_length(ws_1min_close, 1) > 0
         AND token = ANY($1) AND date < $2
       ORDER BY date ASC`,
      [activeTokens, today]
    );
    wsPrevCloses.clear();
    for (const r of rows) {
      const arr = wsPrevCloses.get(String(r.token)) || [];
      for (const c of r.ws_1min_close) arr.push(+c);
      wsPrevCloses.set(String(r.token), arr);
    }
    for (const [t, arr] of wsPrevCloses) {
      if (arr.length > 1000) wsPrevCloses.set(t, arr.slice(-1000));
    }
    console.log(`📈 WS prev closes: ${wsPrevCloses.size} tokens (multi-day seed)`);
  } catch (e) { console.error('WS prev closes load failed:', e.message); }
}

async function loadTodayWSClosesFromDB() {
  try {
    const today = getIST().toISOString().split('T')[0];
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      `SELECT token, ws_1min_close FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND ws_1min_close IS NOT NULL
         AND token = ANY($2)`,
      [today, activeTokens]
    );
    wsTodayCloses.clear();
    for (const r of rows) {
      if (Array.isArray(r.ws_1min_close) && r.ws_1min_close.length > 0) {
        wsTodayCloses.set(String(r.token), r.ws_1min_close.map(c => +c));
      }
    }
    console.log(`📊 WS today closes: ${wsTodayCloses.size} tokens`);
  } catch (e) { console.error('WS today closes load failed:', e.message); }
}

function seedRSIStateFromMemory() {
  let n = 0;
  for (const s of STOCKS) {
    const token = String(s.token);
    const todayArr = wsTodayCloses.get(token) || [];
    const prevArr = wsPrevCloses.get(token) || [];
    const series = todayArr.length ? prevArr.concat(todayArr) : prevArr;
    const st = computeRSIWilderState(series);
    if (st) { rsiState.set(token, st); n++; }
    else rsiState.delete(token);
  }
  console.log(`🧮 RSI live state seeded: ${n} tokens`);
}

async function updateRSIFromWS(date) {
  const toks = [], rsis = [];
  for (const s of STOCKS) {
    const token = String(s.token);
    const todayArr = wsTodayCloses.get(token) || [];
    const prevArr = wsPrevCloses.get(token) || [];
    const series = todayArr.length ? prevArr.concat(todayArr) : prevArr;
    const st = computeRSIWilderState(series);
    if (!st) continue;
    rsiState.set(token, st);
    const v = +st.rsi.toFixed(2);
    toks.push(token); rsis.push(v);
    const cached = bsCache.get(token) || {};
    cached.rsi = v;
    bsCache.set(token, cached);
  }
  if (!toks.length) return;
  try {
    await db.query(
      `UPDATE strategy_bs_snapshot AS s SET rsi=v.rsi
       FROM unnest($1::text[], $2::numeric[]) AS v(token, rsi)
       WHERE s.date=$3 AND s.token=v.token AND s.strategy_id='momentum'`,
      [toks, rsis, date]
    );
  } catch (e) { console.error('WS RSI update failed:', e.message); }
}

async function recomputeRSIFromWS(date) {
  try {
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows: prevRows } = await db.query(
      `SELECT token, ws_1min_close FROM strategy_bs_snapshot
       WHERE strategy_id='momentum' AND ws_1min_close IS NOT NULL
         AND array_length(ws_1min_close, 1) > 0
         AND token = ANY($1) AND date < $2
       ORDER BY date ASC`,
      [activeTokens, date]
    );
    const prevMap = new Map();
    for (const r of prevRows) {
      const arr = prevMap.get(String(r.token)) || [];
      for (const c of r.ws_1min_close) arr.push(+c);
      prevMap.set(String(r.token), arr);
    }
    const { rows } = await db.query(
      `SELECT token, ws_1min_close FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND ws_1min_close IS NOT NULL
         AND token = ANY($2)`,
      [date, activeTokens]
    );
    const toks = [], rsis = [];
    for (const r of rows) {
      const dayArr = r.ws_1min_close.map(Number);
      const series = (prevMap.get(String(r.token)) || []).concat(dayArr);
      const rsi = computeRSIWilder(series);
      if (rsi == null) continue;
      toks.push(String(r.token)); rsis.push(+rsi.toFixed(2));
    }
    if (toks.length) {
      await db.query(
        `UPDATE strategy_bs_snapshot AS s SET rsi=v.rsi
         FROM unnest($1::text[], $2::numeric[]) AS v(token, rsi)
         WHERE s.date=$3 AND s.token=v.token AND s.strategy_id='momentum'`,
        [toks, rsis, date]
      );
      if (date === getIST().toISOString().split('T')[0]) {
        for (let i = 0; i < toks.length; i++) {
          const cached = bsCache.get(toks[i]) || {};
          cached.rsi = rsis[i];
          bsCache.set(toks[i], cached);
        }
      }
    }
    console.log(`🧪 recomputeRSIFromWS: ${toks.length} stocks updated for ${date}`);
  } catch (e) { console.error('recomputeRSIFromWS failed:', e.message); }
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
   SECTION 4.6 — WS MINUTE-CLOSE SHADOW SAMPLER
   ============================================================ */
const lastLtpAt = new Map();
const lastWsVolume = new Map();
const prevCumVol = new Map();
const minVolRing = new Map();
let wsMinuteKey = null;

async function flushWSMinuteClose(prevKey, prevTs, date) {
  const tokens = [], closes = [], minVols = [];
  for (const s of STOCKS) {
    const token = String(s.token);
    const age = Date.now() - (lastLtpAt.get(token) || 0);
    let close = age < 75000 ? getCachedLTP(token) : null;
    if (close == null) close = bsCache.get(token)?.ltp ?? null;
    if (!Number.isFinite(close) || close <= 0) continue;

    const cum = lastWsVolume.get(token) ?? bsCache.get(token)?.volume ?? null;
    const prev = prevCumVol.get(token) ?? null;
    let mv = 0;
    if (cum != null && prev != null && cum >= prev) mv = cum - prev;
    if (cum != null) prevCumVol.set(token, cum);

    tokens.push(token);
    closes.push(close);
    minVols.push(mv);

    const ring = minVolRing.get(token) || [];
    ring.push(mv);
    if (ring.length > 5) ring.shift();
    minVolRing.set(token, ring);
  }
  if (!tokens.length) return;

  const isFive = Number(prevKey.slice(3)) % 5 === 4;
  const tss = tokens.map(() => prevTs);
  const vols5 = isFive ? tokens.map(t => (minVolRing.get(t) || []).reduce((a, b) => a + b, 0)) : [];
  try {
    await db.query(
      `UPDATE strategy_bs_snapshot AS s
       SET ws_1min_close  = COALESCE(s.ws_1min_close,  ARRAY[]::numeric[]) || v.c,
           ws_1min_ts     = COALESCE(s.ws_1min_ts,     ARRAY[]::timestamptz[]) || v.t,
           ws_1min_volume = COALESCE(s.ws_1min_volume, ARRAY[]::numeric[]) || v.vol
       FROM unnest($1::text[], $2::numeric[], $3::timestamptz[], $4::numeric[]) AS v(token, c, t, vol)
       WHERE s.date = $5 AND s.token = v.token AND s.strategy_id = 'momentum'`,
      [tokens, closes, tss, minVols, date]
    );
    if (isFive) {
      await db.query(
        `UPDATE strategy_bs_snapshot AS s
         SET ws_5min_close  = COALESCE(s.ws_5min_close,  ARRAY[]::numeric[]) || v.c,
             ws_5min_ts     = COALESCE(s.ws_5min_ts,     ARRAY[]::timestamptz[]) || v.t,
             ws_5min_volume = COALESCE(s.ws_5min_volume, ARRAY[]::numeric[]) || v.vol
         FROM unnest($1::text[], $2::numeric[], $3::timestamptz[], $4::numeric[]) AS v(token, c, t, vol)
         WHERE s.date = $5 AND s.token = v.token AND s.strategy_id = 'momentum'`,
        [tokens, closes, tss, vols5, date]
      );
    }
    for (let i = 0; i < tokens.length; i++) {
      const arr = wsTodayCloses.get(tokens[i]) || [];
      arr.push(closes[i]);
      wsTodayCloses.set(tokens[i], arr);
    }
    if (RSI_SOURCE === 'ws') await updateRSIFromWS(date);

    console.log(`🕐 WS minute-close: ${tokens.length} tokens @ ${prevKey}${isFive ? ' (5m)' : ''}`);
  } catch (e) { console.error('WS minute-close flush failed:', e.message); }
}

setInterval(() => {
  const ist = getIST();
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  const key = `${hh}:${mm}`;

  if (wsMinuteKey === null) { wsMinuteKey = key; return; }
  if (key === wsMinuteKey) return;

  const prevKey = wsMinuteKey;
  wsMinuteKey = key;

  if (!isTradingDay(ist)) return;
  const secs = ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
  if (secs < 9 * 3600 + 15 * 60 || secs > 15 * 3600 + 31 * 60) return;

  const d = new Date(ist);
  d.setUTCMinutes(d.getUTCMinutes() - 1);
  d.setUTCSeconds(0, 0);
  const prevTs = d.toISOString().replace('Z', '+05:30');
  const date = ist.toISOString().split('T')[0];

  flushWSMinuteClose(prevKey, prevTs, date).catch(() => {});
}, 1000);


/* ============================================================
   SECTION 4.7 — MARGIN SERVICE INTEGRATION
   ============================================================ */
function getBrokerSession(broker) {
  if (broker !== 'angelone') return null;

  let jwt = null;
  if (getSessionStatusREST()?.loggedIn)          jwt = getJwtREST?.();
  if (!jwt && getSessionStatusQuote()?.loggedIn) jwt = getJwtQuote?.();
  if (!jwt && getSessionStatusBS()?.loggedIn)    jwt = getJwtBS?.();
  if (!jwt) jwt = process.env.ANGEL_JWT || null;

  if (!jwt) return null;

  return {
    jwt,
    apiKey: process.env.ANGEL_API_KEY,
    clientCode: process.env.ANGEL_CLIENT_ID
  };
}

function buildLtpMap() {
  const map = {};
  for (const s of STOCKS) {
    const t = String(s.token);
    const ltp = getCachedLTP(t) ?? bsCache.get(t)?.ltp ?? null;
    if (ltp && ltp > 0) map[t] = ltp;
  }
  return map;
}

async function maybeRefreshMargins(broker = 'angelone', { force = false } = {}) {
  if (!force && !shouldRefresh(broker)) return;
  const ltpMap = buildLtpMap();
  if (!Object.keys(ltpMap).length) {
    console.log(`📊 Margin refresh [${broker}]: skipped (no LTPs yet)`);
    return;
  }
  await refreshMargins(broker, STOCKS, ltpMap);
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



function broadcastBS(fetchedAt) {
  if (!sseClients.size) return;
  sseSend(`data: ${JSON.stringify({
    type: 'bs', fetchedAt,
    bs: Object.fromEntries([...bsCache.entries()].map(([t, v]) => {
      const m = getMarginInfo('angelone', t);
      return [t, {
        buyQty: v.buyQty, sellQty: v.sellQty, ltp: v.ltp,
        volume: v.volume, rank: v.rank,
        preopenPrice: v.preopenPrice ?? null,
        dayOpen: v.dayOpen ?? null,
        rsi: v.rsi ?? null,
        leverage: m?.leverage ?? null,
        marginPerShare: m?.marginPerShare ?? null
      }];
    }))
  })}\n\n`);
}

function broadcastChip() {
  if (!sseClients.size) return;
  sseSend(`data: ${JSON.stringify({ type: 'chip', chips: [...chipList.values()] })}\n\n`);
}

function handleTick(token, ltp, tickMs, extra) {
  if (!Number.isFinite(ltp) || ltp < 1 || ltp > 1000000) return;
  if (extra && Number.isFinite(extra.volume)) lastWsVolume.set(String(token), extra.volume);

  if (token === NIFTY50_TOKEN) {
    setCachedLTP(token, ltp);
    broadcastLTP(token, ltp);
    return;
  }

  setCachedLTP(token, ltp);
  broadcastLTP(token, ltp);
  lastLtpAt.set(String(token), Date.now());
  onTickPos(token, ltp);                      // v4.9.3: autoTrader SL/T1/T2/trail monitor

  if (RSI_SOURCE === 'ws') {
    const st = rsiState.get(String(token));
    if (st && st.prevClose > 0) {
      const d = ltp - st.prevClose;
      const gain = d > 0 ? d : 0;
      const loss = d < 0 ? -d : 0;
      const lg = (st.avgGain * 13 + gain) / 14;
      const ll = (st.avgLoss * 13 + loss) / 14;
      const live = ll === 0 ? 100 : 100 - (100 / (1 + lg / ll));
      const cached = bsCache.get(String(token)) || {};
      cached.rsi = +live.toFixed(2);
      bsCache.set(String(token), cached);
    }
  }

  const p = getScreenerPhase();
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
  if (!shouldStartWS()) return;

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
    bs: getSessionStatusBS(),
    margins: getMarginStatus()
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



  const allCached = allCandles.filter(c => Array.isArray(c.candle) && c.candle.length >= 5);

  res.json({
    ok: true, phase: p.phase, date: p.date,
    strategy: strategy.id, strategyName: strategy.name, filters: strategy.filters,
    total: STOCKS.length,
    cachedTokens,
    results: allCached, stocks: []
  });
});

app.get('/api/screener/chips', auth, (req, res) => {
  const chips = [...chipList.values()].map(c => ({
    token: c.token,
    sym: c.sym,
    rank: c.rank,
    gapPct: c.gapPct,
    rsiAtLock: c.rsiAtLock,
    rsiLive: bsCache.get(c.token)?.rsi ?? null,
    ltp: getCachedLTP(c.token) ?? null
  }));
  res.json({ ok: true, date: chipDate, locked: chipDate != null, chips });
});

/* v4.9.4: ORDERS page endpoint — positions + live LTP + Net P&L */
app.get('/api/auto/positions', auth, async (req, res) => {
  try {
    const date = req.query.date || getIST().toISOString().split('T')[0];
    const { rows } = await db.query(
      `SELECT date::text AS date, token, sym, qty, entry, sl, t1, t2, stage, peak,
              status, exit_price, exit_reason, entry_at, exit_at
       FROM auto_positions WHERE date=$1 ORDER BY entry_at`,
      [date]
    );
    const live = getPositions();
    const out = rows.map(r => {
      const lp = live.find(p => p.token === String(r.token));
      const ltp = getCachedLTP(String(r.token)) ?? null;
      const ref = r.status === 'open' ? (ltp ?? +r.entry) : (r.exit_price != null ? +r.exit_price : +r.entry);
      const pnl = +((ref - +r.entry) * r.qty).toFixed(2);
      const pnlPct = +(((ref - +r.entry) / +r.entry) * 100).toFixed(2);
      return {
        date: r.date, token: String(r.token), sym: r.sym, qty: +r.qty,
        entry: +r.entry, sl: +r.sl, t1: +r.t1, t2: +r.t2,
        stage: lp ? lp.stage : +r.stage,
        slLive: lp ? lp.sl : +r.sl,
        peak: lp ? lp.peak : (r.peak != null ? +r.peak : null),
        status: r.status, exitPrice: r.exit_price != null ? +r.exit_price : null,
        exitReason: r.exit_reason, entryAt: r.entry_at, exitAt: r.exit_at,
        ltp, pnl, pnlPct
      };
    });
    const total = +out.reduce((a, b) => a + b.pnl, 0).toFixed(2);
    res.json({ ok: true, date, total, positions: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/screener/margins', auth, (req, res) => {
  res.json({ ok: true, status: getMarginStatus() });
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



app.post('/api/screener/ltp', auth, async (req, res) => {
  const { tokens } = req.body;
  if (!Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: 'tokens array required' });
  const p = getScreenerPhase();
  if (!p.date) return res.json({ ok: true, results: [] });

  const serverTime = new Date().toISOString();
  const enriched = tokens.map(t => {
    const token = String(t);
    const ltp = getCachedLTP(token) ?? bsCache.get(token)?.ltp ?? null;   // v4.9.4: market band/restart ke baad BS table ka LTP
    const prevClose = prevCloseCache.get(token) || null;
    const bs = bsCache.get(token) || null;
    const m = getMarginInfo('angelone', token);
    return {
      token, ltp, prevClose,
      buyQty: bs?.buyQty ?? null,
      sellQty: bs?.sellQty ?? null,
      bsVolume: bs?.volume ?? null,
      rank: bs?.rank ?? null,
      preopenPrice: bs?.preopenPrice ?? null,
      dayOpen: bs?.dayOpen ?? null,
      rsi: bs?.rsi ?? null,
      leverage: m?.leverage ?? null,
      marginPerShare: m?.marginPerShare ?? null,
      serverTime
    };
  });

  res.json({ ok: true, count: enriched.length, results: enriched });
});

app.post('/api/screener/maxqty', auth, (req, res) => {
  const { token, capital, broker = 'angelone' } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  const capitalNum = +capital;
  if (!capitalNum || capitalNum <= 0) return res.status(400).json({ error: 'invalid capital' });

  const ltp = getCachedLTP(String(token));
  const lev = getLeverage(broker, String(token));
  const qty = computeMaxQty(capitalNum, ltp, lev);

  res.json({
    ok: true, token: String(token), broker, capital: capitalNum,
    ltp, leverage: lev, maxQty: qty,
    marginPerShare: lev && ltp ? +(ltp / lev).toFixed(4) : null
  });
});


/* ============================================================
   SECTION 7.1 — ADMIN TRIGGERS
   ============================================================ */

app.post('/api/admin/force-day-hlc', auth, adminOnly, async (req, res) => {
  try {
    await fetchDayHLC();
    const p = getScreenerPhase();
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM angel_15m_candle WHERE date=$1 AND day_high IS NOT NULL`,
      [p.date]
    );
    res.json({ ok: true, date: p.date, saved: +rows[0].cnt, total: STOCKS.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/fetch-preopen', auth, adminOnly, async (req, res) => {
  try {
    const json = await fetchPreopenRaw();
    const { matched, unmatchedSyms, nseTotal } = parsePreopen(json);
    const fetchedAt = new Date();
    const p = getScreenerPhase();
    const dbErrors = [];

    for (const m of matched) {
      const existing = bsCache.get(m.token) || {};
      bsCache.set(m.token, {
        ...existing,
        preopenPrice: m.price,
        preopenAt: fetchedAt
      });

      if (p.date) {
        try {
          await db.query(
            `UPDATE strategy_bs_snapshot SET preopen_price=$1, preopen_at=$2
             WHERE date=$3 AND token=$4 AND strategy_id='momentum'`,
            [m.price, fetchedAt, p.date, m.token]
          );
        } catch (e) { dbErrors.push(`${m.sym}: ${e.message}`); }
      }
    }

    console.log(`🌅 Preopen fetch: NSE=${nseTotal}, matched=${matched.length}, unmatched=${unmatchedSyms.length}`);
    if (unmatchedSyms.length) console.log(`🌅 Unmatched (first 20): ${unmatchedSyms.slice(0, 20).join(', ')}`);
    if (dbErrors.length) console.log(`❌ Preopen DB errors (first 5):`, dbErrors.slice(0, 5));

    res.json({
      ok: true, date: p.date, nseTotal,
      matched: matched.length,
      unmatchedCount: unmatchedSyms.length,
      unmatchedSample: unmatchedSyms.slice(0, 30),
      dbErrors: dbErrors.slice(0, 5),
      fetchedAt
    });
  } catch (e) {
    console.error('Preopen fetch failed:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/compute-rsi', auth, adminOnly, async (req, res) => {
  try {
    const dateParam = req.body?.date || req.query?.date;
    let targetDate = dateParam;

    if (!targetDate) {
      const src = RSI_SOURCE === 'ws' ? 'ws_1min_close' : 'min_1_close';
      const { rows } = await db.query(
        `SELECT date::text AS d FROM strategy_bs_snapshot
         WHERE strategy_id='momentum' AND ${src} IS NOT NULL
         ORDER BY date DESC LIMIT 1`
      );
      if (!rows.length) return res.json({ ok: false, error: 'No candle data found' });
      targetDate = rows[0].d;
    }

    await recomputeAllRSI(targetDate);

    const { rows: out } = await db.query(
      `SELECT sym, rsi FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND rsi IS NOT NULL
       ORDER BY rsi DESC`,
      [targetDate]
    );
    console.log(`🧪 Compute-RSI: ${out.length} saved for ${targetDate}`);
    res.json({ ok: true, date: targetDate, count: out.length, top10: out.slice(0, 10), bottom10: out.slice(-10) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/refresh-margins', auth, adminOnly, async (req, res) => {
  try {
    const broker = req.body?.broker || 'angelone';
    const result = await maybeRefreshMargins(broker, { force: true });
    res.json({ ok: true, broker, status: getMarginStatus(), detail: result || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


/* ============================================================
   SECTION 7.2 — HISTORICAL BACKFILL (v5.4)
   Fetch 1-min + 5-min from Angel REST, overwrite WS columns
   ============================================================ */
const HISTORICAL_DAYS_DEFAULT = 2;   // v4.9.1: yesterday + today only
const ANGEL_HISTORICAL_URL = 'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData';
let historicalRunning = false;
const historicalFailed = new Set();   // v4.9.1: pichle run ke failed tokens → agla click sirf inhe retry karega

function getAnyAngelJwt() {
  if (getSessionStatusREST()?.loggedIn && getJwtREST?.())  return getJwtREST();
  if (getSessionStatusQuote()?.loggedIn && getJwtQuote?.()) return getJwtQuote();
  if (getSessionStatusBS()?.loggedIn && getJwtBS?.())       return getJwtBS();
  return process.env.ANGEL_JWT || null;
}

async function fetchAngelInterval(token, interval, daysBack) {
  const JWT = getAnyAngelJwt();
  if (!JWT) throw new Error('No Angel JWT');

  const nowIST = getIST();
  const toDate = nowIST.toISOString().split('T')[0];
  const fromMs = nowIST.getTime() - (daysBack + 4) * 24 * 3600 * 1000;
  const fromDate = new Date(fromMs).toISOString().split('T')[0];

  const r = await fetch(ANGEL_HISTORICAL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': process.env.ANGEL_API_KEY,
      'Authorization': 'Bearer ' + JWT
    },
    body: JSON.stringify({
      exchange: 'NSE',
      symboltoken: String(token),
      interval,
      fromdate: `${fromDate} 09:15`,
      todate: `${toDate} 15:30`
    })
  });

  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.status || !Array.isArray(j.data)) throw new Error(j.message || 'no data');
  return j.data;   // [ [ts, o, h, l, c, v], ... ]
}

function groupCandlesByDate(raw) {
  const byDate = {};
  for (const b of raw) {
    let ms;
    if (typeof b[0] === 'number') ms = b[0];
    else ms = new Date(b[0]).getTime();
    if (!Number.isFinite(ms)) continue;

    const istD = new Date(ms + 5.5 * 3600 * 1000);
    const date = istD.toISOString().slice(0, 10);
    const hh = istD.getUTCHours();
    const mm = istD.getUTCMinutes();
    const mins = hh * 60 + mm;

    // Filter 9:15–15:30 IST
    if (mins < 9 * 60 + 15 || mins > 15 * 60 + 30) continue;

    if (!byDate[date]) byDate[date] = { closes: [], ts: [], vols: [], minutes: [] };
    const tsStr = `${date}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00.000+05:30`;
    byDate[date].closes.push(+b[4]);
    byDate[date].ts.push(tsStr);
    byDate[date].vols.push(+b[5] || 0);
    byDate[date].minutes.push(mins);   // v4.9.2: minutes-of-day (555-929) — fillMissingMinutes isi ko match karta hai
  }
  return byDate;
}

function fillMissingMinutes(by1m) {
  // Angel sirf traded minutes deta hai → khali minutes bhar do
  // (carry-forward close, volume 0) taaki har din 375 continuous candles ho
  // — live WS sampler ki convention se exact match
  for (const date in by1m) {
    const src = by1m[date];
    if (!src.minutes || !src.minutes.length) continue;
    const have = new Map();
    for (let i = 0; i < src.minutes.length; i++) have.set(src.minutes[i], i);
    const closes = [], ts = [], vols = [], minutes = [];
    let prevClose = src.closes[0];   // leading minutes = pehli candle ka close
    for (let m = 555; m <= 929; m++) {   // 9:15 → 15:29 IST
      const idx = have.get(m);
      let c, v;
      if (idx !== undefined) { c = src.closes[idx]; v = src.vols[idx]; }
      else { c = prevClose; v = 0; }
      prevClose = c;
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      closes.push(c); vols.push(v); minutes.push(m);
      ts.push(idx !== undefined ? src.ts[idx] : `${date}T${hh}:${mm}:00.000+05:30`);
    }
    by1m[date] = { closes, ts, vols, minutes };
  }
  return by1m;
}

function derive5minFrom1min(by1m) {
  // 5-min candle ends at minutes % 5 === 4  (matches WS sampler convention)
  // 5-min volume = pichle 5 one-min volumes ka sum (live ws_5min_volume jaisa)
  const by5m = {};
  for (const date in by1m) {
    const src = by1m[date];
    const dst = { closes: [], ts: [], vols: [] };
    for (let i = 0; i < src.minutes.length; i++) {
      if (src.minutes[i] % 5 === 4) {
        let v = 0;
        for (let k = Math.max(0, i - 4); k <= i; k++) v += src.vols[k] || 0;
        dst.closes.push(src.closes[i]);
        dst.ts.push(src.ts[i]);
        dst.vols.push(v);
      }
    }
    by5m[date] = dst;
  }
  return by5m;
}

async function backfillOneStock(stock, daysBack) {
  const sym = stock.sym;
  const token = String(stock.token);

  // 1-min from Angel
  const raw1m = await fetchAngelInterval(token, 'ONE_MINUTE', daysBack);
  const by1m = fillMissingMinutes(groupCandlesByDate(raw1m));   // v4.9.1: 375 continuous candles

  // Derive 5-min
  const by5m = derive5minFrom1min(by1m);

  // Keep last N days
  const dates = Object.keys(by1m).sort().slice(-daysBack);
  let saved = 0;

  for (const date of dates) {
    const d1 = by1m[date];
    const d5 = by5m[date] || { closes: [], ts: [], vols: [] };
    if (d1.closes.length < 20) continue;

    const rsi = computeRSIWilder(d1.closes);

    await db.query(
      `INSERT INTO strategy_bs_snapshot
         (date, sym, token, strategy_id,
          ws_1min_close, ws_1min_ts, ws_1min_volume,
          ws_5min_close, ws_5min_ts, ws_5min_volume,
          rsi, fetched_at)
       VALUES ($1, $2, $3, 'momentum',
               $4::numeric[], $5::timestamptz[], $6::numeric[],
               $7::numeric[], $8::timestamptz[], $9::numeric[],
               $10, NOW())
       ON CONFLICT (date, token, strategy_id) DO UPDATE SET
         ws_1min_close  = EXCLUDED.ws_1min_close,
         ws_1min_ts     = EXCLUDED.ws_1min_ts,
         ws_1min_volume = EXCLUDED.ws_1min_volume,
         ws_5min_close  = EXCLUDED.ws_5min_close,
         ws_5min_ts     = EXCLUDED.ws_5min_ts,
         ws_5min_volume = EXCLUDED.ws_5min_volume,
         rsi            = EXCLUDED.rsi,
         fetched_at     = NOW()`,
      [
        date, sym, token,
        d1.closes, d1.ts, d1.vols,
        d5.closes, d5.ts, d5.vols,
        rsi != null ? +rsi.toFixed(2) : null
      ]
    );
    saved++;
  }
  return { sym, days_saved: saved, dates };
}

app.post('/api/admin/fetch-historical', auth, adminOnly, async (req, res) => {
  if (historicalRunning) {
    return res.status(409).json({ error: 'Historical fetch already running' });
  }
  historicalRunning = true;

  // v4.9.2: cross-instance DB lock — Render pe 2+ instances ho to bhi sirf EK run chalega
  // (advisory xact lock: instance mare ya connection toote to lock khud release)
  let lockClient = null;
  try {
    lockClient = await db.connect();
    await lockClient.query('BEGIN');
    const lk = await lockClient.query('SELECT pg_try_advisory_xact_lock(7451) AS got');
    if (!lk.rows[0]?.got) {
      await lockClient.query('ROLLBACK');
      lockClient.release();
      lockClient = null;
      historicalRunning = false;
      return res.status(409).json({ error: 'Historical fetch already running on another instance' });
    }
  } catch (e) {
    try { if (lockClient) { await lockClient.query('ROLLBACK'); lockClient.release(); } } catch {}
    lockClient = null;
    historicalRunning = false;
    return res.status(500).json({ error: 'lock failed: ' + e.message });
  }

  const days = Math.min(Math.max(+req.body?.days || HISTORICAL_DAYS_DEFAULT, 1), 5);
  const t0 = Date.now();
  const summary = { ok: 0, failed: 0, skipped: 0, days_saved: 0, total: STOCKS.length };
  const errors = [];

  const DELAY_MS = 900;   // v4.9.1: ~1.1 req/sec — Angel rate-limit safe
  const retryOnly = req.body?.all !== true && historicalFailed.size > 0;
  const queue = retryOnly
    ? STOCKS.filter(s => historicalFailed.has(String(s.token)))
    : [...STOCKS];
  if (!retryOnly) historicalFailed.clear();
  console.log(`📥 Historical start: ${queue.length} stocks (${retryOnly ? 'retry-failed only' : 'full run'})`);
  let processed = 0;

  try {
    while (queue.length) {
      const stock = queue.shift();
      try {
        const r = await backfillOneStock(stock, days);
        if (r.days_saved > 0) {
          summary.ok++;
          summary.days_saved += r.days_saved;
        } else {
          summary.skipped++;
        }
        historicalFailed.delete(String(stock.token));   // ✅ success = retry list se hatao
      } catch (e) {
        // v4.9.1: ek retry, 2s ruk ke (rate-limit safe)
        await new Promise(r => setTimeout(r, 2000));
        try {
          const r2 = await backfillOneStock(stock, days);
          if (r2.days_saved > 0) { summary.ok++; summary.days_saved += r2.days_saved; }
          else summary.skipped++;
          historicalFailed.delete(String(stock.token));
        } catch (e2) {
          summary.failed++;
          historicalFailed.add(String(stock.token));    // ❌ fail = agla click sirf inhe chalega
          if (summary.failed === 1) console.error('❌ First error:', stock.sym, e2.message);
          if (errors.length < 20) errors.push(`${stock.sym}: ${e2.message}`);
        }
      }
      processed++;
      if (processed % 25 === 0) {
        console.log(`📥 Historical: ${processed}/${STOCKS.length} | ok=${summary.ok} fail=${summary.failed}`);
      }
      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`✅ Historical DONE ${elapsed}s | ok=${summary.ok} skip=${summary.skipped} fail=${summary.failed} days=${summary.days_saved} | retry_pending=${historicalFailed.size}`);

    // Rebuild memory after backfill
    try {
      await loadPrevWSClosesFromDB();
      await loadTodayWSClosesFromDB();
      seedRSIStateFromMemory();
      console.log('🔄 WS caches reloaded after backfill');
    } catch (e) { console.error('Post-backfill reload failed:', e.message); }

    res.json({ ok: true, elapsed_sec: elapsed, summary, errors });
  } catch (e) {
    console.error('Historical fetch error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    historicalRunning = false;
    try { if (lockClient) { await lockClient.query('ROLLBACK'); lockClient.release(); } } catch {}   // v4.9.2: lock release
  }
});


/* ============================================================
   SECTION 8 — DAY H/L/C FETCH (15:31 IST)
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

      try {
        await db.query(
          `INSERT INTO strategy_bs_snapshot
             (date, sym, token, strategy_id, preopen_price, preopen_at, fetched_at)
           VALUES ($1, $2, $3, 'momentum', $4, $5, NOW())
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
   SECTION 11 — BS FETCH (9:15 + 30s interval) + MINUTE SELF-COLLECT
   ============================================================ */
let bsIntervalTimer = null;
let bsRunning = false;
let prevSyncDate = null;   // v5.3: din me ek baar prev_close cache sync

async function autoFetchBS({ volumeOnly = false, silent = false } = {}) {
  if (bsRunning) { if (!silent) console.log('💹 Auto-BS: previous run in progress — skipping'); return; }
  bsRunning = true;
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

    const bTokens = [], bSyms = [], bBuy = [], bSell = [], bLtp = [], bVol = [], bOpen = [];
    const bHigh = [], bLow = [], bClose = [], bPivot = [], bPrevClose = [], bRsi = [];
    const vTokens = [], vVols = [];

    for (const r of results) {
      if (volumeOnly) {
        if (!Number.isFinite(r.volume) || r.volume <= 0) continue;
        vTokens.push(String(r.token));
        vVols.push(r.volume);
        const existing = bsCache.get(String(r.token)) || {};
        existing.volume = r.volume;
        bsCache.set(String(r.token), existing);
      } else {
        const existing = bsCache.get(String(r.token)) || {};

        let rsi = existing.rsi ?? null;
        if (RSI_SOURCE === 'bs' && rsi == null) {
          const closes14 = buildCloses14(r.token);
          if (closes14) rsi = computeRSIFromArray(closes14);
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

        if (r.prevClose && r.prevClose > 0) {
          prevCloseCache.set(String(r.token), +r.prevClose);
        }

        const flushed = updateMinuteBuffer(r.token, r.ltp);
        if (flushed) minuteChanges.push({ token: String(r.token), ts: flushed.ts, close: flushed.close });

        const pivot = (r.dayHigh && r.dayLow && r.ltp)
          ? +(((r.dayHigh + r.dayLow + r.ltp) / 3).toFixed(4))
          : null;

        bTokens.push(String(r.token));
        bSyms.push(SYM_BY_TOKEN[r.token] || '?');
        bBuy.push(r.buyQty ?? null);
        bSell.push(r.sellQty ?? null);
        bLtp.push(r.ltp ?? null);
        bVol.push(r.volume ?? null);
        bOpen.push(r.dayOpen ?? null);
        bHigh.push(r.dayHigh ?? null);
        bLow.push(r.dayLow ?? null);
        bClose.push(r.ltp ?? null);
        bPivot.push(pivot);
        bPrevClose.push(r.prevClose ?? null);
        bRsi.push(rsi);
      }
    }

    if (volumeOnly && vTokens.length) {
      try {
        await db.query(
          `UPDATE strategy_bs_snapshot AS s SET volume=v.volume, fetched_at=NOW()
           FROM unnest($1::text[], $2::numeric[]) AS v(token, volume)
           WHERE s.date=$3 AND s.token=v.token AND s.strategy_id='momentum'`,
          [vTokens, vVols, p.date]
        );
      } catch (e) { dbErrors.push(`bulk-vol: ${e.message}`); }
    }

    if (!volumeOnly && bTokens.length) {
      try {
        await db.query(
          `INSERT INTO strategy_bs_snapshot AS s (
             date, sym, token, strategy_id,
             buy_qty, sell_qty, ltp, volume,
             day_open, day_high, day_low, day_close, pivot, prev_close,
             rsi, fetched_at
           )
           SELECT $1, v.sym, v.token, 'momentum',
                  v.buy_qty, v.sell_qty, v.ltp, v.volume,
                  v.day_open, v.day_high, v.day_low, v.day_close, v.pivot, v.prev_close,
                  v.rsi, $15
           FROM unnest(
             $2::text[], $3::text[], $4::numeric[], $5::numeric[],
             $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[],
             $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[], $14::numeric[]
           ) AS v(token, sym, buy_qty, sell_qty, ltp, volume, day_open, day_high, day_low, day_close, pivot, prev_close, rsi)
           ON CONFLICT (date, token, strategy_id) DO UPDATE SET
             sym=EXCLUDED.sym,
             buy_qty=EXCLUDED.buy_qty,
             sell_qty=EXCLUDED.sell_qty,
             ltp=EXCLUDED.ltp,
             volume=EXCLUDED.volume,
             day_open=COALESCE(EXCLUDED.day_open, s.day_open),
             day_high=COALESCE(EXCLUDED.day_high, s.day_high),
             day_low=COALESCE(EXCLUDED.day_low, s.day_low),
             day_close=COALESCE(EXCLUDED.day_close, s.day_close),
             pivot=COALESCE(EXCLUDED.pivot, s.pivot),
             prev_close=COALESCE(EXCLUDED.prev_close, s.prev_close),
             rsi=COALESCE(EXCLUDED.rsi, s.rsi),
             fetched_at=EXCLUDED.fetched_at`,
          [p.date, bTokens, bSyms, bBuy, bSell, bLtp, bVol, bOpen, bHigh, bLow, bClose, bPivot, bPrevClose, bRsi, fetchedAt]
        );
      } catch (e) { dbErrors.push(`bulk-bs: ${e.message}`); }
    }

    // v5.3: 9:15 ke pehle BS write ke baad prev_close cache sync (din me ek baar)
    if (!volumeOnly && prevSyncDate !== p.date) {
      await loadPrevCloseFromDB();
      prevSyncDate = p.date;
    }

    if (minuteChanges.length) {
      await bulkFlushMinuteChanges(minuteChanges, p.date);
      if (!silent) console.log(`💾 Minute flush: ${minuteChanges.length} tokens`);
    }

    if (dbErrors.length) console.log(`❌ [BS] DB errors (first 5):`, dbErrors.slice(0, 5));

    broadcastBS(fetchedAt);
    if (!silent) console.log(`✅ Auto-BS: ${results.length}/${allTokens.length} in ${Math.round((Date.now() - t0) / 1000)}s`);

    if (!volumeOnly) await assignDailyRank(p.date);
    if (!volumeOnly) await buildChipList(p.date);

    if (!volumeOnly) {
      maybeRefreshMargins('angelone').catch(e => console.error('margin refresh:', e.message));
    }
  } catch (e) { console.error('Auto-BS failed:', e.message); }
  finally { bsRunning = false; }
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

async function buildChipList(date) {
  try {
    if (chipDate === date) return;

    const { rows: chk } = await db.query(
      `SELECT COUNT(*) AS cnt FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND chip_rank IS NOT NULL`,
      [date]
    );
    if (+chk[0].cnt > 0) { await loadChipListFromDB(date); return; }

    const pool = STOCKS.map(s => String(s.token))
      .map(t => ({ token: t, rank: bsCache.get(t)?.rank ?? null }))
      .filter(x => x.rank != null && x.rank >= 1 && x.rank <= 10)
      .sort((a, b) => a.rank - b.rank);
    if (!pool.length) return;

    const readyCount = pool.filter(x =>
      (bsCache.get(x.token)?.rsi ?? null) != null && getCachedLTP(x.token)
    ).length;
    const ist = getIST();
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const forceLock = mins >= 9 * 60 + 20;
    if (!forceLock && readyCount < Math.min(5, pool.length)) {
      console.log(`🔒 Chip list: first ticks ka wait (ready ${readyCount}/${pool.length})`);
      return;
    }

    const chips = [];
    for (const x of pool) {
      const dayOpen = bsCache.get(x.token)?.dayOpen ?? null;
      const prevClose = prevCloseCache.get(x.token) || null;
      if (!dayOpen || !prevClose || prevClose <= 0) continue;
      const gapPct = ((dayOpen - prevClose) / prevClose) * 100;
      const rsi = bsCache.get(x.token)?.rsi ?? null;
      if (gapPct > 3) continue;
      if (rsi == null || rsi < 70) continue;
      chips.push({
        token: x.token,
        sym: SYM_BY_TOKEN[x.token] || '?',
        rank: x.rank,
        gapPct: +gapPct.toFixed(2),
        rsiAtLock: rsi
      });
    }

    for (const c of chips) {
      db.query(
        `UPDATE strategy_bs_snapshot SET chip_rank=$1, chip_rsi=$2
         WHERE date=$3 AND token=$4 AND strategy_id='momentum'`,
        [c.rank, c.rsiAtLock, date, c.token]
      ).catch(() => {});
      chipList.set(c.token, c);
    }
    chipDate = date;
    console.log(`🔒 Chip list LOCKED for ${date}: ${chips.length} stocks → ${chips.map(c => `${c.sym}(#${c.rank},gap+${c.gapPct}%,RSI${c.rsiAtLock})`).join(', ') || 'none'}`);
    broadcastChip();
    // v4.9.3: autoTrader entry — chip lock hote hi RSI>=70 top-10 pe market buy
    onChipLock(chips, date).catch(e => console.error('🤖 AutoTrader entry error:', e.message));
  } catch (e) { console.error('Chip list build failed:', e.message); }
}

async function loadChipListFromDB(date) {
  try {
    if (!date) return;
    const { rows } = await db.query(
      `SELECT token, sym, chip_rank, chip_rsi, day_open FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND chip_rank IS NOT NULL
       ORDER BY chip_rank`,
      [date]
    );
    chipList.clear();
    for (const r of rows) {
      const prevClose = prevCloseCache.get(String(r.token)) || null;
      const gapPct = (r.day_open && prevClose > 0) ? +(((+r.day_open - prevClose) / prevClose) * 100).toFixed(2) : null;
      chipList.set(String(r.token), {
        token: String(r.token),
        sym: r.sym,
        rank: +r.chip_rank,
        gapPct,
        rsiAtLock: r.chip_rsi != null ? +r.chip_rsi : null
      });
    }
    chipDate = date;
    if (rows.length) console.log(`🔒 Chip list DB se loaded: ${rows.length} stocks for ${date}`);
  } catch (e) { console.error('Chip list load failed:', e.message); }
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
  const ms = msUntil(15, 31);
  console.log(`⏰ Next HLC fetch in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => { await fetchDayHLC(); scheduleDailyHLC(); }, ms);
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
    await loadPrevCloseFromDB();
    await loadPrevClosesFromDB();
    await loadTodayClosesFromDB();
    await loadPrevWSClosesFromDB();
    await loadTodayWSClosesFromDB();
    seedRSIStateFromMemory();
    const today = getIST().toISOString().split('T')[0];
    await recomputeAllRSI(today);
    scheduleMorningPreload();
  }, ms);
}

function startMarginRefreshLoop() {
  setInterval(() => {
    const ist = getIST();
    if (!isTradingDay(ist)) return;
    const secs = ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
    if (secs < 9 * 3600 + 15 * 60 || secs > 15 * 3600 + 30 * 60) return;
    maybeRefreshMargins('angelone').catch(() => {});
  }, 5 * 60 * 1000);
  console.log('📊 Margin refresh loop started (30-min cadence, from 9:15)');
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
      `SELECT token, open, high, low, close, volume,
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
    }
    console.log(`📦 Loaded ${rows.length} candles for ${p.date} (WS provides LTP)`);
  } catch (e) { console.error('DB load failed:', e.message); }
}


/* ============================================================
   REGISTER ADMIN ROUTES
   ============================================================ */
registerAdminRoutes(app, {
  db, SECRET,
  auth, adminOnly, log,
  loadHolidaysFromDB
});


/* ============================================================
   SECTION 14 — START
   ============================================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server on port ${PORT} — v5.4`);
  console.log(`📊 Strategies: Momentum + Advance ORB`);
  console.log(`💾 LTP flush: ${LTP_FLUSH_MS / 1000}s`);

  initMarginService(db, getBrokerSession);

  try { await loginREST(); console.log('✅ [REST] session'); } catch (e) { console.error('⚠️ [REST] login failed:', e.message); }
  await new Promise(r => setTimeout(r, 4000));
  try { await loginQuote(); console.log('✅ [Quote] session'); } catch (e) { console.error('⚠️ [Quote] login failed:', e.message); }
  await new Promise(r => setTimeout(r, 4000));
  try { await loginBS(); console.log('✅ [BS] session'); } catch (e) { console.error('⚠️ [BS] login failed:', e.message); }

  await loadHolidaysFromDB();
  await loadScreenerCacheFromDB();
  await loadPrevCloseFromDB();
  await loadBSCacheFromDB();
  await loadPrevClosesFromDB();
  await loadTodayClosesFromDB();
  await loadChipListFromDB(getIST().toISOString().split('T')[0]);

  // v4.9.3: AutoTrader init (PAPER mode jab tak env AUTO_TRADE=true na karo)
  initAutoTrader({
    db,
    getJwt: getJwtREST,
    apiKey: process.env.ANGEL_API_KEY,
    clientCode: process.env.ANGEL_CLIENT_ID,
    symByToken: SYM_BY_TOKEN,
    getLtp: getCachedLTP,
    perTrade: Number(process.env.AUTO_PER_TRADE || 10000)
  });
  await loadOpenPositions(getIST().toISOString().split('T')[0]);
  await loadPrevWSClosesFromDB();
  await loadTodayWSClosesFromDB();
  seedRSIStateFromMemory();

  await loadCachedMargins('angelone');

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
  schedulePreopenFetch();
  scheduleBSAutoFetch();
  scheduleFinalFlush();
  scheduleMorningPreload();
  startMarginRefreshLoop();

  maybeRefreshMargins('angelone', { force: true }).catch(() => {});

  console.log('ℹ️  Schedule: WS@9:14:55 | Preopen@9:13:30 | BS@9:15 (30s) | Quote@9:30 | HLC@15:31 | FinalFlush@15:31 | Preload@9:00 | Margins@30min');
});
