/* ============================================================
   Angel_Quote.js  —  v1.0  (standalone)
   ============================================================

   FULL QUOTE based candle service — replaces REST historical.

   - Standalone login (own TOTP, own session)
   - FULL quote batch fetch (50 tokens per call)
   - Candle cache (memory) + LTP cache
   - Strategy filter helper (1.5% body, price band)
   - fetchAndCacheQuotes() — fetch + filter + cache in one call

   Exports mirror Angel_REST.js interface for easy server.js swap.
   ============================================================ */

import crypto from 'crypto';

const BASE_URL = 'https://apiconnect.angelone.in';
const API_KEY = process.env.ANGEL_API_KEY;
const CLIENT_ID = process.env.ANGEL_CLIENT_ID;
const PIN = process.env.ANGEL_PIN;
const TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;

const BATCH_SIZE = 50;                                        // tokens per FULL quote call
const BATCH_DELAY_MS = Number(process.env.QUOTE_BATCH_DELAY_MS || 400);
const COOLDOWN_ON_403_MS = Number(process.env.ANGEL_COOLDOWN_403_MS || 3000);

const session = { jwtToken: null, feedToken: null, expiresAt: null, loginTime: null };
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
   TOTP
   ============================================================ */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(str) {
  str = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
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

function generateTOTP(secret) {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(counter, 4);
  const hmac = crypto.createHmac('sha1', key);
  hmac.update(buf);
  const hash = hmac.digest();
  const off = hash[hash.length - 1] & 0x0f;
  const code = ((hash[off] & 0x7f) << 24) |
               ((hash[off + 1] & 0xff) << 16) |
               ((hash[off + 2] & 0xff) << 8) |
               (hash[off + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

/* ============================================================
   HTTP (text-first parsing, retries, cooldown)
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
  if (session.jwtToken) h['Authorization'] = 'Bearer ' + session.jwtToken;
  return h;
}

async function post(path, body, { retries = 2, baseBackoff = 1200 } = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
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
      continue;
    }

    try { return JSON.parse(text); } catch {}

    const snippet = text.slice(0, 120).replace(/\s+/g, ' ');
    console.error(`⛔ [Quote] non-JSON HTTP ${res.status} from ${path}: "${snippet}"`);

    if (res.status === 403 || res.status === 429 || /access denied/i.test(text)) {
      startCooldown(COOLDOWN_ON_403_MS, `rate-limited on ${path}`);
      lastErr = new Error(`Rate limited (HTTP ${res.status}): ${snippet}`);
      continue;
    }

    throw new Error(`HTTP ${res.status}: ${snippet}`);
  }

  throw lastErr || new Error('Request failed after retries');
}

/* ============================================================
   LOGIN (standalone — own session)
   ============================================================ */
export async function loginPlatform() {
  if (!API_KEY || !CLIENT_ID || !PIN || !TOTP_SECRET) {
    throw new Error('Angel credentials missing in .env');
  }
  const totp = generateTOTP(TOTP_SECRET);
  const r = await post('/rest/auth/angelbroking/user/v1/loginByPassword', {
    clientcode: CLIENT_ID,
    password: PIN,
    totp
  }, { retries: 2, baseBackoff: 3000 });

  if (!r.status || !r.data?.jwtToken) {
    throw new Error(r.message || 'Login failed');
  }
  session.jwtToken = r.data.jwtToken;
  session.feedToken = r.data.feedToken;
  session.loginTime = Date.now();
  const midnight = new Date();
  midnight.setHours(23, 59, 59, 999);
  session.expiresAt = midnight.getTime();
  return { ok: true, expiresAt: session.expiresAt };
}

let loginInFlight = null;

function ensureLoggedIn() {
  if (session.jwtToken && Date.now() < session.expiresAt - 60000) return Promise.resolve(true);
  if (!loginInFlight) {
    loginInFlight = loginPlatform()
      .then(() => { console.log('✅ [Quote] session started'); return true; })
      .catch(e => { console.error('❌ [Quote] login failed:', e.message); return false; })
      .finally(() => { loginInFlight = null; });
  }
  return loginInFlight;
}

export function getSessionStatus() {
  return {
    loggedIn: !!session.jwtToken && Date.now() < session.expiresAt,
    expiresAt: session.expiresAt,
    loginTime: session.loginTime
  };
}

export function getFeedToken() { return session.feedToken; }

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
  const ok = await ensureLoggedIn();
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
