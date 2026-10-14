/* ============================================================
   DEAD_CODE_advance_orb.js — ARCHIVE (read-only reference)
   Advance ORB strategy ka poora code yahan safe hai.
   server.js (v5.4) aur screener.js (v4.4) se hataya gaya.
   Revive karna ho: block copy karke wapas apni jagah lagao —
   har block ke comment me USE + original location likhi hai.
   Ye file kahin se import NAHI hoti — sirf documentation.
   ============================================================ */

/* ############################################################
   PART A — SERVER.JS (backend) CODE
   ############################################################ */

/* ---------- A1. STRATEGIES.advance_orb entry ----------
   USE: Advance ORB strategy config (filters: maxRangePct 1.5 / minPrice 150 / maxPrice 3500). /api/strategies + getStrategy() me list hoti thi. Revive: STRATEGIES object me wapas add karo.
   ---------- */
  advance_orb: {
    id: 'advance_orb',
    name: 'Advance ORB',
    filters: { maxRangePct: 1.5, minPrice: 150, maxPrice: 3500 }
  }

/* ---------- A1b. ENTRY_CUTOFF_MINS constant ----------
   USE: ORB entry ka last allowed minute (885 = 14:45 IST). handleTick ORB block me check hota tha.
   ---------- */
const ENTRY_CUTOFF_MINS = Number(process.env.ENTRY_CUTOFF_MINS || 885);

/* ---------- A2. ORB STATE (orbState + loadOrbStateFromDB + getOrbState) ----------
   USE: In-memory ORB state per token_date (lowBroken/pullback/entry/target/SL + first-* fields). angel_15m_candle ORB columns se load hota tha. handleTick, /ltp, fetch-batch use karte the.
   ---------- */
/* ============================================================
   SECTION 4 — ORB STATE
   ============================================================ */
const orbState = new Map();

async function loadOrbStateFromDB(date) {
  try {
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      `SELECT token, low_broken, first_low_break_at, first_low_break_price,
              pullback_confirmed, first_pullback_at, first_pullback_price,
              entry_signal, first_entry_at, first_entry_price,
              target_hit, target_hit_at, sl_hit, sl_hit_at
       FROM angel_15m_candle WHERE date=$1 AND token = ANY($2)`,
      [date, activeTokens]
    );
    for (const r of rows) {
      orbState.set(`${r.token}_${date}`, {
        lowBroken: !!r.low_broken,
        pullbackConfirmed: !!r.pullback_confirmed,
        entrySignal: !!r.entry_signal,
        firstLowBreakAt: r.first_low_break_at,
        firstPullbackAt: r.first_pullback_at,
        firstEntryAt: r.first_entry_at,
        firstLowBreakPrice: r.first_low_break_price != null ? +r.first_low_break_price : null,
        firstPullbackPrice: r.first_pullback_price != null ? +r.first_pullback_price : null,
        firstEntryPrice: r.first_entry_price != null ? +r.first_entry_price : null,
        targetHit: !!r.target_hit,
        targetHitAt: r.target_hit_at,
        slHit: !!r.sl_hit,
        slHitAt: r.sl_hit_at
      });
    }
    console.log(`🎯 Loaded ORB for ${rows.length} stocks`);
  } catch (e) { console.error('ORB load failed:', e.message); }
}

const getOrbState = (token, date) => orbState.get(`${token}_${date}`) || {
  lowBroken: false, pullbackConfirmed: false, entrySignal: false,
  firstLowBreakAt: null, firstPullbackAt: null, firstEntryAt: null,
  firstLowBreakPrice: null, firstPullbackPrice: null, firstEntryPrice: null,
  targetHit: false, targetHitAt: null, slHit: false, slHitAt: null
};

/* ---------- A3. loadScreenerCacheFromDB me ORB load call ----------
   USE: Startup pe din ka ORB state DB se load hota tha.
   ---------- */
    await loadOrbStateFromDB(p.date);

/* ---------- A4. QUOTE H/L CACHE (quoteCache + loadQuoteCacheFromDB) ----------
   USE: 9:15 ORB range (q15_high/q15_low) cache. ORB breakout levels isi se aate the; frontend ORB 'Quote H/L' column dikhata tha.
   ---------- */
/* ============================================================
   SECTION 4.2 — QUOTE H/L CACHE
   ============================================================ */
const quoteCache = new Map();

async function loadQuoteCacheFromDB() {
  try {
    const p = getScreenerPhase();
    if (!p.date) return;
    const activeTokens = STOCKS.map(s => String(s.token));
    const { rows } = await db.query(
      `SELECT token, q15_high, q15_low, quote_fetched_at
       FROM angel_15m_candle
       WHERE date=$1 AND token = ANY($2) AND q15_high IS NOT NULL`,
      [p.date, activeTokens]
    );
    for (const r of rows) {
      quoteCache.set(String(r.token), {
        high: +r.q15_high,
        low: +r.q15_low,
        fetchedAt: r.quote_fetched_at
      });
    }
    console.log(`📊 Loaded quote H/L for ${rows.length} tokens`);
  } catch (e) { console.error('quoteCache load failed:', e.message); }
}


/* ---------- A5. PIVOT CACHE (pivotCache + loadLatestPivotFromDB) ----------
   USE: Prev-day pivot (H+L+C)/3 cache. ORB 'Pivot + Entry' filter + purana Pivot column use karta tha.
   ---------- */
/* ============================================================
   SECTION 4.3 — PIVOT CACHE
   ============================================================ */
const pivotCache = new Map();

async function loadLatestPivotFromDB() {
  try {
    const activeTokens = STOCKS.map(s => String(s.token));
    const today = getIST().toISOString().split('T')[0];
    const { rows } = await db.query(
      `SELECT DISTINCT ON (token) token, pivot
       FROM angel_15m_candle
       WHERE pivot IS NOT NULL
         AND token = ANY($1)
         AND date < $2
       ORDER BY token, date DESC`,
      [activeTokens, today]
    );
    for (const r of rows) pivotCache.set(String(r.token), +r.pivot);
    console.log(`📐 Loaded pivot for ${rows.length} tokens`);
  } catch (e) { console.error('pivot load failed:', e.message); }
}


/* ---------- A6a. broadcastORB() ----------
   USE: SSE 'orb' event — ORB state changes frontend ko real-time bhejna.
   ---------- */
function broadcastORB(token, state) {
  if (!sseClients.size) return;
  sseSend(`data: ${JSON.stringify({
    type: 'orb', token,
    state: {
      lowBroken: state.lowBroken, pullbackConfirmed: state.pullbackConfirmed, entrySignal: state.entrySignal,
      firstLowBreakAt: state.firstLowBreakAt, firstPullbackAt: state.firstPullbackAt, firstEntryAt: state.firstEntryAt,
      firstLowBreakPrice: state.firstLowBreakPrice, firstPullbackPrice: state.firstPullbackPrice, firstEntryPrice: state.firstEntryPrice,
      targetHit: state.targetHit, targetHitAt: state.targetHitAt, slHit: state.slHit, slHitAt: state.slHitAt
    }

/* ---------- A6b. broadcastQuote() ----------
   USE: SSE 'quote' event — GetQuote H/L fetch ke baad poora quoteCache bhejna.
   ---------- */
function broadcastQuote(fetchedAt) {
  if (!sseClients.size) return;
  sseSend(`data: ${JSON.stringify({
    type: 'quote', fetchedAt,
    quotes: Object.fromEntries([...quoteCache.entries()].map(([t, v]) => [t, { high: v.high, low: v.low, fetchedAt: v.fetchedAt }]))
  })}\n\n`);
}

/* ---------- A7. handleTick ORB signal engine ----------
   USE: Tick-by-tick ORB: ltp<low → lowBroken; pullback; ltp>high → entry (cutoff se pehle); target=high*1.01 / sl=low. DB flags + SSE orb. WS momentum lines (setCachedLTP/broadcastLTP/lastLtpAt/onTickPos/live-RSI/queueLtpWrite) RETAINED.
   ---------- */
  const p = getScreenerPhase();
  if (p.phase !== 'ready' || !p.date) return;

  const candleArr = getCachedCandles([token], p.date)[0]?.candle;
  if (!Array.isArray(candleArr) || candleArr.length < 5) return;

  const low = +candleArr[3];
  const high = +candleArr[2];
  const key = `${token}_${p.date}`;
  const state = getOrbState(token, p.date);
  let changed = false;

  if (!state.lowBroken && ltp < low) {
    state.lowBroken = true;
    state.firstLowBreakAt = new Date().toISOString();
    state.firstLowBreakPrice = ltp;
    db.query(
      `UPDATE angel_15m_candle SET low_broken=true, first_low_break_at=NOW(), first_low_break_price=$3
       WHERE date=$1 AND token=$2 AND low_broken=false`,
      [p.date, token, ltp]
    ).catch(() => {});
    changed = true;
  }

  if (state.lowBroken && !state.pullbackConfirmed && ltp > low && ltp < high) {
    state.pullbackConfirmed = true;
    state.firstPullbackAt = new Date().toISOString();
    state.firstPullbackPrice = ltp;
    db.query(
      `UPDATE angel_15m_candle SET pullback_confirmed=true, first_pullback_at=NOW(), first_pullback_price=$3
       WHERE date=$1 AND token=$2 AND pullback_confirmed=false`,
      [p.date, token, ltp]
    ).catch(() => {});
    changed = true;
  }

  if (state.pullbackConfirmed && !state.entrySignal && ltp > high) {
    const ist = getIST();
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (mins < ENTRY_CUTOFF_MINS) {
      state.entrySignal = true;
      state.firstEntryAt = new Date().toISOString();
      state.firstEntryPrice = ltp;
      db.query(
        `UPDATE angel_15m_candle SET entry_signal=true, first_entry_at=NOW(), first_entry_price=$3
         WHERE date=$1 AND token=$2 AND entry_signal=false`,
        [p.date, token, ltp]
      ).catch(() => {});
      changed = true;
    }
  }

  if (state.entrySignal && !state.targetHit && !state.slHit) {
    const target = high * 1.01;
    if (ltp >= target) {
      state.targetHit = true;
      state.targetHitAt = new Date().toISOString();
      db.query(`UPDATE angel_15m_candle SET target_hit=true, target_hit_at=NOW() WHERE date=$1 AND token=$2 AND target_hit=false`,
        [p.date, token]).catch(() => {});
      changed = true;
    } else if (ltp <= low) {
      state.slHit = true;
      state.slHitAt = new Date().toISOString();
      db.query(`UPDATE angel_15m_candle SET sl_hit=true, sl_hit_at=NOW() WHERE date=$1 AND token=$2 AND sl_hit=false`,
        [p.date, token]).catch(() => {});
      changed = true;
    }
  }

  if (changed) { orbState.set(key, state); broadcastORB(token, state); }

/* ---------- A8. POST /api/screener/fetch-batch ----------
   USE: ORB 9:15 REST candles endpoint (Angel getCandleData batch). 'Fetch 9:15 Candles' button (ORB) call karta tha.
   ---------- */
app.post('/api/screener/fetch-batch', auth, async (req, res) => {
  const { tokens } = req.body;
  if (!Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: 'tokens array required' });
  const p = getScreenerPhase();
  if (p.phase !== 'ready' && p.phase !== 'weekend' && p.phase !== 'forming') {
    return res.status(400).json({ error: `Cannot fetch in phase: ${p.phase}` });
  }
  if (!p.date) return res.status(400).json({ error: 'No date available' });

  try {
    const results = await getCandlesForTokens(tokens, p.date);
    for (const r of results) {
      const c = r.candle;
      if (Array.isArray(c) && c.length >= 5) {
        db.query(
          `INSERT INTO angel_15m_candle (date, token, sym, open, high, low, close, volume, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (date, token) DO UPDATE SET
             sym=EXCLUDED.sym, open=EXCLUDED.open, high=EXCLUDED.high,
             low=EXCLUDED.low, close=EXCLUDED.close, volume=EXCLUDED.volume,
             updated_at=NOW()`,
          [p.date, r.token, SYM_BY_TOKEN[r.token] || '?', c[1], c[2], c[3], c[4], c[5] || 0]
        ).catch(() => {});
        if (!orbState.has(`${r.token}_${p.date}`)) {
          orbState.set(`${r.token}_${p.date}`, {
            lowBroken: false, pullbackConfirmed: false, entrySignal: false,
            firstLowBreakAt: null, firstPullbackAt: null, firstEntryAt: null,
            firstLowBreakPrice: null, firstPullbackPrice: null, firstEntryPrice: null,
            targetHit: false, targetHitAt: null, slHit: false, slHitAt: null
          });
        }
      }
    }
    console.log(`📊 REST fetch: ${results.length}/${tokens.length} candles`);
    res.json({ ok: true, date: p.date, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- A9. POST /api/screener/fetch-quote-batch ----------
   USE: ORB manual Quote H/L endpoint (GetQuote). 'Fetch Quote H/L' button (ORB) se; q15 columns + quoteCache + candles update.
   ---------- */
app.post('/api/screener/fetch-quote-batch', auth, async (req, res) => {
  const { tokens } = req.body;
  if (!Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: 'tokens array required' });
  const p = getScreenerPhase();
  if (!p.date) return res.status(400).json({ error: 'No trading date' });

  try {
    const quotes = await fetchQuotesForTokens(tokens);
    const fetchedAt = new Date();
    const results = [];

    for (const q of quotes) {
      if (!q || !q.token) continue;
      if (!Number.isFinite(q.high) || !Number.isFinite(q.low) || q.high <= 0 || q.low <= 0) continue;

      const token = String(q.token);
      quoteCache.set(token, { high: q.high, low: q.low, fetchedAt });

      db.query(
        `INSERT INTO angel_15m_candle (date, token, sym, q15_open, q15_high, q15_low, q15_close, quote_fetched_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (date, token) DO UPDATE SET
           sym=EXCLUDED.sym,
           q15_open=EXCLUDED.q15_open, q15_high=EXCLUDED.q15_high,
           q15_low=EXCLUDED.q15_low, q15_close=EXCLUDED.q15_close,
           quote_fetched_at=EXCLUDED.quote_fetched_at, updated_at=NOW()`,
        [p.date, token, SYM_BY_TOKEN[token] || '?', q.open || q.low, q.high, q.low, q.ltp || q.high, fetchedAt]
      ).catch(() => {});

      setCachedCandle(token, p.date, [0, q.open || q.low, q.high, q.low, q.ltp || q.high, 0]);
      if (q.ltp) setCachedLTP(token, q.ltp);

      if (!orbState.has(`${token}_${p.date}`)) {
        orbState.set(`${token}_${p.date}`, {
          lowBroken: false, pullbackConfirmed: false, entrySignal: false,
          firstLowBreakAt: null, firstPullbackAt: null, firstEntryAt: null,
          firstLowBreakPrice: null, firstPullbackPrice: null, firstEntryPrice: null,
          targetHit: false, targetHitAt: null, slHit: false, slHitAt: null
        });
      }

      results.push({ token, open: q.open, high: q.high, low: q.low, close: q.ltp, prevClose: q.close });
    }

    broadcastQuote(fetchedAt);
    console.log(`📊 Quote fetch: ${results.length}/${tokens.length} processed`);
    res.json({ ok: true, date: p.date, fetchedAt, results });
  } catch (e) {
    console.error('fetch-quote-batch failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- A10. autoFetchQuote() — auto 9:30 GetQuote job ----------
   USE: Daily 9:30:10 GetQuote H/L fetch → q15 columns + quoteCache + candles. ORB candles ka primary source; momentum ab BS day_open/prev_close use karta hai.
   ---------- */
/* ============================================================
   SECTION 9 — AUTO QUOTE FETCH @ 09:30:10 IST
   ============================================================ */
async function autoFetchQuote() {
  try {
    if (!isTradingDay(getIST())) { console.log('📊 Auto-quote: non-trading day'); return; }
    const p = getScreenerPhase();
    if (!p.date) return;

    const allTokens = STOCKS.map(s => String(s.token));
    console.log(`📊 Auto-quote: fetching ${allTokens.length} tokens...`);
    const t0 = Date.now();

    const savedTokens = new Set();
    const fetchedAt = new Date();

    const quotes = await fetchQuotesForTokens(allTokens);
    for (const q of quotes) {
      if (!q || !q.token) continue;
      if (!Number.isFinite(q.high) || !Number.isFinite(q.low) || q.high <= 0 || q.low <= 0) continue;

      const token = String(q.token);
      quoteCache.set(token, { high: q.high, low: q.low, fetchedAt });

      db.query(
        `INSERT INTO angel_15m_candle (date, token, sym, q15_open, q15_high, q15_low, q15_close, quote_fetched_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (date, token) DO UPDATE SET
           sym=EXCLUDED.sym,
           q15_open=EXCLUDED.q15_open, q15_high=EXCLUDED.q15_high,
           q15_low=EXCLUDED.q15_low, q15_close=EXCLUDED.q15_close,
           quote_fetched_at=EXCLUDED.quote_fetched_at, updated_at=NOW()`,
        [p.date, token, SYM_BY_TOKEN[token] || '?', q.open || q.low, q.high, q.low, q.ltp || q.high, fetchedAt]
      ).catch(() => {});

      setCachedCandle(token, p.date, [0, q.open || q.low, q.high, q.low, q.ltp || q.high, 0]);
      if (q.ltp) setCachedLTP(token, q.ltp);

      if (!orbState.has(`${token}_${p.date}`)) {
        orbState.set(`${token}_${p.date}`, {
          lowBroken: false, pullbackConfirmed: false, entrySignal: false,
          firstLowBreakAt: null, firstPullbackAt: null, firstEntryAt: null,
          firstLowBreakPrice: null, firstPullbackPrice: null, firstEntryPrice: null,
          targetHit: false, targetHitAt: null, slHit: false, slHitAt: null
        });
      }
      savedTokens.add(token);
    }

    broadcastQuote(fetchedAt);
    console.log(`✅ Auto-quote: ${savedTokens.size}/${allTokens.length} saved in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) { console.error('Auto-quote failed:', e.message); }
}


/* ---------- A10b. scheduleQuoteAutoFetch() ----------
   USE: 9:30 auto-quote ka daily scheduler.
   ---------- */
function scheduleQuoteAutoFetch() {
  const ms = msUntil(9, 30, 1) + 10000;
  console.log(`⏰ Next auto-quote in ${Math.round(ms / 60000)} min`);
  setTimeout(async () => { await autoFetchQuote(); scheduleQuoteAutoFetch(); }, ms);
}

/* ---------- A10c. startup scheduler call ----------
   USE: Startup pe scheduler register hota tha.
   ---------- */
  scheduleQuoteAutoFetch();

/* ---------- A11a. startup loadQuoteCacheFromDB call ----------
   USE: Startup pe q15 cache load.
   ---------- */
  await loadQuoteCacheFromDB();

/* ---------- A14. Late-startup auto-quote catch-up block (9:30-9:45 window) ----------
   USE: Agar server 9:30-9:45 me restart hua aur q15 rows missing thin to autoQuote catch-up chalata tha. ORB infra tha.
   ---------- */
  if (dow >= 1 && dow <= 5 && isTradingDay(nowIST) && mins >= 570 && mins <= 585) {
    const pQ = getScreenerPhase();
    if (pQ.date) {
      try {
        const { rows } = await db.query(
          'SELECT COUNT(*) AS cnt FROM angel_15m_candle WHERE date=$1 AND q15_high IS NOT NULL',
          [pQ.date]
        );
        if (+rows[0].cnt === 0) {
          console.log('🔔 Late startup — running auto-quote catch-up');
          autoFetchQuote().catch(e => console.error('catch-up failed:', e.message));
        }
      } catch (e) { console.error('catch-up failed:', e.message); }
    }

/* ---------- A12a. /ltp ORB state read ----------
   USE: ORB state response ke liye.
   ---------- */
    const state = getOrbState(token, p.date);

/* ---------- A12b. /ltp quote read ----------
   USE: Quote H/L ke liye.
   ---------- */
    const quote = quoteCache.get(token) || null;

/* ---------- A12c. /ltp pivot read ----------
   USE: Pivot column ke liye.
   ---------- */
    const pivot = pivotCache.get(token) || null;

/* ---------- A12d. /ltp quote H/L fields ----------
   USE: highQuote/lowQuote/quoteFetchedAt — ORB Quote H/L column.
   ---------- */
      highQuote: quote?.high ?? null,
      lowQuote: quote?.low ?? null,
      quoteFetchedAt: quote?.fetchedAt ?? null,

/* ---------- A12e. /ltp ORB state fields ----------
   USE: ORB stage fields (NEW LOW/PULLBACK/BREAKOUT/STAGE columns ke liye).
   ---------- */
      lowBroken: state.lowBroken,
      pullbackConfirmed: state.pullbackConfirmed,
      entrySignal: state.entrySignal,
      newLowAt: state.firstLowBreakAt,
      pullbackAt: state.firstPullbackAt,
      breakoutAt: state.firstEntryAt,
      lowBreakPrice: state.firstLowBreakPrice,
      pullbackPrice: state.firstPullbackPrice,
      entryPrice: state.firstEntryPrice,
      targetHit: state.targetHit,
      targetHitAt: state.targetHitAt,
      slHit: state.slHit,
      slHitAt: state.slHitAt,

/* ---------- A13a. /data quotes payload ----------
   USE: quoteCache se H/L map — ORB branch ko jata tha.
   ---------- */
  const quotes = {};
  for (const t of cachedTokens) {
    const q = quoteCache.get(t);
    if (q) quotes[t] = { high: q.high, low: q.low, fetchedAt: q.fetchedAt };
  }

/* ---------- A13b. /data passing stocks calc ----------
   USE: passesStrategy filter — filled/stocks list ke liye (momentum frontend use nahi karta).
   ---------- */
  const passing = allCandles.filter(c => passesStrategy(c.candle, strategy));
  const passingTokens = new Set(passing.map(c => String(c.token)));
  const passingStocks = STOCKS.filter(s => passingTokens.has(String(s.token)));

/* ---------- A13c. passesStrategy() ----------
   USE: Range%/price filters — ORB stock filtering core.
   ---------- */
function passesStrategy(candle, strategy) {
  if (!Array.isArray(candle) || candle.length < 5) return false;
  const high = +candle[2], low = +candle[3], close = +candle[4];
  if (low <= 0 || high <= low) return false;
  const rangePct = ((high - low) / low) * 100;
  const f = strategy.filters;
  return rangePct <= f.maxRangePct && close >= f.minPrice && close <= f.maxPrice;
}


/* ############################################################
   PART B — SCREENER.JS (frontend) CODE
   ############################################################ */

/* ---------- B1. state var: let SCREENER_STOCKS = []; ----------
   USE: ORB branch ka in-memory state (candles/quote cache/ORB state/filtered stocks/stage filter). Momentum ko inki zaroorat nahi.
   ---------- */
let SCREENER_STOCKS = [];

/* ---------- B1. state var: let SCREENER_ALL_CANDLES = {}; ----------
   USE: ORB branch ka in-memory state (candles/quote cache/ORB state/filtered stocks/stage filter). Momentum ko inki zaroorat nahi.
   ---------- */
let SCREENER_ALL_CANDLES = {};

/* ---------- B1. state var: let SCREENER_CACHED_TOKENS = new Set(); ----------
   USE: ORB branch ka in-memory state (candles/quote cache/ORB state/filtered stocks/stage filter). Momentum ko inki zaroorat nahi.
   ---------- */
let SCREENER_CACHED_TOKENS = new Set();

/* ---------- B1. state var: let SCREENER_QUOTE = {}; ----------
   USE: ORB branch ka in-memory state (candles/quote cache/ORB state/filtered stocks/stage filter). Momentum ko inki zaroorat nahi.
   ---------- */
let SCREENER_QUOTE = {};

/* ---------- B1. state var: let SCREENER_ORB = {}; ----------
   USE: ORB branch ka in-memory state (candles/quote cache/ORB state/filtered stocks/stage filter). Momentum ko inki zaroorat nahi.
   ---------- */
let SCREENER_ORB = {};

/* ---------- B1. state var: let SCREENER_STAGE_FILTER = 'all'; ----------
   USE: ORB branch ka in-memory state (candles/quote cache/ORB state/filtered stocks/stage filter). Momentum ko inki zaroorat nahi.
   ---------- */
let SCREENER_STAGE_FILTER = 'all';

/* ---------- B1. state var: const STRATEGY_FILTER = ----------
   USE: ORB branch ka in-memory state (candles/quote cache/ORB state/filtered stocks/stage filter). Momentum ko inki zaroorat nahi.
   ---------- */
const STRATEGY_FILTER = { maxRangePct: 1.5, minPrice: 150, maxPrice: 3500 };

/* ---------- B2. computeGapPct (purana q15-candle version) ----------
   USE: Gap% pehle 9:15 q15 candle ke OPEN se banta tha. Ab BS table ke day_open vs prev_close se banta hai (naya version server.js v4.4/v5.4 me).
   ---------- */
function computeGapPct(token) {
  const c = SCREENER_ALL_CANDLES[token];
  const prev = SCREENER_PREV_CLOSE[token];
  if (!c || !c.open || !prev || prev <= 0) return null;
  return ((c.open - prev) / prev) * 100;
}

/* ---------- B3. passesFilter + recomputeFilteredStocks ----------
   USE: ORB stock universe filter (range% / price band) — SCREENER_STOCKS list banata tha jo sirf ORB branch use karta tha.
   ---------- */
function passesFilter(candle) {
  if (!candle) return false;
  const rangePct = ((candle.high - candle.low) / candle.low) * 100;
  if (rangePct > STRATEGY_FILTER.maxRangePct) return false;
  if (candle.close < STRATEGY_FILTER.minPrice || candle.close > STRATEGY_FILTER.maxPrice) return false;
  return true;
}

function recomputeFilteredStocks() {
  if (SCREENER_CACHED_TOKENS.size === 0) {
    SCREENER_STOCKS = [...SCREENER_ALL_STOCKS];
    return;
  }
  SCREENER_STOCKS = SCREENER_ALL_STOCKS.filter(s => passesFilter(SCREENER_ALL_CANDLES[s.token]));
}

/* ---------- B4. categorizeStock + passesPivotFilter + setStageFilter ----------
   USE: ORB stage categorization (entry/lowbrok/waiting), pivot-entry filter, stage-filter setter — ORB chips + table ke liye.
   ---------- */
function categorizeStock(stock) {
  const orb = SCREENER_ORB[stock.token] || {};
  if (orb.entrySignal) return 'entry';
  if (orb.lowBroken)   return 'lowbrok';
  return 'waiting';
}

function passesPivotFilter(token) {
  const c = SCREENER_ALL_CANDLES[token];
  const pivot = SCREENER_PIVOT[token];
  if (!c || !pivot || pivot <= 0) return false;
  const buffer = pivot * 0.001;
  const touches = (c.low - buffer) <= pivot && pivot <= (c.high + buffer);
  if (!touches) return false;
  if (c.close <= pivot) return false;
  return true;
}

function setStageFilter(key) {
  SCREENER_STAGE_FILTER = key;
  renderScreenerTable();
}

/* ---------- B5. renderChips ORB counts+chips branch ----------
   USE: ORB filter chips (All/Pivot+Entry/Entry/Low Broken/Waiting) counts ke saath render hoti thin.
   ---------- */
  const counts = { all: 0, entry: 0, lowbrok: 0, waiting: 0, pivot_entry: 0 };
  for (const s of SCREENER_STOCKS) {
    counts.all++;
    counts[categorizeStock(s)]++;
    if (passesPivotFilter(s.token) && (SCREENER_ORB[s.token]?.entrySignal)) {
      counts.pivot_entry++;
    }
  }

  const chip = (key, label, count) => {
    const active = SCREENER_STAGE_FILTER === key ? 'active' : '';
    return `<button class="filter-chip ${active}" onclick="setStageFilter('${key}')">
      ${label} <span class="chip-count">${count}</span>
    </button>`;
  };

  el.innerHTML =
    chip('all', 'All', counts.all) +
    chip('pivot_entry', '🎯 Pivot + Entry', counts.pivot_entry) +
    chip('entry', '🎯 Entry Signal', counts.entry) +
    chip('lowbrok', '⬇️ Low Broken', counts.lowbrok) +
    chip('waiting', '⏸️ Waiting', counts.waiting);

/* ---------- B6. getSortValue range/stage branches ----------
   USE: ORB table ke sortable columns (9:15 Range, ORB Stage) ke sort values.
   ---------- */
  if (field === 'range') {
    if (!candle) return -Infinity;
    return ((candle.high - candle.low) / candle.low) * 100;
  }
  if (field === 'stage') {
    const orb = SCREENER_ORB[stock.token] || {};
    if (orb.entrySignal)       return 4;
    if (orb.pullbackConfirmed) return 3;
    if (orb.lowBroken)         return 2;
    return 1;
  }

/* ---------- B7. updateORBRow + renderTimePrice + renderTargetSL ----------
   USE: SSE 'orb' event par row fast-update (NEW LOW/PULLBACK/BREAKOUT/STAGE/T-SL cells) + time-price renderer + Target/SL renderer (candle high*1.01 / low).
   ---------- */
function updateORBRow(token, state) {
  SCREENER_ORB[token] = {
    lowBroken: state.lowBroken,
    pullbackConfirmed: state.pullbackConfirmed,
    entrySignal: state.entrySignal,
    newLowAt: state.firstLowBreakAt,
    pullbackAt: state.firstPullbackAt,
    breakoutAt: state.firstEntryAt,
    lowBreakPrice: state.firstLowBreakPrice,
    pullbackPrice: state.firstPullbackPrice,
    entryPrice: state.firstEntryPrice,
    targetHit: state.targetHit,
    targetHitAt: state.targetHitAt,
    slHit: state.slHit,
    slHitAt: state.slHitAt
  };

  const row = document.querySelector(`#screenerBody tr[data-token="${token}"]`);
  if (!row) return;

  const nlCell = row.querySelector('.cell-newlow');
  if (nlCell) {
    nlCell.innerHTML = state.lowBroken
      ? renderTimePrice(state.firstLowBreakAt, state.firstLowBreakPrice)
      : '—';
  }

  const pbCell = row.querySelector('.cell-pullback');
  if (pbCell) {
    pbCell.innerHTML = state.pullbackConfirmed
      ? renderTimePrice(state.firstPullbackAt, state.firstPullbackPrice)
      : '—';
  }

  const boCell = row.querySelector('.cell-breakout');
  if (boCell) {
    boCell.innerHTML = state.entrySignal
      ? renderTimePrice(state.firstEntryAt, state.firstEntryPrice)
      : '—';
  }

  const stageCell = row.querySelector('.cell-stage');
  if (stageCell && SCREENER_ALL_CANDLES[token]) {
    const stage = resolveOrbStage(token, SCREENER_ALL_CANDLES[token], SCREENER_LTP[token]);
    stageCell.style.color = stage.color;
    stageCell.fontWeight = stage.weight;
    stageCell.textContent = stage.label;
  }

  const tslCell = row.querySelector('.cell-targetsl');
  if (tslCell && SCREENER_ALL_CANDLES[token]) {
    tslCell.innerHTML = renderTargetSL(SCREENER_ALL_CANDLES[token], SCREENER_ORB[token]);
  }

  if (state.entrySignal) row.classList.add('row-signal');
  else row.classList.remove('row-signal');

  const actionCell = row.querySelector('.cell-action');
  if (actionCell) {
    const stock = SCREENER_ALL_STOCKS.find(s => String(s.token) === String(token));
    actionCell.innerHTML = state.entrySignal
      ? `<button class="btn btn-success btn-sm" onclick="placeOrder('${stock?.sym || token}')">Buy</button>`
      : '<span style="color:var(--text-muted);font-size:11px">—</span>';
  }
}

function renderTimePrice(isoStr, price) {
  if (!isoStr) return '—';
  const t = formatTimeIST(isoStr);
  const p = (price !== null && price !== undefined) ? '₹' + (+price).toFixed(2) : '';
  return `<span class="cell-time" style="display:block">${t}</span>` +
         (p ? `<span style="display:block;font-size:10px;color:var(--text-muted);font-family:ui-monospace,monospace">${p}</span>` : '');
}

/* Advance ORB branch me use hota hai — momentum se hataya gaya (v4.2) */
function renderTargetSL(c, orb) {
  const target = c.high * 1.01;
  const sl = c.low;

  let targetLine = `<span class="cell-primary" style="color:#6C5CE7">T: ₹${target.toFixed(2)}</span>`;
  let slLine = `<span class="cell-sub" style="color:var(--text-secondary)">SL: ₹${sl.toFixed(2)}</span>`;

  if (orb?.targetHit) {
    targetLine = `<span class="cell-primary" style="color:var(--success)">T: ₹${target.toFixed(2)} <span style="font-size:13px">✓</span></span>`;
    slLine = `<span class="cell-sub" style="color:var(--text-muted);text-decoration:line-through">SL: ₹${sl.toFixed(2)}</span>`;
  } else if (orb?.slHit) {
    targetLine = `<span class="cell-primary" style="color:var(--text-muted);text-decoration:line-through">T: ₹${target.toFixed(2)}</span>`;
    slLine = `<span class="cell-sub" style="color:var(--danger)">SL: ₹${sl.toFixed(2)} <span style="font-size:13px">✗</span></span>`;
  }

  return targetLine + slLine;
}

/* ---------- B8. startFetch + startQuoteFetch + startDayHLCFetch ----------
   USE: ORB branch ke 3 manual fetch buttons: 9:15 REST candles (fetch-batch), Quote H/L (fetch-quote-batch), Day H/L/C (force-day-hlc). Progress bar ke saath batched fetch.
   ---------- */
/* ============================================================
   SECTION 5 — FETCH 9:15 (REST)  [Advance ORB only]
   ============================================================ */
async function startFetch() {
  if (FETCHING) return;
  const btn = document.getElementById('fetch915Btn');
  if (!btn) return;
  if (!SCREENER_ALL_STOCKS.length) { showToast('⚠️ No stocks', ''); return; }

  FETCHING = true;
  btn.disabled = true;
  btn.textContent = '⏳ Fetching...';
  document.getElementById('progressBar').style.display = 'block';

  const allTokens = SCREENER_ALL_STOCKS.map(s => s.token);
  const total = allTokens.length;
  let ok = 0, failed = 0;

  const missing = allTokens.filter(t => !SCREENER_CACHED_TOKENS.has(String(t)));

  if (!missing.length) {
    updateProgress(total, total);
    FETCHING = false;
    btn.disabled = false;
    btn.textContent = '⚡ Refresh';
    await loadLTP();
    startSSE();
    return;
  }

  updateProgress(total - missing.length, total);
  const alreadyCached = total - missing.length;

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);

    try {
      const r = await fetch(API + '/api/screener/fetch-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify({ tokens: batch })
      });
      const d = await r.json();
      if (d.results) {
        for (const item of d.results) {
          const c = item.candle;
          if (Array.isArray(c) && c.length >= 5) {
            SCREENER_ALL_CANDLES[item.token] = {
              open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0
            };
            SCREENER_CACHED_TOKENS.add(String(item.token));
            ok++;
          } else failed++;
        }
      }
    } catch (e) { failed += batch.length; }

    const done = alreadyCached + i + batch.length;
    recomputeFilteredStocks();
    renderScreenerTable();
    updateProgress(done, total);

    if (i + BATCH_SIZE < missing.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  FETCHING = false;
  btn.disabled = false;
  btn.textContent = '⚡ Refresh';

  await loadLTP();
  startSSE();
}

/* ============================================================
   SECTION 5.1 — FETCH QUOTE  [Advance ORB only]
   ============================================================ */
async function startQuoteFetch() {
  if (QUOTE_FETCHING) return;
  const btn = document.getElementById('fetchQuoteBtn');
  if (!btn) return;
  if (!SCREENER_ALL_STOCKS.length) { showToast('⚠️ No stocks', ''); return; }

  QUOTE_FETCHING = true;
  btn.disabled = true;
  btn.textContent = '⏳ Quote fetch...';
  document.getElementById('progressBar').style.display = 'block';

  const allTokens = SCREENER_ALL_STOCKS.map(s => String(s.token));
  const total = allTokens.length;
  let ok = 0, failed = 0;
  const QUOTE_BATCH = 50;

  for (let i = 0; i < allTokens.length; i += QUOTE_BATCH) {
    const batch = allTokens.slice(i, i + QUOTE_BATCH);

    try {
      const r = await fetch(API + '/api/screener/fetch-quote-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify({ tokens: batch })
      });
      const d = await r.json();
      if (d.results) {
        for (const item of d.results) {
          SCREENER_QUOTE[String(item.token)] = {
            high: item.high,
            low: item.low,
            fetchedAt: d.fetchedAt
          };
          SCREENER_CACHED_TOKENS.add(String(item.token));

          if (!SCREENER_ALL_CANDLES[item.token]) {
            SCREENER_ALL_CANDLES[item.token] = {
              open: item.open || item.low,
              high: item.high,
              low: item.low,
              close: item.close || item.high,
              volume: 0
            };
          }
          ok++;
        }
        failed += (batch.length - (d.results?.length || 0));
      } else {
        failed += batch.length;
      }
    } catch (e) { failed += batch.length; }

    recomputeFilteredStocks();
    renderScreenerTable();
    updateProgress(i + batch.length, total);
  }

  QUOTE_FETCHING = false;
  btn.disabled = false;
  btn.textContent = '📊 Refresh Quote';

  const ts = formatTimeOnly(new Date().toISOString());
  showToast('📊 Quote Done', `${ok} fetched · ${failed} failed · at ${ts} IST`);

  await loadLTP();
  startSSE();
}

/* ============================================================
   SECTION 5.2 — MANUAL DAY H/L/C  [Advance ORB only]
   ============================================================ */
async function startDayHLCFetch() {
  const btn = document.getElementById('fetchDayHLCBtn');
  if (!btn) return;
  if (DAYHLC_FETCHING) return;

  const ok = confirm('Fetch day High/Low/Close + Pivot for all stocks now?');
  if (!ok) return;

  DAYHLC_FETCHING = true;
  btn.disabled = true;
  btn.textContent = '⏳ Fetching day H/L/C...';

  try {
    const r = await fetch(API + '/api/admin/force-day-hlc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();

    if (!r.ok) {
      showToast('⚠️ Failed', d.error || `HTTP ${r.status}`);
    } else {
      showToast('✅ Day H/L/C Saved', `${d.saved}/${d.total} stocks · ${d.date}`);
      await loadLTP();
    }
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }

  DAYHLC_FETCHING = false;
  btn.disabled = false;
  btn.textContent = '📅 Fetch Day H/L/C';
}

/* ---------- B9a. init me loadCachedData call ----------
   USE: Init pe /api/screener/data se candles/quotes load hoti thin.
   ---------- */
  await loadCachedData();

/* ---------- B9b. loadCachedData() ----------
   USE: /api/screener/data se candles (q15/ORB) + cachedTokens + quotes load karke SCREENER_ALL_CANDLES bharta tha — sirf ORB branch use karta tha.
   ---------- */
async function loadCachedData() {
  try {
    const r = await fetch(API + '/api/screener/data?strategy=' + CURRENT_STRATEGY, {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();
    if (!d.ok) {
      renderScreenerTable();
      return;
    }

    SCREENER_ALL_CANDLES = {};
    if (d.results) {
      for (const item of d.results) {
        const c = item.candle;
        if (Array.isArray(c) && c.length >= 5) {
          SCREENER_ALL_CANDLES[item.token] = {
            open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0
          };
        }
      }
    }

    if (Array.isArray(d.cachedTokens)) {
      d.cachedTokens.forEach(t => SCREENER_CACHED_TOKENS.add(String(t)));
    }

    if (d.quotes) {
      for (const [token, q] of Object.entries(d.quotes)) {
        SCREENER_QUOTE[token] = { high: q.high, low: q.low, fetchedAt: q.fetchedAt };
      }
    }

    recomputeFilteredStocks();
    renderScreenerTable();
  } catch (e) { console.error(e); }
}


/* ---------- B10a. loadLTP quote fields ----------
   USE: SCREENER_QUOTE populate (ORB Quote H/L column).
   ---------- */
        if (item.highQuote) {
          SCREENER_QUOTE[item.token] = {
            high: item.highQuote,
            low: item.lowQuote,
            fetchedAt: item.quoteFetchedAt
          };
        }

/* ---------- B10b. loadLTP ORB state fields ----------
   USE: SCREENER_ORB populate (stage/newlow/pullback/breakout/target-sl).
   ---------- */
        if (item.token !== NIFTY50_TOKEN) {
          SCREENER_ORB[item.token] = {
            lowBroken: !!item.lowBroken,
            pullbackConfirmed: !!item.pullbackConfirmed,
            entrySignal: !!item.entrySignal,
            newLowAt: item.newLowAt || null,
            pullbackAt: item.pullbackAt || null,
            breakoutAt: item.breakoutAt || null,
            lowBreakPrice: item.lowBreakPrice ?? null,
            pullbackPrice: item.pullbackPrice ?? null,
            entryPrice: item.entryPrice ?? null,
            targetHit: !!item.targetHit,
            targetHitAt: item.targetHitAt || null,
            slHit: !!item.slHit,
            slHitAt: item.slHitAt || null,
            serverTime: item.serverTime || null
          };
        }

/* ---------- B10c. loadLTP baseList ternary ----------
   USE: ORB strategy pe SCREENER_STOCKS use hota tha; ab hamesha ALL_STOCKS.
   ---------- */
  const baseList = SCREENER_ACTIVE_STRATEGY === 'momentum'
    ? SCREENER_ALL_STOCKS
    : SCREENER_STOCKS;

/* ---------- B11a. SSE 'orb' handler ----------
   USE: ORB state events receive karke updateORBRow chalata tha.
   ---------- */
      else if (msg.type === 'orb' && msg.token && msg.state) {
        updateORBRow(msg.token, msg.state);
      }

/* ---------- B11b. SSE 'quote' handler ----------
   USE: Quote H/L broadcast receive karke SCREENER_QUOTE + table refresh.
   ---------- */
      else if (msg.type === 'quote' && msg.quotes) {
        for (const [token, q] of Object.entries(msg.quotes)) {
          SCREENER_QUOTE[token] = { high: q.high, low: q.low, fetchedAt: q.fetchedAt };
        }

/* ---------- B12. resolveOrbStage() ----------
   USE: ORB stage label resolver (ENTRY/PULLBACK/LOW BROKEN/Above High/Inside Range).
   ---------- */
function resolveOrbStage(token, candle, ltp) {
  const orb = SCREENER_ORB[token] || { lowBroken: false, pullbackConfirmed: false, entrySignal: false };

  if (orb.entrySignal)       return { label: '🎯 ENTRY', color: '#6C5CE7', weight: 700 };
  if (orb.pullbackConfirmed) return { label: '↩️ PULLBACK', color: 'var(--text-secondary)', weight: 600 };
  if (orb.lowBroken)         return { label: '⬇️ LOW BROKEN', color: 'var(--text-secondary)', weight: 600 };
  if (ltp && candle) {
    if (ltp > candle.high) return { label: '⏸️ Above High', color: 'var(--text-muted)', weight: 500 };
    return { label: '⏸️ Inside Range', color: 'var(--text-muted)', weight: 500 };
  }

/* ---------- B13. renderScreenerTable ORB branch ----------
   USE: Poora ORB table render: head (Pivot/Range/Quote H-L/T-SL/NEW LOW/PULLBACK/BREAKOUT/STAGE columns) + rows + filters. Momentum branch untouched.
   ---------- */
  /* ============================================================
     ADVANCE ORB strategy branch (untouched — Pivot/Target/SL yahi chahiye)
     ============================================================ */
  head.innerHTML = `<tr>
    <th>Stock / Company</th>
    <th class="th-sortable" onclick="setSort('ltp')">LTP ${sortIndicator('ltp')}<br>
        <span class="th-sub" onclick="event.stopPropagation();setSort('change')">Change % ${sortIndicator('change')}</span></th>
    <th>Pivot</th>
    <th class="th-sortable" onclick="setSort('range')">9:15 Range (H / L) ${sortIndicator('range')}</th>
    <th>Quote H / L</th>
    <th>Target / SL</th>
    <th>MAXQTY</th>
    <th>NEW LOW</th>
    <th>PULLBACK</th>
    <th>BREAKOUT</th>
    <th>LAST UPDATE</th>
    <th class="th-sortable" onclick="setSort('stage')">ORB STAGE ${sortIndicator('stage')}</th>
    <th>ACTION</th>
  </tr>`;

  if (!SCREENER_STOCKS.length) {
    body.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:60px;color:var(--text-muted)">
      Loading stocks...<br>
      Click <strong>⚡ Fetch 9:15 Candles</strong> or <strong>📊 Fetch Quote H/L</strong> to load data.
    </td></tr>`;
    if (count) count.textContent = `0 / ${SCREENER_ALL_STOCKS.length}`;
    renderChips();
    return;
  }

  let filtered = SCREENER_STOCKS;
  if (SCREENER_STAGE_FILTER === 'pivot_entry') {
    filtered = filtered.filter(s => passesPivotFilter(s.token) && (SCREENER_ORB[s.token]?.entrySignal));
  } else if (SCREENER_STAGE_FILTER !== 'all') {
    filtered = filtered.filter(s => categorizeStock(s) === SCREENER_STAGE_FILTER);
  }

  const sorted = sortStocks(filtered);

  if (!sorted.length) {
    body.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:40px;color:var(--text-muted)">
      No stocks in this category.
    </td></tr>`;
    if (count) count.textContent = `${SCREENER_STOCKS.length} / ${SCREENER_ALL_STOCKS.length}`;
    renderChips();
    return;
  }

  body.innerHTML = sorted.map(s => {
    const c = SCREENER_ALL_CANDLES[s.token];
    const ltp = SCREENER_LTP[s.token];
    const orb = SCREENER_ORB[s.token] || {};
    const quote = SCREENER_QUOTE[s.token];
    const pivot = SCREENER_PIVOT[s.token];

    const maxQty = computeMaxQty(s.token, ltp);
    const stage = c
      ? resolveOrbStage(s.token, c, ltp)
      : { label: '⏸️ No 9:15 data', color: 'var(--text-muted)', weight: 500 };

    const changePct = computeChangePct(s.token);
    let changeLine;
    if (changePct === null) {
      changeLine = '<span style="color:var(--text-muted)">—</span>';
    } else {
      const isPos = changePct >= 0;
      const color = isPos ? 'var(--success)' : 'var(--danger)';
      changeLine = `<span style="color:${color};font-weight:700">${isPos ? '+' : ''}${changePct.toFixed(2)}%</span>`;
    }

    let pivotCell;
    if (pivot) {
      const above = ltp ? (+ltp >= pivot) : null;
      if (above === null) {
        pivotCell = `<span style="color:var(--text-muted)">₹${pivot.toFixed(2)}</span>`;
      } else {
        const color = above ? 'var(--success)' : 'var(--danger)';
        const arrow = above ? '▲' : '▼';
        pivotCell = `<span style="color:${color};font-weight:700">${arrow} ₹${pivot.toFixed(2)}</span>`;
      }
    } else {
      pivotCell = '<span style="color:var(--text-muted)">—</span>';
    }

    let quoteCell;
    if (quote) {
      const qt = formatTimeOnly(quote.fetchedAt);
      quoteCell = `
        <span class="cell-primary" style="color:var(--success)">H: ₹${(+quote.high).toFixed(2)}</span>
        <span class="cell-sub" style="color:var(--danger)">L: ₹${(+quote.low).toFixed(2)}</span>
        <span style="display:block;font-size:9px;color:var(--text-muted);margin-top:2px;font-family:ui-monospace,monospace">${qt}</span>`;
    } else {
      quoteCell = '<span style="color:var(--text-muted)">—</span>';
    }

    const newLowCell   = (c && orb.lowBroken) ? renderTimePrice(orb.newLowAt, orb.lowBreakPrice) : '—';
    const pullbackCell = (c && orb.pullbackConfirmed) ? renderTimePrice(orb.pullbackAt, orb.pullbackPrice) : '—';
    const breakoutCell = (c && orb.entrySignal) ? renderTimePrice(orb.breakoutAt, orb.entryPrice) : '—';

    const lastUpdate = formatTimeIST(orb.serverTime);
    const rowClass = orb.entrySignal ? 'row-signal' : '';

    return `<tr class="${rowClass}" data-token="${s.token}">
      <td><span class="sym">${s.sym}</span><span class="tok">${s.token}</span></td>
      <td style="white-space:nowrap">
        <span class="cell-primary ltp-cell">${ltp ? '₹' + (+ltp).toFixed(2) : '—'}</span>
        <span class="cell-sub change-cell">${changeLine}</span>
      </td>
      <td class="pivot-cell" style="white-space:nowrap">${pivotCell}</td>
      <td style="white-space:nowrap">
        ${c ? `<span class="cell-primary" style="color:var(--success)">H: ₹${c.high.toFixed(2)}</span>
               <span class="cell-sub" style="color:var(--danger)">L: ₹${c.low.toFixed(2)}</span>`
            : '<span style="color:var(--text-muted)">—</span>'}
      </td>
      <td style="white-space:nowrap">${quoteCell}</td>
      <td style="white-space:nowrap" class="cell-targetsl">${c ? renderTargetSL(c, orb) : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td class="maxqty-cell" style="font-weight:700;color:#6C5CE7">${maxQty}</td>
      <td class="cell-newlow">${newLowCell}</td>
      <td class="cell-pullback">${pullbackCell}</td>
      <td class="cell-breakout">${breakoutCell}</td>
      <td style="color:var(--text-muted);font-size:11px;font-family:ui-monospace,monospace">${lastUpdate}</td>
      <td class="cell-stage" style="color:${stage.color};font-weight:${stage.weight};font-size:11px">${stage.label}</td>
      <td class="cell-action">${orb.entrySignal
        ? `<button class="btn btn-success btn-sm" onclick="placeOrder('${s.sym}')">Buy</button>`
        : '<span style="color:var(--text-muted);font-size:11px">—</span>'}</td>
    </tr>`;
  }).join('');

  if (count) count.textContent = `${sorted.length} / ${SCREENER_ALL_STOCKS.length} shown`;
  renderChips();

/* ---------- B14a. ORB buttons branch (renderStrategyControls) ----------
   USE: ORB branch ke 3 fetch buttons (9:15 candles / Quote H/L / Day HLC).
   ---------- */
  } else {
    strategyButtons = `
      <button id="fetch915Btn" class="btn btn-primary" ${btnStyle} onclick="startFetch()">⚡ Fetch 9:15 Candles</button>
      <button id="fetchQuoteBtn" class="btn btn-outline" ${btnStyle} onclick="startQuoteFetch()">📊 Fetch Quote H/L</button>
      <button id="fetchDayHLCBtn" class="btn btn-outline" ${btnStyle} onclick="startDayHLCFetch()">📅 Fetch Day H/L/C</button>`;
  }

/* ---------- B14b. strategy dropdown UI ----------
   USE: Momentum/Advance-ORB switch dropdown.
   ---------- */
    <select id="strategyDropdown" onchange="onStrategyChange(this.value)"
            style="padding:6px 10px;border:1.5px solid var(--border-soft);border-radius:8px;
                   font-size:12px;font-weight:600;font-family:inherit;
                   background:var(--bg-secondary);color:var(--text-primary);cursor:pointer">
      <option value="momentum">🚀 Momentum</option>
      <option value="advance_orb">🔍 Advance ORB</option>
    </select>

/* ---------- B14c. dropdown value restore ----------
   USE: Dropdown ko active strategy pe set karna.
   ---------- */
  const dd = document.getElementById('strategyDropdown');
  if (dd) dd.value = SCREENER_ACTIVE_STRATEGY;

/* ---------- B14d. onStrategyChange() ----------
   USE: Strategy switch handler (controls re-render + LTP reload + table).
   ---------- */
async function onStrategyChange(value) {
  SCREENER_ACTIVE_STRATEGY = value;
  SCREENER_SORT_BY = 'change';
  SCREENER_SORT_DIR = 'desc';
  SCREENER_STAGE_FILTER = 'all';
  SCREENER_MOMENTUM_FILTER = 'all';

  renderStrategyControls();
  await loadLTP();
  renderScreenerTable();
}

/* ---------- B15. updateLTPCells pivot cell update ----------
   USE: Live tick pe momentum purana Pivot cell update karta tha (column already removed v4.2 me).
   ---------- */
    const pivotEl = row.querySelector('.pivot-cell');
    if (pivotEl && SCREENER_PIVOT[token]) {
      const pivot = SCREENER_PIVOT[token];
      const above = (+price) >= pivot;
      const color = above ? 'var(--success)' : 'var(--danger)';
      const arrow = above ? '▲' : '▼';
      pivotEl.innerHTML = `<span style="color:${color};font-weight:700">${arrow} ₹${pivot.toFixed(2)}</span>`;
    }
