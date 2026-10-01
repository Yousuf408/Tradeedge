/* ============================================================
   ANGEL_REST.js  —  FIXED VERSION (drop-in replacement)
   Uses 1-minute candles aggregated into 9:15-9:30 window
   (Angel One 15-min @ 9:15 API has a known bug — returns empty)

   ------------------------------------------------------------
   WHY IT BROKE:
   Angel One's rate limiter intermittently returns HTTP 403 with
   a PLAIN-TEXT body:  "Access denied because of exceeding access rate"
   (not JSON!). The old code did r.json() on that body, which throws:
   Unexpected token 'A', "Access den"... is not valid JSON
   This is a documented, ongoing Angel-side bug (false positives even
   far below the documented limits) — see SmartAPI forum topics
   5560 / 5639 etc. That's why it "suddenly" broke with no code change.

   FIXES IN THIS FILE:
   #1  post() reads the response as TEXT first, then tries JSON.parse.
       Non-JSON responses no longer crash with a confusing SyntaxError —
       you now see the real HTTP status + body in the logs.
   #2  Automatic retry with exponential backoff + jitter on
       403 / 429 / "Access denied" responses.
   #3  Global cooldown: when rate-limited, ALL Angel calls pause for a
       while instead of burning through the whole token list while the
       limiter is blocking you.
   #4  Circuit breaker in getCandlesForTokens(): aborts the batch after
       3 consecutive failures so you don't spam a blocked API for 500
       tokens. Re-click the Fetch button later — it resumes where it
       left off (only "missing" tokens are fetched).
   #5  Candle pacing configurable via env (default 1500 ms, was 1200).
   #6  LTP: cache TTL raised to 30 s (was 10 s) so the client's 15 s
       poll no longer hits Angel on every tick, and LTP calls are
       skipped entirely outside market hours (9:10–15:35 IST, Mon–Fri).
       Fewer total requests on the same API key = fewer 403s.
   ============================================================ */

import crypto from 'crypto';

const BASE_URL = 'https://apiconnect.angelone.in';
const API_KEY = process.env.ANGEL_API_KEY;
const CLIENT_ID = process.env.ANGEL_CLIENT_ID;
const PIN = process.env.ANGEL_PIN;
const TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;

const CANDLE_DELAY_MS = Number(process.env.ANGEL_CANDLE_DELAY_MS || 1500); // FIX #5
const LTP_TTL = 30000;                                                     // FIX #6 (was 10000)

const session = { jwtToken: null, feedToken: null, expiresAt: null, loginTime: null };

const candleCache = new Map();
const ltpCache = new Map();
const failedCache = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   GLOBAL RATE-LIMIT COOLDOWN  (FIX #3)
   When Angel says "Access denied", pause everything for a bit —
   hammering on during a block just extends it and floods logs.
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
   HTTP  (FIX #1 + #2 + #3)
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

async function post(path, body, { retries = 3, baseBackoff = 2000 } = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = baseBackoff * Math.pow(2, attempt - 1) + Math.random() * 1000; // jitter
      console.warn(`↻ retry ${attempt}/${retries} for ${path} in ${Math.round(backoff)}ms`);
      await sleep(backoff);
    }
    await waitForCooldown();

    let res, text;
    try {
      res = await fetch(BASE_URL + path, {
        method: 'POST', headers: buildHeaders(), body: JSON.stringify(body)
      });
      text = await res.text();               // FIX #1: read as TEXT, never blind r.json()
    } catch (e) {
      lastErr = new Error(`Network error: ${e.message}`);
      continue;                              // network hiccup → retry
    }

    try {
      return JSON.parse(text);               // happy path — valid JSON
    } catch { /* fall through: non-JSON body */ }

    // ---- Non-JSON body = rate limiter / WAF rejection ----
    const snippet = text.slice(0, 120).replace(/\s+/g, ' ');
    console.error(`⛔ non-JSON response HTTP ${res.status} from ${path}: "${snippet}"`);

    if (res.status === 403 || res.status === 429 || /access denied/i.test(text)) {
      startCooldown(20000, `rate-limited on ${path}`);   // FIX #3
      lastErr = new Error(`Rate limited (HTTP ${res.status}): ${snippet}`);
      continue;                                          // FIX #2: retry after cooldown
    }

    // Unexpected non-JSON (HTML error page, proxy error, etc.)
    throw new Error(`HTTP ${res.status}: ${snippet}`);
  }

  throw lastErr || new Error('Request failed after retries');
}

/* ============================================================
   LOGIN  (unchanged logic, now with safe post())
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
  }, { retries: 2, baseBackoff: 3000 });   // login limit is 1 req/s — back off longer

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

async function ensureLoggedIn() {
  if (session.jwtToken && Date.now() < session.expiresAt - 60000) return true;
  try {
    await loginPlatform();
    console.log('✅ Angel One session started');
    return true;
  } catch (e) {
    console.error('❌ Angel login failed:', e.message);
    return false;
  }
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

/* FIX #4 — circuit breaker: stop the batch after 3 consecutive failures
   (almost always means Angel is rate-limiting us right now). The client
   only ever sends "missing" tokens, so re-clicking Fetch resumes fine. */
export async function getCandlesForTokens(tokens, date) {
  const results = [];
  let consecutiveFails = 0;

  for (const token of tokens) {
    if (consecutiveFails >= 3) {
      console.error('🛑 Batch aborted — 3 consecutive failures (Angel rate-limit block?). ' +
                    'Skipped remaining tokens; re-click Fetch in a few minutes to resume.');
      startCooldown(30000, 'circuit breaker after consecutive failures');
      break;
    }

    const candle = await getCandlesForToken(token, date);
    results.push({ token: String(token), candle });

    if (Array.isArray(candle)) consecutiveFails = 0;
    else consecutiveFails++;

    await sleep(CANDLE_DELAY_MS);   // FIX #5: default 1.5s per token (was 1.2s)
  }
  return results;
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
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);   // UTC → IST
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return false;               // weekend
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 10 && mins <= 15 * 60 + 35;     // 09:10 – 15:35 IST
}

export async function getLTPForTokens(tokens) {
  // Outside market hours: serve whatever is cached, make ZERO API calls.
  // (The client polls every 15s around the clock — that was burning your
  //  rate-limit budget on the same API key for nothing.)
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
    return !c || (now - c.ts) > LTP_TTL;   // 30s TTL > 15s client poll → ~half the calls skipped
  });

  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50).map(String);
    try {
      const r = await post('/rest/secure/angelbroking/market/v1/quote', {
        mode: 'LTP',
        exchangeTokens: { NSE: batch }
      }, { retries: 2, baseBackoff: 2000 });
      if (r.status && r.data?.fetched) {
        for (const q of r.data.fetched) {
          ltpCache.set(q.symbolToken, { price: q.ltp, ts: now });
        }
      }
    } catch (e) {
      console.error('LTP batch failed:', e.message);
    }
    await sleep(500);   // was 300ms — gentler on the shared per-key limit
  }

  return tokens.map(t => ({
    token: String(t),
    ltp: ltpCache.get(String(t))?.price || null
  }));
}

export function clearCandleCache() { candleCache.clear(); }
export function clearLtpCache() { ltpCache.clear(); }
