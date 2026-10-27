/* ============================================================
   Angel_Quote.js  —  v1.1  (SHARED SESSION — no private login)
   ============================================================

   FULL QUOTE based candle service — replaces REST historical.

   v1.1 CHANGE (2026-10-27) — WHY:
   Angel One allows only ONE live session per client code. This module's
   private login was killing the REST session (used by historical candles)
   every time it logged in. Login/TOTP/session are now REMOVED from here —
   the single session lives in Angel_REST.js and is borrowed from there.

   - No private login anymore (borrows Angel_REST session)
   - FULL quote batch fetch (50 tokens per call)
   - Candle cache (memory) + LTP cache
   - Strategy filter helper (1.5% body, price band)
   - fetchAndCacheQuotes() — fetch + filter + cache in one call

   Exports keep the SAME names & signatures as v1.0 → server.js unchanged.
   ============================================================ */

import {
  ensureLoggedIn as ensureSharedSession,
  getSessionStatus as getSharedSessionStatus,
  getJwt as getSharedJwt,
  getFeedToken as getSharedFeedToken,
  forceRelogin as forceSharedRelogin
} from './Angel_REST.js';

const BASE_URL = 'https://apiconnect.angelone.in';
const API_KEY = process.env.ANGEL_API_KEY;

const BATCH_SIZE = 50;                                        // tokens per FULL quote call
const BATCH_DELAY_MS = Number(process.env.QUOTE_BATCH_DELAY_MS || 400);
const COOLDOWN_ON_403_MS = Number(process.env.ANGEL_COOLDOWN_403_MS || 3000);

const candleCache = new Map();
const ltpCache = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   COOLDOWN
   ============================================================ */
let cooldownUntil = 0;

function startCooldown(ms, reason) {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
  console.warn(`⛔ [Quote] cooldown ${Math.round(ms / 1000)}s — ${reason}`);
}

async function waitForCooldown() {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) await sleep(wait);
}

/* ============================================================
   HTTP (shared token, auto re-login on dead session)
   ============================================================ */
function buildHeaders() {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': API_KEY
  };
  const jwt = getSharedJwt();
  if (jwt) h['Authorization'] = 'Bearer ' + jwt;
  return h;
}

async function post(path, body, { retries = 2, baseBackoff = 1200 } = {}) {
  let lastErr = null;
  let attempt = 0;
  let relogins = 0;

  while (attempt <= retries) {
    if (attempt > 0) {
      const backoff = baseBackoff * Math.pow(2, attempt - 1) + Math.random() * 500;
      console.warn(`↻ [Quote] retry ${attempt}/${retries} for ${path} in ${Math.round(backoff)}ms`);
      await sleep(backoff);
    }
    await waitForCooldown();

    let res, text;
    try {
      res = await fetch(BASE_URL + path, {
        method: 'POST', headers: buildHeaders(), body: JSON.stringify(body)
      });
      text = await res.text();
    } catch (e) {
      lastErr = new Error(`Network error: ${e.message}`);
      attempt++;
      continue;
    }

    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (json) {
      const why = `${json.errorcode || ''} ${json.message || ''}`;
      if (json.status === false &&
          /AB1010|invalid session|session.{0,20}expired|please re-?login/i.test(why) &&
          relogins < 2) {
        relogins++;
        console.warn(`🔑 [Quote] session dead (${json.errorcode || json.message}) — shared re-login, retry ${path}`);
        await forceSharedRelogin();
        continue;
      }
      return json;
    }

    const snippet = text.slice(0, 120).replace(/\s+/g, ' ');
    console.error(`⛔ [Quote] non-JSON HTTP ${res.status} from ${path}: "${snippet}"`);

    if (res.status === 403 || res.status === 429 || /access denied/i.test(text)) {
      startCooldown(COOLDOWN_ON_403_MS, `rate-limited on ${path}`);
      lastErr = new Error(`Rate limited (HTTP ${res.status}): ${snippet}`);
      attempt++;
      continue;
    }

    throw new Error(`HTTP ${res.status}: ${snippet}`);
  }

  throw lastErr || new Error('Request failed after retries');
}

/* ============================================================
   SESSION — delegated to the single shared session (Angel_REST)
   (names kept so server.js imports keep working)
   ============================================================ */
export async function loginPlatform() { return ensureSharedSession(); }
export function getSessionStatus() { return getSharedSessionStatus(); }
export function getFeedToken() { return getSharedFeedToken(); }
export function getJwt() { return getSharedJwt(); }

/* ============================================================
   CACHE — candles + LTP
   ============================================================ */
export function setCachedCandle(token, date, candle) {
  candleCache.set(`${token}_${date}`, candle);
}

export function getCachedCandles(tokens, date) {
  return tokens.map(t => ({
    token: String(t),
    candle: candleCache.get(`${t}_${date}`) || null
  }));
}

export function setCachedLTP(token, price) {
  ltpCache.set(String(token), { price: +price, ts: Date.now() });
}

export function getCachedLTP(token) {
  return ltpCache.get(String(token))?.price || null;
}

export function clearCandleCache() { candleCache.clear(); }
export function clearLtpCache() { ltpCache.clear(); }

/* ============================================================
   QUOTE FETCH — pure fetch, returns raw OHLC+LTP array
   ============================================================ */
export async function fetchQuotesForTokens(tokens) {
  const ok = await ensureSharedSession();
  if (!ok) return [];

  const out = [];

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE).map(String);
    await waitForCooldown();

    try {
      const r = await post('/rest/secure/angelbroking/market/v1/quote', {
        mode: 'FULL',
        exchangeTokens: { NSE: batch }
      });
      if (r.status && r.data?.fetched) {
        for (const q of r.data.fetched) {
          const open  = +q.open;
          const high  = +q.high;
          const low   = +q.low;
          const close = +q.close;   // previous day close
          const ltp   = +q.ltp;

          if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
          if (high <= 0 || low <= 0) continue;

          out.push({
            token: String(q.symbolToken),
            open, high, low, close, ltp
          });
        }
      }
    } catch (e) {
      console.error('[Quote] batch failed:', e.message);
    }

    if (i + BATCH_SIZE < tokens.length) await sleep(BATCH_DELAY_MS);
  }

  return out;
}

/* ============================================================
   STRATEGY FILTER
   ============================================================ */
export function passesQuoteFilter(q, filters) {
  if (!q) return false;
  if (q.high <= 0 || q.low <= 0 || q.low >= q.high) return false;
  const rangePct = ((q.high - q.low) / q.low) * 100;
  if (rangePct > filters.maxRangePct) return false;
  if (q.ltp < filters.minPrice || q.ltp > filters.maxPrice) return false;
  return true;
}

/* ============================================================
   FETCH + CACHE + FILTER (all-in-one)
   Populates candle cache for every stock, marks which pass filter.
   ============================================================ */
export async function fetchAndCacheQuotes(tokens, date, filters) {
  const quotes = await fetchQuotesForTokens(tokens);
  const results = [];

  for (const q of quotes) {
    const passes = filters ? passesQuoteFilter(q, filters) : true;

    /* Populate candle cache: [0, open, high, low, close, volume=0] */
    setCachedCandle(q.token, date, [
      0,
      q.open || q.low,
      q.high,
      q.low,
      q.ltp || q.high,
      0
    ]);

    if (q.ltp) setCachedLTP(q.token, q.ltp);

    results.push({ ...q, passes });
  }

  return results;
}
