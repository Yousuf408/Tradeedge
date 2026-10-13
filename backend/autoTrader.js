/* ============================================================
   autoTrader.js — v1.0
   Chip-list auto entry + SL/T1/T2 trail + 15:00 auto square-off

   RULES (user-confirmed):
   - Entry: chip lock (9:15) pe top-10 me RSI >= 70 → turant MARKET BUY
   - Qty = floor(AUTO_PER_TRADE / (entry * 0.01))   (MAXQTY formula, 1% risk)
   - SL = entry - 1%
   - T1 (+1.5%) hit → koi exit nahi, SL → ENTRY (breakeven)
   - T2 (+2%) hit → koi exit nahi, SL → T1
   - T2 ke baad: trail SL = peak - 0.3%, poore din
   - SL/trail hit → MARKET SELL (full qty)
   - 15:00 IST → auto square-off (full qty, market)
   - Same stock me dobara entry nahi (1 trade/stock/day)
   - SAFETY: env AUTO_TRADE=true → LIVE orders; default PAPER (log-only)
   - Restart-safe: positions DB table auto_positions me
   ============================================================ */

let db = null;
let getJwt = null;
let apiKey = null;
let clientCode = null;
let symByToken = {};
let getLtp = () => null;
let perTrade = 10000;
let live = false;

const positions = new Map();   // token -> pos
let posDate = null;
let sqDoneDate = null;

const getIST = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000);
const todayIST = () => getIST().toISOString().split('T')[0];

export function initAutoTrader(deps) {
  db = deps.db;
  getJwt = deps.getJwt;
  apiKey = deps.apiKey;
  clientCode = deps.clientCode;
  symByToken = deps.symByToken || {};
  getLtp = deps.getLtp || (() => null);
  perTrade = deps.perTrade || 10000;
  live = String(process.env.AUTO_TRADE).toLowerCase() === 'true';
  console.log(`🤖 AutoTrader init — mode: ${live ? '🔴 LIVE' : '📝 PAPER'} | perTrade ₹${perTrade}`);
  startSquareOffWatch();
}

/* ---------- Angel placeOrder (MARKET, INTRADAY) ---------- */
async function placeOrder({ token, sym, side, qty }) {
  const jwt = getJwt ? getJwt() : null;
  if (!jwt) throw new Error('No Angel JWT');
  const r = await fetch('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': apiKey,
      'Authorization': 'Bearer ' + jwt
    },
    body: JSON.stringify({
      variety: 'NORMAL',
      exchange: 'NSE',
      symboltoken: String(token),
      transactiontype: side,           // BUY | SELL
      quantity: qty,
      ordertype: 'MARKET',
      producttype: 'INTRADAY',
      duration: 'DAY',
      price: 0,
      squareoff: 0,
      stoploss: 0,
      tradingsymbol: sym
    })
  });
  const j = await r.json();
  if (!j.status) throw new Error(j.message || 'order rejected');
  return j.data?.orderid || null;
}

/* ---------- ENTRY: chip lock pe ---------- */
export async function onChipLock(chips, date) {
  if (posDate !== date) {
    positions.clear();
    posDate = date;
    await loadOpenPositions(date);
  }
  for (const c of chips) {
    const token = String(c.token);
    if (positions.has(token)) continue;                 // no re-entry
    const ltp = getLtp(token);
    if (!ltp || ltp <= 0) continue;
    const qty = Math.floor(perTrade / (ltp * 0.01));    // MAXQTY formula (1% risk)
    if (qty < 1) continue;

    const pos = {
      token, sym: c.sym || symByToken[token] || '?', qty,
      entry: +ltp.toFixed(2),
      sl: +(ltp * 0.99).toFixed(2),
      t1: +(ltp * 1.015).toFixed(2),
      t2: +(ltp * 1.02).toFixed(2),
      stage: 0, peak: +ltp.toFixed(2),
      status: 'open', reason: null, exitPrice: null,
      entryAt: new Date().toISOString(), exitAt: null
    };
    positions.set(token, pos);
    try {
      if (live) {
        const oid = await placeOrder({ token, sym: pos.sym, side: 'BUY', qty });
        console.log(`🤖 BUY ${pos.sym} qty=${qty} @${pos.entry} SL=${pos.sl} T1=${pos.t1} T2=${pos.t2} order=${oid}`);
      } else {
        console.log(`🤖 [PAPER] BUY ${pos.sym} qty=${qty} @${pos.entry} SL=${pos.sl} T1=${pos.t1} T2=${pos.t2}`);
      }
      await savePos(pos, date);
    } catch (e) {
      console.error(`🤖 BUY failed ${pos.sym}: ${e.message}`);
      positions.delete(token);
    }
  }
}

/* ---------- TICK MONITOR: SL / T1 / T2 / trail ---------- */
export function onTickPos(token, ltp) {
  const pos = positions.get(String(token));
  if (!pos || pos.status !== 'open') return;
  let changed = false;

  if (pos.stage === 0 && ltp >= pos.t1) {
    pos.stage = 1; pos.sl = pos.entry; changed = true;
    console.log(`🤖 ${pos.sym} T1 hit (${ltp}) → SL = entry ${pos.sl}`);
  }
  if (pos.stage === 1 && ltp >= pos.t2) {
    pos.stage = 2; pos.sl = pos.t1; pos.peak = ltp; changed = true;
    console.log(`🤖 ${pos.sym} T2 hit (${ltp}) → SL = T1 ${pos.sl}, trail 0.3% ON`);
  }
  if (pos.stage === 2) {
    if (ltp > pos.peak) pos.peak = ltp;
    const trail = +(pos.peak * 0.997).toFixed(2);
    if (trail > pos.sl) { pos.sl = trail; changed = true; }
  }

  if (ltp <= pos.sl) {
    const reason = pos.stage === 2 ? 'TRAIL_SL' : (pos.stage === 1 ? 'BE_SL' : 'SL');
    exitPosition(pos, ltp, reason);
    return;
  }
  if (changed) savePos(pos, posDate).catch(() => {});
}

/* ---------- EXIT ---------- */
async function exitPosition(pos, price, reason) {
  pos.status = 'closed';
  pos.reason = reason;
  pos.exitPrice = +price.toFixed(2);
  pos.exitAt = new Date().toISOString();
  try {
    if (live) {
      const oid = await placeOrder({ token: pos.token, sym: pos.sym, side: 'SELL', qty: pos.qty });
      console.log(`🤖 SELL ${pos.sym} qty=${pos.qty} @~${price} (${reason}) order=${oid}`);
    } else {
      console.log(`🤖 [PAPER] SELL ${pos.sym} qty=${pos.qty} @${price} (${reason})`);
    }
  } catch (e) {
    console.error(`🤖 SELL FAILED ${pos.sym} (${reason}): ${e.message} — MANUAL EXIT NEEDED`);
  }
  savePos(pos, posDate).catch(() => {});
}

/* ---------- 15:00 AUTO SQUARE-OFF ---------- */
function startSquareOffWatch() {
  setInterval(() => {
    const ist = getIST();
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const date = todayIST();
    if (mins >= 15 * 60 && mins < 15 * 60 + 10 && sqDoneDate !== date) {
      sqDoneDate = date;
      console.log('🤖 15:00 — auto square-off starting');
      squareOffAll('EOD_15:00');
    }
  }, 15000);
}

export function squareOffAll(reason) {
  for (const pos of positions.values()) {
    if (pos.status !== 'open') continue;
    const ltp = getLtp(pos.token) || pos.entry;
    exitPosition(pos, ltp, reason);
  }
}

/* ---------- DB PERSIST (restart-safe) ---------- */
async function savePos(p, date) {
  if (!db) return;
  await db.query(
    `INSERT INTO auto_positions
       (date, token, sym, qty, entry, sl, t1, t2, stage, peak, status, exit_price, exit_reason, entry_at, exit_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
     ON CONFLICT (date, token) DO UPDATE SET
       sl=EXCLUDED.sl, stage=EXCLUDED.stage, peak=EXCLUDED.peak,
       status=EXCLUDED.status, exit_price=EXCLUDED.exit_price,
       exit_reason=EXCLUDED.exit_reason, exit_at=EXCLUDED.exit_at, updated_at=NOW()`,
    [date, p.token, p.sym, p.qty, p.entry, p.sl, p.t1, p.t2, p.stage, p.peak,
     p.status, p.exitPrice, p.reason, p.entryAt, p.exitAt]
  );
}

export async function loadOpenPositions(date) {
  if (!db) return;
  try {
    const { rows } = await db.query(
      `SELECT token, sym, qty, entry, sl, t1, t2, stage, peak, status, exit_price, exit_reason, entry_at, exit_at
       FROM auto_positions WHERE date=$1`,
      [date]
    );
    for (const r of rows) {
      positions.set(String(r.token), {
        token: String(r.token), sym: r.sym, qty: +r.qty,
        entry: +r.entry, sl: +r.sl, t1: +r.t1, t2: +r.t2,
        stage: +r.stage, peak: r.peak != null ? +r.peak : +r.entry,
        status: r.status, reason: r.exit_reason,
        exitPrice: r.exit_price != null ? +r.exit_price : null,
        entryAt: r.entry_at, exitAt: r.exit_at
      });
    }
    posDate = date;
    const open = rows.filter(r => r.status === 'open').length;
    console.log(`🤖 Positions loaded: ${rows.length} total, ${open} open`);
  } catch (e) {
    console.error('🤖 Positions load failed:', e.message);
  }
}

export function getPositions() {
  return [...positions.values()];
}
