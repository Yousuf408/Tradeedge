/* ============================================================
   Angel_BS.js  —  v1.0  (standalone)
   Buy/Sell snapshot service via REST FULL quote

   - Fully independent (own login, own TOTP, own session)
   - Fetches FULL quote in 50-token batches
   - Extracts: buyQty (totBuyQuan), sellQty (totSellQuan),
               ltp, volume, ltq, atp
   - No DB writes here — server.js handles persistence

   Exports:
     - loginPlatform()
     - getSessionStatus()
     - fetchBuySellForTokens(tokens) → [{ token, buyQty, sellQty, ... }]
   ============================================================ */

import crypto from 'crypto';

const BASE_URL = 'https://apiconnect.angelone.in';
const API_KEY = process.env.ANGEL_API_KEY;
const CLIENT_ID = process.env.ANGEL_CLIENT_ID;
const PIN = process.env.ANGEL_PIN;
const TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = Number(process.env.BS_BATCH_DELAY_MS || 400);
const COOLDOWN_ON_403_MS = Number(process.env.ANGEL_COOLDOWN_403_MS || 3000);

const session = { jwtToken: null, feedToken: null, expiresAt: null, loginTime: null };

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
   HTTP
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
      continue;
    }

    try { return JSON.parse(text); } catch {}

    const snippet = text.slice(0, 120).replace(/\s+/g, ' ');
    console.error(`⛔ [BS] non-JSON HTTP ${res.status} from ${path}: "${snippet}"`);

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
   LOGIN (standalone)
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
      .then(() => { console.log('✅ [BS] session started'); return true; })
      .catch(e => { console.error('❌ [BS] login failed:', e.message); return false; })
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
   FETCH BUY/SELL SNAPSHOT
   ============================================================ */
export async function fetchBuySellForTokens(tokens) {
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
          const token = String(q.symbolToken);

          const buyQty  = Number.isFinite(+q.totBuyQuan)  ? +q.totBuyQuan  : null;
          const sellQty = Number.isFinite(+q.totSellQuan) ? +q.totSellQuan : null;
          const ltp     = Number.isFinite(+q.ltp)         ? +q.ltp         : null;
          const volume  = Number.isFinite(+q.tradeVolume) ? +q.tradeVolume : null;
          const ltq     = Number.isFinite(+q.lastTradeQty) ? +q.lastTradeQty : null;
          const atp     = Number.isFinite(+q.avgPrice)    ? +q.avgPrice    : null;

          /* Skip if BOTH buy and sell missing (Angel sometimes omits) */
          if (buyQty === null && sellQty === null) continue;

          out.push({ token, buyQty, sellQty, ltp, volume, ltq, atp });
        }
      }
    } catch (e) {
      console.error('[BS] batch failed:', e.message);
    }

    if (i + BATCH_SIZE < tokens.length) await sleep(BATCH_DELAY_MS);
  }

  return out;
}
