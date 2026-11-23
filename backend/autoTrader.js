/* ============================================================
   autoTrader.js — v6.1 (Swing Trading Engine)
   - Removed MAX_ENTRIES_PER_USER limit
   - Open trades carry forward to next day (no clear)
   - Date-wise DB tracking using entryDate
   - Entry: LTP > PWH + LTP > DayOpen + RVOL >= 0.80
   - SL: PDL | Target: Entry * 1.04 (4%)
   ============================================================ */

const BIGPLAYER_ENTRY_END_MIN = Number(process.env.BIGPLAYER_ENTRY_END_MIN ?? 14 * 60 + 30);

const bigPlayerEntered = new Set(); 
const swingData = new Map();        

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

  console.log(`🤖 AutoTrader v6.1 (SWING) init — mode: ${live ? '🔴 LIVE' : '📝 PAPER'}`);
  
  loadSwingData(); 
  scheduleSwingDataRefresh();
}

/* ---------- DB: Load PWH, PDL, Yesterday High ---------- */
async function loadSwingData() {
  if (!db) return;
  try {
    const { rows } = await db.query(`
      WITH ist_date AS (
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date AS today
      ),
      prev_week AS (
        SELECT token, MAX(day_high) AS pwh
        FROM strategy_bs_snapshot, ist_date
        WHERE strategy_id = 'momentum'
          AND date >= date_trunc('week', today)::date - 7
          AND date <  date_trunc('week', today)::date
        GROUP BY token
      ),
      prev_day AS (
        SELECT token, day_low AS pdl, day_close AS yest_close
        FROM strategy_bs_snapshot, ist_date
        WHERE strategy_id = 'momentum'
          AND date = (SELECT MAX(date) FROM strategy_bs_snapshot WHERE date < today)
      )
      SELECT pw.token, pw.pwh, pd.pdl, pd.yest_close
      FROM prev_week pw
      JOIN prev_day pd ON pw.token = pd.token
    `);
    
    swingData.clear();
    bigPlayerEntered.clear(); 
    for (const r of rows) {
      swingData.set(String(r.token), {
        pwh: +r.pwh,
        pdl: +r.pdl,
        yestClose: +r.yest_close
      });
    }
    console.log(`📊 Swing Data Loaded: ${swingData.size} tokens (PWH, PDL, YestClose)`);
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
    setInterval(() => loadSwingData().catch(() => {}), 24 * 60 * 60 * 1000); 
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
      producttype: 'DELIVERY', 
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
  const { pwh, pdl, yestClose } = data;

  // 1. Fresh Breakout today
  if (yestClose >= pwh) return;
   
  // 2. Price > PWH & Price > Day Open
  const open = getDayOpen(tk);
  if (!open || open <= 0) return;
  if (ltp <= open) return;
  if (ltp <= pwh) return; 

  // 3. RVOL >= 0.80
  const rvol = getRvol(tk);
  if (rvol == null || Number(rvol) < 0.80) return;
   
  // All conditions met
  bigPlayerEntered.add(tk);
  
  console.log(`🚀 SWING TRIGGER ${symByToken[tk] || tk} BUY @${ltp} | PWH: ${pwh} | PDL: ${pdl} | RVOL: ${rvol}`);
  
  placeEntries(tk, { 
    sym: symByToken[tk] || '?', 
    side: 'BUY', 
    sl: pdl,              
    target: ltp * 1.04,   
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
  // 🆕 Date change hui toh sirf liveOrdered clear hoga, positions nahi
  if (posDate !== todayIST()) {
    liveOrdered.clear(); 
    posDate = todayIST();
  }
  
  const users = await getUsers();
  let placed = 0;

  for (const u of users) {
    const userMode = u.sideMode || 'MIX';
    if (userMode !== 'MIX' && userMode !== o.side) continue;

    // 🆕 MAX_ENTRIES_PER_USER logic removed

    const key = pkey(u.userId, tk, o.side);
    if (positions.has(key)) continue;

    const entryLtp = getLtp(tk) || ltp;
    const lev = getLev ? getLev('angelone', tk) : 1;
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
      entryDate: todayIST(), // 🆕 DB date tracking ke liye
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
    savePos(pos).catch(() => {});
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
      if (changed) savePos(pos).catch(() => {});
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
  savePos(pos).catch(() => {});
}

/* ---------- DB PERSIST ---------- */
async function savePos(p) {
  if (!db) return;
  // 🆕 Entry date use karega taaki purane open trade aaj ke date me duplicate na ho
  const dateToSave = p.entryDate || posDate; 
  
   await db.query(
    `INSERT INTO auto_positions
       (date, token, user_id, sym, qty, entry, sl, stage, peak, status, exit_price, exit_reason, entry_at, exit_at, updated_at, side, strategy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,$16)
     ON CONFLICT (date, token, user_id, strategy) DO UPDATE SET
       sl=EXCLUDED.sl, stage=EXCLUDED.stage, peak=EXCLUDED.peak,
       status=EXCLUDED.status, exit_price=EXCLUDED.exit_price,
       exit_reason=EXCLUDED.exit_reason, exit_at=EXCLUDED.exit_at, updated_at=NOW(), side=EXCLUDED.side`,
    [dateToSave, p.token, p.userId, p.sym, p.qty, p.entry, p.sl, p.stage, p.entry,
     p.status, p.exitPrice, p.reason, p.entryAt, p.exitAt, p.side || 'BUY', p.strat || 'swing']
  );
}

export async function loadOpenPositions(date, userId) {
  if (!db) return;
  try {
    // 🆕 Date filter hataya taaki kal ke Open trades aaj bhi load hon
    const q = userId
      ? { text: `SELECT * FROM auto_positions WHERE user_id=$1 AND status='open'`, values: [userId] }
      : { text: `SELECT * FROM auto_positions WHERE status='open'` };
    const { rows } = await db.query(q);
    
    for (const r of rows) {
      positions.set(pkey(r.user_id || 'admin', String(r.token), r.side || 'BUY'), {
        userId: r.user_id || 'admin',
        token: String(r.token), sym: r.sym, qty: +r.qty,
        side: r.side || 'BUY',
        entry: +r.entry, sl: +r.sl,
        stage: +r.stage, target: +r.entry * 1.04, 
        status: r.status, reason: r.exit_reason,
        exitPrice: r.exit_price != null ? +r.exit_price : null,
        entryAt: r.entry_at, exitAt: r.exit_at, 
        entryDate: r.date ? new Date(r.date).toISOString().split('T')[0] : date, 
        strat: 'swing'
      });
      bigPlayerEntered.add(String(r.token));
    }
    posDate = date;
    console.log(`🤖 Positions loaded: ${rows.length} open positions carried over.`);
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
