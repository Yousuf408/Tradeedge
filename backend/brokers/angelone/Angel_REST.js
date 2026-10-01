/* ============================================================
   ANGEL_REST.js  —  v2.1
   ALL Angel One REST logic lives here:
   - Login (auto, platform creds)
   - 1-min candle aggregation (9:15-9:30 window)
   - Rate-limited parallel fetch (150/min, 5 workers)
   - LTP batch (50/call, market hours only)
   - Closing price via 15:30 candle (works 24/7)
   - Cache helpers (memory only — server.js persists to DB)
   ============================================================ */

import crypto from 'crypto';

const BASE_URL = 'https://apiconnect.angelone.in';
const API_KEY = process.env.ANGEL_API_KEY;
const CLIENT_ID = process.env.ANGEL_CLIENT_ID;
const PIN = process.env.ANGEL_PIN;
const TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;

const CANDLE_RATE_PER_MIN = Number(process.env.ANGEL_CANDLE_RATE_PER_MIN || 150);
const CANDLE_CONCURRENCY  = Number(process.env.ANGEL_CANDLE_CONCURRENCY  || 5);
const SLOT_INTERVAL_MS    = 60000 / CANDLE_RATE_PER_MIN;
const LTP_TTL = 30000;

const session = { jwtToken: null, feedToken: null, expiresAt: null, loginTime: null };

const candleCache = new Map();
const ltpCache = new Map();
const failedCache = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   RATE-LIMIT COOLDOWN
   ============================================================ */
let cooldownUntil = 0;

function startCooldown(ms, reason) {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
  console.warn(`⛔ Angel cooldown ${Math.round(ms / 1000)}s — ${reason}`);
}

async function waitForCooldown() {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) await sleep(wait);
}

/* ============================================================
   TOKEN-BUCKET SLOT SCHEDULER (150/min global cap)
   ============================================================ */
let nextSlotTime = 0;

async function acquireRateSlot() {
  for (;;) {
    await waitForCooldown();
    const now = Date.now();
    const start = Math.max(now, nextSlotTime);
    nextSlotTime = start + SLOT_INTERVAL_MS;
    if (start > now) await sleep(start - now);
    if (Date.now() >= cooldownUntil) return;
  }
}

/* ============================================================
   BASE32 + TOTP
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
      console.warn(`↻ retry ${attempt}/${retries} for ${path} in ${Math.round(backoff)}ms`);
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
    console.error(`⛔ non-JSON response HTTP ${res.status} from ${path}: "${snippet}"`);

    if (res.status === 403 || res.status === 429 || /access denied/i.test(text)) {
      startCooldown(8000, `rate-limited on ${path}`);
      lastErr = new Error(`Rate limited (HTTP ${res.status}): ${snippet}`);
      continue;
    }

    throw new Error(`HTTP ${res.status}: ${snippet}`);
  }

  throw lastErr || new Error('Request failed after retries');
}

/* ============================================================
   LOGIN (single-flight)
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
      .then(() => { console.log('✅ Angel One session started'); return true; })
      .catch(e => { console.error('❌ Angel login failed:', e.message); return false; })
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

/* ============================================================
   CANDLES — 1-min bars → 9:15-9:30 aggregated
   ============================================================ */
export async function getCandlesForToken(token, date) {
  const key = `${token}_${date}`;
  if (candleCache.has(key)) return candleCache.get(key);

  const ok = await ensureLoggedIn();
  if (!ok) return { error: 'Not logged in' };

  try {
    const r = await post('/rest/secure/angelbroking/historical/v1/getCandleData', {
      exchange: 'NSE',
      symboltoken: String(token),
      interval: 'ONE_MINUTE',
      fromdate: `${date} 09:15`,
      todate: `${date} 09:30`
    });

    if (!r.status || !r.data?.length) {
      const errMsg = r.message || r.errorcode || 'No data';
      failedCache.set(key, { error: errMsg, ts: Date.now() });
      console.log(`🔍 FAIL token=${token} msg="${errMsg}"`);
      return { error: errMsg };
    }

    const bars = r.data;
    const agg = [
      bars[0][0],
      bars[0][1],
      Math.max(...bars.map(x => x[2])),
      Math.min(...bars.map(x => x[3])),
      bars[bars.length - 1][4],
      bars.reduce((s, x) => s + (x[5] || 0), 0)
    ];

    candleCache.set(key, agg);
    failedCache.delete(key);
    return agg;
  } catch (e) {
    failedCache.set(key, { error: e.message, ts: Date.now() });
    console.log(`🔍 THROW token=${token} err="${e.message}"`);
    return { error: e.message };
  }
}

/* ============================================================
   PARALLEL BATCH FETCH (rate-limited, circuit breaker)
   ============================================================ */
export async function getCandlesForTokens(tokens, date) {
  const results = new Map();
  const queue = [];

  for (const token of tokens) {
    const key = `${token}_${date}`;
    if (candleCache.has(key)) results.set(String(token), candleCache.get(key));
    else queue.push(token);
  }

  let consecutiveFails = 0;
  let aborted = false;
  const t0 = Date.now();
  const workerCount = Math.min(CANDLE_CONCURRENCY, Math.max(queue.length, 1));

  async function worker() {
    while (queue.length && !aborted) {
      const token = queue.shift();
      await acquireRateSlot();
      if (aborted) { queue.unshift(token); break; }

      const candle = await getCandlesForToken(token, date);
      results.set(String(token), candle);

      if (Array.isArray(candle)) consecutiveFails = 0;
      else if (++consecutiveFails >= 10) aborted = true;
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));

  if (aborted) {
    startCooldown(30000, 'circuit breaker — Angel blocking');
    console.error(`🛑 Run aborted after 10 consecutive failures. Got ${results.size}/${tokens.length} in ${Math.round((Date.now() - t0) / 1000)}s.`);
  } else {
    console.log(`✅ Batch done: ${results.size}/${tokens.length} tokens in ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  return tokens.map(t => ({
    token: String(t),
    candle: results.get(String(t)) || { error: 'skipped (run aborted)' }
  }));
}

export function getCachedCandles(tokens, date) {
  return tokens.map(t => ({
    token: String(t),
    candle: candleCache.get(`${t}_${date}`) || null
  }));
}

export function getFailedList(date) {
  const out = [];
  for (const [k, v] of failedCache) {
    if (k.endsWith(`_${date}`)) out.push({ token: k.split('_')[0], error: v.error });
  }
  return out;
}

/* ============================================================
   CACHE SETTERS (used by server.js to rehydrate from DB)
   ============================================================ */
export function setCachedCandle(token, date, candle) {
  candleCache.set(`${token}_${date}`, candle);
}

export function setCachedLTP(token, price) {
  ltpCache.set(String(token), { price: +price, ts: Date.now() });
}

/* ============================================================
   LTP (batch, 50/call, market hours only)
   ============================================================ */
function isMarketHoursIST() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 10 && mins <= 15 * 60 + 35;
}

export async function getLTPForTokens(tokens) {
  if (!isMarketHoursIST()) {
    return tokens.map(t => ({
      token: String(t),
      ltp: ltpCache.get(String(t))?.price || null
    }));
  }

  const ok = await ensureLoggedIn();
  if (!ok) return [];

  const now = Date.now();
  const need = tokens.filter(t => {
    const c = ltpCache.get(String(t));
    return !c || (now - c.ts) > LTP_TTL;
  });

  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50).map(String);
    try {
      const r = await post('/rest/secure/angelbroking/market/v1/quote', {
        mode: 'LTP',
        exchangeTokens: { NSE: batch }
      });
      if (r.status && r.data?.fetched) {
        for (const q of r.data.fetched) {
          ltpCache.set(q.symbolToken, { price: q.ltp, ts: now });
        }
      }
    } catch (e) {
      console.error('LTP batch failed:', e.message);
    }
    await sleep(400);
  }

  return tokens.map(t => ({
    token: String(t),
    ltp: ltpCache.get(String(t))?.price || null
  }));
}

/* ============================================================
   CLOSING PRICE via 15:30 candle (works 24/7)
   ============================================================ */
export async function getClosingPriceForToken(token, date) {
  const ok = await ensureLoggedIn();
  if (!ok) return null;

  try {
    const r = await post('/rest/secure/angelbroking/historical/v1/getCandleData', {
      exchange: 'NSE',
      symboltoken: String(token),
      interval: 'ONE_MINUTE',
      fromdate: `${date} 15:29`,
      todate: `${date} 15:30`
    });
    if (!r.status || !r.data?.length) return null;
    return r.data[r.data.length - 1][4];
  } catch { return null; }
}

/* ============================================================
   BULK HELPERS — loops + batching live HERE
   ============================================================ */

/* Fetch closing price for many tokens in batches.
   Returns { ok: [{token, price}], failed: [token] } */
export async function fetchAllClosingPrices(tokens, date, batchSize = 50, delayMs = 20000) {
  const ok = [];
  const failed = [];

  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    const t0 = Date.now();
    await Promise.all(batch.map(async (token) => {
      await acquireRateSlot();
      const price = await getClosingPriceForToken(token, date);
      if (price) ok.push({ token: String(token), price });
      else failed.push(String(token));
    }));
    console.log(`📊 Closing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(tokens.length / batchSize)} — ok:${ok.length} failed:${failed.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
    if (i + batchSize < tokens.length) await sleep(delayMs);
  }

  return { ok, failed };
}

/* Fetch LTP for many tokens in batches of 50 */
export async function fetchAllLTP(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 50) {
    const batch = tokens.slice(i, i + 50);
    const res = await getLTPForTokens(batch);
    out.push(...res);
    if (i + 50 < tokens.length) await sleep(400);
  }
  return out;
}

/* ============================================================
   CACHE CLEAR
   ============================================================ */
export function clearCandleCache() { candleCache.clear(); }
export function clearLtpCache() { ltpCache.clear(); }
