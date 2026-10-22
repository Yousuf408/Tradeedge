/* ============================================================
   autoTrader.js — v1.6 (Buy/Sell/Mix 50-50 support)
   ============================================================ */

const BE_TRIGGER_PCT = Number(process.env.AT_BE_PCT ?? 0.7);
const T1_PCT         = Number(process.env.AT_T1_PCT ?? 1.0);
const T2_PCT         = Number(process.env.AT_T2_PCT ?? 1.5);
const TRAIL_PCT      = Number(process.env.AT_TRAIL_PCT ?? 0.2);
const MAX_ENTRIES_PER_USER = Number(process.env.MAX_ENTRIES || 10);

let db = null;
let getJwt = null;
let apiKey = null;
let clientCode = null;
let symByToken = {};
let getLtp = () => null;
let getLev = null;
let live = false;

const positions = new Map();
const liveOrdered = new Set();
let posDate = null;
let sqDoneDate = null;

const getIST = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000);
const todayIST = () => getIST().toISOString().split('T')[0];
const pkey = (userId, token, side) => `${userId}|${token}|${side}`;

export function initAutoTrader(deps) {
  db = deps.db;
  getJwt = deps.getJwt;
  apiKey = deps.apiKey;
  clientCode = deps.clientCode;
  symByToken = deps.symByToken || {};
  getLtp = deps.getLtp || (() => null);
  getLev = deps.getLeverage || null;
  live = String(process.env.AUTO_TRADE).toLowerCase() === 'true';
  console.log(`🤖 AutoTrader v1.6 init — mode: ${live ? '🔴 LIVE' : '📝 PAPER'} | rules: Buy & Sell (Short)`);
  startSquareOffWatch();
}

/* ---------- Angel placeOrder (MARKET, INTRADAY) ---------- */
async function placeOrder({ token, sym, side, qty }) {
  const jwt = getJwt ? getJwt() : null;
  if (!jwt) throw new Error('No Angel JWT');
  const r = await fetch('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Accept': 'application/json',
      'X-UserType': 'USER', 'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': apiKey,
      'Authorization': 'Bearer ' + jwt
    },
    body: JSON.stringify({
      variety: 'NORMAL', exchange: 'NSE', symboltoken: String(token),
      transactiontype: side, quantity: qty, ordertype: 'MARKET',
      producttype: 'INTRADAY', duration: 'DAY', price: 0, squareoff: 0, stoploss: 0, tradingsymbol: sym
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
    const userMode = u.sideMode || 'MIX';

    // Count current positions for this user to enforce limit
    let userEntryCount = 0;
    for (const p of positions.values()) {
      if (p.userId === u.userId) userEntryCount++;
    }
    if (userEntryCount >= MAX_ENTRIES_PER_USER) continue;

    // Filter candidates by user preference
    let userCands = cands.filter(c => userMode === 'MIX' || c.side === userMode);
    userCands.sort((a, b) => Math.abs(b.openGainPct) - Math.abs(a.openGainPct));

    let selectedCands = [];
    
    if (userMode === 'MIX') {
      const buys = userCands.filter(c => c.side === 'BUY');
      const sells = userCands.filter(c => c.side === 'SELL');
      const half = Math.floor(MAX_ENTRIES_PER_USER / 2);

      let pickedBuys = buys.slice(0, half);
      let pickedSells = sells.slice(0, half);

      // Fill missing slots from the other side
      if (pickedBuys.length < half) {
        pickedSells = sells.slice(0, MAX_ENTRIES_PER_USER - pickedBuys.length);
      } else if (pickedSells.length < half) {
        pickedBuys = buys.slice(0, MAX_ENTRIES_PER_USER - pickedSells.length);
      }

      selectedCands = [...pickedBuys, ...pickedSells];
    } else {
      selectedCands = userCands.slice(0, MAX_ENTRIES_PER_USER);
    }

    // Apply remaining slots limit
    const availableSlots = MAX_ENTRIES_PER_USER - userEntryCount;
    selectedCands = selectedCands.slice(0, availableSlots);

    for (const c of selectedCands) {
      const token = String(c.token);
      const key = pkey(u.userId, token, c.side);
      if (positions.has(key)) continue; 
      
      const ltp = getLtp(token);
      if (!ltp || ltp <= 0) continue;
      const lev = getLev ? getLev('angelone', token) : null;
      const qty = (lev && lev > 0)
        ? Math.floor((u.capital * lev) / ltp)
        : Math.floor(u.capital / (ltp * 0.01));
      if (qty < 1) continue;

      const isShort = c.side === 'SELL';
      const dayOpen = (c.dayOpen != null && +c.dayOpen > 0) ? +c.dayOpen : null;
      
      const sl = dayOpen != null 
        ? +dayOpen.toFixed(2) 
        : (isShort ? +(ltp * 1.01).toFixed(2) : +(ltp * 0.99).toFixed(2));
      
      const t1 = isShort ? +(ltp * (1 - T1_PCT / 100)).toFixed(2) : +(ltp * (1 + T1_PCT / 100)).toFixed(2);
      const t2 = isShort ? +(ltp * (1 - T2_PCT / 100)).toFixed(2) : +(ltp * (1 + T2_PCT / 100)).toFixed(2);

      const pos = {
        userId: u.userId, token, sym: c.sym || symByToken[token] || '?', qty,
        side: c.side,
        entry: +ltp.toFixed(2),
        sl, t1, t2,
        stage: 0, 
        peak: +ltp.toFixed(2),
        status: 'open', reason: null, exitPrice: null,
        entryAt: new Date().toISOString(), exitAt: null
      };
      positions.set(key, pos);
      
      if (dayOpen == null) console.warn(`🤖 ⚠️ ${pos.sym}: dayOpen missing → SL fallback`);

      const orderKey = `${c.side}:${token}`;
      if (live && !liveOrdered.has(orderKey)) {
        liveOrdered.add(orderKey);
        try {
          const oid = await placeOrder({ token, sym: pos.sym, side: pos.side, qty: pos.qty });
          console.log(`🤖 ${pos.side} ${pos.sym} qty=${pos.qty} @${pos.entry} SL=${pos.sl} order=${oid}`);
        } catch (e) {
          console.error(`🤖 ${pos.side} failed ${pos.sym}: ${e.message}`);
        }
      } else if (!live) {
        console.log(`🤖 [PAPER] ${pos.side} ${pos.sym} qty=${pos.qty} @${pos.entry} SL=${pos.sl} user=${u.userId}`);
      }
      savePos(pos, date).catch(() => {});
    }
  }
}

/* ---------- TICK MONITOR ---------- */
export function onTickPos(token, ltp) {
  const tk = String(token);
  for (const [key, pos] of positions) {
    if (pos.token !== tk || pos.status !== 'open') continue;
    let changed = false;

    if (pos.side === 'BUY') {
      const beTrigger = pos.entry * (1 + BE_TRIGGER_PCT / 100);
      if (pos.stage === 0 && ltp >= beTrigger) {
        pos.stage = 1;
        if (pos.entry > pos.sl) pos.sl = pos.entry;
        changed = true;
      }
      if ((pos.stage === 0 || pos.stage === 1) && ltp >= pos.t1) {
        pos.stage = 2;
        if (pos.t1 > pos.sl) pos.sl = pos.t1;
        if (ltp > pos.peak) pos.peak = ltp;
        changed = true;
      }
      if (pos.stage === 2 && ltp >= pos.t2) {
        pos.stage = 3;
        changed = true;
      }
      if (pos.stage >= 2) {
        if (ltp > pos.peak) pos.peak = ltp;
        const trail = +(pos.peak * (1 - TRAIL_PCT / 100)).toFixed(2);
        if (trail > pos.sl) { pos.sl = trail; changed = true; }
      }

      if (ltp <= pos.sl) {
        exitPosition(pos, ltp, pos.stage >= 2 ? 'TRAIL_SL' : (pos.stage === 1 ? 'BE_SL' : 'SL'));
        continue;
      }
    } else {
      const beTrigger = pos.entry * (1 - BE_TRIGGER_PCT / 100);
      if (pos.stage === 0 && ltp <= beTrigger) {
        pos.stage = 1;
        if (pos.entry < pos.sl) pos.sl = pos.entry;
        changed = true;
      }
      if ((pos.stage === 0 || pos.stage === 1) && ltp <= pos.t1) {
        pos.stage = 2;
        if (pos.t1 < pos.sl) pos.sl = pos.t1;
        if (ltp < pos.peak) pos.peak = ltp;
        changed = true;
      }
      if (pos.stage === 2 && ltp <= pos.t2) {
        pos.stage = 3;
        changed = true;
      }
      if (pos.stage >= 2) {
        if (ltp < pos.peak) pos.peak = ltp;
        const trail = +(pos.peak * (1 + TRAIL_PCT / 100)).toFixed(2);
        if (trail < pos.sl) { pos.sl = trail; changed = true; }
      }

      if (ltp >= pos.sl) {
        exitPosition(pos, ltp, pos.stage >= 2 ? 'TRAIL_SL' : (pos.stage === 1 ? 'BE_SL' : 'SL'));
        continue;
      }
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
  
  const exitSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
  const exitKey = `EXIT:${pos.side}:${pos.token}`;

  if (live && !liveOrdered.has(exitKey)) {
    liveOrdered.add(exitKey);
    try {
      const oid = await placeOrder({ token: pos.token, sym: pos.sym, side: exitSide, qty: pos.qty });
      console.log(`🤖 ${exitSide} (Exit) ${pos.sym} qty=${pos.qty} @~${price} (${reason}) order=${oid}`);
    } catch (e) {
      console.error(`🤖 EXIT FAILED ${pos.sym} (${reason}): ${e.message} — MANUAL EXIT NEEDED`);
    }
  } else if (!live) {
    console.log(`🤖 [PAPER] ${exitSide} (Exit) ${pos.sym} qty=${pos.qty} @${price} (${reason}) [${pos.userId}]`);
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

/* ---------- DB PERSIST ---------- */
async function savePos(p, date) {
  if (!db) return;
  await db.query(
    `INSERT INTO auto_positions
       (date, token, user_id, sym, qty, entry, sl, t1, t2, stage, peak, status, exit_price, exit_reason, entry_at, exit_at, updated_at, side)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),$17)
     ON CONFLICT (date, token, user_id) DO UPDATE SET
       sl=EXCLUDED.sl, stage=EXCLUDED.stage, peak=EXCLUDED.peak,
       status=EXCLUDED.status, exit_price=EXCLUDED.exit_price,
       exit_reason=EXCLUDED.exit_reason, exit_at=EXCLUDED.exit_at, updated_at=NOW(), side=EXCLUDED.side`,
    [date, p.token, p.userId, p.sym, p.qty, p.entry, p.sl, p.t1, p.t2, p.stage, p.peak,
     p.status, p.exitPrice, p.reason, p.entryAt, p.exitAt, p.side || 'BUY']
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
      positions.set(pkey(r.user_id || 'admin', String(r.token), r.side || 'BUY'), {
        userId: r.user_id || 'admin',
        token: String(r.token), sym: r.sym, qty: +r.qty,
        side: r.side || 'BUY',
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

export function getPositionDate() { return posDate; }
