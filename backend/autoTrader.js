/* ============================================================
   autoTrader.js — v1.3 (Top Performing entry rules)
   ------------------------------------------------------------
   - Capital user ke browser se real-time aata hai (POST /api/auto/capital)
     → server memory me per-user; DB me capital SAVE NAHI hota
   - Positions per-user: auto_positions me user_id ke saath (DB = record)
   - Qty = floor(user_capital × leverage / LTP)  ← page ke MAXQTY jaisi
   - v1.3 TRADE RULES (server v5.20 entry engine ke saath):
       · Candidate universe = Top Performing chip (gap-up <3% wale stocks)
       · Entry  = day-open se +1% cross hone pe (9:15–11:00 window, server side)
       · SL     = DAY OPEN price (initial)
       · +0.7%  = entry se upar → SL = COST (entry price)      [stage 1]
       · T1 +1% = hit → SL = T1, phir TRAIL ON (peak − 0.2%)   [stage 2]
       · T2 +1.5% = milestone — trail continue, koi booking nahi [stage 3]
       · Exit = LTP ≤ SL (SL / BE_SL / TRAIL_SL) ya 15:00 square-off
   - LIVE mode (AUTO_TRADE=true): broker account EK hai (server wala),
     isliye broker order har token pe EK BAAR jata hai (pehle position ki qty);
     baaki users ki positions paper-mirror hoti hain.
   - PAPER mode (default): koi broker order nahi, sirf per-user book
   ============================================================ */

/* v1.3: trade rule constants (env se override possible) */
const BE_TRIGGER_PCT = Number(process.env.AT_BE_PCT ?? 0.7);    // entry +0.7% → SL = cost
const T1_PCT         = Number(process.env.AT_T1_PCT ?? 1.0);    // T1 = entry +1%
const T2_PCT         = Number(process.env.AT_T2_PCT ?? 1.5);    // T2 = entry +1.5% (milestone)
const TRAIL_PCT      = Number(process.env.AT_TRAIL_PCT ?? 0.2); // T1 ke baad peak se trail %

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
  console.log(`🤖 AutoTrader v1.3 init — mode: ${live ? '🔴 LIVE' : '📝 PAPER'} | rules: SL=DayOpen · +${BE_TRIGGER_PCT}%→Cost · T1=+${T1_PCT}%→SL@T1+trail${TRAIL_PCT}% · T2=+${T2_PCT}% milestone`);
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

      // v1.3: SL = DAY OPEN (entry engine cand.dayOpen bhejta hai); fallback = 1% below entry
      const dayOpen = (c.dayOpen != null && +c.dayOpen > 0) ? +c.dayOpen : null;
      const pos = {
        userId: u.userId, token, sym: c.sym || symByToken[token] || '?', qty,
        entry: +ltp.toFixed(2),
        sl: dayOpen != null ? +dayOpen.toFixed(2) : +(ltp * 0.99).toFixed(2),
        t1: +(ltp * (1 + T1_PCT / 100)).toFixed(2),
        t2: +(ltp * (1 + T2_PCT / 100)).toFixed(2),
        stage: 0, peak: +ltp.toFixed(2),
        status: 'open', reason: null, exitPrice: null,
        entryAt: new Date().toISOString(), exitAt: null
      };
      positions.set(key, pos);
      if (dayOpen == null) console.warn(`🤖 ⚠️ ${pos.sym}: dayOpen missing → SL fallback 1% below entry`);

      // LIVE: broker order token-pe-ek-baar (single account), qty = pehli position
      if (live && !liveOrdered.has(token)) {
        liveOrdered.add(token);
        try {
          const oid = await placeOrder({ token, sym: pos.sym, side: 'BUY', qty: pos.qty });
          console.log(`🤖 BUY ${pos.sym} qty=${pos.qty} @${pos.entry} SL=${pos.sl}${dayOpen != null ? '(dayOpen)' : '(fallback)'} T1=${pos.t1} T2=${pos.t2} user=${u.userId} order=${oid}`);
        } catch (e) {
          console.error(`🤖 BUY failed ${pos.sym}: ${e.message}`);
        }
      } else if (!live) {
        console.log(`🤖 [PAPER] BUY ${pos.sym} qty=${pos.qty} @${pos.entry} SL=${pos.sl}${dayOpen != null ? '(dayOpen)' : '(fallback)'} T1=${pos.t1} T2=${pos.t2} user=${u.userId} (capital ₹${u.capital})`);
      }
      savePos(pos, date).catch(() => {});
    }
  }
}

/* ---------- TICK MONITOR: SL / BE / T1 / T2 / trail (sab users) ----------
   v1.3 stages: 0=fresh (SL@dayOpen) → 1=BE (+0.7% → SL@cost)
                → 2=T1 hit (SL@T1, trail peak−0.2% ON) → 3=T2 milestone (trail continue) */
export function onTickPos(token, ltp) {
  const tk = String(token);
  for (const [key, pos] of positions) {
    if (pos.token !== tk || pos.status !== 'open') continue;
    let changed = false;
    const beTrigger = pos.entry * (1 + BE_TRIGGER_PCT / 100);

    // +0.7% entry se upar → SL = COST (entry price)
    if (pos.stage === 0 && ltp >= beTrigger) {
      pos.stage = 1;
      if (pos.entry > pos.sl) pos.sl = pos.entry;
      changed = true;
      console.log(`🤖 ${pos.sym} +${BE_TRIGGER_PCT}% cross (${ltp}) → SL = COST ${pos.sl} [${pos.userId}]`);
    }
    // T1 (+1%) hit → SL = T1, trail ON (stage 0 se direct jump bhi possible)
    if ((pos.stage === 0 || pos.stage === 1) && ltp >= pos.t1) {
      pos.stage = 2;
      if (pos.t1 > pos.sl) pos.sl = pos.t1;
      if (ltp > pos.peak) pos.peak = ltp;
      changed = true;
      console.log(`🤖 ${pos.sym} T1 hit (${ltp}) → SL = T1 ${pos.sl}, trail ${TRAIL_PCT}% ON [${pos.userId}]`);
    }
    // T2 (+1.5%) = milestone only — trail continue, koi exit nahi
    if (pos.stage === 2 && ltp >= pos.t2) {
      pos.stage = 3;
      changed = true;
      console.log(`🤖 ${pos.sym} T2 hit (${ltp}) → milestone, trail ${TRAIL_PCT}% continues [${pos.userId}]`);
    }
    // T1 ke baad trail: peak − 0.2%
    if (pos.stage >= 2) {
      if (ltp > pos.peak) pos.peak = ltp;
      const trail = +(pos.peak * (1 - TRAIL_PCT / 100)).toFixed(2);
      if (trail > pos.sl) { pos.sl = trail; changed = true; }
    }

    if (ltp <= pos.sl) {
      exitPosition(pos, ltp, pos.stage >= 2 ? 'TRAIL_SL' : (pos.stage === 1 ? 'BE_SL' : 'SL'));
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

/* v1.3: server entry-engine restart-safe seeding ke liye — positions kis date ke hain */
export function getPositionDate() { return posDate; }
