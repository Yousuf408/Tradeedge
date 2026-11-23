/* ============================================================
   btstRoutes.js — BTST (Inside Bar / Mother Candle Breakout)
   Mounted at /api/btst in server.js
   ============================================================ */

import express from 'express';
import { placeOrder } from './brokers/kotak/Kotak_Orders.js';

const activeTraders = new Map();
const btstPositions = new Map(); // Tracks active BTST trades for SL/Target

const getIST = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000);
const todayIST = () => getIST().toISOString().split('T')[0];
const pkey = (userId, token) => `${userId}|${token}`;

// Helper to save to DB (Matches autoTrader.js exactly)
async function savePos(db, p) {
  try {
    await db.query(
      `INSERT INTO auto_positions
         (date, token, user_id, sym, qty, entry, sl, stage, peak, status, exit_price, exit_reason, entry_at, exit_at, updated_at, side, strategy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,$16)
       ON CONFLICT (date, token, user_id, strategy) DO UPDATE SET
         sl=EXCLUDED.sl, stage=EXCLUDED.stage, peak=EXCLUDED.peak,
         status=EXCLUDED.status, exit_price=EXCLUDED.exit_price,
         exit_reason=EXCLUDED.exit_reason, exit_at=EXCLUDED.exit_at, updated_at=NOW(), side=EXCLUDED.side`,
      [p.entryDate, p.token, p.userId, p.sym, p.qty, p.entry, p.sl, p.stage, p.entry,
       p.status, p.exitPrice, p.reason, p.entryAt, p.exitAt, p.side || 'BUY', 'BTST']
    );
  } catch (e) {
    console.error('BTST DB Save Error:', e.message);
  }
}

export function registerBtstRoutes(app, db) {
  const router = express.Router();

  // ─── 1. SCAN ENDPOINT ──────────────────────────────────
  router.get('/scan', async (req, res) => {
    try {
      const date = req.query.date;
      const strategyId = req.query.strategy || 'momentum';

      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, error: 'date required' });

      const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
      const todayIst = istNow.toISOString().slice(0, 10);
      const isLive = date === todayIst;

      const sql = `
        WITH daily_data AS (
          SELECT sym, date, MAX(token) AS token, MAX(day_high) AS high, MIN(day_low) AS low, MAX(day_close) AS close,
            LEAD(date) OVER (PARTITION BY sym ORDER BY date) AS next_date,
            LEAD(MAX(day_close)) OVER (PARTITION BY sym ORDER BY date) AS next_close,
            LEAD(MAX(day_high), 2) OVER (PARTITION BY sym ORDER BY date) AS next2_high
          FROM strategy_bs_snapshot
          WHERE day_high IS NOT NULL AND day_low IS NOT NULL AND strategy_id = $2
            AND date BETWEEN ($1::date - 60) AND ($1::date + 3)
          GROUP BY sym, date
        )
        SELECT t.sym, t.token, m.date AS mother_date, m.high AS mother_high, m.low AS mother_low,
          t.high AS inside_high, t.low AS inside_low, (t.date - m.date) AS days_inside,
          CASE WHEN t.next_close > m.high THEN ROUND(((t.next_close - m.high) / NULLIF(m.high, 0)) * 100, 2) ELSE NULL END AS change_pct,
          CASE WHEN t.next_close > m.high THEN ROUND(((t.next2_high - m.high) / NULLIF(m.high, 0)) * 100, 2) ELSE NULL END AS t1_pct,
          bt.breakout_ts, bt.breakout_time_ist, bt.breakout_rvol,
          CASE WHEN t.next_close > m.high THEN 'Yes' ELSE 'No' END AS is_breakout
        FROM daily_data t
        CROSS JOIN LATERAL (
          SELECT d.date, d.high, d.low FROM daily_data d
          WHERE d.sym = t.sym AND d.date < t.date
            AND d.high >= (SELECT MAX(high) FROM daily_data c WHERE c.sym = t.sym AND c.date > d.date AND c.date <= t.date)
            AND d.low  <= (SELECT MIN(low)  FROM daily_data c WHERE c.sym = t.sym AND c.date > d.date AND c.date <= t.date)
          ORDER BY d.date DESC LIMIT 1
        ) m
        LEFT JOIN LATERAL (
          SELECT u.ts AS breakout_ts, to_char(u.ts AT TIME ZONE 'Asia/Kolkata', 'HH24:MI:SS') AS breakout_time_ist,
            (SELECT r.rvol FROM UNNEST(s.ws_1min_ts, s.ws_1min_rvol) AS r(ts, rvol)
             WHERE r.ts >= u.ts - INTERVAL '4 minutes' AND r.ts <= u.ts ORDER BY r.ts DESC LIMIT 1) AS breakout_rvol
          FROM strategy_bs_snapshot s, UNNEST(s.ws_5min_close, s.ws_5min_ts) AS u(close_val, ts)
          WHERE s.sym = t.sym AND s.strategy_id = $2 AND s.date = t.next_date AND u.close_val > m.high
          ORDER BY u.ts ASC LIMIT 1
        ) bt ON TRUE
        WHERE t.date = $1::date ORDER BY change_pct DESC NULLS LAST;
      `;

      const { rows } = await db.query(sql, [date, strategyId]);
      res.json({ success: true, date, isLive, count: rows.length, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── 2. START AUTO-TRADE ────────────────────────────────
  router.post('/start', (req, res) => {
    const { userId, stocks, config } = req.body;
    if (!userId || !stocks) return res.status(400).json({ success: false, error: 'Invalid payload' });

    const list = stocks.map(s => ({
      sym: s.sym, token: String(s.token), mother_high: Number(s.mother_high), triggered: false
    }));

    activeTraders.set(String(userId), { watchlist: list, config });
    res.json({ success: true, count: list.length });
  });

  // ─── 3. STOP AUTO-TRADE ─────────────────────────────────
  router.post('/stop', (req, res) => {
    activeTraders.delete(String(req.body.userId));
    res.json({ success: true });
  });

  // ─── 4. TICK PROCESSOR (Called from server.js) ──────────
  app.processBtstTick = async (token, price) => {
    const tk = String(token);

    // A) Check for NEW Entries
    for (const [userId, data] of activeTraders.entries()) {
      const stock = data.watchlist.find(s => s.token === tk && !s.triggered);
      
      if (stock && Number(price) > stock.mother_high) {
        stock.triggered = true;
        const config = data.config || {};
        
        const pos = {
          userId, token: tk, sym: stock.sym, qty: config.qty || 1,
          side: 'BUY',
          entry: +price.toFixed(2),
          sl: +(price * 0.98).toFixed(2),     // 2% SL
          target: +(price * 1.04).toFixed(2), // 4% Target
          stage: 0, status: 'open', reason: null, exitPrice: null,
          entryAt: new Date().toISOString(), exitAt: null,
          entryDate: todayIST()
        };

        btstPositions.set(pkey(userId, tk), pos);
        savePos(db, pos); // <-- Save to DB immediately

        if (config.tradeMode === 'REAL') {
          console.log(`💸 [BTST] REAL TRADE: Ordering ${stock.sym} @ ₹${price}`);
          placeOrder(userId, { sym: stock.sym, qty: pos.qty, side: 'BUY', price: 0, type: 'MKT', product: config.productType }).catch(e => console.error(e));
        } else {
          console.log(`📝 [BTST] PAPER TRADE: Bought ${pos.qty} x ${stock.sym} @ ₹${price} (SL: ${pos.sl} | Tgt: ${pos.target})`);
        }
      }
    }

    // B) Check for EXITS (Target/SL)
    for (const [key, pos] of btstPositions.entries()) {
      if (pos.token !== tk || pos.status !== 'open') continue;

      // Check Target
      if (pos.stage === 0 && price >= pos.target) {
        pos.stage = 1;
        pos.sl = pos.target; // Trail SL to Target (Lock profit)
        savePos(db, pos);
        console.log(`🤖 BTST ${pos.sym}: Target 4% hit → SL trailed to @${pos.sl}`);
      }

      // Check SL
      if (price <= pos.sl) {
        pos.status = 'closed';
        pos.reason = pos.stage >= 1 ? 'TARGET_TRAIL' : 'SL';
        pos.exitPrice = +price.toFixed(2);
        pos.exitAt = new Date().toISOString();
        
        savePos(db, pos);
        btstPositions.delete(key);

        console.log(`🤖 BTST ${pos.sym}: Exited at ₹${price} (${pos.reason})`);
        
        // If REAL mode, fire sell order
        const mode = activeTraders.get(pos.userId)?.config?.tradeMode;
        if (mode === 'REAL') {
           placeOrder(pos.userId, { sym: pos.sym, qty: pos.qty, side: 'SELL', price: 0, type: 'MKT', product: activeTraders.get(pos.userId).config.productType }).catch(e => console.error(e));
        }
      }
    }
  };

  router.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/api/btst', router);
  console.log('🎯 BTST routes mounted: /api/btst');
}
