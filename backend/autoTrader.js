/* ============================================================
   autoTrader.js — v1.2 (per-user capital & positions)
   ------------------------------------------------------------
   - Capital user ke browser se real-time aata hai (POST /api/auto/capital)
     → server memory me per-user; DB me capital SAVE NAHI hota
   - Positions per-user: auto_positions me user_id ke saath (DB = record)
   - Qty = floor(user_capital × leverage / LTP)  ← page ke MAXQTY jaisi
   - SL/T1/T2/trail/15:00 square-off rules wahi (v1.0 jaise)
   - LIVE mode (AUTO_TRADE=true): broker account EK hai (server wala),
     isliye broker order har token pe EK BAAR jata hai (pehle position ki qty);
     baaki users ki positions paper-mirror hoti hain.
     Per-user broker connect = baad ka phase.
   - PAPER mode (default): koi broker order nahi, sirf per-user book
   ============================================================ */

let db = null;
let getJwt = null;
let apiKey = null;
let clientCode = null;
let symByToken = {};
let getLtp = () => null;
let getLev = null;
let live = false;

const positions = new Map();   // `${userId}|${token}` -> pos
const liveOrdered = new Set(); // token → broker order ja chuka (LIVE mode)
let posDate = null;
let sqDoneDate = null;

const getIST = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000);
const todayIST = () => getIST().toISOString().split('T')[0];
const pkey = (userId, token) => `${userId}|${token}`;

export function initAutoTrader(deps) {
  db = deps.db;
  getJwt = deps.getJwt;
  apiKey = deps.apiKey;
  clientCode = deps.clientCode;
  symByToken = deps.symByToken || {};
  getLtp = deps.getLtp || (() => null);
  getLev = deps.getLeverage || null;
  live = String(process.env.AUTO_TRADE).toLowerCase() === 'true';
  console.log(`🤖 AutoTrader init — mode: ${live ? '🔴 LIVE' : '📝 PAPER'} (per-user capital)`);
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
      transactiontype: side,
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

/* ---------- ENTRY: scan ke baad, per-user positions ---------- */
export async function onEntryScan(cands, date, users) {
  if (posDate !== date) {
    positions.clear();
    liveOrdered.clear();
    posDate = date;
  }
  for (const u of users) {
    for (const c of cands) {
      const token = String(c.token);
      const key = pkey(u.userId, token);
      if (positions.has(key)) continue;                    // no re-entry (per user)
      const ltp = getLtp(token);
      if (!ltp || ltp <= 0) continue;
      const lev = getLev ? getLev('angelone', token) : null;
      const qty = (lev && lev > 0)
        ? Math.floor((u.capital * lev) / ltp)              // page MAXQTY jaisi qty
        : Math.floor(u.capital / (ltp * 0.01));
      if (qty < 1) continue;

      const pos = {
        userId: u.userId, token, sym: c.sym || symByToken[token] || '?', qty,
        entry: +ltp.toFixed(2),
        sl: +(ltp * 0.99).toFixed(2),
        t1: +(ltp * 1.015).toFixed(2),
        t2: +(ltp * 1.02).toFixed(2),
        stage: 0, peak: +ltp.toFixed(2),
        status: 'open', reason: null, exitPrice: null,
        entryAt: new Date().toISOString(), exitAt: null
      };
      positions.set(key, pos);

      // LIVE: broker order token-pe-ek-baar (single account), qty = pehli position
      if (live && !liveOrdered.has(token)) {
        liveOrdered.add(token);
        try {
          const oid = await placeOrder({ token, sym: pos.sym, side: 'BUY', qty: pos.qty });
          console.log(`🤖 BUY ${pos.sym} qty=${pos.qty} @${pos.entry} user=${u.userId} order=${oid}`);
        } catch (e) {
          console.error(`🤖 BUY failed ${pos.sym}: ${e.message}`);
        }
      } else if (!live) {
        console.log(`🤖 [PAPER] BUY ${pos.sym} qty=${pos.qty} @${pos.entry} user=${u.userId} (capital ₹${u.capital})`);
      }
      savePos(pos, date).catch(() => {});
    }
  }
}

/* ---------- TICK MONITOR: SL / T1 / T2 / trail (sab users) ---------- */
export function onTickPos(token, ltp) {
  const tk = String(token);
  for (const [key, pos] of positions) {
    if (pos.token !== tk || pos.status !== 'open') continue;
    let changed = false;

    if (pos.stage === 0 && ltp >= pos.t1) {
      pos.stage = 1; pos.sl = pos.entry; changed = true;
      console.log(`🤖 ${pos.sym} T1 hit (${ltp}) → SL = entry ${pos.sl} [${pos.userId}]`);
    }
    if (pos.stage === 1 && ltp >= pos.t2) {
      pos.stage = 2; pos.sl = pos.t1; pos.peak = ltp; changed = true;
      console.log(`🤖 ${pos.sym} T2 hit (${ltp}) → SL = T1 ${pos.sl}, trail 0.3% ON [${pos.userId}]`);
    }
    if (pos.stage === 2) {
      if (ltp > pos.peak) pos.peak = ltp;
      const trail = +(pos.peak * 0.997).toFixed(2);
      if (trail > pos.sl) { pos.sl = trail; changed = true; }
    }

    if (ltp <= pos.sl) {
      exitPosition(pos, ltp, pos.stage === 2 ? 'TRAIL_SL' : (pos.stage === 1 ? 'BE_SL' : 'SL'));
      continue;
    }
    if (changed) savePos(pos, posDate).catch(() => {});
  }
}

/* ---------- EXIT ---------- */
async function exitPosition(pos, price, reason) {
  pos.status = 'closed';
  pos.reason = reason;
  pos.exitPrice = +price.toFixed(2);
  pos.exitAt = new Date().toISOString();
  if (live && !liveOrdered.has('EXIT:' + pos.token)) {
    liveOrdered.add('EXIT:' + pos.token);
    try {
      const oid = await placeOrder({ token: pos.token, sym: pos.sym, side: 'SELL', qty: pos.qty });
      console.log(`🤖 SELL ${pos.sym} qty=${pos.qty} @~${price} (${reason}) order=${oid}`);
    } catch (e) {
      console.error(`🤖 SELL FAILED ${pos.sym} (${reason}): ${e.message} — MANUAL EXIT NEEDED`);
    }
  } else if (!live) {
    console.log(`🤖 [PAPER] SELL ${pos.sym} qty=${pos.qty} @${price} (${reason}) [${pos.userId}]`);
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
      console.log('🤖 15:00 — auto square-off starting (all users)');
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

/* ---------- DB PERSIST (per-user, restart-safe) ---------- */
async function savePos(p, date) {
  if (!db) return;
  await db.query(
    `INSERT INTO auto_positions
       (date, token, user_id, sym, qty, entry, sl, t1, t2, stage, peak, status, exit_price, exit_reason, entry_at, exit_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
     ON CONFLICT (date, token, user_id) DO UPDATE SET
       sl=EXCLUDED.sl, stage=EXCLUDED.stage, peak=EXCLUDED.peak,
       status=EXCLUDED.status, exit_price=EXCLUDED.exit_price,
       exit_reason=EXCLUDED.exit_reason, exit_at=EXCLUDED.exit_at, updated_at=NOW()`,
    [date, p.token, p.userId, p.sym, p.qty, p.entry, p.sl, p.t1, p.t2, p.stage, p.peak,
     p.status, p.exitPrice, p.reason, p.entryAt, p.exitAt]
  );
}

export async function loadOpenPositions(date, userId) {
  if (!db) return;
  try {
    const q = userId
      ? { text: `SELECT * FROM auto_positions WHERE date=$1 AND user_id=$2`, values: [date, userId] }
      : { text: `SELECT * FROM auto_positions WHERE date=$1`, values: [date] };
    const { rows } = await db.query(q);
    for (const r of rows) {
      positions.set(pkey(r.user_id || 'admin', String(r.token)), {
        userId: r.user_id || 'admin',
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
    console.log(`🤖 Positions loaded: ${rows.length} total, ${open} open${userId ? ` (user=${userId})` : ''}`);
  } catch (e) {
    console.error('🤖 Positions load failed:', e.message);
  }
}

export function getPositions(userId) {
  const out = [];
  for (const pos of positions.values()) {
    if (!userId || pos.userId === userId) out.push(pos);
  }
  return out;
}
