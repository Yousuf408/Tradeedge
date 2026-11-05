/* ============================================================
   autoTrader.js — v4.0 (VC + ORB + BIGPLAYER Engine)
   ============================================================ */

/* ===== (legacy constants above used ONLY by legacy mgmt block below) ===== */
const MAX_ENTRIES_PER_USER = Number(process.env.MAX_ENTRIES || 10);

/* ---- VC engine config (all switchable from Render env) ---- */
const VC_ENABLED        = String(process.env.VC_ENGINE ?? 'true') === 'true';
const VC_RANGE_MAX_PCT  = Number(process.env.VC_RANGE_MAX_PCT ?? 1.5);
const VC_GAP_MAX_PCT    = Number(process.env.VC_GAP_MAX_PCT ?? 3.0);
const VC_MIN_CANDLE_PCT = Number(process.env.VC_MIN_CANDLE_PCT ?? 1.0);
const VC_CTC_PCT        = Number(process.env.VC_CTC_PCT ?? 1.0);
const VC_ENTRY_END_MIN  = Number(process.env.VC_ENTRY_END_MIN ?? 14 * 60 + 30);
const VC_SECTOR_GATE    = String(process.env.VC_SECTOR_GATE ?? 'true') === 'true';
const VC_ENTRIES        = String(process.env.VC_ENTRIES ?? 'false') === 'true';

/* ---- v3.3 ORB ENTRY ENGINE (9:15–9:30 candle breakout) ---- */
const ORB_MAX_SIZE      = Number(process.env.ORB_MAX_SIZE ?? 1.5);
const ORB_ENTRY_START   = 9 * 60 + 30;
const ORB_ENTRY_END_MIN = Number(process.env.ORB_ENTRY_END_MIN ?? 14 * 60 + 30);
const ORB_SECTOR_GATE   = String(process.env.ORB_SECTOR_GATE ?? 'true') === 'true';
const ORB_ENABLED       = String(process.env.ORB_ENGINE ?? 'true') === 'true';
const orbEntered = new Set();

/* ---- v4.0 BIGPLAYER ENGINE (Open + RVOL) ---- */
const BIGPLAYER_ENABLED = String(process.env.BIGPLAYER_ENGINE ?? 'true') === 'true';
const BIGPLAYER_ENTRY_END_MIN = Number(process.env.BIGPLAYER_ENTRY_END_MIN ?? 14 * 60 + 30);
const bigPlayerEntered = new Set(); // token -> already entered today

let db = null;
let getJwt = null;
let apiKey = null;
let clientCode = null;
let symByToken = {};
let getLtp = () => null;
let getLev = null;
let getDayOpen = () => null;
let getTodayMinutes = () => null;
let getUsers = async () => [];
let sectorByToken = {};
let getOrb = () => null;
let getRvol = () => null; // 🆕 For Bigplayer Engine
let onVCChange = null;
let live = false;

const positions = new Map();
const liveOrdered = new Set();
let posDate = null;
let sqDoneDate = null;

const vcWatch = new Map();
const vcState = new Map();
let vcDate = null;
let vcWatchDateUsed = null;

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
  getTodayMinutes = deps.getTodayMinutes || (() => null);
  getUsers = deps.getUsers || (async () => []);
  sectorByToken = deps.sectorByToken || {};
  getOrb = deps.getOrb || (() => null);
  getRvol = deps.getRvol || (() => null); // 🆕 Injecting RVOL getter
  onVCChange = deps.onVCChange || null;
  live = String(process.env.AUTO_TRADE).toLowerCase() === 'true';
  
  console.log(`🤖 AutoTrader v4.0 init — mode: ${live ? '🔴 LIVE' : '📝 PAPER'} | VC: ${VC_ENABLED ? 'ON' : 'OFF'} | ORB: ${ORB_ENABLED ? 'ON' : 'OFF'} | BIGPLAYER: ${BIGPLAYER_ENABLED ? 'ON' : 'OFF'}`);
  startSquareOffWatch();
}

function vcNotify() { if (onVCChange) { try { onVCChange(); } catch {} } }

function sectorBias(sector) {
  let up = 0, down = 0;
  for (const [t, sec] of Object.entries(sectorByToken)) {
    if (sec !== sector) continue;
    const ltp = getLtp(t);
    const open = getDayOpen(t);
    if (!ltp || ltp <= 0 || !open || open <= 0) continue;
    if (ltp > open) up++;
    else if (ltp < open) down++;
  }
  if (up === down) return { side: null, up, down };
  return { side: up > down ? 'BUY' : 'SELL', up, down };
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
   VC ENGINE — watchlist (pre-market)
   ============================================================ */
export async function loadVCWatchlist(date, watchDate) {
  if (!db || !VC_ENABLED) return;
  try {
    const { rows } = await db.query(
      `SELECT token, sym, day_close, ws_5min_close
       FROM strategy_bs_snapshot
       WHERE strategy_id='momentum' AND date = $1
         AND ws_5min_close IS NOT NULL AND array_length(ws_5min_close,1) >= 30`,
      [watchDate]
    );
    vcWatch.clear();
    for (const r of rows) {
      const arr = r.ws_5min_close.map(Number).slice(-30);
      const hi = Math.max(...arr);
      const lo = Math.min(...arr);
      if (!(lo > 0) || !(r.day_close > 0)) continue;
      const rangePct = (hi - lo) / lo * 100;
      if (rangePct <= VC_RANGE_MAX_PCT) {
        vcWatch.set(String(r.token), { sym: r.sym, pdc: +r.day_close, rangePct: +rangePct.toFixed(2) });
      }
    }
    vcDate = date;
    vcWatchDateUsed = watchDate;
    vcState.clear();
    console.log(`🧿 VC watchlist: ${vcWatch.size} sideways stocks for ${date}`);
    vcNotify();
  } catch (e) {
    console.error('🧿 VC watchlist load failed:', e.message);
  }
}

/* ============================================================
   VC ENGINE — signal candle
   ============================================================ */
export function vcOnMinuteCandle(token, c) {
  if (!VC_ENABLED || !c) return;
  const tk = String(token);
  if (vcDate !== todayIST()) return;
  const w = vcWatch.get(tk);
  if (!w) return;
  if (vcState.has(tk)) return;
  if (!(c.minuteKey >= '09:15')) return;

  const open = getDayOpen(tk);
  if (!open || open <= 0) return;
  const pdc = w.pdc;

  const gap = Math.abs(open - pdc) / pdc * 100;
  if (gap > VC_GAP_MAX_PCT) {
    vcState.set(tk, { done: true, why: 'gap' });
    return;
  }
  const side = open > pdc ? 'BUY' : (open < pdc ? 'SELL' : null);
  if (!side) return;

  const confirmed = side === 'BUY' ? c.close > pdc : c.close < pdc;
  if (!confirmed) return;

  const candleOpen = (c.open > 0) ? c.open : open;
  const movePct = Math.abs(c.close - candleOpen) / candleOpen * 100;
  const mode = movePct >= VC_MIN_CANDLE_PCT ? 'candle' : 'growth';
  const trigger = mode === 'candle'
    ? (side === 'BUY' ? c.high : c.low)
    : +(side === 'BUY' ? open * 1.01 : open * 0.99).toFixed(2);
  const sl = side === 'BUY' ? c.low : c.high;

  vcState.set(tk, { sym: w.sym, side, mode, trigger, sl0: sl, entered: false, open });
  console.log(`🧿 VC setup ${w.sym} ${side} | trigger=${trigger} | SL=${sl}`);
  vcNotify();
}

function vcOnTick(tk, ltp) {
  if (!VC_ENABLED || !VC_ENTRIES) return;
  const st = vcState.get(tk);
  if (!st || st.entered || st.done) return;
  const ist = getIST();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (mins < 9 * 60 + 16 || mins >= VC_ENTRY_END_MIN) return;
  if (!Number.isFinite(ltp) || ltp <= 0) return;

  const hit = st.side === 'BUY' ? ltp >= st.trigger : ltp <= st.trigger;
  if (!hit) return;

  if (VC_SECTOR_GATE) {
    const sector = sectorByToken[tk] || 'MISC';
    const sb = sectorBias(sector);
    if (!sb.up && !sb.down) {
      console.warn(`🧭 VC ${st.sym}: no open-data for sector ${sector} — gate skipped`);
    } else if (sb.side !== st.side) {
      return;
    }
  }

  st.entered = true;
  console.log(`🎯 VC TRIGGER ${st.sym} ${st.side} @${ltp}`);
  vcNotify();
  placeEntries(tk, { sym: st.sym, side: st.side, sl: st.sl0, strat: 'vc', tag: 'VC' }, ltp).catch(e => console.error('🤖 VC entry error:', e.message));
}

/* ============================================================
   v4.0 BIGPLAYER ENGINE — (Open vs LTP + RVOL)
   ============================================================ */
function bigPlayerOnTick(tk, ltp) {
  if (!BIGPLAYER_ENABLED || bigPlayerEntered.has(tk)) return;
  
  const ist = getIST();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (mins < 9 * 60 + 15 || mins >= BIGPLAYER_ENTRY_END_MIN) return;
  if (!Number.isFinite(ltp) || ltp <= 0) return;

  const open = getDayOpen(tk);
  if (!open || open <= 0) return;

  // Condition 1: LTP > Open
  if (ltp <= open) return;

  // Condition 2: RVOL >= 0.05
  const rvol = getRvol(tk);
  if (rvol == null || rvol < 0.05) return;

  // Condition 3: Move >= 0.5%
  const movePct = ((ltp - open) / open) * 100;
  if (movePct < 0.5) return;

  // Execute Entry
  bigPlayerEntered.add(tk);
  
  // 2% Stop Loss
  const sl = ltp * 0.98;
  
  console.log(`🚀 BIGPLAYER TRIGGER ${symByToken[tk] || tk} BUY @${ltp} | Move: ${movePct.toFixed(2)}% | RVOL: ${rvol}`);
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
   VC ENGINE — restart rebuild
   ============================================================ */
export async function rebuildVCState(date) {
  if (!VC_ENABLED || !getTodayMinutes) return;
  vcDate = date;
  vcState.clear();
  let setups = 0, entered = 0;

  for (const [tk, w] of vcWatch) {
    const m = getTodayMinutes(tk);
    if (!m || !m.c || !m.c.length) continue;
    const open = getDayOpen(tk);
    if (!open || open <= 0) continue;

    const gap = Math.abs(open - w.pdc) / w.pdc * 100;
    if (gap > VC_GAP_MAX_PCT) { vcState.set(tk, { done: true, why: 'gap' }); continue; }
    const side = open > w.pdc ? 'BUY' : (open < w.pdc ? 'SELL' : null);
    if (!side) continue;

    let st = null, idx = -1;
    for (let i = 0; i < m.c.length; i++) {
      const ok = side === 'BUY' ? m.c[i] > w.pdc : m.c[i] < w.pdc;
      if (!ok) continue;
      const high = m.h?.[i] ?? m.c[i];
      const low  = m.l?.[i] ?? m.c[i];
      const cOpen0 = i > 0 ? m.c[i - 1] : open;
      const movePct = Math.abs(m.c[i] - cOpen0) / cOpen0 * 100;
      const mode = movePct >= VC_MIN_CANDLE_PCT ? 'candle' : 'growth';
      st = {
        sym: w.sym, side, mode, entered: false, open,
        trigger: mode === 'candle' ? (side === 'BUY' ? high : low) : +(side === 'BUY' ? open * 1.01 : open * 0.99).toFixed(2),
        sl0: side === 'BUY' ? low : high
      };
      idx = i;
      break;
    }
    if (!st) continue;

    for (let i = idx + 1; i < m.c.length; i++) {
      const hi = m.h?.[i] ?? m.c[i];
      const lo = m.l?.[i] ?? m.c[i];
      if (side === 'BUY' ? hi >= st.trigger : lo <= st.trigger) { st.entered = true; break; }
    }
    if (!st.entered) {
      const ltp = getLtp(tk);
      if (ltp && (side === 'BUY' ? ltp >= st.trigger : ltp <= st.trigger)) st.entered = true;
    }
    vcState.set(tk, st);
    setups++;
    if (st.entered) entered++;
  }
  console.log(`🧿 VC state rebuilt: ${setups} setups, ${entered} already triggered`);
  vcNotify();
}

export function getVCStatus() {
  const watch = {};
  for (const [t, w] of vcWatch) watch[t] = { sym: w.sym, pdc: w.pdc, rangePct: w.rangePct };
  const state = {};
  for (const [t, st] of vcState) {
    state[t] = st.done
      ? { done: true, why: st.why || 'gap' }
      : { side: st.side, mode: st.mode, trigger: st.trigger, sl: st.sl0, entered: !!st.entered };
  }
  return { date: vcDate, watchDate: vcWatchDateUsed, watch, state };
}

/* ============================================================
   v3.3 ORB ENTRY ENGINE
   ============================================================ */
function orbOnTick(tk, ltp) {
  if (!ORB_ENABLED || orbEntered.has(tk)) return;
  const ist = getIST();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (mins < ORB_ENTRY_START || mins >= ORB_ENTRY_END_MIN) return;
  if (!Number.isFinite(ltp) || ltp <= 0) return;
  const orb = getOrb(tk);
  if (!orb || !(orb.high > 0) || !(orb.low > 0)) return;
  if (orb.size > ORB_MAX_SIZE) return;
  let side = null;
  if (ltp >= orb.high) side = 'BUY';
  else if (ltp <= orb.low) side = 'SELL';
  if (!side) return;
  
  if (ORB_SECTOR_GATE) {
    const sector = sectorByToken[tk] || 'MISC';
    const sb = sectorBias(sector);
    if (sb.up || sb.down) {
      if (sb.side !== side) {
        return;
      }
    }
  }
  orbEntered.add(tk);
  const sl = side === 'BUY' ? orb.low : orb.high;
  console.log(`🎯 ORB TRIGGER ${symByToken[tk] || tk} ${side} @${ltp} | SL ${sl}`);
  placeEntries(tk, { sym: symByToken[tk] || '?', side, sl, strat: 'orb', tag: 'ORB' }, ltp)
    .catch(e => console.error('🤖 ORB entry error:', e.message));
}

/* ============================================================
   MAIN TICK HANDLER
   ============================================================ */
export function onTickPos(token, ltp) {
  const tk = String(token);

  // 🆕 1. Fire Entries
  orbOnTick(tk, ltp);       
  vcOnTick(tk, ltp);        
  bigPlayerOnTick(tk, ltp); // <-- New Bigplayer Engine

  // 2. Manage Open Positions
  for (const [key, pos] of positions) {
    if (pos.token !== tk || pos.status !== 'open') continue;
    let changed = false;

       /* ---- VC, ORB & BIGPLAYER Positions — CTC at +1% ---- */
    if (pos.strat === 'vc' || pos.strat === 'orb' || pos.strat === 'bigplayer') {
      if (pos.stage === 0) {
        // 🆕 Bigplayer ke liye 2% CTC, baaki ke liye purana VC_CTC_PCT (1%)
        const ctcTarget = pos.strat === 'bigplayer' ? 2.0 : VC_CTC_PCT;
        
        const ctcHit = pos.side === 'BUY'
          ? ltp >= pos.entry * (1 + ctcTarget / 100)
          : ltp <= pos.entry * (1 - ctcTarget / 100);
          
        if (ctcHit) {
          pos.stage = 1;
          pos.sl = pos.side === 'BUY'
            ? Math.max(pos.sl, +pos.entry.toFixed(2))
            : Math.min(pos.sl, +pos.entry.toFixed(2));
          changed = true;
          console.log(`🤖 ${pos.strat.toUpperCase()} ${pos.sym}: +${ctcTarget}% reached → SL to CTC @${pos.sl}`);
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

    /* ---- legacy management ---- */
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
      orbEntered.add(String(r.token));
      bigPlayerEntered.add(String(r.token)); // 🆕 Restore Bigplayer state
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
