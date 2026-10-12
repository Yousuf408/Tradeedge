/* ============================================================
   brokers/margin.js — Multi-Broker Margin Service  |  v1.0
   ============================================================
   Broker-level margin/leverage cache + MAXQTY computation.

   - Cache key = (broker, token) — shared across all users
   - First user of a broker triggers fetch → saved to DB
   - Other users of same broker → reuse cached data
   - Refresh: 9:15 full fetch + 30-min interval

   Adding a new broker (e.g. Dhan, Zerodha):
     → Add one entry in BROKER_CONFIG below
     → Everything else is broker-agnostic

   Angel One API:
     POST /rest/secure/angelbroking/margin/v1/batch
     Batch: 50 positions | Rate: 10 req/sec
     productType: INTRADAY

   Dhan API (future):
     POST /v2/margincalculator/multi
     Batch: 20 | productType: INTRADAY

   Zerodha Kite (future):
     POST /margins/basket
     Batch: 50 | product: MIS
   ============================================================ */

import pg from 'pg';

/* ============================================================
   SECTION 1 — BROKER CONFIG
   Add new brokers here. One object per broker. Nothing else changes.
   ============================================================ */
const BROKER_CONFIG = {

  /* ---- Angel One (SmartAPI) ---- */
  angelone: {
    name: 'Angel One',
    url: 'https://apiconnect.angelbroking.com/rest/secure/angelbroking/margin/v1/batch',
    batchSize: 50,
    rateLimitMs: 120,               // ~8 req/s (safe under 10/s limit)

    buildHeaders: (session) => ({
      'Authorization': `Bearer ${session.jwt}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': session.apiKey
    }),

   buildBody: (positions) => ({
  positions: positions.map(p => ({
    exchange: 'NSE',
    qty: 1,
    price: +p.price,
    productType: 'INTRADAY',
    token: String(p.token),
    tradeType: 'BUY',
    orderType: 'MARKET'
  }))
}),

    /* Angel batch response: { status, data: [{ totalMarginRequired, ... }] } */
    parse: (json, batch) => {
      if (!json.status || !Array.isArray(json.data)) {
        throw new Error(`Angel margin API: ${json.message || 'bad response'}`);
      }
      const out = [];
      for (let i = 0; i < batch.length; i++) {
        const p = batch[i];
        const d = json.data[i] || {};
        const totalMargin = +(d.totalMarginRequired ?? d.totalMargin ?? 0);
        const notional = (+p.price) * 1;
        const leverage = totalMargin > 0 ? notional / totalMargin : null;
        out.push({
          token: String(p.token),
          leverage: leverage ? +leverage.toFixed(4) : null,
          marginPerShare: totalMargin > 0 ? +totalMargin.toFixed(4) : null,
          raw: d
        });
      }
      return out;
    }
  },

  /* ---- Dhan (future — placeholder) ---- */
  dhan: {
    name: 'Dhan',
    url: 'https://api.dhan.co/v2/margincalculator/multi',
    batchSize: 20,
    rateLimitMs: 200,
    buildHeaders: (session) => ({
      'access-token': session.jwt,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }),
    buildBody: (positions) => ({
      dhanClientId: positions[0]?.clientId || '',
      scripList: positions.map(p => ({
        exchangeSegment: 'NSE_EQ',
        transactionType: 'BUY',
        quantity: 1,
        productType: 'INTRADAY',
        securityId: String(p.token),
        price: +p.price
      }))
    }),
    parse: (json, batch) => {
      if (!json || !json.data) throw new Error('Dhan margin API: bad response');
      const arr = Array.isArray(json.data) ? json.data : [json.data];
      const out = [];
      for (let i = 0; i < batch.length; i++) {
        const p = batch[i];
        const d = arr[i] || {};
        const totalMargin = +(d.totalMargin ?? 0);
        const notional = (+p.price) * 1;
        const leverage = totalMargin > 0 ? notional / totalMargin : (d.leverage ? +d.leverage : null);
        out.push({
          token: String(p.token),
          leverage: leverage ? +leverage.toFixed(4) : null,
          marginPerShare: totalMargin > 0 ? +totalMargin.toFixed(4) : null,
          raw: d
        });
      }
      return out;
    }
  }

  /* ---- Zerodha (future — placeholder) ---- */
  // zerodha: {
  //   name: 'Zerodha',
  //   url: 'https://api.kite.trade/margins/basket',
  //   batchSize: 50,
  //   rateLimitMs: 150,
  //   buildHeaders: (session) => ({
  //     'Authorization': `token ${session.apiKey}:${session.jwt}`,
  //     'Content-Type': 'application/json',
  //     'X-Kite-Version': '3'
  //   }),
  //   buildBody: (positions) => positions.map(p => ({
  //     exchange: 'NSE',
  //     tradingsymbol: p.sym,
  //     transaction_type: 'BUY',
  //     quantity: 1,
  //     product: 'MIS',
  //     order_type: 'MARKET',
  //     price: +p.price
  //   })),
  //   parse: (json, batch) => {
  //     // Zerodha returns basket-level margin, not per-position.
  //     // Would need per-token calls or notional split.
  //     throw new Error('Zerodha adapter not yet implemented');
  //   }
  // }
};


/* ============================================================
   SECTION 2 — SERVICE (core, broker-agnostic)
   ============================================================ */
let dbPool = null;
let getSessionFn = null;   // (broker) => { jwt, apiKey, clientId } | null

/* In-memory cache: Map<broker, Map<token, { leverage, marginPerShare, fetchedAt }>> */
const memoryCache = new Map();

/* Track last refresh time per broker */
const lastRefreshAt = new Map();

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;   // 30 min

/**
 * Init margin service.
 * @param {pg.Pool} db
 * @param {Function} getSession — returns session credentials for a broker
 */
export function initMarginService(db, getSession) {
  dbPool = db;
  getSessionFn = getSession;
  console.log('📊 MarginService initialised');
}

/* ---- DB helpers ---- */
async function ensureTable() {
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS broker_margin_cache (
        broker          TEXT NOT NULL,
        token           TEXT NOT NULL,
        sym             TEXT,
        product_type    TEXT DEFAULT 'INTRADAY',
        leverage        NUMERIC(10,4),
        margin_per_share NUMERIC(14,4),
        total_margin    NUMERIC(14,4),
        raw_json        JSONB,
        fetched_at      TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (broker, token)
      )
    `);
  } catch (e) { console.error('margin table create failed:', e.message); }
}

async function loadFromDB(broker) {
  try {
    const { rows } = await dbPool.query(
      `SELECT token, sym, leverage, margin_per_share, total_margin, fetched_at
       FROM broker_margin_cache WHERE broker = $1`,
      [broker]
    );
    if (!memoryCache.has(broker)) memoryCache.set(broker, new Map());
    const m = memoryCache.get(broker);
    for (const r of rows) {
      m.set(String(r.token), {
        leverage: r.leverage != null ? +r.leverage : null,
        marginPerShare: r.margin_per_share != null ? +r.margin_per_share : null,
        totalMargin: r.total_margin != null ? +r.total_margin : null,
        fetchedAt: r.fetched_at
      });
    }
    console.log(`📊 Margin cache loaded: ${broker} → ${rows.length} tokens`);
  } catch (e) { console.error('margin load failed:', e.message); }
}

async function saveToDB(broker, results) {
  if (!results.length) return;
  const tokens = [], syms = [], levs = [], mps = [], tms = [], raws = [];
  for (const r of results) {
    tokens.push(String(r.token));
    syms.push(r.sym || null);
    levs.push(r.leverage);
    mps.push(r.marginPerShare);
    tms.push(r.totalMargin ?? null);
    raws.push(JSON.stringify(r.raw || {}));
  }
  try {
    await dbPool.query(
      `INSERT INTO broker_margin_cache (broker, token, sym, leverage, margin_per_share, total_margin, raw_json, fetched_at)
       SELECT $1, v.token, v.sym, v.lev, v.mps, v.tm, v.raw::jsonb, NOW()
       FROM unnest($2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::text[])
         AS v(token, sym, lev, mps, tm, raw)
       ON CONFLICT (broker, token) DO UPDATE SET
         sym = EXCLUDED.sym,
         leverage = EXCLUDED.leverage,
         margin_per_share = EXCLUDED.margin_per_share,
         total_margin = EXCLUDED.total_margin,
         raw_json = EXCLUDED.raw_json,
         fetched_at = NOW()`,
      [broker, tokens, syms, levs, mps, tms, raws]
    );
  } catch (e) { console.error('margin save failed:', e.message); }
}


/* ============================================================
   SECTION 3 — FETCH (adapter-driven)
   ============================================================ */
async function fetchBrokerMargins(broker, positions) {
  const cfg = BROKER_CONFIG[broker];
  if (!cfg) throw new Error(`Unknown broker: ${broker}`);

  const session = getSessionFn(broker);
  if (!session || !session.jwt) throw new Error(`No session for ${broker}`);

  const headers = cfg.buildHeaders(session);
  const allResults = [];

  for (let i = 0; i < positions.length; i += cfg.batchSize) {
    const batch = positions.slice(i, i + cfg.batchSize);
    const body = cfg.buildBody(batch);

    const res = await fetch(cfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`${broker} margin HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }

    const json = await res.json();
    const parsed = cfg.parse(json, batch);
    allResults.push(...parsed);

    if (i + cfg.batchSize < positions.length) {
      await new Promise(r => setTimeout(r, cfg.rateLimitMs));
    }
  }

  return allResults;
}


/* ============================================================
   SECTION 4 — PUBLIC API
   ============================================================ */

/**
 * Refresh margins for a broker (fetches all tokens).
 * @param {string} broker — e.g. 'angelone'
 * @param {Array}  stocks — [{ token, sym }]
 * @param {Object} ltpMap — { token: price }
 */
export async function refreshMargins(broker, stocks, ltpMap) {
  await ensureTable();

  const positions = stocks
    .map(s => ({
      token: String(s.token),
      sym: s.sym,
      price: ltpMap[String(s.token)] || 0
    }))
    .filter(p => p.price > 0);

  if (!positions.length) {
    console.log(`📊 Margin refresh [${broker}]: no valid prices`);
    return { ok: false, reason: 'no_prices', count: 0 };
  }

  console.log(`📊 Margin refresh [${broker}]: ${positions.length} tokens...`);

  try {
    const results = await fetchBrokerMargins(broker, positions);
    await saveToDB(broker, results);

    if (!memoryCache.has(broker)) memoryCache.set(broker, new Map());
    const m = memoryCache.get(broker);
    for (const r of results) {
      m.set(String(r.token), {
        leverage: r.leverage,
        marginPerShare: r.marginPerShare,
        totalMargin: r.totalMargin,
        fetchedAt: new Date()
      });
    }

    lastRefreshAt.set(broker, Date.now());
    console.log(`📊 Margin refresh [${broker}]: ${results.length} tokens saved`);
    return { ok: true, count: results.length };
  } catch (e) {
    console.error(`📊 Margin refresh [${broker}] failed:`, e.message);
    return { ok: false, reason: e.message, count: 0 };
  }
}

/**
 * Get leverage for a token (from cache).
 * Returns number | null.
 */
export function getLeverage(broker, token) {
  const m = memoryCache.get(broker);
  if (!m) return null;
  const entry = m.get(String(token));
  return entry?.leverage ?? null;
}

/**
 * Get full margin entry for a token.
 */
export function getMarginInfo(broker, token) {
  const m = memoryCache.get(broker);
  if (!m) return null;
  return m.get(String(token)) || null;
}

/**
 * Compute MAXQTY = floor(capital × leverage / LTP)
 * Returns number | null (null if data missing).
 */
export function computeMaxQty(capital, ltp, leverage) {
  if (!capital || capital <= 0) return null;
  if (!ltp || ltp <= 0) return null;
  if (!leverage || leverage <= 0) return null;
  return Math.floor((capital * leverage) / ltp);
}

/**
 * Check if a broker needs refresh (30-min interval).
 */
export function shouldRefresh(broker) {
  const last = lastRefreshAt.get(broker);
  if (!last) return true;
  return (Date.now() - last) > REFRESH_INTERVAL_MS;
}

/**
 * Load cached margins from DB into memory (call at startup).
 */
export async function loadCachedMargins(broker) {
  await ensureTable();
  await loadFromDB(broker);
}

/**
 * Get session status for all configured brokers.
 */
export function getMarginStatus() {
  const out = {};
  for (const [broker, m] of memoryCache.entries()) {
    out[broker] = {
      tokens: m.size,
      lastRefresh: lastRefreshAt.get(broker)
        ? new Date(lastRefreshAt.get(broker)).toISOString()
        : null
    };
  }
  return out;
}
