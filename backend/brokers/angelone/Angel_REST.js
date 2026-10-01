/* ============================================================
   ANGEL_REST.js  —  v2 (drop-in replacement, speed-optimized)

   ROOT CAUSE OF THE ORIGINAL ERROR:
   Angel One's rate limiter intermittently returns HTTP 403 with a
   PLAIN-TEXT body: "Access denied because of exceeding access rate"
   (not JSON). Old code did r.json() on it → "Unexpected token 'A'".
   Known ongoing Angel-side bug (SmartAPI forum topics 5560/5639).

   v1 PROBLEM (why it got slow):
   Serial fetch (1 token at a time) + 20s cooldowns + long backoffs
   → a 403 storm turned a 10-min run into a 30+ min crawl.

   v2 FIXES:
   #1  PARALLEL fetch with a global token-bucket scheduler at
       150 req/min (documented cap is 180/min, 3/sec — we stay
       under both, never burst). 500 tokens ≈ 3.5 min instead of 13.
   #2  LIGHT retries: 2 attempts, ~1.2s/2.4s backoff, 8s cooldown
       (was 20-30s). Blocked tokens recover fast instead of stalling.
   #3  RUN-LEVEL circuit breaker: 10 consecutive failures across all
       workers → abort the whole run in ~1 min with a clear log,
       instead of crawling for 30 min. Cached tokens are kept;
       re-clicking Fetch resumes only the missing ones.
   #4  Single-flight login (parallel workers can't trigger multiple
       simultaneous logins — login limit is 1/sec).
   #5  post() reads TEXT first, then parses JSON → real errors in
       logs ("Rate limited HTTP 403: Access denied..."), never the
       cryptic "Unexpected token 'A'" again.
   #6  LTP: 30s cache TTL (client polls every 15s → half the calls
       served from cache) and ZERO API calls outside 9:10-15:35 IST
       weekdays. Less background load on the same API key.

   TUNING (env):
   ANGEL_CANDLE_RATE_PER_MIN=150   (max safe: 170)
   ANGEL_CANDLE_CONCURRENCY=5
   ============================================================ */

import crypto from 'crypto';

const BASE_URL = 'https://apiconnect.angelone.in';
const API_KEY = process.env.ANGEL_API_KEY;
const CLIENT_ID = process.env.ANGEL_CLIENT_ID;
const PIN = process.env.ANGEL_PIN;
const TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;

const CANDLE_RATE_PER_MIN = Number(process.env.ANGEL_CANDLE_RATE_PER_MIN || 150); // FIX #1
const CANDLE_CONCURRENCY  = Number(process.env.ANGEL_CANDLE_CONCURRENCY  || 5);   // FIX #1
const SLOT_INTERVAL_MS    = 60000 / CANDLE_RATE_PER_MIN; // 400ms at 150/min
const LTP_TTL = 30000;                                                              // FIX #6

const session = { jwtToken: null, feedToken: null, expiresAt: null, loginTime: null };

const candleCache = new Map();
const ltpCache = new Map();
const failedCache = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   GLOBAL RATE-LIMIT COOLDOWN  (FIX #2 — 8s, was 20-30s)
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
   TOKEN-BUCKET SLOT SCHEDULER  (FIX #1)
   Spaces ALL candle calls globally at SLOT_INTERVAL_MS apart,
   across every worker and every client batch — never exceeds
   CANDLE_RATE_PER_MIN no matter how much runs in parallel.
   If a cooldown starts while a worker waits for its slot, the
   worker re-reserves a fresh slot AFTER the cooldown → no burst.
   ============================================================ */
let nextSlotTime = 0;

async function acquireRateSlot() {
  for (;;) {
    await waitForCooldown();
    const now = Date.now();
    const start = Math.max(now, nextSlotTime);
    nextSlotTime = start + SLOT_INTERVAL_MS;   // reservation is atomic (single-threaded JS)
    if (start > now) await sleep(start - now);
    if (Date.now() >= cooldownUntil) return;   // clean → proceed
    // otherwise loop: re-reserve after the new cooldown ends
  }
}

/* ============================================================
   BASE32 + TOTP  (unchanged)
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
   HTTP  (FIX #5 — text-first parsing, light retries)
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
      text = await res.text();               // FIX #5: text first, never blind r.json()
    } catch (e) {
      lastErr = new Error(`Network error: ${e.message}`);
      continue;
    }

    try {
      return JSON.parse(text);               // happy path
    } catch { /* non-JSON body → fall through */ }

    const snippet = text.slice(0, 120).replace(/\s+/g, ' ');
    console.error(`⛔ non-JSON response HTTP ${res.status} from ${path}: "${snippet}"`);

    if (res.status === 403 || res.status === 429 || /access denied/i.test(text)) {
      startCooldown(8000, `rate-limited on ${path}`);   // FIX #2: 8s, not 20s
      lastErr = new Error(`Rate limited (HTTP ${res.status}): ${snippet}`);
      continue;
    }

    throw new Error(`HTTP ${res.status}: ${snippet}`);
  }

  throw lastErr || new Error('Request failed after retries');
}

/* ============================================================
   LOGIN  (FIX #4 — single-flight: parallel workers share ONE
   login attempt; login endpoint is limited to 1 req/sec)
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
   CANDLES — 1-minute bars aggregated into 9:15–9:30 window
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

    // Aggregate 1-min bars → single 9:15-9:30 candle
    // bar format: [timestamp, open, high, low, close, volume]
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
   PARALLEL BATCH FETCH  (FIX #1 + #3)
   N workers pull from a shared queue; every call passes through
   the global slot scheduler → total rate stays ≤ 150/min.
   Circuit breaker: 10 consecutive failures → abort run fast.
   500 tokens healthy ≈ 3.5 min (was ~13 min serial).
   ============================================================ */
export async function getCandlesForTokens(tokens, date) {
  const results = new Map();
  const queue = [];

  for (const token of tokens) {
    const key = `${token}_${date}`;
    if (candleCache.has(key)) results.set(String(token), candleCache.get(key)); // instant cache hits
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
      else if (++consecutiveFails >= 10) {
        aborted = true;   // FIX #3: run-level circuit breaker
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));

  if (aborted) {
    startCooldown(30000, 'circuit breaker — Angel is blocking right now');
    console.error(`🛑 Run aborted after 10 consecutive failures (Angel rate-limit storm). ` +
                  `Got ${results.size}/${tokens.length} in ${Math.round((Date.now() - t0) / 1000)}s. ` +
                  `Cached tokens are kept — re-click Fetch in a few minutes to resume the rest.`);
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
   LTP (batch, 50 per call)  — FIX #6
   ============================================================ */
function isMarketHoursIST() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 10 && mins <= 15 * 60 + 35;   // 09:10 – 15:35 IST
}

export async function getLTPForTokens(tokens) {
  // Outside market hours: serve cache, make ZERO API calls.
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

export function clearCandleCache() { candleCache.clear(); }
export function clearLtpCache() { ltpCache.clear(); }
