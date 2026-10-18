/* ============================================================
   autoTrader.js — v1.6 (Live Volume + 1s Scan)
   ============================================================ */

const BE_TRIGGER_PCT = Number(process.env.AT_BE_PCT ?? 0.7);
const T1_PCT         = Number(process.env.AT_T1_PCT ?? 1.0);
const T2_PCT         = Number(process.env.AT_T2_PCT ?? 1.5);
const TRAIL_PCT      = Number(process.env.AT_TRAIL_PCT ?? 0.2);

/* Entry Engine Constants */
const MAX_ENTRIES = Number(process.env.MAX_ENTRIES || 10);
const ENTRY_OPEN_GAIN_PCT = Number(process.env.ENTRY_OPEN_GAIN_PCT || 1.0);       // Min +1%
const ENTRY_MAX_OPEN_GAIN_PCT = Number(process.env.ENTRY_MAX_OPEN_GAIN_PCT || 3.0); // Max +3%
const ENTRY_MIN_VOL = Number(process.env.ENTRY_MIN_VOL || 100000);                // Min 1 Lakh
const ENTRY_GAP_MAX_PCT = Number(process.env.ENTRY_GAP_MAX_PCT || 3.0);
const ENTRY_START_MIN = Number(process.env.ENTRY_START_MIN || 9 * 60 + 15);
const ENTRY_END_MIN = Number(process.env.ENTRY_END_MIN || 11 * 60);
const ENTRY_SCAN_MS = Number(process.env.ENTRY_SCAN_MS || 1000); // 1 second

let deps = {}; 
let entryDay = null;
const entryTriggered = new Set();
let entryCount = 0;

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
const pkey = (userId, token) => `${userId}|${token}`;

export function initAutoTrader(dependencies) {
  deps = dependencies;
  db = deps.db;
  getJwt = deps.getJwt;
  apiKey = deps.apiKey;
  clientCode = deps.clientCode;
  symByToken = deps.symByToken || {};
  getLtp = deps.getLtp || (() => null);
  getLev = deps.getLeverage || null;
  live = String(process.env.AUTO_TRADE).toLowerCase() === 'true';
  
  console.log(`🤖 AutoTrader v1.6 init — mode: ${live ? '🔴 LIVE' : '📝 PAPER'} | SL=DayOpen · T1=+${T1_PCT}%`);
  console.log(`🎯 Entry Engine ON — Scan: ${ENTRY_SCAN_MS/1000}s | Min: +${ENTRY_OPEN_GAIN_PCT}%, Max: +${ENTRY_MAX_OPEN_GAIN_PCT}%, Live Vol > 1L`);
  
  startSquareOffWatch();
  startEntryEngine();
}

/* ---------- ENTRY ENGINE ---------- */
function runEntryScan(date) {
  try {
    if (!date) return;
    if (entryDay !== date) {
      entryDay = date;
      entryTriggered.clear();
      entryCount = 0;
      if (getPositionDate() === date) {
        for (const p of getPositions()) entryTriggered.add(String(p.token));
        entryCount = entryTriggered.size;
        if (entryCount) console.log(`🎯 Entry engine: ${entryCount} tokens aaj already-entered (DB positions se seed)`);
      }
    }

    if (deps.getBsFreshDate() !== date) return;

    const ist = deps.getIST();
    const dow = ist.getUTCDay();
    if (dow < 1 || dow > 5 || !deps.isTradingDay(ist)) return;
    
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (mins < ENTRY_START_MIN || mins >= ENTRY_END_MIN) return;
    if (entryCount >= MAX_ENTRIES) return;

    const cands = [];
    for (const st of deps.stocks) {
      const token = String(st.token);
      if (entryTriggered.has(token)) continue;
      
      const bs = deps.getBsCache().get(token);
      if (!bs) continue;
      
      const dayOpen = bs.dayOpen ?? null;
      const prevClose = deps.getPrevClose(token) || null;
      if (!dayOpen || !prevClose || prevClose <= 0) continue;

      // Sanity guard (±20%)
      if (Math.abs((dayOpen - prevClose) / prevClose) * 100 > 20) continue;

      const gapPct = ((dayOpen - prevClose) / prevClose) * 100;
      if (gapPct >= ENTRY_GAP_MAX_PCT) continue;

      const ltp = deps.getLtp(token);
      if (!ltp) continue;
      
      const openGainPct = ((ltp - dayOpen) / dayOpen) * 100;
      
      // Min +1%
      if (openGainPct < ENTRY_OPEN_GAIN_PCT) continue;             
      
      // Max +3% (No chasing)
      if (openGainPct >= ENTRY_MAX_OPEN_GAIN_PCT) continue;        

      // LIVE Volume Check
      const liveVol = deps.getLiveVol(token);
      if (liveVol < ENTRY_MIN_VOL) continue;                    

      cands.push({
        token, sym: st.sym, dayOpen: +(+dayOpen).toFixed(2),
        gapPct: +gapPct.toFixed(2), openGainPct: +openGainPct.toFixed(2)
      });
    }
    
    if (!cands.length) return;

    cands.sort((a, b) => b.openGainPct - a.openGainPct);
    const list = cands.slice(0, MAX_ENTRIES - entryCount);
    for (const c of list) entryTriggered.add(c.token);
    entryCount += list.length;

    const hh = String(ist.getUTCHours()).padStart(2, '0');
    const mi = String(ist.getUTCMinutes()).padStart(2, '0');
    console.log(`🎯 Entry trigger ${hh}:${mi} — ${list.length} BUY: ${list.map(c => `${c.sym}(+${c.openGainPct}%, LiveVol>1L)`).join(', ')} | today ${entryCount}/${MAX_ENTRIES}`);

    const users = [...deps.getUserCapital().entries()].map(([userId, capital]) => ({ userId, capital }));
    if (!users.length) users.push({ userId: 'admin', capital: Number(process.env.AUTO_PER_TRADE || 25000) });
    
    onEntryScan(list, date, users).catch(e => console.error('🤖 Entry error:', e.message));
  } catch (e) { console.error('Entry scan failed:', e.message); }
}

function startEntryEngine() {
  setInterval(() => {
    const p = deps.getScreenerPhase();
    if (p && p.date) runEntryScan(p.date);
  }, ENTRY_SCAN_MS);
}

/* ---------- ANGEL PLACE ORDER ---------- */
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

/* ---------- ENTRY EXECUTION ---------- */
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
      if (positions.has(key)) continue; 
      
      const ltp = getLtp(token);
      if (!ltp || ltp <= 0) continue;
      const lev = getLev ? getLev('angelone', token) : null;
      const qty = (lev && lev > 0) ? Math.floor((u.capital * lev) / ltp) : Math.floor(u.capital / (ltp * 0.01));
      if (qty < 1) continue;

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

      if (live && !liveOrdered.has(token)) {
        liveOrdered.add(token);
        try {
          const oid = await placeOrder({ token, sym: pos.sym, side: 'BUY', qty: pos.qty });
          console.log(`🤖 BUY ${pos.sym} qty=${pos.qty} @${pos.entry} SL=${pos.sl} order=${oid}`);
        } catch (e) { console.error(`🤖 BUY failed ${pos.sym}: ${e.message}`); }
      } else if (!live) {
        console.log(`🤖 [PAPER] BUY ${pos.sym} qty=${pos.qty} @${pos.entry} SL=${pos.sl} user=${u.userId}`);
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
      await placeOrder({ token: pos.token, sym: pos.sym, side: 'SELL', qty: pos.qty });
    } catch (e) { console.error(`🤖 SELL FAILED ${pos.sym} (${reason}): ${e.message}`); }
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

/* ---------- DB PERSIST ---------- */
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
  } catch (e) { console.error('🤖 Positions load failed:', e.message); }
}

export function getPositions(userId) {
  const out = [];
  for (const pos of positions.values()) {
    if (!userId || pos.userId === userId) out.push(pos);
  }
  return out;
}

export function getPositionDate() { return posDate; }
