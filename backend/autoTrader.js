/* ============================================================
   autoTrader.js — v5.0 (Bigplayer Only — Top RVOL Engine)
   ============================================================ */

const MAX_ENTRIES_PER_USER = Number(process.env.MAX_ENTRIES || 10);

/* ---- BIGPLAYER ENGINE ---- */
const BIGPLAYER_ENABLED = String(process.env.BIGPLAYER_ENGINE ?? 'true') === 'true';
const BIGPLAYER_ENTRY_END_MIN = Number(process.env.BIGPLAYER_ENTRY_END_MIN ?? 14 * 60 + 30);
const bigPlayerEntered = new Set(); // token -> already entered today

// 🆕 Top RVOL Tracking
let topRvolToken = null;
let topRvolValue = 0;
let rvolLocked = false;

let db = null;
let getJwt = null;
let apiKey = null;
let clientCode = null;
let symByToken = {};
let getLtp = () => null;
let getLev = null;
let getDayOpen = () => null;
let getUsers = async () => [];
let getRvol = () => null;
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
  getDayOpen = deps.getDayOpen || (() => null);
  getUsers = deps.getUsers || (async () => []);
  getRvol = deps.getRvol || (() => null);
  live = String(process.env.AUTO_TRADE).toLowerCase() === 'true';
  
  console.log(`🤖 AutoTrader v5.0 init — mode: ${live ? '🔴 LIVE' : '📝 PAPER'} | BIGPLAYER: ${BIGPLAYER_ENABLED ? 'ON' : 'OFF'}`);
  startSquareOffWatch();
}

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

/* ============================================================
   BIGPLAYER ENGINE — (Top RVOL Only)
   ============================================================ */
function lockTopRvol() {
  if (rvolLocked) return;
  rvolLocked = true;
  
  let maxRv = 0;
  let bestTk = null;

  // Iterate all active stocks to find the one with highest 1st-minute RVOL
  for (const s of Object.values(symByToken)) {
    const tk = String(s.token || Object.keys(symByToken).find(k => symByToken[k] === s));
    if (!tk) continue;
    const rv = getRvol(tk);
    if (rv != null && rv > maxRv) {
      maxRv = rv;
      bestTk = tk;
    }
  }

  if (bestTk && maxRv >= 0.05) {
    topRvolToken = bestTk;
    topRvolValue = maxRv;
    console.log(`🏆 BIGPLAYER: Locked TOP RVOL stock -> ${symByToken[bestTk]} | RVOL: ${maxRv}`);
  } else {
    console.log(`🏆 BIGPLAYER: No stock found with RVOL >= 0.05`);
  }
}

function bigPlayerOnTick(tk, ltp) {
  if (!BIGPLAYER_ENABLED || bigPlayerEntered.has(tk)) return;
  
  const ist = getIST();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  // Take entry strictly AFTER 9:16 AM
  if (mins < 9 * 60 + 16 || mins >= BIGPLAYER_ENTRY_END_MIN) return;
  
  // Lock the top RVOL stock on the first tick after 9:16
  if (!rvolLocked) lockTopRvol();
  
  // Only trade the token that has the highest RVOL
  if (!topRvolToken || tk !== topRvolToken) return;

  if (!Number.isFinite(ltp) || ltp <= 0) return;
  const open = getDayOpen(tk);
  if (!open || open <= 0) return;

  // Condition: LTP > Open
  if (ltp <= open) return;

  // Condition: Move >= 0.5%
  const movePct = ((ltp - open) / open) * 100;
  if (movePct < 0.5) return;

  // Execute Entry
  bigPlayerEntered.add(tk);
  const sl = ltp * 0.98; // 2% Stop Loss
  
  console.log(`🚀 BIGPLAYER TRIGGER ${symByToken[tk] || tk} BUY @${ltp} | Move: ${movePct.toFixed(2)}% | RVOL: ${topRvolValue}`);
  placeEntries(tk, { sym: symByToken[tk] || '?', side: 'BUY', sl, strat: 'bigplayer', tag: 'BIGPLAYER' }, ltp)
    .catch(e => console.error('🤖 Bigplayer entry error:', e.message));
}

async function placeEntries(tk, o, ltp) {
  if (posDate !== todayIST()) {
    positions.clear();
    liveOrdered.clear();
    posDate = todayIST();
  }
  const users = await getUsers();
  for (const u of users) {
    const userMode = u.sideMode || 'MIX';
    if (userMode !== 'MIX' && userMode !== o.side) continue;

    let userEntryCount = 0;
    for (const p of positions.values()) if (p.userId === u.userId) userEntryCount++;
    if (userEntryCount >= MAX_ENTRIES_PER_USER) continue;

    let already = false;
    for (const p of positions.values()) {
      if (p.userId === u.userId && p.token === tk && p.status === 'open') { already = true; break; }
    }
    if (already) continue;

    const key = pkey(u.userId, tk, o.side);
    if (positions.has(key)) continue;

    const entryLtp = getLtp(tk) || ltp;
    if (!entryLtp || entryLtp <= 0) continue;
    const lev = getLev ? getLev('angelone', tk) : null;
    const qty = (lev && lev > 0)
      ? Math.floor((u.capital * lev) / entryLtp)
      : Math.floor(u.capital / (entryLtp * 0.01));
    if (qty < 1) continue;

    const pos = {
      userId: u.userId, token: tk, sym: o.sym || symByToken[tk] || '?', qty,
      side: o.side,
      entry: +entryLtp.toFixed(2),
      sl: +o.sl.toFixed(2),
      stage: 0,
      peak: +entryLtp.toFixed(2),
      status: 'open', reason: null, exitPrice: null,
      entryAt: new Date().toISOString(), exitAt: null,
      strat: o.strat
    };
    positions.set(key, pos);

    const orderKey = `${o.side}:${tk}`;
    if (live && !liveOrdered.has(orderKey)) {
      liveOrdered.add(orderKey);
      try {
        const oid = await placeOrder({ token: tk, sym: pos.sym, side: pos.side, qty: pos.qty });
        console.log(`🤖 ${o.tag} ${pos.side} ${pos.sym} qty=${pos.qty} @${pos.entry} SL=${pos.sl} order=${oid}`);
      } catch (e) {
        console.error(`🤖 ${o.tag} failed ${pos.sym}: ${e.message}`);
      }
    } else if (!live) {
      console.log(`🤖 [PAPER] ${o.tag} ${pos.side} ${pos.sym} qty=${pos.qty} @${pos.entry} SL=${pos.sl} user=${u.userId}`);
    }
    savePos(pos, posDate).catch(() => {});
  }
}

/* ============================================================
   MAIN TICK HANDLER
   ============================================================ */
export function onTickPos(token, ltp) {
  const tk = String(token);

  // 1. Fire Entries
  bigPlayerOnTick(tk, ltp);

  // 2. Manage Open Positions
  for (const [key, pos] of positions) {
    if (pos.token !== tk || pos.status !== 'open') continue;
    let changed = false;

    if (pos.strat === 'bigplayer') {
      if (pos.stage === 0) {
        const ctcTarget = 2.0; // 2% CTC
        
        const ctcHit = pos.side === 'BUY'
          ? ltp >= pos.entry * (1 + ctcTarget / 100)
          : ltp <= pos.entry * (1 - ctcTarget / 100);
          
        if (ctcHit) {
          pos.stage = 1;
          pos.sl = pos.side === 'BUY'
            ? Math.max(pos.sl, +pos.entry.toFixed(2))
            : Math.min(pos.sl, +pos.entry.toFixed(2));
          changed = true;
          console.log(`🤖 BIGPLAYER ${pos.sym}: +${ctcTarget}% reached → SL to CTC @${pos.sl}`);
        }
      }
       
      const hitSL = pos.side === 'BUY' ? ltp <= pos.sl : ltp >= pos.sl;
      if (hitSL) {
        exitPosition(pos, ltp, pos.stage >= 1 ? 'CTC' : 'SL');
        continue;
      }
      if (changed) savePos(pos, posDate).catch(() => {});
      continue;
    }
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
       (date, token, user_id, sym, qty, entry, sl, stage, peak, status, exit_price, exit_reason, entry_at, exit_at, updated_at, side)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15)
     ON CONFLICT (date, token, user_id) DO UPDATE SET
       sl=EXCLUDED.sl, stage=EXCLUDED.stage, peak=EXCLUDED.peak,
       status=EXCLUDED.status, exit_price=EXCLUDED.exit_price,
       exit_reason=EXCLUDED.exit_reason, exit_at=EXCLUDED.exit_at, updated_at=NOW(), side=EXCLUDED.side`,
    [date, p.token, p.userId, p.sym, p.qty, p.entry, p.sl, p.stage, p.peak,
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
        entry: +r.entry, sl: +r.sl,
        stage: +r.stage, peak: r.peak != null ? +r.peak : +r.entry,
        status: r.status, reason: r.exit_reason,
        exitPrice: r.exit_price != null ? +r.exit_price : null,
        entryAt: r.entry_at, exitAt: r.exit_at
      });
    }
    posDate = date;
    for (const r of rows) {
      bigPlayerEntered.add(String(r.token)); // Restore Bigplayer state
    }
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
