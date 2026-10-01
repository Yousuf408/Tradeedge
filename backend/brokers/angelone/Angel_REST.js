/* ============================================================
   ANGEL_REST.js
   ALL Angel One REST logic in one file
   Auto-login with platform credentials (from .env)
   In-memory caches for candles + LTP
   Other files only call the exported functions
   ============================================================ */

import crypto from 'crypto';

const BASE_URL = 'https://apiconnect.angelone.in';
const API_KEY = process.env.ANGEL_API_KEY;
const CLIENT_ID = process.env.ANGEL_CLIENT_ID;
const PIN = process.env.ANGEL_PIN;
const TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;

/* ---- Session (single platform account) ---- */
const session = { jwtToken: null, feedToken: null, expiresAt: null, loginTime: null };

/* ---- Caches ---- */
const candleCache = new Map();   // `${token}_${date}` → candle
const ltpCache = new Map();      // token → { price, ts }
const LTP_TTL = 10000;           // 10 seconds

/* ============================================================
   BASE32 + TOTP (RFC 6238)
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
   HTTP HELPERS
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

async function post(path, body) {
  const r = await fetch(BASE_URL + path, {
    method: 'POST', headers: buildHeaders(), body: JSON.stringify(body)
  });
  return r.json();
}

/* ============================================================
   LOGIN (auto, platform credentials)
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
  });
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

/* ============================================================
   STATUS
   ============================================================ */
export function getSessionStatus() {
  return {
    loggedIn: !!session.jwtToken && Date.now() < session.expiresAt,
    expiresAt: session.expiresAt,
    loginTime: session.loginTime
  };
}

/* ============================================================
   CANDLES (cached per day)
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
      interval: 'FIFTEEN_MINUTE',
      fromdate: `${date} 09:15`,
      todate: `${date} 09:16`
    });

        // DEBUG — log exact Angel One error response
    if (!r.status || !r.data?.length) {
      console.log(`🔍 FAIL token=${token} status=${r.status} msg="${r.message || r.errorcode || 'unknown'}" data=${JSON.stringify(r.data).slice(0,120)}`);
    }

    if (r.status && r.data?.length) {
      const candle = r.data[0];
      candleCache.set(key, candle);
      return candle;
    }
    return { error: 'No data', raw: r };
  } catch (e) {
    return { error: e.message };
  }
}

export async function getCandlesForTokens(tokens, date) {
  const results = [];
  for (const token of tokens) {
    const candle = await getCandlesForToken(token, date);
    results.push({ token: String(token), candle });
    await new Promise(r => setTimeout(r, 400));  // 3 req/sec rate limit
  }
  return results;
}

/* Return all cached candles for a date instantly (no API calls) */
export function getCachedCandles(tokens, date) {
  return tokens.map(t => ({
    token: String(t),
    candle: candleCache.get(`${t}_${date}`) || null
  }));
}

/* ============================================================
   LTP (batch, 50 tokens per call, 10s cache)
   ============================================================ */
export async function getLTPForTokens(tokens) {
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
    await new Promise(r => setTimeout(r, 300));
  }

  return tokens.map(t => ({
    token: String(t),
    ltp: ltpCache.get(String(t))?.price || null
  }));
}

/* ============================================================
   CACHE CLEAR
   ============================================================ */
export function clearCandleCache() { candleCache.clear(); }
export function clearLtpCache() { ltpCache.clear(); }
