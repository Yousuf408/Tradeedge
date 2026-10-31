/* ============================================================
   fifteen.js — v1.0  (SEPARATE 15-min candle backfill from Angel REST)
   ------------------------------------------------------------
   - Own button / own route / own lock (7452) / own progress state
   - NEVER touches the 5-min historical flow (processHistoricalFetch)
   - Reuses ONLY the safe shared helpers passed via deps (D):
       login/re-login, rate & session error classification, fetchAngelInterval
   - Fetches FULL OHLCV: tries interval FIFTEEN_MINUTE first; if Angel
     rejects the interval, falls back to FIVE_MINUTE and merges 3→1
     (high = max of highs, low = min of lows → exchange-exact)
   - Stores into: ws_15min_open/high/low/close/volume/ts (nullable cols)
   - Window: last N working days (default 44 ≈ 2 months), alphabetical,
     paced 1.5s, same 2-attempt safe-stop rules as the 5-min runner
   - Pauses itself automatically if the 5-min historical run is active
   ============================================================ */

let fifteenRunning = false;
const fifteenFailed = new Set();
const fifteenProgress = { running: false, done: 0, total: 0, current: '' };
const sleep15 = ms => new Promise(r => setTimeout(r, ms));

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

/* ---------- one stock: fetch + upsert ---------- */
async function backfill15OneStock(D, stock, daysKeep) {
  const token = String(stock.token);
  let raw;
  try {
    raw = await D.fetchAngelInterval(token, 'FIFTEEN_MINUTE', 62);   // 62 → ~68 calendar days ≈ 44+ working days
  } catch (e) {
    if (D.isRateError(e) || D.isSessionError(e)) throw e;             // never mask safety errors
    console.log(`📊 ${stock.sym}: FIFTEEN_MINUTE unsupported → merging FIVE_MINUTE`);
    raw = await D.fetchAngelInterval(token, 'FIVE_MINUTE', 62);
  }
  const by15 = group15OHLCV(raw);
  const dates = Object.keys(by15).sort().slice(-daysKeep);
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
  const queue = [...D.STOCKS].sort((a, b) => String(a.sym).localeCompare(String(b.sym)));
  fifteenProgress.running = true;
  fifteenProgress.done = 0;
  fifteenProgress.total = queue.length;
  fifteenProgress.current = '';
  let ok = 0, fail = 0;
  console.log(`📊 15-min fetch start: ${queue.length} stocks | keeping last ${daysKeep} working days | OHLCV`);

  try {
    while (queue.length) {
      // never fight the 5-min historical runner
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
        await backfill15OneStock(D, stock, daysKeep);
        ok++; fifteenProgress.done++;
        fifteenFailed.delete(String(stock.token));
      } catch (e) {
        if (D.isSessionError(e)) {
          console.error(`🔑 15-min session error on ${stock.sym}: ${e.message} — re-login + 1 retry`);
          try { await D.forceRelogin(); } catch {}
          try {
            await backfill15OneStock(D, stock, daysKeep);
            ok++; fifteenProgress.done++;
          } catch (e2) {
            console.error(`🛑 15-min session still dead on ${stock.sym} (${e2.message}) — STOPPING`);
            fifteenFailed.add(String(stock.token));
            for (const s of queue) fifteenFailed.add(String(s.token));
            break;
          }
        } else if (D.isRateError(e) || /403/.test(e?.message || '')) {
          console.warn(`⛔ 15-min rate-limit on ${stock.sym}: ${e.message} — 60s wait, 1 retry (last)`);
          await sleep15(60000);
          try {
            await backfill15OneStock(D, stock, daysKeep);
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
    res.json({ ok: true, message: '15-min fetch started in background' });
    process15minFetch(D, req.body).catch(e => {
      console.error('🛑 15-min background error:', e.message);
      fifteenRunning = false;
      fifteenProgress.running = false;
    });
  });

  app.get('/api/admin/fetch-15min-progress', D.auth, (req, res) => {
    res.json({ running: fifteenRunning || fifteenProgress.running, ...fifteenProgress });
  });

  console.log('📊 15-min backfill routes registered (/api/admin/fetch-15min)');
}
