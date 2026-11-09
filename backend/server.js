/* ============================================================
   server.js — TradeAlgo Pro backend  |  v5.48 (Manual-Only Heavy Fetches)
   ============================================================
   CHANGES vs v5.47 (NOTHING else touched):
   20. Historical 5-min backfill NO LONGER auto-fires at 16:00.
       Manual only via POST /api/admin/fetch-historical (button).
   21. Volume backfill NEVER auto-fires. Manual only via
       POST /api/admin/fetch-volume-backfill (button).
   22. Volume backfill route now checks pg_locks for 15-min
       fetch (advisory 7452) to avoid rate-limit collisions.
   Unchanged: HLC@15:31, BS@9:15, morning preload, AI, VC, margins,
   WS/SSE, ORB, depth, all admin routes, all screener routes.
   ============================================================ */

// === GLOBAL ERROR HANDLERS (Prevents crashes) ===
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message);
});

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
  getJwt as getJwtREST,
  forceRelogin as forceReloginREST
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
import { startDepthWS, resubscribeDepth, getDepthStatus } from './brokers/angelone/Angel_Depth.js';
import * as AngelDepth from './brokers/angelone/Angel_Depth.js';

import {
  initAutoTrader, onTickPos, loadOpenPositions, getPositions, getPositionDate,
  loadVCWatchlist, rebuildVCState, vcOnMinuteCandle, getVCStatus
} from './autoTrader.js';

import { registerAdminRoutes } from './admin.js';
import { registerFifteenRoutes } from './fifteen.js';
import { generateAIPlan } from './aiAnalyzer.js';

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
  max: 10,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 5000
});

db.on('error', (err) => {
  console.error('💥 DB pool error:', err.message);
});

const SECRET = process.env.JWT_SECRET;
const __dir = dirname(fileURLToPath(import.meta.url));

const RAW_STOCKS = JSON.parse(
  readFileSync(join(__dir, 'brokers/angelone/Angel_nifty500.json'), 'utf8')
);
const ALL_STOCKS = Array.isArray(RAW_STOCKS)
  ? RAW_STOCKS
  : Object.entries(RAW_STOCKS).flatMap(([sector, arr]) => arr.map(s => ({ ...s, sector })));
const STOCKS = ALL_STOCKS.filter(s => !s.disabled);
const SECTOR_BY_TOKEN = {};
ALL_STOCKS.forEach(s => { SECTOR_BY_TOKEN[String(s.token)] = s.sector || 'MISC'; });
console.log(`📋 Stocks: ${STOCKS.length} active / ${ALL_STOCKS.length} total`);

const SYM_BY_TOKEN = {};
STOCKS.forEach(s => { SYM_BY_TOKEN[String(s.token)] = s.sym; });

const TOKEN_BY_SYM = {};
STOCKS.forEach(s => {
  const key = String(s.sym).toUpperCase().trim().replace(/-EQ$|-BE$|-BL$|-BZ$/, '');
  TOKEN_BY_SYM[key] = s.token;
});

const NIFTY50_TOKEN = '99926000';
const BANKNIFTY_TOKEN = '99926009';
const INDIAVIX_TOKEN = '99926017';
const INDEX_TOKENS = [NIFTY50_TOKEN, BANKNIFTY_TOKEN, INDIAVIX_TOKEN];
const INDEX_SYMS = {
  [NIFTY50_TOKEN]: 'NIFTY 50',
  [BANKNIFTY_TOKEN]: 'BANKNIFTY',
  [INDIAVIX_TOKEN]: 'INDIA VIX'
};

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

// SINGLE SOURCE OF TRUTH: If it's in the table, it's closed. Otherwise, open.
const isTradingDay = d => {
  const ds = d.toISOString().split('T')[0];
  return !isHoliday(ds); 
};

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
   SECTION 4.1 — PREV CLOSE & PDH/PDL CACHES
   ============================================================ */
const prevCloseCache = new Map();
const prevHighCache = new Map();
const prevLowCache = new Map();
const avgVolume5D = new Map();
const lastEodVolume = new Map();

async function loadLastEodVolumeFromDB() {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (token) token,
              (SELECT COALESCE(SUM(x),0) FROM unnest(ws_1min_volume) x) AS vol
       FROM strategy_bs_snapshot
       WHERE strategy_id='momentum' AND ws_1min_volume IS NOT NULL
         AND array_length(ws_1min_volume,1) > 0 AND date < CURRENT_DATE
       ORDER BY token, date DESC`
    );
    for (const r of rows) if (+r.vol > 0) lastEodVolume.set(String(r.token), +r.vol);
    console.log(`📊 Last EOD volume loaded: ${lastEodVolume.size} tokens`);
  } catch (e) { console.error('EOD volume load failed:', e.message); }
}

async function loadPrevCloseFromDB() {
  try {
    const activeTokens = [...STOCKS.map(s => String(s.token)), ...INDEX_TOKENS];
    const istNow = getIST();
    const todayStr = istNow.toISOString().split('T')[0];
    const baseDate = isTradingDay(istNow) ? todayStr : getPreviousTradingDay(istNow);

    const { rows } = await db.query(
      `SELECT DISTINCT ON (token) token, prev_close
       FROM strategy_bs_snapshot
       WHERE prev_close IS NOT NULL
         AND token = ANY($1)
         AND date = $2
       ORDER BY token, date DESC`,
      [activeTokens, baseDate]
    );

    for (const r of rows) prevCloseCache.set(String(r.token), +r.prev_close);
    console.log(`💾 prevClose (BS source, base=${baseDate}): ${rows.length} tokens`);

    if (rows.length < activeTokens.length) {
      const missingTokens = activeTokens.filter(t => !prevCloseCache.has(String(t)));
      if (isTradingDay(istNow)) {
        console.log(`🔄 Fetching prevClose via Quote API fallback for missing tokens...`);
        try {
          const quotes = await fetchQuotesForTokens(missingTokens);
          if (quotes && quotes.length > 0) {
            let count = 0;
            for (const q of quotes) {
              if (q.close && q.close > 0) {
                prevCloseCache.set(String(q.token), +q.close);
                count++;
              }
              if (q.ltp && q.ltp > 0) {
                setCachedLTP(String(q.token), +q.ltp);
              }
            }
            console.log(`✅ Quote API Fallback: Fetched data for ${count} tokens`);
          }
        } catch (apiErr) {
          console.error('⚠️ Quote API fallback failed:', apiErr.message);
        }
      } else {
        const P = getPreviousTradingDay(new Date(baseDate + 'T00:00:00Z'));
        try {
          const { rows: r2 } = await db.query(
            `SELECT DISTINCT ON (token) token, day_close
             FROM strategy_bs_snapshot
             WHERE day_close IS NOT NULL AND token = ANY($1) AND date = $2
             ORDER BY token, date DESC`,
            [missingTokens, P]
          );
          for (const r of r2) prevCloseCache.set(String(r.token), +r.day_close);
          console.log(`💾 prevClose weekend baseline from ${P}: ${r2.length} tokens`);
        } catch (e2) { console.error('weekend baseline failed:', e2.message); }
      }
    }

    const prevDate = getPreviousTradingDay(getIST());
    const { rows: hlRows } = await db.query(
      `SELECT token, day_high, day_low
       FROM strategy_bs_snapshot
       WHERE date = $1 AND token = ANY($2)`,
      [prevDate, activeTokens]
    );
    for (const r of hlRows) {
      if (r.day_high) prevHighCache.set(String(r.token), +r.day_high);
      if (r.day_low) prevLowCache.set(String(r.token), +r.day_low);
    }
    console.log(`📈 Loaded PDH/PDL for ${hlRows.length} tokens (from ${prevDate})`);

  } catch (e) { 
    console.error('prevClose load failed:', e.message); 
  }
}

async function loadAvgVolumeFromDB() {
  try {
    const { rows } = await db.query(`
      SELECT token, AVG(volume) as avg_vol 
      FROM strategy_bs_snapshot 
      WHERE date < CURRENT_DATE AND date >= CURRENT_DATE - 10
        AND strategy_id = 'momentum' AND volume > 0 
      GROUP BY token
    `);
    for (const r of rows) avgVolume5D.set(String(r.token), +r.avg_vol);
    console.log(`📊 Loaded 5-day Avg Volume for ${rows.length} tokens`);
  } catch (e) { console.error('Avg Volume load failed:', e.message); }
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
const wsTodayVols = new Map();
const wsTodayHighs = new Map();
const wsTodayLows = new Map();

const currentMinHighs = new Map();
const currentMinLows = new Map();

const CHIP_TEST_MODE = String(process.env.CHIP_TEST_MODE || 'true') === 'true';
const rsiState = new Map();

const chipList = new Map();
let chipDate = null;

const orbCache = new Map();
let orbDoneDate = null;
const orbForming = new Map();

let latestBreadth = { adv: 0, dec: 0 };

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
    
    const activeTokens = [...STOCKS.map(s => String(s.token)), ...INDEX_TOKENS];
    const { rows } = await db.query(
      `SELECT token, buy_qty, sell_qty, ltp, volume, rank_no, day_open, rsi, rsi_first
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
        dayOpen: r.day_open != null ? +r.day_open : null,
        rsi: r.rsi != null ? +r.rsi : null,
        rsiFirst: r.rsi_first != null ? +r.rsi_first : null
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
         AND date >= CURRENT_DATE - 2
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
      `SELECT token, ws_1min_close, ws_1min_volume FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND ws_1min_close IS NOT NULL
         AND token = ANY($2)`,
      [today, activeTokens]
    );
    wsTodayCloses.clear();
    wsTodayVols.clear();
    wsTodayHighs.clear();
    wsTodayLows.clear();
    prevCumVol.clear(); 

    
    for (const r of rows) {
      if (Array.isArray(r.ws_1min_close) && r.ws_1min_close.length > 0) {
        wsTodayCloses.set(String(r.token), r.ws_1min_close.map(c => +c));
        const vols = Array.isArray(r.ws_1min_volume) ? r.ws_1min_volume.map(v => +v || 0) : [];
        wsTodayVols.set(String(r.token), vols);
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

function computeVWAP(token) {
  const c = wsTodayCloses.get(String(token));
  const v = wsTodayVols.get(String(token));
  if (!c || !v || !c.length) return null;
  let pv = 0, vv = 0;
  for (let i = 0; i < c.length; i++) {
    const vol = v[i] || 0;
    pv += c[i] * vol;
    vv += vol;
  }
  return vv > 0 ? +(pv / vv).toFixed(2) : null;
}

async function backfillRsiFirst(date) {
  try {
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      `SELECT token, ws_1min_close FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND rsi_first IS NULL
         AND ws_1min_close IS NOT NULL AND array_length(ws_1min_close,1) > 0
         AND token = ANY($2)`,
      [date, activeTokens]
    );
    const toks = [], rsis = [];
    for (const r of rows) {
      const series = (wsPrevCloses.get(String(r.token)) || []).concat([+r.ws_1min_close[0]]);
      const rsi = computeRSIWilder(series);
      if (rsi == null) continue;
      toks.push(String(r.token)); rsis.push(+rsi.toFixed(2));
    }
    if (toks.length) {
      await db.query(
        `UPDATE strategy_bs_snapshot AS s SET rsi_first=v.rsi
         FROM unnest($1::text[], $2::numeric[]) AS v(token, rsi)
         WHERE s.date=$3 AND s.token=v.token AND s.strategy_id='momentum' AND s.rsi_first IS NULL`,
        [toks, rsis, date]
      );
      console.log(`🥇 rsi_first backfill: ${toks.length} tokens for ${date}`);
    }
  } catch (e) { console.error('rsi_first backfill failed:', e.message); }
}

async function updateRSIFromWS(date, prevKey) {
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
    if (prevKey === '09:15' && toks.length) {
      try {
        await db.query(
          `UPDATE strategy_bs_snapshot AS s SET rsi_first = v.rsi
           FROM unnest($1::text[], $2::numeric[]) AS v(token, rsi)
           WHERE s.date=$3 AND s.token=v.token AND s.strategy_id='momentum' AND s.rsi_first IS NULL`,
          [toks, rsis, date]
        );
        for (let i = 0; i < toks.length; i++) {
          const c = bsCache.get(toks[i]) || {};
          c.rsiFirst = rsis[i];
          bsCache.set(toks[i], c);
        }
        console.log(`🥇 RSI-first (9:15 candle) locked: ${toks.length} tokens`);
        broadcastBS(new Date());
      } catch (e) { console.error('rsi_first write failed:', e.message); }
    }
  } catch (e) { console.error('WS RSI update failed:', e.message); }
}

async function recomputeRSIFromWS(date) {
  try {
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows: prevRows } = await db.query(
      `SELECT token, ws_1min_close
       FROM strategy_bs_snapshot
       WHERE strategy_id='momentum' AND ws_1min_close IS NOT NULL
         AND array_length(ws_1min_close, 1) > 0
         AND token = ANY($1) AND date < $2
         AND date >= CURRENT_DATE - 2
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
   TRADINGVIEW EXACT RSI VIA PYTHON (MICROSERVICE)
   ============================================================ */
async function fetchTvRsiFromPython(symbols) {
  const baseUrl = process.env.PYTHON_RSI_URL;
  if (!baseUrl) {
    console.error('❌ PYTHON_RSI_URL missing in .env');
    return null;
  }

  try {
    const query = Array.isArray(symbols) ? `symbols=${symbols.join(',')}` : `symbol=${symbols}`;
    const res = await fetch(`${baseUrl}/rsi?${query}`);
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('❌ Python RSI fetch failed:', err.message);
    return null;
  }
}

/* ============================================================
   SECTION 4.6 — WS MINUTE-CLOSE SHADOW SAMPLER
   ============================================================ */
const lastLtpAt = new Map();
const lastWsVolume = new Map();
const lastWsAvg = new Map();
const vwapPV = new Map();
const vwapV = new Map();
let vwapDate = null;
const prevCumVol = new Map();
const minVolRing = new Map();
let wsMinuteKey = null;

async function flushWSMinuteClose(prevKey, prevTs, date) {
  const tokens = [], closes = [], minVols = [], minRvols = [];
  
  for (const s of STOCKS) {
    const token = String(s.token);
    const age = Date.now() - (lastLtpAt.get(token) || 0);
    let close = age < 75000 ? getCachedLTP(token) : null;
    if (close == null) close = bsCache.get(token)?.ltp ?? null;
    if (!Number.isFinite(close) || close <= 0) continue;

    const cumRaw = lastWsVolume.get(token) ?? bsCache.get(token)?.volume ?? null;
    const cum = (cumRaw != null && cumRaw > 0) ? cumRaw : null;
    
    const prev = prevCumVol.get(token) ?? 0;
    let mv = 0;
    if (cum != null) {
      if (cum >= prev) mv = cum - prev;
      else mv = cum; // Agar kal ka volume bada tha (naya din), toh poora volume aaj ka maano
    }
    if (cum != null) prevCumVol.set(token, cum);
         
    const histAvg = avgVolume5D.get(token) || 0;
    const officialCumVol = cum || bsCache.get(token)?.volume || 0;
    const rvol = histAvg > 0 ? +(officialCumVol / histAvg).toFixed(2) : 0;

    tokens.push(token);
    closes.push(close);
    minVols.push(mv);
    minRvols.push(rvol);

    const ring = minVolRing.get(token) || [];
    ring.push(mv);
    if (ring.length > 5) ring.shift();
    minVolRing.set(token, ring);
  }
  if (!tokens.length) return;

  const isFive = Number(prevKey.slice(3)) % 5 === 4;
  const tss = tokens.map(() => prevTs);
  const vols5 = isFive ? tokens.map(t => (minVolRing.get(t) || []).reduce((a, b) => a + b, 0)) : [];
  const vwaps = tokens.map(t => lastWsAvg.get(t) ?? 0);
  try {
    await db.query(
      `UPDATE strategy_bs_snapshot AS s
       SET ws_1min_close  = COALESCE(s.ws_1min_close,  ARRAY[]::numeric[]) || v.c,
           ws_1min_ts     = COALESCE(s.ws_1min_ts,     ARRAY[]::timestamptz[]) || v.t,
           ws_1min_volume = COALESCE(s.ws_1min_volume, ARRAY[]::numeric[]) || v.vol,
           ws_1min_vwap   = COALESCE(s.ws_1min_vwap,   ARRAY[]::numeric[]) || v.w,
           ws_1min_rvol   = COALESCE(s.ws_1min_rvol,   ARRAY[]::numeric[]) || v.rvol
       FROM unnest($1::text[], $2::numeric[], $3::timestamptz[], $4::numeric[], $5::numeric[], $6::numeric[]) AS v(token, c, t, vol, w, rvol)
       WHERE s.date = $7 AND s.token = v.token AND s.strategy_id = 'momentum'`,
      [tokens, closes, tss, minVols, vwaps, minRvols, date]
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
      const tk = tokens[i];
      const arr = wsTodayCloses.get(tk) || [];
      arr.push(closes[i]);
      wsTodayCloses.set(tk, arr);
      
      const va = wsTodayVols.get(tk) || [];
      va.push(minVols[i]);
      wsTodayVols.set(tk, va);

      const h = currentMinHighs.get(tk) ?? closes[i];
      const l = currentMinLows.get(tk) ?? closes[i];
      const arrH = wsTodayHighs.get(tk) || []; arrH.push(h); wsTodayHighs.set(tk, arrH);
      const arrL = wsTodayLows.get(tk) || []; arrL.push(l); wsTodayLows.set(tk, arrL);
      
      const cOpen = i > 0 ? closes[i - 1] : (bsCache.get(tk)?.dayOpen ?? closes[i]);
      vcOnMinuteCandle(tk, { high: h, low: l, close: closes[i], open: cOpen, minuteKey: prevKey });

      currentMinHighs.delete(tk);
      currentMinLows.delete(tk);
    }
    if (RSI_SOURCE === 'ws') await updateRSIFromWS(date, prevKey);

    if (prevKey === '09:29' && orbQuoteDoneDate !== date && orbHistDoneDate !== date) {
      setTimeout(() => {
        if (orbQuoteDoneDate !== date && orbHistDoneDate !== date && !orbOfficialRunning)
          computeOrbCandles(date).catch(e => console.error('🎯 ORB WS fallback failed:', e.message));
      }, 70000);
    }

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
  const jwt = getJwtREST();
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
  let markerAge = null;
  try {
    const { rows } = await db.query(`SELECT value FROM kv_store WHERE key = $1`, ['margin_refresh_' + broker]);
    if (rows.length) markerAge = Date.now() - new Date(rows[0].value).getTime();
  } catch {}
  let cacheOk = false;
  for (let i = 0; i < 20 && !cacheOk; i++) {
    if (STOCKS[i]) cacheOk = !!getMarginInfo(broker, String(STOCKS[i].token));
  }
  if (!force) {
    if (cacheOk && markerAge === null) {
      await db.query(
        `INSERT INTO kv_store (key, value) VALUES ($1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = kv_store.value`,
        ['margin_refresh_' + broker]
      ).catch(() => {});
      return;
    }
    if (markerAge !== null && markerAge < 7 * 24 * 3600 * 1000) return;
    if (!shouldRefresh(broker)) return;
  }
  const ltpMap = buildLtpMap();
  if (!Object.keys(ltpMap).length) {
    console.log(`📊 Margin refresh [${broker}]: skipped (no LTPs yet)`);
    return;
  }
  await refreshMargins(broker, STOCKS, ltpMap);
  await db.query(
    `INSERT INTO kv_store (key, value) VALUES ($1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = NOW()`,
    ['margin_refresh_' + broker]
  ).catch(() => {});
  console.log(`📊 Margin refreshed [${broker}] — agla auto refresh 7 din baad`);
}

/* ============================================================
   SECTION 5 — WEBSOCKET + SSE + BATCHED LTP
   ============================================================ */
let wsStarted = false;
let depthStarted = false;
const depthCache = new Map();
const depthSec = new Map();
let depthPend = new Map();
let depthTimer = null;
let lastDepthPacket = 0;
let depthPktCount = 0;
let depthRestarts = 0;
let depthWatchdog = null;

const activeDepthTokens = new Set();
setInterval(() => {
  if (activeDepthTokens.size > 0) {
    const total = getDepthStatus().tokenCount || 300;
    console.log(`🧿 Depth Active: ${activeDepthTokens.size} / ${total} tokens`);
    activeDepthTokens.clear();
  }
}, 10000);

const sseClients = new Set();
let ssePending = new Map();
let sseFlushTimer = null;

function sseSend(payload) {
  for (const c of sseClients) {
    try { c.res.write(payload); } catch { sseClients.delete(c); }
  }
}

const ssePendingVwap = new Map();
const ssePendingRsi = new Map();
const ssePendingPrevClose = new Map();

function updateMarketBreadth() {
  let adv = 0, dec = 0;
  for (const s of STOCKS) {
    const token = String(s.token);
    const ltp = getCachedLTP(token) || bsCache.get(token)?.ltp;
    const pc = prevCloseCache.get(token);
    if (ltp && pc && pc > 0) {
      if (ltp > pc) adv++;
      else if (ltp < pc) dec++;
    }
  }
  latestBreadth = { adv, dec };
}

function broadcastLTP(token, ltp) {
  if (!sseClients.size) return;
  ssePending.set(String(token), ltp);
  const vw = lastWsAvg.get(String(token));
  if (vw != null) ssePendingVwap.set(String(token), vw);
  const rs = bsCache.get(String(token))?.rsi;
  if (rs != null) ssePendingRsi.set(String(token), rs);
  
  const pc = prevCloseCache.get(String(token));
  if (pc != null) ssePendingPrevClose.set(String(token), pc);

  if (sseFlushTimer) return;
  sseFlushTimer = setTimeout(() => {
    sseFlushTimer = null;
    if (!ssePending.size) return;
    const payload = `data: ${JSON.stringify({
      type: 'ltp',
      ticks: Object.fromEntries(ssePending),
      vwaps: Object.fromEntries(ssePendingVwap),
      rsis: Object.fromEntries(ssePendingRsi),
      prevCloses: Object.fromEntries(ssePendingPrevClose),
      breadth: latestBreadth
    })}\n\n`;
    ssePending.clear();
    ssePendingVwap.clear();
    ssePendingRsi.clear();
    ssePendingPrevClose.clear();
    sseSend(payload);
  }, 50);
}

function broadcastBS(fetchedAt) {
  if (!sseClients.size) return;
  sseSend(`data: ${JSON.stringify({
    type: 'bs', fetchedAt,
    bs: Object.fromEntries([...bsCache.entries()].map(([t, v]) => {
      const lev = getLeverage('angelone', t);
      const wsV = (wsTodayVols.get(t) || []).reduce((a, b) => a + (+b || 0), 0);
      const eodV = lastEodVolume.get(t) > 0 ? lastEodVolume.get(t) : null;
      const volV = (v.volume > 0 ? +v.volume : (wsV > 0 ? wsV : eodV));
      return [t, {
        buyQty: v.buyQty, sellQty: v.sellQty, ltp: v.ltp,
        volume: volV,
        rvol: volV && avgVolume5D.get(t) ? +(volV / avgVolume5D.get(t)).toFixed(1) : (v.rvol ?? null),
        rank: v.rank,
        dayOpen: v.dayOpen ?? null,
        rsi: v.rsi ?? null,
        leverage: lev ?? null,
        marginPerShare: lev && v.ltp ? +(v.ltp / lev).toFixed(4) : null,
        rsiFirst: v.rsiFirst ?? null,
        prevClose: prevCloseCache.get(t) ?? null
      }];
    }))
  })}\n\n`);
}

function broadcastChip() {
  if (!sseClients.size) return;
  sseSend(`data: ${JSON.stringify({ type: 'chip', chips: [...chipList.values()] })}\n\n`);
}

function broadcastVC() {
  if (!sseClients.size) return;
  sseSend(`data: ${JSON.stringify({ type: 'vc', vc: getVCStatus() })}\n\n`);
}

function handleTick(token, ltp, tickMs, extra) {
  if (!Number.isFinite(ltp) || ltp < 1 || ltp > 1000000) return;
  
  const tk = String(token);
  if (!currentMinHighs.has(tk) || ltp > currentMinHighs.get(tk)) currentMinHighs.set(tk, ltp);
  if (!currentMinLows.has(tk) || ltp < currentMinLows.get(tk)) currentMinLows.set(tk, ltp);

  const minsNow = getIST().getUTCHours() * 60 + getIST().getUTCMinutes();
  if (minsNow >= 555 && minsNow <= 569 && ltp > 0) {
    const f = orbForming.get(tk) || { h: ltp, l: ltp };
    if (ltp > f.h) f.h = ltp;
    if (ltp < f.l) f.l = ltp;
    orbForming.set(tk, f);
  }

  if (extra && Number.isFinite(extra.volume) && extra.volume > 0) {
    const today = getIST().toISOString().split('T')[0];
    if (vwapDate !== today) { vwapPV.clear(); vwapV.clear(); vwapDate = today; }
    const prevVol = lastWsVolume.get(tk);
    const dv = prevVol == null ? extra.volume : (extra.volume - prevVol);
    lastWsVolume.set(tk, extra.volume);
    if (dv > 0) {
      vwapPV.set(tk, (vwapPV.get(tk) || 0) + ltp * dv);
      vwapV.set(tk, (vwapV.get(tk) || 0) + dv);
      const vv = vwapV.get(tk);
      if (vv > 0) lastWsAvg.set(tk, +((vwapPV.get(tk)) / vv).toFixed(2));
    }
  }

  if (INDEX_TOKENS.includes(String(token))) {
    setCachedLTP(token, ltp);
    broadcastLTP(token, ltp);
    return;
  }

  setCachedLTP(token, ltp);
  broadcastLTP(token, ltp);
  lastLtpAt.set(String(token), Date.now());
  onTickPos(token, ltp);

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
}

function startWebSocketForReadyPhase() {
  if (wsStarted) return;
  if (!shouldStartWS()) return;

  const restSession = getSessionStatusREST();
  const feedToken = restSession.loggedIn ? getFeedTokenREST() : getFeedTokenQuote();
  if (!feedToken) { console.log('⚠️  WS skipped — no feed token'); return; }

  const tokens = [...STOCKS.map(s => String(s.token)), ...INDEX_TOKENS];
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

    if (String(process.env.DEPTH_LIVE || 'true') === 'true' && !depthStarted) {
      depthStarted = true;
      setTimeout(() => startDepthLive(feedToken), 45000);
      console.log('🧿 Depth engine scheduled (45s delay)');
    }
  } catch (e) { console.error('WS start failed:', e.message); }
}

function stopWebSocketIfNeeded() {
  if (!wsStarted) return;
  if (!shouldStartWS()) return;

  stopWS();
  wsStarted = false;
  console.log('🔌 WS stopped');
}

setInterval(() => {
  if (shouldStartWS()) startWebSocketForReadyPhase();
  else stopWebSocketIfNeeded();
}, 5 * 1000);

/* ============================================================
   SECTION 5.9 — DEPTH ENGINE
   ============================================================ */
function onDepthPacket(d) {
  if (d.buyQty == null || d.sellQty == null) return;
  lastDepthPacket = Date.now();
  depthPktCount++;
  depthCache.set(d.token, d);

  if (d.shouldValidate) {
    activeDepthTokens.add(d.token);
  }

  const tot = (d.buyQty || 0) + (d.sellQty || 0);
  const r = tot > 0 ? d.buyQty / tot : 0.5;
  const secKey = Math.floor(Date.now() / 1000);
  let arr = depthSec.get(d.token);
  if (!arr) { arr = []; depthSec.set(d.token, arr); }
  if (!arr.length || arr[arr.length - 1].sec !== secKey) {
    arr.push({ sec: secKey, r });
    if (arr.length > 60) arr.shift();
  } else {
    arr[arr.length - 1].r = r;
  }

  broadcastDepth(d.token, d, r);
}

function broadcastDepth(token, d, r) {
  if (!sseClients.size) return;
  depthPend.set(token, { b: d.buyQty, s: d.sellQty, r: +r.toFixed(3), ltp: d.ltp });
  if (depthTimer) return;
  depthTimer = setTimeout(() => {
    depthTimer = null;
    if (!depthPend.size) return;
    sseSend(`data: ${JSON.stringify({ type: 'depth', depth: Object.fromEntries(depthPend) })}\n\n`);
    depthPend.clear();
  }, 500);
}

function computeDepthList() {
  const scored = STOCKS.map(s => {
    const t = String(s.token);
    const ltp = getCachedLTP(t) ?? bsCache.get(t)?.ltp ?? null;
    const pc = prevCloseCache.get(t) || null;
    const chg = (ltp && pc && pc > 0) ? ((ltp - pc) / pc) * 100 : -Infinity;
    return { t, chg };
  }).sort((a, b) => b.chg - a.chg);
  const set = new Set(scored.slice(0, 300).map(x => x.t));
  for (const t of chipList.keys()) set.add(String(t));
  for (const p of getPositions()) {
    if (p.status === 'open') set.add(String(p.token));
  }
  const cap = depthRestarts >= 3 ? 150 : (depthRestarts >= 1 ? 250 : 330);
  return [...set].slice(0, cap);
}

function startDepthLive(feedToken) {
  const list = computeDepthList();
  startDepthWS({
    feedToken,
    apiKey: process.env.ANGEL_API_KEY,
    clientCode: process.env.ANGEL_CLIENT_ID,
    tokens: list,
    onDepth: onDepthPacket
  });
  setInterval(() => {
    if (!shouldStartWS() || !depthStarted) return;
    resubscribeDepth(computeDepthList());
  }, 10 * 60 * 1000);

  if (!depthWatchdog) {
    depthWatchdog = setInterval(() => {
      if (!shouldStartWS()) return;
      const st = getDepthStatus();
      const silentMs = Date.now() - lastDepthPacket;
      if (depthPktCount > 0 || lastDepthPacket) {
        console.log(`🧿 depth rate: ${depthPktCount} pkt/min | connected=${st.connected} | tokens=${st.tokenCount}`);
      }
      depthPktCount = 0;
      if (!st.connected || silentMs > 90000) {
        depthRestarts++;
        console.warn(`🧿 Depth WATCHDOG: restart #${depthRestarts} (connected=${st.connected}, silent=${Math.round(silentMs / 1000)}s)`);
        try {
          if (typeof AngelDepth.stopDepthWS === 'function') AngelDepth.stopDepthWS();
          else console.warn('🧿 stopDepthWS not exported by Angel_Depth.js — skipping clean stop');
        } catch {}
        startDepthLive(getLastFeedToken());
      }
    }, 60000);
  }
}

function getLastFeedToken() {
  const restSession = getSessionStatusREST();
  return restSession.loggedIn ? getFeedTokenREST() : getFeedTokenQuote();
}

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

app.get('/api/screener/vc', auth, (req, res) => {
  res.json({ ok: true, ...getVCStatus() });
});

app.get('/api/screener/orb', auth, (req, res) => {
  const list = [];
  for (const [t, o] of orbCache) {
    if (o.size <= 1.5) {
      list.push({
        token: t,
        sym: SYM_BY_TOKEN[t] || '?',
        ltp: getCachedLTP(t) ?? bsCache.get(t)?.ltp ?? null,
        size: o.size, volume: o.volume, high: o.high, low: o.low
      });
    }
  }
  list.sort((a, b) => a.size - b.size);
  res.json({ ok: true, done: orbDoneDate != null, count: list.length, list });
});

function orbSizeFor(t) {
  const done = orbCache.get(t);
  if (done) return done.size;
  const f = orbForming.get(t);
  if (f && f.l > 0) return +(((f.h - f.l) / f.l) * 100).toFixed(2);
  return null;
}

app.get('/api/sectors', auth, (req, res) => {
  const by = {};
  for (const s of STOCKS) {
    const t = String(s.token);
    const sec = s.sector || 'MISC';
    const ltp = getCachedLTP(t) ?? bsCache.get(t)?.ltp ?? null;
    const open = bsCache.get(t)?.dayOpen ?? null;
    const pc = prevCloseCache.get(t) || null;
    const e = by[sec] || (by[sec] = { sector: sec, up: 0, down: 0, flat: 0, noData: 0, sumOpen: 0, nOpen: 0, sumPrev: 0, nPrev: 0, stocks: [] });
    const orbSize = orbSizeFor(t);
    if (!ltp || ltp <= 0) {
      e.noData++;
      e.stocks.push({ sym: s.sym, token: t, ltp: null, open, prev: pc, openPct: null, prevPct: null, orbSize });
      continue;
    }
    let openPct = null, prevPct = null;
    if (open && open > 0) {
      openPct = +(((ltp - open) / open) * 100).toFixed(2);
      if (ltp > open) e.up++;
      else if (ltp < open) e.down++;
      else e.flat++;
      e.sumOpen += openPct;
      e.nOpen++;
    } else {
      e.noData++;
    }
    if (pc && pc > 0) {
      prevPct = +(((ltp - pc) / pc) * 100).toFixed(2);
      e.sumPrev += prevPct;
      e.nPrev++;
    }
    e.stocks.push({ sym: s.sym, token: t, ltp, open, prev: pc, openPct, prevPct, orbSize });
  }
  const sectors = Object.values(by).map(e => ({
    ...e,
    avgOpenPct: e.nOpen ? +(e.sumOpen / e.nOpen).toFixed(2) : null,
    avgPrevPct: e.nPrev ? +(e.sumPrev / e.nPrev).toFixed(2) : null
  })).sort((a, b) => (b.avgOpenPct ?? -999) - (a.avgOpenPct ?? -999));
  for (const e of sectors) e.stocks.sort((a, b) => (b.openPct ?? -999) - (a.openPct ?? -999));
  res.json({ ok: true, time: new Date().toISOString(), sectors });
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
app.get('/api/ai-plans', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM ai_trade_plans WHERE date = CURRENT_DATE ORDER BY sym`);
    res.json({ ok: true, plans: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv-rsi/:sym', auth, async (req, res) => {
  const symbol = req.params.sym;
  const rsiData = await fetchTvRsiFromPython(symbol);
  if (!rsiData || !rsiData.ok) {
    return res.status(500).json({ error: 'Failed to fetch from Python', detail: rsiData });
  }
  res.json(rsiData);
});

const userCapital = new Map();

app.post('/api/auto/capital', auth, (req, res) => {
  const uid = req.user?.id || req.user?.username || 'admin';
  const val = Number(req.body?.value);
  if (!Number.isFinite(val) || val <= 0) return res.status(400).json({ error: 'invalid capital' });
  userCapital.set(uid, val);
  res.json({ ok: true, userId: uid, capital: val });
});

app.get('/api/auto/capital', auth, (req, res) => {
  const uid = req.user?.id || req.user?.username || 'admin';
  res.json({ ok: true, capital: userCapital.get(uid) ?? Number(process.env.AUTO_PER_TRADE || 25000) });
});

app.post('/api/auto/side-mode', auth, async (req, res) => {
  const uid = req.user?.id || req.user?.username || 'admin';
  const mode = String(req.body?.value || 'MIX').toUpperCase();
  if (!['BUY', 'SELL', 'MIX'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
  
  try {
    await db.query(`UPDATE users SET side_mode = $1 WHERE id = $2`, [mode, uid]);
    res.json({ ok: true, userId: uid, mode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auto/side-mode', auth, async (req, res) => {
  const uid = req.user?.id || req.user?.username || 'admin';
  try {
    const { rows } = await db.query(`SELECT side_mode FROM users WHERE id = $1`, [uid]);
    res.json({ ok: true, mode: rows[0]?.side_mode || 'MIX' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/screener/buyers', auth, (req, res) => {
  res.json({ ok: true, buyers: Object.fromEntries(buyersInfo) });
});

app.get('/api/auto/positions', auth, async (req, res) => {
  try {
    const date = req.query.date || getIST().toISOString().split('T')[0];
    const uid = req.user?.id || req.user?.username || 'admin';
    
    const { rows } = await db.query(
      `SELECT date::text AS date, token, sym, qty, entry, sl, stage, peak, side,
              status, exit_price, exit_reason, entry_at, exit_at
       FROM auto_positions WHERE date=$1 AND user_id=$2 ORDER BY entry_at`,
      [date, uid]
    );
    const live = getPositions(uid);
    const out = rows.map(r => {
      const lp = live.find(p => p.token === String(r.token) && p.side === r.side);
      const ltp = getCachedLTP(String(r.token)) ?? null;
      const ref = r.status === 'open' ? (ltp ?? +r.entry) : (r.exit_price != null ? +r.exit_price : +r.entry);
      const pnl = r.side === 'SELL' 
        ? +((+r.entry - ref) * r.qty).toFixed(2)
        : +((ref - +r.entry) * r.qty).toFixed(2);
      const pnlPct = +(((pnl / (r.entry * r.qty)) * 100)).toFixed(2);
      return {
        date: r.date, token: String(r.token), sym: r.sym, qty: +r.qty, side: r.side || 'BUY',
        entry: +r.entry, sl: +r.sl, t1: null, t2: null,
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
    const ltp = getCachedLTP(token) ?? bsCache.get(token)?.ltp ?? null;
    const prevClose = prevCloseCache.get(token) || null;
    const bs = bsCache.get(token) || null;
    const lev = getLeverage('angelone', token);
    const wsVol = (wsTodayVols.get(token) || []).reduce((a, b) => a + (+b || 0), 0);
    const eodVol = lastEodVolume.get(token) > 0 ? lastEodVolume.get(token) : null;
    const vol = (bs?.volume > 0 ? +bs.volume : (wsVol > 0 ? wsVol : eodVol));
    const rvol = vol && avgVolume5D.get(token) ? +(vol / avgVolume5D.get(token)).toFixed(1) : (bs?.rvol ?? null);
    return {
      token, ltp, prevClose,
      buyQty: bs?.buyQty ?? null,
      sellQty: bs?.sellQty ?? null,
      bsVolume: vol,
      rvol,
      rank: bs?.rank ?? null,
      dayOpen: bs?.dayOpen ?? null,
      rsi: bs?.rsi ?? null,
      leverage: lev ?? null,
      marginPerShare: lev && ltp ? +(ltp / lev).toFixed(4) : null,
      vwap: lastWsAvg.get(token) ?? computeVWAP(token),
      rsiFirst: bs?.rsiFirst ?? null,
      serverTime
    };
  });

  res.json({ ok: true, count: enriched.length, breadth: latestBreadth, results: enriched });
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
      `SELECT COUNT(*) AS cnt FROM strategy_bs_snapshot WHERE date=$1 AND day_high IS NOT NULL`,
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
   SECTION 7.2 — HISTORICAL BACKFILL (5-MIN ONLY, MANUAL)
   ============================================================ */
const HISTORICAL_DAYS_DEFAULT = 5;
const ANGEL_HISTORICAL_URL = 'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData';
let historicalRunning = false;
let historicalProgress = { running: false, total: 0, done: 0, current: '' };
const historicalFailed = new Set();

app.get('/api/admin/fetch-progress', auth, (req, res) => {
  res.json(historicalProgress);
});

async function getAnyAngelJwt() {
  if (getSessionStatusREST()?.loggedIn && getJwtREST?.()) return getJwtREST();
  try {
    await loginREST();
    if (getSessionStatusREST()?.loggedIn && getJwtREST?.()) {
      console.log('🔑 getAnyAngelJwt: fresh login done (session had died)');
      return getJwtREST();
    }
  } catch (e) {
    console.error('🔑 getAnyAngelJwt: re-login failed:', e.message);
  }
  return process.env.ANGEL_JWT || null;
}

async function fetchAngelInterval(token, interval, daysBack) {
  const nowIST = getIST();
  const toDate = nowIST.toISOString().split('T')[0];
  const fromMs = nowIST.getTime() - (daysBack + 6) * 24 * 3600 * 1000;
  const fromDate = new Date(fromMs).toISOString().split('T')[0];

  const doRequest = async (jwt) => {
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
        'Authorization': 'Bearer ' + jwt
      },
      body: JSON.stringify({
        exchange: 'NSE',
        symboltoken: String(token),
        interval,
        fromdate: `${fromDate} 09:15`,
        todate: `${toDate} 15:30`
      })
    });
    if (r.status === 401 || r.status === 403 || r.status === 429) {
      let m = `HTTP ${r.status}`;
      try {
        const j = await r.json();
        if (j && (j.message || j.errorcode)) m += ` [${j.errorcode || '-'}] ${j.message || ''}`.trim();
      } catch {}
      return { authFail: true, msg: m };
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j.status || !Array.isArray(j.data)) {
      if (/invalid token|session expired|token expired|too many requests|rate limit/i.test(j.message || '')) return { authFail: true, msg: j.message };
      throw new Error(j.message || 'no data');
    }
    return { data: j.data };
  };

  let jwt = await getAnyAngelJwt();
  if (!jwt) throw new Error('No Angel JWT');
  let out = await doRequest(jwt);
  
  if (out.authFail) {
    throw new Error(out.msg + ' (Auth fail)');
  }
  return out.data;
}

function groupCandlesByDate(raw, shiftMin = 0) {
  const byDate = {};
  for (const b of raw) {
    let ms;
    if (typeof b[0] === 'number') ms = b[0];
    else ms = new Date(b[0]).getTime();
    if (!Number.isFinite(ms)) continue;

    const istD = new Date(ms + 5.5 * 3600 * 1000 + shiftMin * 60000);
    const date = istD.toISOString().slice(0, 10);
    const hh = istD.getUTCHours();
    const mm = istD.getUTCMinutes();
    const mins = hh * 60 + mm;

    if (mins < 9 * 60 + 15 || mins > 15 * 60 + 30) continue;

    if (!byDate[date]) byDate[date] = { closes: [], ts: [], vols: [], minutes: [] };
    const tsStr = `${date}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00.000+05:30`;
    byDate[date].closes.push(+b[4]);
    byDate[date].ts.push(tsStr);
    byDate[date].vols.push(+b[5] || 0);
    byDate[date].minutes.push(mins);
  }
  return byDate;
}

function fillMissingMinutes(by1m, step = 1, first = 555, last = 929) {
  for (const date in by1m) {
    const src = by1m[date];
    if (!src.minutes || !src.minutes.length) continue;
    const have = new Map();
    for (let i = 0; i < src.minutes.length; i++) have.set(src.minutes[i], i);
    const closes = [], ts = [], vols = [], minutes = [];
    let prevClose = src.closes[0];
    for (let m = first; m <= last; m += step) {
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

async function backfillOneStock(stock, daysBack) {
  const sym = stock.sym;
  const token = String(stock.token);

  const raw5m = await fetchAngelInterval(token, 'FIVE_MINUTE', daysBack);
  const by5m = fillMissingMinutes(groupCandlesByDate(raw5m, 4), 5, 559, 929);

  const dates = Object.keys(by5m).sort().slice(-daysBack);
  let saved = 0;

  for (const date of dates) {
    const d5 = by5m[date];
    if (!d5 || d5.closes.length < 15) continue;

    const rsi = computeRSIWilder(d5.closes);

    await db.query(
      `INSERT INTO strategy_bs_snapshot
         (date, sym, token, strategy_id,
          ws_5min_close, ws_5min_ts, ws_5min_volume,
          rsi, fetched_at)
       VALUES ($1, $2, $3, 'momentum',
               $4::numeric[], $5::timestamptz[], $6::numeric[],
               $7, NOW())
       ON CONFLICT (date, token, strategy_id) DO UPDATE SET
         ws_5min_close  = EXCLUDED.ws_5min_close,
         ws_5min_ts     = EXCLUDED.ws_5min_ts,
         ws_5min_volume = EXCLUDED.ws_5min_volume,
         rsi            = EXCLUDED.rsi,
         fetched_at     = NOW()`,
      [
        date, sym, token,
        d5.closes, d5.ts, d5.vols,
        rsi != null ? +rsi.toFixed(2) : null
      ]
    );
    saved++;
  }
  return { sym, days_saved: saved, dates };
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const isSessionError = e => /401|ab1010|invalid session|session.{0,20}expired|please re-?login/i.test(e?.message || '');
const isRateError = e => /429|ab1021|too many requests|rate limit/i.test(e?.message || '');

async function processHistoricalFetch(body) {
  let lockClient = null;
  try {
    lockClient = await db.connect();
    const lk = await lockClient.query('SELECT pg_try_advisory_lock(7451) AS got');
    if (!lk.rows[0]?.got) {
      lockClient.release();
      lockClient = null;
      historicalRunning = false;
      console.log('📥 Historical: another run already holds the lock — skipping');
      return;
    }
  } catch (e) {
    try { if (lockClient) lockClient.release(); } catch {}
    historicalRunning = false;
    return;
  }

  const days = Math.min(Math.max(+body?.days || HISTORICAL_DAYS_DEFAULT, 1), 15);
  const t0 = Date.now();
  const summary = { ok: 0, failed: 0, skipped: 0, days_saved: 0, total: STOCKS.length };
  const errors = [];

  const DELAY_MS = 1500;
  const retryOnly = body?.all !== true && historicalFailed.size > 0;
  const queue = retryOnly
    ? STOCKS.filter(s => historicalFailed.has(String(s.token)))
    : [...STOCKS];
  if (!retryOnly) historicalFailed.clear();
  queue.sort((a, b) => String(a.sym).localeCompare(String(b.sym)));
  
  historicalProgress = { running: true, total: queue.length, done: 0, current: '' };
  
  console.log(`📥 Historical start: ${queue.length} stocks (${retryOnly ? 'retry-failed only' : 'full run'}) | window=${days} working days | 5-MIN ONLY`);
  let processed = 0;

  try {
    try { 
      await loginREST(); 
      console.log('✅ Fresh login successful before starting bulk fetch'); 
    } catch(e) { 
      console.log('❌ Initial login failed:', e.message); 
    }

    while (queue.length) {
      const stock = queue.shift();
      historicalProgress.current = stock.sym;

      if (!getSessionStatusREST()?.loggedIn) {
        try {
          await loginREST();
          console.log('🔑 Session refreshed mid-run (token had died)');
        } catch (e) { console.error('🔑 Mid-run re-login failed:', e.message); }
      }
      if (processed > 0 && processed % 100 === 0) {
        try {
          await loginREST();
          console.log(`🔑 Scheduled re-login after ${processed} stocks`);
        } catch (e) { console.error('🔑 Scheduled re-login failed:', e.message); }
      }

      try {
        const r = await backfillOneStock(stock, days);
        if (r.days_saved > 0) {
          summary.ok++;
          summary.days_saved += r.days_saved;
        } else {
          summary.skipped++;
        }
        historicalFailed.delete(String(stock.token));
      } catch (e) {
        if (isSessionError(e)) {
          console.error(`🔑 Session error on ${stock.sym}: ${e.message} — forcing shared re-login`);
          try { await forceReloginREST(); } catch (le) { console.error('🔑 Re-login failed:', le.message); }
          try {
            const r2 = await backfillOneStock(stock, days);
            if (r2.days_saved > 0) { summary.ok++; summary.days_saved += r2.days_saved; }
            else summary.skipped++;
            historicalFailed.delete(String(stock.token));
          } catch (e2) {
            console.error(`🛑 Session still dead after re-login (${e2.message}). Stopping historical fetch.`);
            historicalFailed.add(String(stock.token));
            for (const s of queue) historicalFailed.add(String(s.token));
            break;
          }
        }
        else if (isRateError(e) || /403/.test(e?.message || '')) {
          console.warn(`⛔ Rate-limit on ${stock.sym}: ${e.message} — waiting 60s, then 1 retry (2nd & last attempt)`);
          await sleepMs(60000);
          try {
            const r2 = await backfillOneStock(stock, days);
            if (r2.days_saved > 0) { summary.ok++; summary.days_saved += r2.days_saved; }
            else summary.skipped++;
            historicalFailed.delete(String(stock.token));
          } catch (e2) {
            console.error(`🛑 Rate-limit again on ${stock.sym}: ${e2.message} — STOPPING run to protect the API key. Leftover stocks resume next run.`);
            historicalFailed.add(String(stock.token));
            for (const s of queue) historicalFailed.add(String(s.token));
            break;
          }
        }
        else {
          await new Promise(r => setTimeout(r, 5000));
          try {
            const r2 = await backfillOneStock(stock, days);
            if (r2.days_saved > 0) { summary.ok++; summary.days_saved += r2.days_saved; }
            else summary.skipped++;
            historicalFailed.delete(String(stock.token));
          } catch (e2) {
            summary.failed++;
            historicalFailed.add(String(stock.token));
            if (errors.length < 20) errors.push(`${stock.sym}: ${e2.message}`);
          }
        }
      }
      
      processed++;
      historicalProgress.done = processed;

      if (processed % 25 === 0) {
        console.log(`📥 Historical: ${processed}/${STOCKS.length} | ok=${summary.ok} fail=${summary.failed}`);
      }
      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`✅ Historical DONE ${elapsed}s | ok=${summary.ok} skip=${summary.skipped} fail=${summary.failed} days=${summary.days_saved} | retry_pending=${historicalFailed.size}`);

    try {
      await loadPrevWSClosesFromDB();
      await loadTodayWSClosesFromDB();
      const t0 = getIST().toISOString().split('T')[0];
      vwapDate = t0;
      for (const [tk, closes] of wsTodayCloses) {
        const vols = wsTodayVols.get(tk) || [];
        let pv = 0, vv = 0;
        for (let i = 0; i < closes.length; i++) { const v = vols[i] || 0; pv += closes[i] * v; vv += v; }
        if (vv > 0) { vwapPV.set(tk, pv); vwapV.set(tk, vv); lastWsAvg.set(tk, +(pv / vv).toFixed(2)); }
      }
      await backfillRsiFirst(getIST().toISOString().split('T')[0]);
      seedRSIStateFromMemory();
      console.log('🔄 WS caches reloaded after backfill');
    } catch (e) { console.error('Post-backfill reload failed:', e.message); }

  } catch (e) {
    console.error('Historical fetch error:', e);
  } finally {
    historicalRunning = false;
    historicalProgress.running = false;
    try {
      if (lockClient) {
        await lockClient.query('SELECT pg_advisory_unlock(7451)').catch(() => {});
        lockClient.release();
      }
    } catch {}
  }
}

app.post('/api/admin/fetch-historical', auth, adminOnly, async (req, res) => {
  if (historicalRunning) {
    return res.status(409).json({ error: 'Historical fetch already running' });
  }
  historicalRunning = true;
  
  res.json({ ok: true, message: 'Historical fetch started in background. Check server logs for progress.' });

  processHistoricalFetch(req.body).catch(e => {
    console.error('🛑 Historical Background Error:', e.message);
    historicalRunning = false;
  });
});

/* ============================================================
   SECTION 7.3 — VOLUME-ONLY BACKFILL (ONE_DAY, MANUAL ONLY)
   ------------------------------------------------------------
   Writes ONLY strategy_bs_snapshot.volume. Never INSERTs rows.
   Never touches OHLC / arrays / any other column.
   Own advisory lock (7453) — 5-min uses 7451, 15-min uses 7452.
   Refuses to run if 5-min historical OR 15-min fetch is active.
   ============================================================ */
const VOLUME_LOCK_KEY = 7453;
let volumeBackfillRunning = false;
let volumeBackfillProgress = { running: false, done: 0, total: 0, current: '', updated: 0, skipped: 0 };

async function fetchDailyVolumes(token, daysBack) {
  // ONE_DAY → [[ts, o, h, l, c, volume], ...] — one bar per trading day
  const raw = await fetchAngelInterval(token, 'ONE_DAY', daysBack);
  const out = {};
  const today = getIST().toISOString().split('T')[0];
  const nowMins = getIST().getUTCHours() * 60 + getIST().getUTCMinutes();

  for (const b of raw) {
    const ms = typeof b[0] === 'number' ? b[0] : new Date(b[0]).getTime();
    if (!Number.isFinite(ms)) continue;
    const date = new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const vol  = +b[5] || 0;
    if (vol <= 0) continue;
    if (date === today && nowMins < 15 * 60 + 35) continue;
    out[date] = vol;
  }
  return out;
}

async function updateVolumeOnly(stock, byDate) {
  let updated = 0, skipped = 0;
  for (const date of Object.keys(byDate)) {
    try {
      const r = await db.query(
        `UPDATE strategy_bs_snapshot
         SET volume = $1
         WHERE date = $2 AND token = $3 AND strategy_id = 'momentum'`,
        [byDate[date], date, String(stock.token)]
      );
      if (r.rowCount > 0) updated++;
      else skipped++;
    } catch (e) {
      console.warn(`vol update ${stock.sym} ${date}:`, e.message);
    }
  }
  return { updated, skipped };
}

async function processVolumeBackfill(body) {
  let lockClient = null;
  try {
    lockClient = await db.connect();
    const lk = await lockClient.query(`SELECT pg_try_advisory_lock($1) AS got`, [VOLUME_LOCK_KEY]);
    if (!lk.rows[0]?.got) {
      lockClient.release(); lockClient = null;
      volumeBackfillRunning = false;
      console.log('📈 Volume backfill: another run holds the lock — skipping');
      return;
    }
  } catch {
    try { if (lockClient) lockClient.release(); } catch {}
    volumeBackfillRunning = false;
    return;
  }

  const days = Math.min(Math.max(+body?.days || 35, 5), 60);
  const queue = [...STOCKS].sort((a, b) => String(a.sym).localeCompare(String(b.sym)));
  volumeBackfillProgress = { running: true, total: queue.length, done: 0, current: '', updated: 0, skipped: 0 };

  try {
    try { await loginREST(); } catch (e) { console.error('vol backfill init login:', e.message); }

    while (queue.length) {
      const stock = queue.shift();
      volumeBackfillProgress.current = stock.sym;

      if (!getSessionStatusREST()?.loggedIn) {
        try { await loginREST(); } catch {}
      }

      try {
        const byDate = await fetchDailyVolumes(stock.token, days);
        const { updated, skipped } = await updateVolumeOnly(stock, byDate);
        volumeBackfillProgress.updated += updated;
        volumeBackfillProgress.skipped += skipped;
      } catch (e) {
        if (isSessionError(e)) {
          try { await forceReloginREST(); } catch {}
          try {
            const byDate = await fetchDailyVolumes(stock.token, days);
            const { updated, skipped } = await updateVolumeOnly(stock, byDate);
            volumeBackfillProgress.updated += updated;
            volumeBackfillProgress.skipped += skipped;
          } catch {}
        } else if (isRateError(e)) {
          await sleepMs(60000);
          try {
            const byDate = await fetchDailyVolumes(stock.token, days);
            const { updated, skipped } = await updateVolumeOnly(stock, byDate);
            volumeBackfillProgress.updated += updated;
            volumeBackfillProgress.skipped += skipped;
          } catch {}
        }
      }

      volumeBackfillProgress.done++;
      if (volumeBackfillProgress.done % 25 === 0) {
        console.log(`📈 Volume backfill: ${volumeBackfillProgress.done}/${volumeBackfillProgress.total} | updated=${volumeBackfillProgress.updated} skipped=${volumeBackfillProgress.skipped}`);
      }
      await sleepMs(400);
    }

    console.log(`✅ Volume backfill DONE | updated=${volumeBackfillProgress.updated} skipped=${volumeBackfillProgress.skipped}`);
  } catch (e) {
    console.error('Volume backfill error:', e);
  } finally {
    volumeBackfillRunning = false;
    volumeBackfillProgress.running = false;
    volumeBackfillProgress.current = '';
    try {
      if (lockClient) {
        await lockClient.query(`SELECT pg_advisory_unlock($1)`, [VOLUME_LOCK_KEY]).catch(() => {});
        lockClient.release();
      }
    } catch {}
  }
}

app.post('/api/admin/fetch-volume-backfill', auth, adminOnly, async (req, res) => {
  if (volumeBackfillRunning) return res.status(409).json({ error: 'Volume backfill already running' });
  if (historicalRunning) return res.status(409).json({ error: '5-min historical is running — wait for it to finish first' });
  // 15-min fetch shares the same Angel rate bucket — refuse if it's active
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=7452 AND granted`
    );
    if (rows.length) return res.status(409).json({ error: '15-min fetch is running — wait for it to finish first' });
  } catch {}
  volumeBackfillRunning = true;
  res.json({ ok: true, message: 'Volume backfill started' });
  processVolumeBackfill(req.body).catch(e => {
    console.error('🛑 Volume backfill bg error:', e.message);
    volumeBackfillRunning = false;
    volumeBackfillProgress.running = false;
  });
});

app.get('/api/admin/fetch-volume-progress', auth, (req, res) => {
  res.json({ running: volumeBackfillRunning || volumeBackfillProgress.running, ...volumeBackfillProgress });
});

/* ============================================================
   NSE DIRECT OHLCV FETCH (Last 3 Days)
   ============================================================ */
let nseFetchRunning = false;
let nseFetchProgress = { running: false, done: 0, total: 0, current: '', saved: 0 };

async function getNSECookies() {
  const res = await fetch('https://www.nseindia.com/report-detail/eq_security', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    }
  });
  const setCookies = res.headers.getSetCookie();
  return setCookies.map(c => c.split(';')[0]).join('; ');
}

async function fetchNseHistoricalData(sym, fromDate, toDate, cookies) {
  const url = `https://www.nseindia.com/api/historicalOR/generateSecurityWiseHistoricalData?from=${fromDate}&to=${toDate}&symbol=${encodeURIComponent(sym)}&type=priceVolumeDeliverable&series=EQ`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://www.nseindia.com/report-detail/eq_security',
      'Cookie': cookies
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.data || [];
}

async function processNseFetch() {
  if (nseFetchRunning) return;
  nseFetchRunning = true;

  const days = 3;
  const today = getIST();
  
  // Format: DD-MM-YYYY for NSE
  const toDateStr = `${String(today.getUTCDate()).padStart(2, '0')}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${today.getUTCFullYear()}`;
  const fromDateObj = new Date(today.getTime() - (days * 24 * 3600 * 1000));
  const fromDateStr = `${String(fromDateObj.getUTCDate()).padStart(2, '0')}-${String(fromDateObj.getUTCMonth() + 1).padStart(2, '0')}-${fromDateObj.getUTCFullYear()}`;

  const queue = [...STOCKS].sort((a, b) => String(a.sym).localeCompare(String(b.sym)));
  nseFetchProgress = { running: true, total: queue.length, done: 0, current: '', saved: 0 };

  try {
    console.log(`📥 NSE Fetch Start: ${fromDateStr} to ${toDateStr}`);
    let cookies = await getNSECookies();
    const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

        while (queue.length) {
      const stock = queue.shift();
      nseFetchProgress.current = stock.sym;

      try {
        // --- DEBUG: Fetch raw text first to see what NSE returns ---
        const url = `https://www.nseindia.com/api/historicalOR/generateSecurityWiseHistoricalData?from=${fromDateStr}&to=${toDateStr}&symbol=${encodeURIComponent(stock.sym)}&type=priceVolumeDeliverable&series=EQ`;
        const rawRes = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Cookie': cookies
          }
        });
        
        const textData = await rawRes.text();
        
        // Print the first stock's raw response to the console
        if (nseFetchProgress.done === 0) {
          console.log(`\n🔍 [DEBUG NSE RESPONSE for ${stock.sym}]:`, textData.substring(0, 300));
        }

        let json;
        try { json = JSON.parse(textData); } catch (e) { throw new Error('Not JSON (Probably blocked by NSE)'); }
        
        const data = json.data || [];
        let savedRows = 0;

        for (const bar of data) {
          // NSE returns timestamp like "08-Nov-2026"
          const parts = bar.mTIMESTAMP.split('-');
          if (parts.length !== 3) continue;
          const isoDate = `${parts[2]}-${monthMap[parts[1]]}-${parts[0].padStart(2, '0')}`;
          
          const vol = +bar.mTOTTRDQTY || 0;
          if (vol <= 0) continue;

          await db.query(
            `INSERT INTO strategy_bs_snapshot (date, sym, token, strategy_id, day_open, day_high, day_low, day_close, volume)
             VALUES ($1, $2, $3, 'momentum', $4, $5, $6, $7, $8)
             ON CONFLICT (date, token, strategy_id) DO UPDATE SET
             day_open = EXCLUDED.day_open,
             day_high = EXCLUDED.day_high,
             day_low = EXCLUDED.day_low,
             day_close = EXCLUDED.day_close,
             volume = EXCLUDED.volume`,
            [isoDate, stock.sym, String(stock.token), +bar.mOPEN, +bar.mHIGH, +bar.mLOW, +bar.mCLOSE, vol]
          );
          savedRows++;
        }
        nseFetchProgress.saved += savedRows;
      } catch (e) {
        console.warn(`NSE fetch ${stock.sym} failed: ${e.message}`);
        if (e.message.includes('401') || e.message.includes('403')) {
          try { cookies = await getNSECookies(); } catch {}
        }
      }

      nseFetchProgress.done++;
      if (nseFetchProgress.done % 25 === 0) {
        console.log(`📥 NSE Fetch: ${nseFetchProgress.done}/${nseFetchProgress.total} | saved=${nseFetchProgress.saved}`);
      }
      await new Promise(r => setTimeout(r, 1500)); // 1.5s delay to bypass IP block
    }
    console.log(`✅ NSE Fetch DONE | saved=${nseFetchProgress.saved} rows`);
  } catch (e) {
    console.error('NSE Fetch Error:', e);
  } finally {
    nseFetchRunning = false;
    nseFetchProgress.running = false;
  }
}

app.post('/api/admin/fetch-nse-ohlcv', auth, adminOnly, (req, res) => {
  if (nseFetchRunning) return res.status(409).json({ error: 'NSE Fetch already running' });
  nseFetchRunning = true;
  res.json({ ok: true, message: 'NSE Fetch started' });
  processNseFetch().catch(e => {
    console.error('🛑 NSE bg error:', e.message);
    nseFetchRunning = false;
  });
});

app.get('/api/admin/fetch-nse-progress', auth, (req, res) => {
  res.json(nseFetchProgress);
});

/* ============================================================
   SECTION 8 — DAY H/L/C FETCH (AUTO @ 15:31 — KEPT)
   ============================================================ */

async function fetchDayHLC() {
  try {
    const p = getScreenerPhase();
    if (!p.date) { console.log('❌ [HLC] No date'); return; }
    
    const allTokens = [...STOCKS.map(s => String(s.token)), ...INDEX_TOKENS];
    console.log(`🔔 [HLC] Fetching day H/L/C + Volume for ${allTokens.length} stocks & indices...`);

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
      const vol = q.volume || 0;
      const sym = SYM_BY_TOKEN[token] || INDEX_SYMS[token] || '?';

      setCachedLTP(token, close);
      if (q.close && q.close > 0) prevCloseCache.set(token, +q.close);

      try {
        await db.query(
          `INSERT INTO strategy_bs_snapshot AS s 
             (date, token, sym, strategy_id, day_high, day_low, day_close, prev_close, volume, fetched_at)
           VALUES ($1, $2, $3, 'momentum', $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (date, token, strategy_id) DO UPDATE SET
             day_high=EXCLUDED.day_high,
             day_low=EXCLUDED.day_low,
             day_close=EXCLUDED.day_close,
             prev_close=EXCLUDED.prev_close,
             volume=CASE WHEN EXCLUDED.volume > 0 THEN EXCLUDED.volume ELSE s.volume END,
             fetched_at=NOW()`,
          [p.date, token, sym, q.high, q.low, close, q.close, vol]
        );
        savedTokens.add(token);
      } catch (e) { dbErrors.push(`${token}: ${e.message}`); }
    }

    if (dbErrors.length) console.log(`❌ [HLC] DB errors (first 5):`, dbErrors.slice(0, 5));
    broadcastBS(new Date());
    console.log(`✅ Day H/L/C + Volume: ${savedTokens.size}/${allTokens.length} saved in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) { console.error('❌ Day H/L/C fetch failed:', e.message); }
}

/* ============================================================
   SECTION 11 — BS FETCH (AUTO @ 9:15 + 1-min loop — KEPT)
   ============================================================ */
let bsIntervalTimer = null;
let bsRunning = false;
let prevSyncDate = null;
let bsFreshDate = null;

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

        const todayVol = r.volume || 0;
        const histAvg = avgVolume5D.get(String(r.token)) || 0;
        const rvol = histAvg > 0 ? +(todayVol / histAvg).toFixed(1) : 0;

        bsCache.set(String(r.token), {
          buyQty: r.buyQty,
          sellQty: r.sellQty,
          ltp: r.ltp,
          volume: todayVol,
          rvol: rvol,
          dayOpen: r.dayOpen ?? null,
          rank: existing.rank ?? null,
          rsi,
          rsiFirst: existing.rsiFirst ?? null
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
           WHERE s.date=$3 AND s.token=v.token AND s.strategy_id = 'momentum'`,
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
        bsFreshDate = p.date;
      } catch (e) { dbErrors.push(`bulk-bs: ${e.message}`); }
    }

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
      (CHIP_TEST_MODE || (bsCache.get(x.token)?.rsi ?? null) != null) && getCachedLTP(x.token)
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
      if (gapPct >= 3) continue;
      if (!CHIP_TEST_MODE && (rsi == null || rsi < 70)) continue;
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
  } catch (e) { console.error('Chip list build failed:', e.message); }
}


/* ============================================================
   ORB-15 (first 15-min candle 9:15–9:30)
   ============================================================ */
async function computeOrbCandles(date) {
  if (orbDoneDate === date) return;
  if (orbCache.size >= 50) { console.log('🎯 ORB WS fallback skipped — official values already in cache'); return; }
  const toks = [], hs = [], ls = [], szs = [], vols = [];
  for (const s of STOCKS) {
    const tk = String(s.token);
    const H = wsTodayHighs.get(tk) || [];
    const L = wsTodayLows.get(tk) || [];
    const C = wsTodayCloses.get(tk) || [];
    const V = wsTodayVols.get(tk) || [];
    if (C.length < 15 || H.length < 15 || L.length < 15) continue;
    if (H.length !== C.length || L.length !== C.length) {
      console.warn(`🎯 ORB WS skip ${tk}: H/L misaligned (restart?) H=${H.length} L=${L.length} C=${C.length}`);
      continue;
    }
    const h = Math.max(...H.slice(0, 15));
    const l = Math.min(...L.slice(0, 15));
    if (!(l > 0) || !(h > 0)) continue;
    const sz = +(((h - l) / l) * 100).toFixed(2);
    const v = V.slice(0, 15).reduce((a, b) => a + (+b || 0), 0);
    orbCache.set(tk, { high: +h.toFixed(2), low: +l.toFixed(2), size: sz, volume: v });
    toks.push(tk); hs.push(+h.toFixed(2)); ls.push(+l.toFixed(2)); szs.push(sz); vols.push(v);
  }
  if (toks.length) {
    try {
      await db.query(
        `UPDATE strategy_bs_snapshot AS s
         SET orb_high=v.h, orb_low=v.l, orb_size=v.sz, orb_volume=v.vol
         FROM unnest($1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[]) AS v(token, h, l, sz, vol)
         WHERE s.date=$6 AND s.token=v.token AND s.strategy_id='momentum'`,
        [toks, hs, ls, szs, vols, date]
      );
    } catch (e) { console.error('🎯 ORB save failed:', e.message); }
  }
  orbDoneDate = date;
  orbForming.clear();
  const tight = [...orbCache.values()].filter(x => x.size <= 1.5).length;
  console.log(`🎯 ORB-15 candles computed: ${toks.length} stocks | size ≤1.5%: ${tight}`);
}

async function loadOrbFromDB(date) {
  if (!date) return;
  try {
    const { rows } = await db.query(
      `SELECT token, gq_high, gq_low, gq_volume
       FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND gq_high IS NOT NULL AND gq_low IS NOT NULL`,
      [date]
    );
    if (rows.length) {
      orbCache.clear();
      for (const r of rows) {
        const h = +r.gq_high, l = +r.gq_low;
        if (!(h > 0) || !(l > 0)) continue;
        orbCache.set(String(r.token), { high: h, low: l, size: +(((h - l) / l) * 100).toFixed(2), volume: +r.gq_volume || 0 });
      }
      orbDoneDate = date;
      console.log(`🎯 ORB loaded from gq_* (GetQuote official): ${orbCache.size} stocks for ${date}`);
      return;
    }
  } catch (e) { console.error('🎯 gq_* load failed (ALTER pending?):', e.message); }
  try {
    const { rows } = await db.query(
      `SELECT token, orb_high, orb_low, orb_size, orb_volume
       FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND orb_size IS NOT NULL`,
      [date]
    );
    orbCache.clear();
    for (const r of rows) {
      orbCache.set(String(r.token), { high: +r.orb_high, low: +r.orb_low, size: +r.orb_size, volume: +r.orb_volume });
    }
    if (rows.length) orbDoneDate = date;
    if (rows.length) console.log(`🎯 ORB loaded from orb_* (fallback archive): ${rows.length} stocks for ${date}`);
  } catch (e) { console.error('🎯 ORB load failed:', e.message); }
}

/* ============================================================
   ORB-15 OFFICIAL SOURCE (GetQuote @9:30 + historical @9:35 / restart)
   ============================================================ */
const ANGEL_QUOTE_URL = 'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/';
let orbQuoteDoneDate = null;
let orbHistDoneDate = null;
let orbOfficialRunning = false;
const orbSleep = ms => new Promise(r => setTimeout(r, ms));

async function angelQuoteBatch(tokens) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 200) chunks.push(tokens.slice(i, i + 200));
  let jwt = await getAnyAngelJwt();
  if (!jwt) throw new Error('No Angel JWT for quote');
  for (const ch of chunks) {
    const doReq = async j => {
      const r = await fetch(ANGEL_QUOTE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Accept': 'application/json',
          'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1', 'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': process.env.ANGEL_API_KEY, 'Authorization': 'Bearer ' + j
        },
        body: JSON.stringify({ mode: 'FULL', exchangeTokens: { NSE: ch } })
      });
      if (r.status === 401 || r.status === 403) return { authFail: true };
      if (r.status === 429) return { rateFail: true };
      if (!r.ok) throw new Error('quote HTTP ' + r.status);
      const j2 = await r.json();
      if (!j2.status || !Array.isArray(j2.data)) throw new Error(j2.message || 'quote no data');
      return { data: j2.data };
    };
    let res = await doReq(jwt);
    if (res.authFail) { jwt = await getAnyAngelJwt(); if (!jwt) throw new Error('quote re-login failed'); res = await doReq(jwt); }
    if (!res.data) throw new Error('quote batch failed (auth/rate), stopping');
    for (const q of res.data) {
      const tk = String(q.exchangeToken ?? q.exchFeedCode ?? q.symbol ?? '');
      if (!tk) continue;
      const h = +q.high, l = +q.low;
      if (Number.isFinite(h) && Number.isFinite(l) && h > 0 && l > 0)
        out.set(tk, { high: h, low: l, volume: +q.volume || +q.lastTradedQuantity || 0, open: +q.open || 0, close: +q.ltp || 0 });
    }
    await orbSleep(800);
  }
  return out;
}

async function saveOrbToDB(toks, hs, ls, szs, vols, date) {
  if (!toks.length) return;
  try {
    await db.query(
      `UPDATE strategy_bs_snapshot AS s
       SET orb_high=v.h, orb_low=v.l, orb_size=v.sz, orb_volume=v.vol
       FROM unnest($1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[]) AS v(token, h, l, sz, vol)
       WHERE s.date=$6 AND s.token=v.token AND s.strategy_id='momentum'`,
      [toks, hs, ls, szs, vols, date]);
  } catch (e) { console.error('🎯 ORB save failed:', e.message); }
}

async function saveGQToDB(toks, os, hs, ls, cs, vs, date) {
  if (!toks.length) return;
  try {
    await db.query(
      `UPDATE strategy_bs_snapshot AS s
       SET gq_open=v.o, gq_high=v.h, gq_low=v.l, gq_close=v.c, gq_volume=v.vol
       FROM unnest($1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[]) AS v(token, o, h, l, c, vol)
       WHERE s.date=$7 AND s.token=v.token AND s.strategy_id='momentum'`,
      [toks, os, hs, ls, cs, vs, date]);
  } catch (e) { console.error('🎯 gq_* save failed (ALTER pending?):', e.message); }
}

function group15FromCandles(candles, date) {
  const buckets = new Map();
  for (const c of candles || []) {
    let dstr, mins;
    if (typeof c[0] === 'number') {
      const d = new Date(c[0] + 5.5 * 3600 * 1000);
      dstr = d.toISOString().slice(0, 10);
      mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    } else {
      dstr = String(c[0]).slice(0, 10);
      mins = +String(c[0]).slice(11, 13) * 60 + +String(c[0]).slice(14, 16);
    }
    if (dstr !== date || mins < 555 || mins > 930) continue;
    const bStart = 555 + Math.floor((mins - 555) / 15) * 15;
    if (!buckets.has(bStart)) buckets.set(bStart, { o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] || 0 });
    else {
      const b = buckets.get(bStart);
      if (+c[2] > b.h) b.h = +c[2];
      if (+c[3] < b.l) b.l = +c[3];
      b.c = +c[4]; b.v += +c[5] || 0;
    }
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([m, b]) => ({
    ...b, ts: `${date}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00.000+05:30`
  }));
}

async function save15MinToDB(tk, sym, rows15, date) {
  if (!rows15.length) return;
  try {
    await db.query(
      `INSERT INTO strategy_bs_snapshot AS s
         (date, sym, token, strategy_id,
          ws_15min_open, ws_15min_high, ws_15min_low, ws_15min_close, ws_15min_volume, ws_15min_ts, fetched_at)
       VALUES ($1,$2,$3,'momentum',$4::numeric[],$5::numeric[],$6::numeric[],$7::numeric[],$8::numeric[],$9::timestamptz[],NOW())
       ON CONFLICT (date, token, strategy_id) DO UPDATE SET
         ws_15min_open=EXCLUDED.ws_15min_open, ws_15min_high=EXCLUDED.ws_15min_high,
         ws_15min_low=EXCLUDED.ws_15min_low, ws_15min_close=EXCLUDED.ws_15min_close,
         ws_15min_volume=EXCLUDED.ws_15min_volume, ws_15min_ts=EXCLUDED.ws_15min_ts, fetched_at=NOW()`,
      [date, sym, tk, rows15.map(x => x.o), rows15.map(x => x.h), rows15.map(x => x.l),
       rows15.map(x => x.c), rows15.map(x => x.v), rows15.map(x => x.ts)]);
  } catch (e) { console.error('🎯 ws_15min save failed:', e.message); }
}

function pushOrb(entries, date, source, mode) {
  const toks = [], os = [], hs = [], ls = [], szs = [], cs = [], vols = [];
  let changed = 0, cacheSet = 0;
  for (const [tk, v] of entries) {
    const sz = +(((v.high - v.low) / v.low) * 100).toFixed(2);
    const prev = orbCache.get(tk);
    if (!prev || Math.abs(prev.high - v.high) > 0.005 || Math.abs(prev.low - v.low) > 0.005) changed++;
    toks.push(tk); hs.push(+v.high.toFixed(2)); ls.push(+v.low.toFixed(2)); szs.push(sz); vols.push(v.volume || 0);
    os.push(v.open || 0); cs.push(v.close || 0);
    if (mode === 'quote' || !prev) {
      orbCache.set(tk, { high: +v.high.toFixed(2), low: +v.low.toFixed(2), size: sz, volume: v.volume || 0 });
      cacheSet++;
    }
  }
  if (mode === 'quote') saveGQToDB(toks, os, hs, ls, cs, vols, date);
  else saveOrbToDB(toks, hs, ls, szs, vols, date);
  console.log(`🎯 ORB official (${source}/${mode}): ${toks.length} stocks | cache set ${cacheSet} | changed vs prev ${changed} | size ≤1.5%: ${[...orbCache.values()].filter(x => x.size <= 1.5).length}`);
  return toks.length;
}

async function orbFinalizeQuote(date) {
  if (orbOfficialRunning) return false;
  orbOfficialRunning = true;
  try {
    let q;
    try { q = await angelQuoteBatch(STOCKS.map(s => String(s.token))); }
    catch (e) { console.error('🎯 ORB quote attempt 1 failed:', e.message); q = await angelQuoteBatch(STOCKS.map(s => String(s.token))); }
    if (!q || q.size < 50) throw new Error('quote too few: ' + (q ? q.size : 0));
    pushOrb(q, date, 'quote@9:30', 'quote');
    orbQuoteDoneDate = date; orbDoneDate = date;
    return true;
  } catch (e) { console.error('🎯 ORB quote finalize failed twice:', e.message); return false; }
  finally { orbOfficialRunning = false; }
}

function orbWindowFromCandles(candles, date) {
  let h = -1, l = Infinity, v = 0, n = 0;
  for (const c of candles || []) {
    let hm, dstr;
    if (typeof c[0] === 'number') {
      const d = new Date(c[0] + 5.5 * 3600 * 1000);
      dstr = d.toISOString().slice(0, 10);
      hm = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    } else {
      dstr = String(c[0]).slice(0, 10);
      hm = String(c[0]).slice(11, 16);
    }
    if (dstr !== date) continue;
    if (hm < '09:15' || hm > '09:29') continue;
    const ch = +c[2], cl = +c[3], cv = +c[5] || 0;
    if (!(ch > 0) || !(cl > 0)) continue;
    if (ch > h) h = ch;
    if (cl < l) l = cl;
    v += cv; n++;
  }
  if (n < 15 || !(h > 0) || !Number.isFinite(l) || !(l > 0)) return null;
  return { high: h, low: l, volume: v };
}

async function orbRepairHistorical(date, source) {
  if (orbOfficialRunning) return 0;
  orbOfficialRunning = true;
  try {
    const entries = new Map(); let fails = 0;
    const fifteenByToken = new Map();
    const symOf = new Map(STOCKS.map(s => [String(s.token), s.sym]));
    for (const s of STOCKS) {
      const tk = String(s.token);
      try {
        const candles = await fetchAngelInterval(tk, 'ONE_MINUTE', 0);
        const w = orbWindowFromCandles(candles, date);
        if (w) entries.set(tk, w); else fails++;
        const r15 = group15FromCandles(candles, date);
        if (r15.length) fifteenByToken.set(tk, r15);
      } catch (e) { fails++; }
      await orbSleep(340);
    }
    if (entries.size < 50) { console.error(`🎯 ORB historical (${source}): too few (${entries.size}, fails ${fails})`); return 0; }
    pushOrb(entries, date, 'historical@' + source, 'hist');
    for (const [tk, r15] of fifteenByToken) await save15MinToDB(tk, symOf.get(tk), r15, date);
    console.log(`🎯 ws_15min_* updated from historical: ${fifteenByToken.size} stocks`);
    orbHistDoneDate = date; orbDoneDate = date;
    return entries.size;
  } finally { orbOfficialRunning = false; }
}

setInterval(() => {
  const ist = getIST();
  if (!isTradingDay(ist)) return;
  const hh = ist.getUTCHours(), mm = ist.getUTCMinutes(), ss = ist.getUTCSeconds();
  const hhmm = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  const today = ist.toISOString().split('T')[0];
  const mins = hh * 60 + mm;

  if (mins >= 555 && mins <= 569 && ss < 4 && !orbOfficialRunning) {
    angelQuoteBatch(STOCKS.map(s => String(s.token)))
      .then(q => { for (const [tk, v] of q) orbForming.set(tk, { h: v.high, l: v.low }); })
      .catch(e => console.error('🎯 ORB forming poll failed:', e.message));
  }
  if (hhmm === '09:30' && ss >= 5 && ss <= 35 && orbQuoteDoneDate !== today && !orbOfficialRunning) {
    orbFinalizeQuote(today).then(ok => {
      if (!ok) orbRepairHistorical(today, 'fallback-931').catch(() => {});
    }).catch(() => {});
  }
  if (hhmm === '09:35' && ss < 10 && orbHistDoneDate !== today && !orbOfficialRunning) {
    orbRepairHistorical(today, '935').catch(e => console.error('🎯 ORB 9:35 repair failed:', e.message));
  }
}, 2000);

app.get('/api/orb/repair', auth, (req, res) => {
  const date = String(req.query.date || getIST().toISOString().split('T')[0]);
  res.json({ ok: true, started: true, date });
  orbRepairHistorical(date, 'manual')
    .then(n => console.log(`🎯 ORB manual repair done: ${n} stocks for ${date}`))
    .catch(e => console.error('🎯 ORB manual repair failed:', e.message));
});

async function buildAutoUsers() {
  const { rows: dbUsers } = await db.query(`SELECT id, username, side_mode FROM users`);
  const users = [...userCapital.entries()].map(([userId, capital]) => {
    const dbU = dbUsers.find(u => u.id === userId || u.username === userId);
    return { userId, capital, sideMode: dbU?.side_mode || 'MIX' };
  });
  if (!users.length) users.push({ userId: 'admin', capital: Number(process.env.AUTO_PER_TRADE || 25000), sideMode: 'MIX' });
  return users;
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
  setTimeout(async () => {
    await fetchDayHLC();
    scheduleDailyHLC();
  }, ms);
}

function msToNextMinute01() {
  const ist = getIST();
  const s = ist.getUTCSeconds();
  const ms = ist.getUTCMilliseconds();
  return (60 - s) * 1000 - ms + 1000;
}

const bsMinBuy = new Map();
const bsMinSell = new Map();
const buyersInfo = new Map();

async function loadBSMinuteArrays(date) {
  try {
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      `SELECT token, bs_1min_buy, bs_1min_sell FROM strategy_bs_snapshot
       WHERE date=$1 AND strategy_id='momentum' AND bs_1min_buy IS NOT NULL AND token = ANY($2)`,
      [date, activeTokens]
    );
    bsMinBuy.clear(); bsMinSell.clear();
    for (const r of rows) {
      bsMinBuy.set(String(r.token), (r.bs_1min_buy || []).map(x => +x));
      bsMinSell.set(String(r.token), (r.bs_1min_sell || []).map(x => +x));
    }
    if (rows.length) console.log(`⚖️ BS minute arrays loaded: ${rows.length} tokens`);
  } catch (e) { console.error('BS minute arrays load failed:', e.message); }
}

function computeBuyersGroups() {
  buyersInfo.clear();
  for (const [token, buys] of bsMinBuy) {
    const sells = bsMinSell.get(token) || [];
    const n = Math.min(buys.length, sells.length);
    if (n < 1) continue;
    let strongMin = 0;
    let latest = 0;
    for (let i = 0; i < n; i++) {
      const tot = buys[i] + sells[i];
      if (tot <= 0) continue;
      const r = buys[i] / tot;
      if (i === n - 1) latest = r;
      if (r >= 0.55) strongMin++;
    }
    if (latest < 0.55) continue;
    const cont = strongMin >= Math.max(1, Math.ceil(n * 0.6));
    buyersInfo.set(token, { ratio: +latest.toFixed(3), cont, n });
  }
  for (const [token, arr] of depthSec) {
    if (!arr.length) continue;
    const latest = arr[arr.length - 1].r;
    if (latest < 0.55) continue;
    const strong = arr.filter(x => x.r >= 0.55).length;
    const cont = strong >= Math.max(1, Math.ceil(arr.length * 0.6));
    buyersInfo.set(token, { ratio: +latest.toFixed(3), cont, n: arr.length, src: 'depth' });
  }
  return buyersInfo;
}

function broadcastBuyers() {
  if (!sseClients.size) return;
  sseSend(`data: ${JSON.stringify({
    type: 'buyers',
    buyers: Object.fromEntries([...buyersInfo.entries()].map(([t, v]) => [t, v]))
  })}\n\n`);
}

async function appendBSMinuteSnapshot(prevKey, prevTs, date) {
  const tokens = [], buys = [], sells = [], tss = [];
  for (const st of STOCKS) {
    const tk = String(st.token);
    const dc = depthCache.get(tk);
    const fresh = dc && (Date.now() - dc.ts) < 5000;
    const bs = bsCache.get(tk);
    const bq = fresh ? dc.buyQty : bs?.buyQty;
    const sq = fresh ? dc.sellQty : bs?.sellQty;
    if (bq == null || sq == null) continue;
    tokens.push(tk);
    buys.push(bq);
    sells.push(sq);
    tss.push(prevTs);
  }
  if (!tokens.length) return;
  for (let i = 0; i < tokens.length; i++) {
    const ab = bsMinBuy.get(tokens[i]) || []; ab.push(buys[i]); bsMinBuy.set(tokens[i], ab);
    const as_ = bsMinSell.get(tokens[i]) || []; as_.push(sells[i]); bsMinSell.set(tokens[i], as_);
  }
  await db.query(
    `UPDATE strategy_bs_snapshot AS s
     SET bs_1min_buy  = COALESCE(s.bs_1min_buy,  ARRAY[]::numeric[]) || v.b,
         bs_1min_sell = COALESCE(s.bs_1min_sell, ARRAY[]::numeric[]) || v.s,
         bs_1min_ts   = COALESCE(s.bs_1min_ts,   ARRAY[]::timestamptz[]) || v.t
     FROM unnest($1::text[], $2::numeric[], $3::numeric[], $4::timestamptz[]) AS v(token, b, s, t)
     WHERE s.date = $5 AND s.token = v.token AND s.strategy_id = 'momentum'`,
    [tokens, buys, sells, tss, date]
  );
  computeBuyersGroups();
  broadcastBuyers();
  if (prevKey === '09:20') backfillRsiFirst(date).catch(() => {});
  console.log(`⚖️ BS minute snapshot: ${tokens.length} tokens @ ${prevKey} | strong buyers: ${buyersInfo.size}`);
}

function startBSInterval() {
  if (bsIntervalTimer) return;
  const loop = () => {
    bsIntervalTimer = setTimeout(async () => {
      const ist = getIST();
      const secs = ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
      if (!isTradingDay(ist) || secs >= 15 * 3600 + 30 * 60) {
        bsIntervalTimer = null;
        console.log('💹 BS minute loop stopped (EOD)');
        return;
      }
      const d = new Date(ist);
      d.setUTCMinutes(d.getUTCMinutes() - 1);
      d.setUTCSeconds(0, 0);
      const prevKey = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
      const prevTs = d.toISOString().replace('Z', '+05:30');
      const date = ist.toISOString().split('T')[0];
      try { await autoFetchBS({ silent: true }); } catch (e) { console.error('BS minute error:', e.message); }
      try { await appendBSMinuteSnapshot(prevKey, prevTs, date); } catch (e) { console.error('BS snapshot failed:', e.message); }
      loop();
    }, msToNextMinute01());
  };
  loop();
  console.log('💹 BS 1-min loop started (:01 aligned, 30s interval band)');
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

function getVCWatchDate() {
  const ist = getIST();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const today = ist.toISOString().split('T')[0];
  if (mins >= 15 * 60 + 35 && isTradingDay(ist)) return today;
  return getPreviousTradingDay(ist);
}

function scheduleVCWatchReload() {
  const ms = msUntil(15, 35);
  console.log(`⏰ VC watchlist post-close refresh in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => {
    await loadVCWatchlist(getIST().toISOString().split('T')[0], getVCWatchDate());
    scheduleVCWatchReload();
  }, ms);
}

// ⚠️ v5.48: scheduleDailyHistorical REMOVED — 4 PM auto-historical no longer fires.
// Historical 5-min backfill runs ONLY when user clicks "📥 Fetch Historical" button
// (POST /api/admin/fetch-historical). Saves rate limit.

// ============================================================
// AI POST-MARKET ANALYSIS (4:30 PM)
// ============================================================
async function runAIPostMarket() {
  if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY.trim() === '') {
    console.log('🛑 AI Engine: No API key found. Background run rejected.');
    return;
  }
  const queue = [...STOCKS]; 
  let processed = 0;

  for (const stock of queue) {
    const sym = stock.sym;
    const token = String(stock.token);

    try {
      await generateAIPlan(db, token, sym);
    } catch (e) {
      console.error(`❌ AI Engine error for ${sym}:`, e.message);
    }
    
    processed++;
    if (processed % 25 === 0) {
      console.log(`🧠 AI Engine Progress: ${processed}/${queue.length} stocks analyzed.`);
    }
    await new Promise(r => setTimeout(r, 500)); 
  }
  console.log('🧠 AI Engine: Post-Market analysis complete!');
}

function scheduleAIPostMarket() {
  const ms = msUntil(16, 30);
  console.log(`⏰ Next AI Post-Market analysis in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => {
    await runAIPostMarket();
  }, ms);
}

// ============================================================
// AI PRE-MARKET TRIGGER CHECK (9:08 AM)
// ============================================================
async function runAIPreMarketCheck() {
  if (!isTradingDay(getIST())) return;
  console.log('🎯 9:08 AM: Checking AI Triggers against Pre-Open...');

  try {
    const { rows: plans } = await db.query(`SELECT * FROM ai_trade_plans WHERE date = CURRENT_DATE`);
    if (!plans.length) {
      console.log('⚠️ No AI plans found for today.');
      return;
    }

    const tokens = plans.map(p => p.token);
    const quotes = await fetchQuotesForTokens(tokens);
    
    const preOpenMap = {};
    for (const q of quotes) {
      preOpenMap[String(q.token)] = q.ltp;
    }

    for (const plan of plans) {
      const preOpen = preOpenMap[plan.token];
      if (!preOpen) continue;

      if (plan.buy_trigger && preOpen >= plan.buy_trigger) {
        console.log(`🚀 9:08 AM TRIGGER: ${plan.sym} BUY | Pre-Open: ${preOpen} >= Trigger: ${plan.buy_trigger}`);
      } else if (plan.sell_trigger && preOpen <= plan.sell_trigger) {
        console.log(`🚀 9:08 AM TRIGGER: ${plan.sym} SELL | Pre-Open: ${preOpen} <= Trigger: ${plan.sell_trigger}`);
      }
    }
  } catch (e) {
    console.error('Error in 9:08 AM Pre-Open check:', e.message);
  }
}

function scheduleAIPreMarketCheck() {
  const ms = msUntil(9, 8);
  console.log(`⏰ Next AI Pre-Open Check in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => {
    await runAIPreMarketCheck();
    scheduleAIPreMarketCheck();
  }, ms);
}

function scheduleMorningPreload() {
  const ms = msUntil(9, 0);
  console.log(`⏰ Next morning preload in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => {
    bsFreshDate = null;
    bsCache.clear();
    chipList.clear();
    chipDate = null;
    orbCache.clear();
    orbDoneDate = null;
    orbForming.clear();
    console.log('🧹 Morning purge: bsCache + chipList cleared, bsFreshDate reset');

    await loadPrevCloseFromDB();
    await loadPrevClosesFromDB();
    await loadTodayClosesFromDB();
    await loadPrevWSClosesFromDB();
    await loadTodayWSClosesFromDB();
    seedRSIStateFromMemory();
    const today = getIST().toISOString().split('T')[0];
    await recomputeAllRSI(today);
    await loadVCWatchlist(today, getVCWatchDate());
    await rebuildVCState(today);
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
}

registerAdminRoutes(app, {
  db, SECRET,
  auth, adminOnly, log,
  loadHolidaysFromDB
});

registerFifteenRoutes(app, {
  db, auth, adminOnly, STOCKS,
  fetchAngelInterval, isRateError, isSessionError,
  forceRelogin: forceReloginREST, loginREST, getSessionStatusREST,
  getHistoricalRunning: () => historicalRunning
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server on port ${PORT} — v5.48 (manual-only heavy fetches)`);
  initMarginService(db, getBrokerSession);

  try { 
    await loginREST(); 
    console.log('✅ [REST] Logged in via Single Session'); 
  } catch (e) { 
    console.error('⚠️ [REST] login failed:', e.message); 
  }

  await loadHolidaysFromDB();
  await loadPrevCloseFromDB();
  await loadAvgVolumeFromDB(); 
  await loadLastEodVolumeFromDB();
  await loadBSCacheFromDB();
  await loadPrevClosesFromDB();
  await loadTodayClosesFromDB();
  await loadChipListFromDB(getIST().toISOString().split('T')[0]);
  await loadBSMinuteArrays(getIST().toISOString().split('T')[0]);
  await loadOrbFromDB(getScreenerPhase().date);

  {
    const i0 = getIST(); const m0 = i0.getUTCHours() * 60 + i0.getUTCMinutes();
    if (isTradingDay(i0) && m0 >= 571) {
      const d0 = i0.toISOString().split('T')[0];
      setTimeout(() => orbRepairHistorical(d0, 'startup').catch(e => console.error('🎯 ORB startup repair failed:', e.message)), 45000);
    }
  }
  computeBuyersGroups();
  updateMarketBreadth();

  try {
    const quotes = await fetchQuotesForTokens(INDEX_TOKENS);
    if (quotes) {
      for (const q of quotes) {
        if (q.close && q.close > 0) prevCloseCache.set(String(q.token), +q.close);
        if (q.ltp && q.ltp > 0) setCachedLTP(String(q.token), +q.ltp);
      }
      console.log(`📊 Indices LTP & PrevClose fetched via Quote API`);
    }
  } catch(e) { console.log('Indices Quote fetch failed', e.message); }

  initAutoTrader({
    db,
    getJwt: getJwtREST,
    apiKey: process.env.ANGEL_API_KEY,
    clientCode: process.env.ANGEL_CLIENT_ID,
    symByToken: SYM_BY_TOKEN,
    getLtp: getCachedLTP,
    getLeverage: (broker, token) => getLeverage(broker, token),
    perTrade: Number(process.env.AUTO_PER_TRADE || 25000),
    getDayOpen: (t) => bsCache.get(String(t))?.dayOpen ?? null,
    getTodayMinutes: (t) => ({
      c: wsTodayCloses.get(String(t)) || [],
      h: wsTodayHighs.get(String(t)) || [],
      l: wsTodayLows.get(String(t)) || []
    }),
    getUsers: buildAutoUsers,
    onVCChange: () => broadcastVC(),
    sectorByToken: SECTOR_BY_TOKEN,
    getOrb: (t) => orbCache.get(String(t)) || null,
    getRvol: (t) => bsCache.get(String(t))?.rvol ?? null
  });
  await loadOpenPositions(getIST().toISOString().split('T')[0]);
  await loadVCWatchlist(getIST().toISOString().split('T')[0], getVCWatchDate());
  await rebuildVCState(getIST().toISOString().split('T')[0]);
  
  await loadPrevWSClosesFromDB();
  await loadTodayWSClosesFromDB();

  const todayStrForVwap = getIST().toISOString().split('T')[0];
  vwapDate = todayStrForVwap;
  for (const [tk, closes] of wsTodayCloses) {
    const vols = wsTodayVols.get(tk) || [];
    let pv = 0, vv = 0;
    for (let i = 0; i < closes.length; i++) {
      const v = vols[i] || 0;
      pv += closes[i] * v;
      vv += v;
    }
    if (vv > 0) {
      vwapPV.set(tk, pv);
      vwapV.set(tk, vv);
      lastWsAvg.set(tk, +(pv / vv).toFixed(2));
    }
  }
  console.log(`🧮 VWAP seeded from stored minutes: ${vwapPV.size} tokens`);

  seedRSIStateFromMemory();
  await loadCachedMargins('angelone');

  const todayDate = getIST().toISOString().split('T')[0];
  await recomputeAllRSI(todayDate);

  const nowIST = getIST();
  const mins = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
  const secs = nowIST.getUTCHours() * 3600 + nowIST.getUTCMinutes() * 60 + nowIST.getUTCSeconds();
  const dow = nowIST.getUTCDay();

   if (isTradingDay(nowIST) && mins >= 916 && mins <= 940) {
    console.log('🔔 Late startup — fetching day H/L/C');
    fetchDayHLC();
  }
  const bsStart = 9 * 3600 + 15 * 60;
  const bsEnd   = 15 * 3600 + 30 * 60;
  if (isTradingDay(nowIST) && secs >= bsStart && secs < bsEnd) {
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
          bsFreshDate = pB.date;
          console.log('🔔 Late startup — bsFreshDate set from existing rows');
        }
      } catch (e) { console.error('BS catch-up failed:', e.message); }
    }
    console.log('🔔 Late startup — starting BS 30s interval');
    startBSInterval();
  }

  // v5.48: Heavy backfills (historical + volume) are MANUAL-ONLY (no scheduler registered).
  scheduleDailyHLC();
  scheduleBSAutoFetch();
  scheduleFinalFlush();
  scheduleVCWatchReload();
  scheduleMorningPreload();
  scheduleAIPostMarket();
  scheduleAIPreMarketCheck();
  startMarginRefreshLoop();
   
  maybeRefreshMargins('angelone', { force: true }).catch(() => {});

  setInterval(updateMarketBreadth, 5000);

  console.log('ℹ️  Schedule: WS@9:14:55 | BS@9:15 (every min) | ORB quote@9:30 | ORB hist@9:35 | VC@9:16-14:30 | HLC@15:31 | FinalFlush@15:31 | AI@16:30 | Preload@9:00 | Margins@5min');
  console.log('⚠️  MANUAL-ONLY (button driven): 📥 Fetch Historical (5-min) | 📈 Fetch Volume History (ONE_DAY)');
});
