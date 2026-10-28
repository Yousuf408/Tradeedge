/* ============================================================
   autoTrader.js — v3.0 (VC "Sideways-PDC" engine + CTC stop)
   ============================================================
   NEW vs v2.1 (existing order/exit/paper/square-off logic untouched):
   - VC ENGINE (replaces old server-side entry engine, which is now OFF by
     default via ENTRY_ENGINE=vc):
       1. Pre-market watchlist: previous day's last 30 five-min CLOSES
          range <= 1.5%  (user's SQL spec)  → loadVCWatchlist()
       2. 9:15 open vs PDC decides side (open>PDC=BUY, open<PDC=SELL);
          gap > 3% (env) → stock dropped for the day.
       3. First 1-min candle (from 9:15-9:16 onwards) that CLOSES on the
          same side of PDC = signal candle.
             - candle move from open >= 1%  → entry on signal-candle
               high (BUY) / low (SELL) break.
             - candle move < 1%             → entry once LTP grows 1%
               from open (safer vs fake crosses).
       4. SL = opposite end of signal candle. NO trailing.
          At +1% from entry → SL moves to CTC (entry price). That's it.
       5. One setup + one entry per stock per day. Entries until 14:30
          (env VC_ENTRY_END_MIN). Restart-safe: rebuildVCState() replays
          today's stored 1-min arrays.
   - Positions created by VC carry strat='vc' → managed by the new SL/CTC
     rules. Old v2.1 entry/SL/trail code has been fully removed from this
     file and archived in DEAD_CODE_old_entry_engine.js (reference only).
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
let onVCChange = null;
let live = false;

const positions = new Map();
const liveOrdered = new Set();
let posDate = null;
let sqDoneDate = null;

/* ---- VC in-memory state (no DB per tick) ---- */
const vcWatch = new Map();   // token -> { sym, pdc, rangePct }
const vcState = new Map();   // token -> setup state (see vcOnMinuteCandle)
let vcDate = null;
let vcWatchDateUsed = null;  // v3.0.3: which day's candles the watchlist was built from

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
  onVCChange = deps.onVCChange || null;
  live = String(process.env.AUTO_TRADE).toLowerCase() === 'true';
  console.log(`🤖 AutoTrader v3.0 init — mode: ${live ? '🔴 LIVE' : '📝 PAPER'} | VC engine: ${VC_ENABLED ? 'ON' : 'OFF'} | Dynamic MIX Enabled`);
  startSquareOffWatch();
}

function vcNotify() { if (onVCChange) { try { onVCChange(); } catch {} } }

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

/* ============================================================
   VC ENGINE — watchlist (pre-market)
   ============================================================ */
export async function loadVCWatchlist(date, watchDate) {
  if (!db || !VC_ENABLED) return;
  try {
    // v3.0.2: pin ONE date (previous trading day) for ALL stocks — exact match with user's SQL
    const { rows } = await db.query(
      `SELECT token, sym, day_close, ws_5min_close
       FROM strategy_bs_snapshot
       WHERE strategy_id='momentum' AND date = $2
         AND ws_5min_close IS NOT NULL AND array_length(ws_5min_close,1) >= 30`,
      [date, watchDate]
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
    console.log(`🧿 VC watchlist: ${vcWatch.size} sideways stocks for ${date} (built from ${watchDate} candles, last-30 5m range ≤ ${VC_RANGE_MAX_PCT}%)`);
    vcNotify();
  } catch (e) {
    console.error('🧿 VC watchlist load failed:', e.message);
  }
}

/* ============================================================
   VC ENGINE — signal candle (called on every 1-min candle close)
   ============================================================ */
export function vcOnMinuteCandle(token, c) {
  if (!VC_ENABLED || !c) return;
  const tk = String(token);
  if (vcDate !== todayIST()) return;
  const w = vcWatch.get(tk);
  if (!w) return;
  if (vcState.has(tk)) return;                 // first cross wins, one setup per day
  if (!(c.minuteKey >= '09:15')) return;       // ignore anything before first candle

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
  if (!confirmed) return;                      // wait for a candle that closes on our side

  const candleOpen = (c.open > 0) ? c.open : open;   // v3.0.1: 1% check = candle's OWN open vs close
  const movePct = Math.abs(c.close - candleOpen) / candleOpen * 100;
  const mode = movePct >= VC_MIN_CANDLE_PCT ? 'candle' : 'growth';
  const trigger = mode === 'candle'
    ? (side === 'BUY' ? c.high : c.low)
    : +(side === 'BUY' ? open * 1.01 : open * 0.99).toFixed(2);
  const sl = side === 'BUY' ? c.low : c.high;

  vcState.set(tk, { sym: w.sym, side, mode, trigger, sl0: sl, entered: false, open });
  console.log(`🧿 VC setup ${w.sym} ${side} | candle ${c.minuteKey} close ${c.close} vs PDC ${pdc} | move ${movePct.toFixed(2)}% → mode=${mode} | trigger=${trigger} | SL=${sl}`);
  vcNotify();
}

/* ============================================================
   VC ENGINE — tick trigger (called from onTickPos for every tick)
   ============================================================ */
function vcOnTick(tk, ltp) {
  if (!VC_ENABLED) return;
  const st = vcState.get(tk);
  if (!st || st.entered || st.done) return;
  const ist = getIST();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (mins < 9 * 60 + 15 || mins >= VC_ENTRY_END_MIN) return;
  if (!Number.isFinite(ltp) || ltp <= 0) return;

  const hit = st.side === 'BUY' ? ltp >= st.trigger : ltp <= st.trigger;
  if (!hit) return;
  st.entered = true;
  console.log(`🎯 VC TRIGGER ${st.sym} ${st.side} @${ltp} | trigger=${st.trigger} mode=${st.mode}`);
  vcNotify();
  vcPlaceEntries(tk, st, ltp).catch(e => console.error('🤖 VC entry error:', e.message));
}

async function vcPlaceEntries(tk, st, ltp) {
  if (posDate !== todayIST()) {
    positions.clear();
    liveOrdered.clear();
    posDate = todayIST();
  }
  const users = await getUsers();
  for (const u of users) {
    const userMode = u.sideMode || 'MIX';
    if (userMode !== 'MIX' && userMode !== st.side) continue;

    let userEntryCount = 0;
    for (const p of positions.values()) if (p.userId === u.userId) userEntryCount++;
    if (userEntryCount >= MAX_ENTRIES_PER_USER) continue;

    let already = false;
    for (const p of positions.values()) {
      if (p.userId === u.userId && p.token === tk && p.status === 'open') { already = true; break; }
    }
    if (already) continue;

    const key = pkey(u.userId, tk, st.side);
    if (positions.has(key)) continue;

    const entryLtp = getLtp(tk) || ltp;
    if (!entryLtp || entryLtp <= 0) continue;
    const lev = getLev ? getLev('angelone', tk) : null;
    const qty = (lev && lev > 0)
      ? Math.floor((u.capital * lev) / entryLtp)
      : Math.floor(u.capital / (entryLtp * 0.01));
    if (qty < 1) continue;

    const pos = {
      userId: u.userId, token: tk, sym: st.sym || symByToken[tk] || '?', qty,
      side: st.side,
      entry: +entryLtp.toFixed(2),
      sl: +st.sl0.toFixed(2),
      stage: 0,
      peak: +entryLtp.toFixed(2),
      status: 'open', reason: null, exitPrice: null,
      entryAt: new Date().toISOString(), exitAt: null,
      strat: 'vc'
    };
    positions.set(key, pos);

    const orderKey = `${st.side}:${tk}`;
    if (live && !liveOrdered.has(orderKey)) {
      liveOrdered.add(orderKey);
      try {
        const oid = await placeOrder({ token: tk, sym: pos.sym, side: pos.side, qty: pos.qty });
        console.log(`🤖 VC ${pos.side} ${pos.sym} qty=${pos.qty} @${pos.entry} SL=${pos.sl} order=${oid}`);
      } catch (e) {
        console.error(`🤖 VC ${pos.side} failed ${pos.sym}: ${e.message}`);
      }
    } else if (!live) {
      console.log(`🤖 [PAPER] VC ${pos.side} ${pos.sym} qty=${pos.qty} @${pos.entry} SL=${pos.sl} user=${u.userId}`);
    }
    savePos(pos, posDate).catch(() => {});
  }
}

/* ============================================================
   VC ENGINE — restart rebuild (replay today's stored 1-min arrays)
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
      const cOpen0 = i > 0 ? m.c[i - 1] : open;      // v3.0.1: candle's own open (prev close; day-open for 1st)
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
    for (const pos of positions.values()) {
      if (pos.token === tk && pos.status === 'open') pos.strat = 'vc';   // restore mgmt rules after restart
    }
  }
  console.log(`🧿 VC state rebuilt: ${setups} setups, ${entered} already triggered`);
  vcNotify();
}

/* ---------- VC status for screener UI (badge + chip) ---------- */
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

export function onTickPos(token, ltp) {
  const tk = String(token);

  vcOnTick(tk, ltp);   // v3.0: VC entry trigger check (lightweight, in-memory)

  for (const [key, pos] of positions) {
    if (pos.token !== tk || pos.status !== 'open') continue;
    let changed = false;

    /* ---- v3.0: VC positions — candle SL → CTC at +1%, NO trail ---- */
    if (pos.strat === 'vc') {
      if (pos.stage === 0) {
        const ctcHit = pos.side === 'BUY'
          ? ltp >= pos.entry * (1 + VC_CTC_PCT / 100)
          : ltp <= pos.entry * (1 - VC_CTC_PCT / 100);
        if (ctcHit) {
          pos.stage = 1;
          pos.sl = pos.side === 'BUY'
            ? Math.max(pos.sl, +pos.entry.toFixed(2))
            : Math.min(pos.sl, +pos.entry.toFixed(2));
          changed = true;
          console.log(`🤖 VC ${pos.sym}: +${VC_CTC_PCT}% reached → SL to CTC @${pos.sl}`);
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

    /* ---- legacy management (positions without strat) ---- */

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
