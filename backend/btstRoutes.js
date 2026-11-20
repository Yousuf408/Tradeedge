/* ============================================================
   btstRoutes.js — BTST (Inside Bar / Mother Candle Breakout)
   Mounted at /api/btst in server.js
   ============================================================
   Endpoints:
     GET /api/btst/scan?date=YYYY-MM-DD[&strategy=momentum]
       → Returns inside-bar setups + breakout stats for that date.
       → For a LIVE date (today), next_date is unknown → breakout fields null.
         These rows are the watchlist for tomorrow morning.
       → For a PAST date, includes 5-min breakout_time_ist, breakout_rvol,
         and is_breakout (close-confirmed).

   Live monitoring (breaking mother_high intraday) is done FRONTEND-side
   via the existing /api/screener/stream SSE — no backend endpoint needed.
   ============================================================ */

import express from 'express';

export function registerBtstRoutes(app, db) {
  const router = express.Router();

  router.get('/scan', async (req, res) => {
    try {
      const date = req.query.date;
      const strategyId = req.query.strategy || 'momentum';

      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({
          success: false,
          error: 'date param required in YYYY-MM-DD format'
        });
      }
      if (!['momentum', 'BTST'].includes(strategyId)) {
        return res.status(400).json({
          success: false,
          error: "strategy must be 'momentum' or 'BTST'"
        });
      }

      // IST "today" for isLive flag
      const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
      const todayIst = istNow.toISOString().slice(0, 10);
      const isLive = date === todayIst;

      const sql = `
        WITH daily_data AS (
          SELECT
            sym,
            date,
            MAX(token)      AS token,
            MAX(day_high)   AS high,
            MIN(day_low)    AS low,
            MAX(day_close)  AS close,
            LEAD(date)                  OVER (PARTITION BY sym ORDER BY date) AS next_date,
            LEAD(MAX(day_close))        OVER (PARTITION BY sym ORDER BY date) AS next_close,
            LEAD(MAX(day_high), 2)      OVER (PARTITION BY sym ORDER BY date) AS next2_high
          FROM strategy_bs_snapshot
          WHERE day_high IS NOT NULL
            AND day_low  IS NOT NULL
            AND strategy_id = $2
            AND date BETWEEN ($1::date - 60) AND ($1::date + 3)
          GROUP BY sym, date
        )
        SELECT
          t.sym,
          t.token,
          m.date  AS mother_date,
          m.high  AS mother_high,
          m.low   AS mother_low,
          t.high  AS inside_high,
          t.low   AS inside_low,
          (t.date - m.date) AS days_inside,
          CASE WHEN t.next_close > m.high
               THEN ROUND(((t.next_close - m.high) / NULLIF(m.high, 0)) * 100, 2)
               ELSE NULL END AS change_pct,
          CASE WHEN t.next_close > m.high
               THEN ROUND(((t.next2_high - m.high) / NULLIF(m.high, 0)) * 100, 2)
               ELSE NULL END AS t1_pct,
          bt.breakout_ts,
          bt.breakout_time_ist,
          bt.breakout_rvol,
          CASE WHEN t.next_close > m.high THEN 'Yes' ELSE 'No' END AS is_breakout
        FROM daily_data t
        CROSS JOIN LATERAL (
          SELECT d.date, d.high, d.low
          FROM daily_data d
          WHERE d.sym = t.sym
            AND d.date < t.date
            AND d.high >= (SELECT MAX(high) FROM daily_data c
                           WHERE c.sym = t.sym AND c.date > d.date AND c.date <= t.date)
            AND d.low  <= (SELECT MIN(low)  FROM daily_data c
                           WHERE c.sym = t.sym AND c.date > d.date AND c.date <= t.date)
          ORDER BY d.date DESC
          LIMIT 1
        ) m
        LEFT JOIN LATERAL (
          SELECT
            u.ts AS breakout_ts,
            to_char(u.ts AT TIME ZONE 'Asia/Kolkata', 'HH24:MI:SS') AS breakout_time_ist,
            (SELECT r.rvol
             FROM UNNEST(s.ws_1min_ts, s.ws_1min_rvol) AS r(ts, rvol)
             WHERE r.ts >= u.ts - INTERVAL '4 minutes'
               AND r.ts <= u.ts
             ORDER BY r.ts DESC
             LIMIT 1) AS breakout_rvol
          FROM strategy_bs_snapshot s,
               UNNEST(s.ws_5min_close, s.ws_5min_ts) AS u(close_val, ts)
          WHERE s.sym = t.sym
            AND s.strategy_id = $2
            AND s.date = t.next_date
            AND u.close_val > m.high
          ORDER BY u.ts ASC
          LIMIT 1
        ) bt ON TRUE
        WHERE t.date = $1::date
        ORDER BY change_pct DESC NULLS LAST;
      `;

      const t0 = Date.now();
      const { rows } = await db.query(sql, [date, strategyId]);
      const scanMs = Date.now() - t0;

      res.json({
        success: true,
        date,
        strategy: strategyId,
        isLive,
        count: rows.length,
        scanMs,
        data: rows
      });
    } catch (err) {
      console.error('BTST /scan error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/health', (_req, res) => {
    res.json({ ok: true, mounted: '/api/btst', endpoints: ['/scan', '/health'] });
  });

  app.use('/api/btst', router);
  console.log('🎯 BTST routes mounted: /api/btst');
}
