/* ============================================================
   Angel_BS.js  —  v1.4  (SHARED SESSION — no private login)
   Buy/Sell snapshot service via REST FULL quote

   v1.4 CHANGE (2026-10-27) — WHY:
   Angel One allows only ONE live session per client code. This module's
   private 9:15 login was killing whichever session existed before it
   (and the historical-candle REST token died at startup even earlier,
   killed by Quote's login). Login/TOTP/session are now REMOVED from here —
   the single session lives in Angel_REST.js and is borrowed from there.

   - Fetches FULL quote in 50-token batches
   - Extracts: buyQty, sellQty, ltp, volume, ltq, atp,
               dayOpen, dayHigh, dayLow, prevClose
   - No DB writes here — server.js handles persistence

   Exports (same names/signatures as v1.3 → server.js unchanged):
     - loginPlatform()   → delegates to shared session
     - getSessionStatus()→ shared session status
     - getJwt()          → shared jwt
     - fetchBuySellForTokens(tokens)

   CHANGELOG v1.3 (2026-10-13):
   - Added dayHigh, dayLow, prevClose (from Angel q.high/q.low/q.close)
   ============================================================ */

import {
  ensureLoggedIn as ensureSharedSession,
  getSessionStatus as getSharedSessionStatus,
  getJwt as getSharedJwt,
  forceRelogin as forceSharedRelogin
} from './Angel_REST.js';

const BASE_URL = 'https://apiconnect.angelone.in';
const API_KEY = process.env.ANGEL_API_KEY;

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = Number(process.env.BS_BATCH_DELAY_MS || 400);
const COOLDOWN_ON_403_MS = Number(process.env.ANGEL_COOLDOWN_403_MS || 3000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   COOLDOWN
   ============================================================ */
let cooldownUntil = 0;

function startCooldown(ms, reason) {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
  console.warn(`⛔ [BS] cooldown ${Math.round(ms / 1000)}s — ${reason}`);
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
      console.warn(`↻ [BS] retry ${attempt}/${retries} for ${path} in ${Math.round(backoff)}ms`);
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
        console.warn(`🔑 [BS] session dead (${json.errorcode || json.message}) — shared re-login, retry ${path}`);
        await forceSharedRelogin();
        continue;
      }
      return json;
    }

    const snippet = text.slice(0, 120).replace(/\s+/g, ' ');
    console.error(`⛔ [BS] non-JSON HTTP ${res.status} from ${path}: "${snippet}"`);

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
   ============================================================ */
export async function loginPlatform() { return ensureSharedSession(); }
export function getSessionStatus() { return getSharedSessionStatus(); }
export function getJwt() { return getSharedJwt(); }

/* ============================================================
   FETCH BUY/SELL SNAPSHOT
   ============================================================ */
export async function fetchBuySellForTokens(tokens) {
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
          const token = String(q.symbolToken);

          const buyQty  = Number.isFinite(+q.totBuyQuan)   ? +q.totBuyQuan   : null;
          const sellQty = Number.isFinite(+q.totSellQuan)  ? +q.totSellQuan  : null;
          const ltp     = Number.isFinite(+q.ltp)          ? +q.ltp          : null;
          const volume  = Number.isFinite(+q.tradeVolume)  ? +q.tradeVolume  : null;
          const ltq     = Number.isFinite(+q.lastTradeQty) ? +q.lastTradeQty : null;
          const atp     = Number.isFinite(+q.avgPrice)     ? +q.avgPrice     : null;
          const dayOpen = Number.isFinite(+q.open)         ? +q.open         : null;
          /* v1.3 additions */
          const dayHigh   = Number.isFinite(+q.high)  ? +q.high  : null;
          const dayLow    = Number.isFinite(+q.low)   ? +q.low   : null;
          const prevClose = Number.isFinite(+q.close) ? +q.close : null;

          if (buyQty === null && sellQty === null) continue;

          out.push({
            token, buyQty, sellQty, ltp, volume, ltq, atp, dayOpen,
            dayHigh, dayLow, prevClose
          });
        }
      }
    } catch (e) {
      console.error('[BS] batch failed:', e.message);
    }

    if (i + BATCH_SIZE < tokens.length) await sleep(BATCH_DELAY_MS);
  }

  return out;
}
