/* ============================================================
   autoTrader.js — v6.0 (Swing Trading Engine)
   - Fresh Breakout Only (Yesterday High < PWH)
   - Entry: LTP > PWH (1% buffer) + LTP > DayOpen + RVOL >= 1
   - SL: PDL | Target: Entry * 1.04 (4%)
   - Once Target Hit -> SL moves to Target
   - No Auto Square-off (Swing Holding)
   ============================================================ */

const MAX_ENTRIES_PER_USER = Number(process.env.MAX_ENTRIES || 10);
const BIGPLAYER_ENTRY_END_MIN = Number(process.env.BIGPLAYER_ENTRY_END_MIN ?? 14 * 60 + 30);

const bigPlayerEntered = new Set(); // token -> already entered today
const swingData = new Map();        // token -> { pwh, pdl, yestHigh }

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

  console.log(`🤖 AutoTrader v6.0 (SWING) init — mode: ${live ? '🔴 LIVE' : '📝 PAPER'}`);
  
  loadSwingData(); // Initial load
  scheduleSwingDataRefresh();
  // startSquareOffWatch() removed for Swing Trading
}

/* ---------- DB: Load PWH, PDL, Yesterday High ---------- */
async function loadSwingData() {
  if (!db) return;
  try {
    const { rows } = await db.query(`
      WITH prev_week AS (
        SELECT token, MAX(day_high) AS pwh
        FROM strategy_bs_snapshot
        WHERE strategy_id = 'momentum'
          AND date >= date_trunc('week', CURRENT_DATE)::date - 7
          AND date <  date_trunc('week', CURRENT_DATE)::date
        GROUP BY token
      ),
      prev_day AS (
        SELECT token, day_low AS pdl, day_high AS yest_high
        FROM strategy_bs_snapshot
        WHERE strategy_id = 'momentum'
          AND date = (SELECT MAX(date) FROM strategy_bs_snapshot WHERE date < CURRENT_DATE)
      )
      SELECT pw.token, pw.pwh, pd.pdl, pd.yest_high
      FROM prev_week pw
      JOIN prev_day pd ON pw.token = pd.token
    `);
    
    swingData.clear();
    for (const r of rows) {
      swingData.set(String(r.token), {
        pwh: +r.pwh,
        pdl: +r.pdl,
        yestHigh: +r.yest_high
      });
    }
    console.log(`📊 Swing Data Loaded: ${swingData.size} tokens (PWH, PDL, YestHigh)`);
  } catch (e) {
    console.error('Swing data load failed:', e.message);
  }
}

function scheduleSwingDataRefresh() {
  const now = getIST();
  const next9AM = new Date(now);
  next9AM.setUTCHours(9, 0, 0, 0);
  if (next9AM <= now) next9AM.setUTCDate(next9AM.getUTCDate() + 1);
  
  const ms = next9AM.getTime() - now.getTime();
  setTimeout(() => {
    loadSwingData().catch(() => {});
    setInterval(() => loadSwingData().catch(() => {}), 24 * 60 * 60 * 1000); // every 24h
  }, ms);
}

/* ---------- Order placement ---------- */
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
      producttype: 'DELIVERY', // Changed to DELIVERY for Swing
      duration: 'DAY', price: 0, squareoff: 0, stoploss: 0, tradingsymbol: sym
    })
  });
  const j = await r.json();
  if (!j.status) throw new Error(j.message || 'order rejected');
  return j.data?.orderid || null;
}

/* ============================================================
   SWING ENGINE
   ============================================================ */
function swingOnTick(tk, ltp) {
  if (bigPlayerEntered.has(tk)) return;

  const ist = getIST();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (mins < 9 * 60 + 16 || mins >= BIGPLAYER_ENTRY_END_MIN) return;

  const data = swingData.get(tk);
  if (!data) return;
  const { pwh, pdl, yestHigh } = data;

  // 1. Fresh Breakout today (Yesterday High must be below PWH)
  if (yestHigh >= pwh) return;

  // 2. Price > PWH (with 1% buffer) & Price > Day Open
  const open = getDayOpen(tk);
  if (!open || open <= 0) return;
  if (ltp <= open) return;
  if (ltp < pwh * 1.01) return; 

  // 3. RVOL >= 1
  const rvol = getRvol(tk);
  if (rvol == null || Number(rvol) < 1) return;

  // All conditions met
  bigPlayerEntered.add(tk);
  
  console.log(`🚀 SWING TRIGGER ${symByToken[tk] || tk} BUY @${ltp} | PWH: ${pwh} | PDL: ${pdl} | RVOL: ${rvol}`);
  
  placeEntries(tk, { 
    sym: symByToken[tk] || '?', 
    side: 'BUY', 
    sl: pdl,              // SL = PDL
    target: ltp * 1.04,   // Target = 4%
    strat: 'swing', 
    tag: 'SWING' 
  }, ltp).then(placed => {
    if (placed === 0) bigPlayerEntered.delete(tk);
  }).catch(e => {
    bigPlayerEntered.delete(tk);
    console.error('🤖 Swing entry error:', e.message);
  });
}

async function placeEntries(tk, o, ltp) {
  if (posDate !== todayIST()) {
    positions.clear();
    liveOrdered.clear();
    posDate = todayIST();
  }
  const users = await getUsers();
  let placed = 0;

  for (const u of users) {
    const userMode = u.sideMode || 'MIX';
    if (userMode !== 'MIX' && userMode !== o.side) continue;

    let userEntryCount = 0;
    for (const p of positions.values()) if (p.userId === u.userId) userEntryCount++;
    if (userEntryCount >= MAX_ENTRIES_PER_USER) continue;

    const key = pkey(u.userId, tk, o.side);
    if (positions.has(key)) continue;

    const entryLtp = getLtp(tk) || ltp;
    const lev = getLev ? getLev('angelone', tk) : 1;
    // Swing usually uses capital / LTP (no leverage), fallback to capital
    const qty = (lev && lev > 0) ? Math.floor((u.capital * lev) / entryLtp) : Math.floor(u.capital / entryLtp);
    if (qty < 1) continue;

    const pos = {
      userId: u.userId, token: tk, sym: o.sym, qty,
      side: o.side,
      entry: +entryLtp.toFixed(2),
      sl: +o.sl.toFixed(2),
      target: +o.target.toFixed(2),
      stage: 0,
      status: 'open', reason: null, exitPrice: null,
      entryAt: new Date().toISOString(), exitAt: null,
      strat: o.strat
    };
    positions.set(key, pos);
    placed++;

    const orderKey = `${o.side}:${tk}`;
    if (live && !liveOrdered.has(orderKey)) {
      liveOrdered.add(orderKey);
      try {
        const oid = await placeOrder({ token: tk, sym: pos.sym, side: pos.side, qty: pos.qty });
        console.log(`🤖 ${o.tag} ${pos.side} ${pos.sym} qty=${pos.qty} @${pos.entry} SL=${pos.sl} Tgt=${pos.target} order=${oid}`);
      } catch (e) {
        console.error(`🤖 ${o.tag} failed ${pos.sym}: ${e.message}`);
      }
    } else if (!live) {
      console.log(`🤖 [PAPER] ${o.tag} ${pos.side} ${pos.sym} qty=${pos.qty} @${pos.entry} SL=${pos.sl} Tgt=${pos.target}`);
    }
    savePos(pos, posDate).catch(() => {});
  }
  return placed;
}

/* ============================================================
   MAIN TICK HANDLER
   ============================================================ */
export function onTickPos(token, ltp) {
  const tk = String(token);
  swingOnTick(tk, ltp);

  for (const [, pos] of positions) {
    if (pos.token !== tk || pos.status !== 'open') continue;
    let changed = false;

    if (pos.strat === 'swing') {
      // 1. Check Target (4%)
      if (pos.stage === 0 && ltp >= pos.target) {
        pos.stage = 1;
        pos.sl = pos.target; // Bring SL to 4% (Lock profit)
        changed = true;
        console.log(`🤖 SWING ${pos.sym}: Target 4% reached → SL moved to @${pos.sl}`);
      }

      // 2. Check SL
      const hitSL = ltp <= pos.sl;
      if (hitSL) {
        exitPosition(pos, ltp, pos.stage >= 1 ? 'TARGET_TRAIL' : 'SL');
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
      console.error(`🤖 EXIT FAILED ${pos.sym}: ${e.message}`);
    }
  } else if (!live) {
    console.log(`🤖 [PAPER] ${exitSide} (Exit) ${pos.sym} qty=${pos.qty} @${price} (${reason})`);
  }
  savePos(pos, posDate).catch(() => {});
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
    [date, p.token, p.userId, p.sym, p.qty, p.entry, p.sl, p.stage, p.entry,
     p.status, p.exitPrice, p.reason, p.entryAt, p.exitAt, p.side || 'BUY']
  );
}

export async function loadOpenPositions(date, userId) {
  if (!db) return;
  try {
    const q = userId
      ? { text: `SELECT * FROM auto_positions WHERE date=$1 AND user_id=$2 AND status='open'`, values: [date, userId] }
      : { text: `SELECT * FROM auto_positions WHERE date=$1 AND status='open'`, values: [date] };
    const { rows } = await db.query(q);
    for (const r of rows) {
      positions.set(pkey(r.user_id || 'admin', String(r.token), r.side || 'BUY'), {
        userId: r.user_id || 'admin',
        token: String(r.token), sym: r.sym, qty: +r.qty,
        side: r.side || 'BUY',
        entry: +r.entry, sl: +r.sl,
        stage: +r.stage, target: +r.entry * 1.04, // Recalculate target on load
        status: r.status, reason: r.exit_reason,
        exitPrice: r.exit_price != null ? +r.exit_price : null,
        entryAt: r.entry_at, exitAt: r.exit_at, strat: 'swing'
      });
      bigPlayerEntered.add(String(r.token));
    }
    posDate = date;
    console.log(`🤖 Positions loaded: ${rows.length} open`);
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
