/* ============================================================
   fifteen.js — v1.1  (SEPARATE 15-min backfill, DB-VERIFIED RESUME)
   ------------------------------------------------------------
   - Own button / route / lock (7452) / progress — never touches 5-min flow
   - RESUME LOGIC (v1.1): before fetching, cross-checks DB per stock:
       * expected trading days = last 66 calendar days minus weekends/holidays
         (today counted only after 15:35)
       * a day is "complete" when ws_15min_close has >= 25 candles
       * stocks with ALL days complete  → skipped, ZERO API calls
       * stocks with gaps               → fetched only from their FIRST
         MISSING DAY forward (last-good-row + 1), not from the beginning
       * stocks failed in an earlier run (fifteenFailed) → always re-queued
   - Fetches true OHLCV: tries FIFTEEN_MINUTE; if Angel refuses, merges
     FIVE_MINUTE 3→1 (max-of-highs / min-of-lows / sum-volume = exact)
   - Safety: session error → re-login → 30s → retry → 120s → last retry → stop;
     rate error → 60s → 1 retry → stop; leftovers resume next press
   - Atomic writes: a stock's day rows are upserted only after its full
     fetch succeeds — partial/wrong data can never be stored
   ============================================================ */

let fifteenRunning = false;
const fifteenFailed = new Set();
const fifteenProgress = { running: false, done: 0, total: 0, current: '' };
const sleep15 = ms => new Promise(r => setTimeout(r, ms));
const getIST15 = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000);

/* ---------- group raw Angel candles into 15-min buckets (IST, true OHLCV) ----------
   Works for FIFTEEN_MINUTE rows as-is AND for FIVE_MINUTE rows (3 merge into 1).   */
function group15OHLCV(raw) {
  const byDate = {};
  for (const b of raw) {
    const ms = typeof b[0] === 'number' ? b[0] : new Date(b[0]).getTime();
    if (!Number.isFinite(ms)) continue;
    const d = new Date(ms + 5.5 * 3600 * 1000);
    const date = d.toISOString().slice(0, 10);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (mins < 555 || mins > 929) continue;                 // market window only
    const bucket = mins - ((mins - 555) % 15);              // 9:15, 9:30, 9:45 ...
    byDate[date] = byDate[date] || {};
    const cur = byDate[date][bucket];
    const o = +b[1], h = +b[2], l = +b[3], c = +b[4], v = +b[5] || 0;
    if (!cur) byDate[date][bucket] = { o, h, l, c, v };
    else { cur.h = Math.max(cur.h, h); cur.l = Math.min(cur.l, l); cur.c = c; cur.v += v; }
  }
  const out = {};
  for (const date of Object.keys(byDate)) {
    out[date] = Object.keys(byDate[date]).map(Number).sort((a, b) => a - b).map(k => {
      const x = byDate[date][k];
      const hh = String(Math.floor(k / 60)).padStart(2, '0');
      const mm = String(k % 60).padStart(2, '0');
      return { o: x.o, h: x.h, l: x.l, c: x.c, v: x.v, ts: `${date}T${hh}:${mm}:00.000+05:30` };
    });
  }
  return out;
}

/* ---------- expected trading days in range (weekends + holidays removed) ---------- */
async function expectedDays15(D, rangeStart, todayStr, istMins) {
  let hol = new Set();
  try {
    const { rows } = await D.db.query('SELECT date::text AS d FROM trading_holidays');
    hol = new Set(rows.map(r => r.d));
  } catch {}
  const out = [];
  const d = new Date(rangeStart + 'T00:00:00Z');
  const end = new Date(todayStr + 'T00:00:00Z');
  while (d <= end) {
    const ds = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    const isToday = ds === todayStr;
    if (dow !== 0 && dow !== 6 && !hol.has(ds) && !(isToday && istMins < 15 * 60 + 35)) out.push(ds);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const isSess15 = (D, e) => D.isSessionError(e) || /invalid token/i.test(e?.message || '');

/* ---------- one stock: fetch ONLY from its first missing day + upsert ---------- */
async function backfill15OneStock(D, stock, daysKeep, missingFrom) {
  const token = String(stock.token);
  const ist = getIST15();
  const todayMs = ist.getTime();
  const fromMs = new Date(missingFrom + 'T00:00:00Z').getTime() - 5.5 * 3600 * 1000;
  const calDays = Math.max(1, Math.ceil((todayMs - fromMs) / 86400000));

  let raw;
  try {
    raw = await D.fetchAngelInterval(token, 'FIFTEEN_MINUTE', calDays);
  } catch (e) {
    if (D.isRateError(e) || isSess15(D, e)) throw e;          // never mask safety/session errors
    console.log(`📊 ${stock.sym}: FIFTEEN_MINUTE unavailable → merging FIVE_MINUTE (exact OHLCV)`);
    raw = await D.fetchAngelInterval(token, 'FIVE_MINUTE', calDays);
  }

  const by15 = group15OHLCV(raw);
  const dates = Object.keys(by15).sort().slice(-daysKeep).filter(dt => dt >= missingFrom);
  let saved = 0;
  for (const date of dates) {
    const rowsArr = by15[date];
    if (!rowsArr.length) continue;
    await D.db.query(
      `INSERT INTO strategy_bs_snapshot AS s
         (date, sym, token, strategy_id,
          ws_15min_open, ws_15min_high, ws_15min_low, ws_15min_close, ws_15min_volume, ws_15min_ts, fetched_at)
       VALUES ($1,$2,$3,'momentum',$4::numeric[],$5::numeric[],$6::numeric[],$7::numeric[],$8::numeric[],$9::timestamptz[],NOW())
       ON CONFLICT (date, token, strategy_id) DO UPDATE SET
         ws_15min_open=EXCLUDED.ws_15min_open, ws_15min_high=EXCLUDED.ws_15min_high,
         ws_15min_low=EXCLUDED.ws_15min_low, ws_15min_close=EXCLUDED.ws_15min_close,
         ws_15min_volume=EXCLUDED.ws_15min_volume, ws_15min_ts=EXCLUDED.ws_15min_ts, fetched_at=NOW()`,
      [date, stock.sym, token,
       rowsArr.map(x => x.o), rowsArr.map(x => x.h), rowsArr.map(x => x.l),
       rowsArr.map(x => x.c), rowsArr.map(x => x.v), rowsArr.map(x => x.ts)]
    );
    saved++;
  }
  return saved;
}

/* ---------- the runner ---------- */
async function process15minFetch(D, body) {
  let lockClient = null;
  try {
    lockClient = await D.db.connect();
    const lk = await lockClient.query('SELECT pg_try_advisory_lock(7452) AS got');
    if (!lk.rows[0]?.got) {
      lockClient.release(); lockClient = null;
      fifteenRunning = false; fifteenProgress.running = false;
      console.log('📊 15-min: another 15-min run holds the lock — skipping');
      return;
    }
  } catch (e) {
    try { if (lockClient) lockClient.release(); } catch {}
    fifteenRunning = false; fifteenProgress.running = false;
    return;
  }

  const daysKeep = Math.min(Math.max(+body?.days || 44, 1), 60);
  const ist0 = getIST15();
  const todayStr = ist0.toISOString().slice(0, 10);
  const mins0 = ist0.getUTCHours() * 60 + ist0.getUTCMinutes();
  const rangeStart = new Date(ist0.getTime() - 66 * 86400000).toISOString().slice(0, 10);

  try {
    /* ---- DB cross-check: which stocks are complete, which day is each missing from ---- */
    const expected = await expectedDays15(D, rangeStart, todayStr, mins0);
    const { rows: fullRows } = await D.db.query(
      `SELECT token, array_agg(date::text ORDER BY date) AS dates
       FROM strategy_bs_snapshot
       WHERE strategy_id='momentum' AND ws_15min_close IS NOT NULL
         AND array_length(ws_15min_close,1) >= 25 AND date >= $1
       GROUP BY token`,
      [rangeStart]
    );
    const fullMap = new Map(fullRows.map(r => [String(r.token), new Set(r.dates)]));

    const queue = [];
    let complete = 0;
    for (const s of D.STOCKS) {
      const t = String(s.token);
      const have = fullMap.get(t);
      let missingFrom = null;
      for (const dstr of expected) {
        if (!have || !have.has(dstr)) { missingFrom = dstr; break; }
      }
      if (!missingFrom && !fifteenFailed.has(t)) { complete++; continue; }
      queue.push({ ...s, missingFrom: missingFrom || rangeStart });
    }
    queue.sort((a, b) => String(a.sym).localeCompare(String(b.sym)));

    fifteenProgress.running = true;
    fifteenProgress.done = 0;
    fifteenProgress.total = queue.length;
    fifteenProgress.current = '';
    console.log(`📊 15-min resume check: ${complete} stocks already COMPLETE (0 API calls) | ${queue.length} to fetch (each from its first missing day, expected ${expected.length} days)`);
    if (!queue.length) {
      console.log('✅ 15-min: nothing to fetch — all stocks complete');
      return;
    }

    let ok = 0, fail = 0;
    while (queue.length) {
      if (D.getHistoricalRunning()) {
        console.warn('⏸️ 15-min fetch pausing — 5-min historical is running');
        await sleep15(30000);
        continue;
      }
      const stock = queue.shift();
      fifteenProgress.current = stock.sym;

      if (!D.getSessionStatusREST()?.loggedIn) {
        try { await D.loginREST(); } catch (e) { console.error('🔑 15-min re-login failed:', e.message); }
      }

      try {
        await backfill15OneStock(D, stock, daysKeep, stock.missingFrom);
        ok++; fifteenProgress.done++;
        fifteenFailed.delete(String(stock.token));
      } catch (e) {
        if (isSess15(D, e)) {
          console.error(`🔑 15-min session error on ${stock.sym}: ${e.message} — re-login → wait 30s → retry`);
          try { await D.forceRelogin(); } catch {}
          await sleep15(30000);
          try {
            await backfill15OneStock(D, stock, daysKeep, stock.missingFrom);
            ok++; fifteenProgress.done++;
          } catch (e2) {
            console.warn(`🔑 Still failing on ${stock.sym}: ${e2.message} — re-login → wait 120s → last retry`);
            try { await D.forceRelogin(); } catch {}
            await sleep15(120000);
            try {
              await backfill15OneStock(D, stock, daysKeep, stock.missingFrom);
              ok++; fifteenProgress.done++;
            } catch (e3) {
              console.error(`🛑 Session truly dead on ${stock.sym} (${e3.message}) — STOPPING, leftovers resume next run`);
              fifteenFailed.add(String(stock.token));
              for (const s of queue) fifteenFailed.add(String(s.token));
              break;
            }
          }
        } else if (D.isRateError(e) || /403/.test(e?.message || '')) {
          console.warn(`⛔ 15-min rate-limit on ${stock.sym}: ${e.message} — 60s wait, 1 retry (last)`);
          await sleep15(60000);
          try {
            await backfill15OneStock(D, stock, daysKeep, stock.missingFrom);
            ok++; fifteenProgress.done++;
          } catch (e2) {
            console.error(`🛑 15-min still limited on ${stock.sym} (${e2.message}) — STOPPING, leftovers resume next run`);
            fifteenFailed.add(String(stock.token));
            for (const s of queue) fifteenFailed.add(String(s.token));
            break;
          }
        } else {
          fail++; fifteenProgress.done++;
          fifteenFailed.add(String(stock.token));
          if (fail <= 10) console.warn(`⚠️ 15-min skip ${stock.sym}: ${e.message}`);
        }
      }
      if (ok % 25 === 0 && ok > 0) console.log(`📊 15-min: ${fifteenProgress.done}/${fifteenProgress.total} | ok=${ok} fail=${fail}`);
      await sleep15(1500);
    }
    console.log(`✅ 15-min fetch DONE | ok=${ok} fail=${fail} | retry_pending=${fifteenFailed.size}`);
  } catch (e) {
    console.error('15-min fetch error:', e);
  } finally {
    fifteenRunning = false;
    fifteenProgress.running = false;
    fifteenProgress.current = '';
    try {
      if (lockClient) {
        await lockClient.query('SELECT pg_advisory_unlock(7452)').catch(() => {});
        lockClient.release();
      }
    } catch {}
  }
}

/* ---------- routes ---------- */
export function registerFifteenRoutes(app, D) {
  app.post('/api/admin/fetch-15min', D.auth, D.adminOnly, async (req, res) => {
    if (fifteenRunning) return res.status(409).json({ error: '15-min fetch already running' });
    if (D.getHistoricalRunning()) return res.status(409).json({ error: '5-min historical is running — try after it finishes' });
    fifteenRunning = true;
    res.json({ ok: true, message: '15-min fetch started in background (DB-verified resume)' });
    process15minFetch(D, req.body).catch(e => {
      console.error('🛑 15-min background error:', e.message);
      fifteenRunning = false;
      fifteenProgress.running = false;
    });
  });

  app.get('/api/admin/fetch-15min-progress', D.auth, (req, res) => {
    res.json({ running: fifteenRunning || fifteenProgress.running, ...fifteenProgress });
  });

  console.log('📊 15-min backfill routes registered (/api/admin/fetch-15min) — DB-verified resume ON');
}
