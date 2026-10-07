/* ============================================================
   Angel_WS_Snap.js  —  v1.0
   Separate WebSocket connection for SnapQuote mode (mode: 3).
   Provides: LTP, total_buy_quantity, total_sell_quantity,
             volume_trade_for_the_day, last_traded_quantity, OHLC.

   ⚠️  INDEPENDENT of Angel_WS.js — no shared state.
   ⚠️  Uses the SAME feedToken (from login), separate connection.

   Exports:
     - startWSSnap({ apiKey, clientCode, feedToken, tokens, onSnapTick, onDisconnect })
     - stopWSSnap()
     - getWSSnapStatus()
   ============================================================ */

import WebSocket from 'ws';

const WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';
const HEARTBEAT_MS = 25000;
const RECONNECT_DELAY_MS = 3000;

/* ---- SnapQuote binary offsets (Angel SmartAPI WebSocket 2.0) ----
   ⚠️  Provisional — first few ticks pe hex dump log karega.
   Us hex dekh ke offsets tweak karenge agar zaroorat pade. */
const OFF = {
  MODE:      0,
  EXCH:      1,
  TOKEN:     2,   // 25 bytes ASCII
  TOKEN_LEN: 25,
  SEQ:       27,  // int64 LE
  TS:        35,  // int64 LE (ms epoch)
  LTP:       43,  // int64 LE (price × 100)
  LTQ:       51,  // int64 LE (last traded qty)
  ATP:       59,  // int64 LE (avg traded price × 100)
  VOLUME:    67,  // int64 LE (volume traded today)
  BUY_QTY:   75,  // int64 LE (total buy quantity — pending)
  SELL_QTY:  83,  // int64 LE (total sell quantity — pending)
  OPEN:      91,  // int64 LE (open × 100)
  HIGH:      99,  // int64 LE (high × 100)
  LOW:       107, // int64 LE (low × 100)
  CLOSE:     115  // int64 LE (prev close × 100)
};

let ws = null;
let feedToken = null;
let apiKey = null;
let clientCode = null;
let subscribedTokens = [];
let onSnapTick = null;
let onDisconnect = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let connectedAt = null;
let shouldRun = false;
let lastTickMs = null;
let tickCount = 0;

/* ---- Public: start ---- */
export function startWSSnap({ apiKey: key, clientCode: code, feedToken: token, tokens, onSnapTick: cb, onDisconnect: disc }) {
  apiKey = key;
  clientCode = code;
  feedToken = token;
  subscribedTokens = [...tokens];
  onSnapTick = cb;
  onDisconnect = disc;
  shouldRun = true;
  connect();
}

/* ---- Public: stop ---- */
export function stopWSSnap() {
  shouldRun = false;
  clearTimers();
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
}

/* ---- Public: status ---- */
export function getWSSnapStatus() {
  return {
    running: shouldRun,
    connected: ws && ws.readyState === WebSocket.OPEN,
    connectedAt,
    lastTickMs,
    tokenCount: subscribedTokens.length,
    tickCount
  };
}

/* ============================================================
   INTERNAL
   ============================================================ */
const _sizesLogged = new Set();
let _hexLogged = 0;

function connect() {
  if (!shouldRun) return;
  clearTimers();

  ws = new WebSocket(WS_URL, {
    headers: {
      'Authorization': `Bearer ${feedToken}`,
      'x-api-key': apiKey,
      'x-client-code': clientCode,
      'x-feed-token': feedToken
    }
  });

  ws.on('open', () => {
    connectedAt = Date.now();
    console.log(`🔌 [Snap] WS connected (${subscribedTokens.length} tokens)`);
    sendSubscribe();
    startHeartbeat();
  });

  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    /* Log each unique packet size once */
    if (!_sizesLogged.has(buf.length)) {
      _sizesLogged.add(buf.length);
      console.log(`🔍 [Snap] packet size=${buf.length}`);
    }

    if (buf.length < 30) return;   // heartbeat / ack

    try {
      const tick = parseSnapTick(buf);
      if (tick && onSnapTick) {
        lastTickMs = Date.now();
        tickCount++;
        onSnapTick(tick.token, tick);
      }
    } catch (e) {
      console.error('🔍 [Snap] parse error:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 [Snap] closed code=${code} reason=${reason?.toString() || ''}`);
    handleDrop();
  });

  ws.on('error', (e) => {
    console.log('🔌 [Snap] error:', e.message);
    handleDrop();
  });

  ws.on('ping', () => {
    try { ws.pong(); } catch {}
  });
}

function handleDrop() {
  clearTimers();
  if (!shouldRun) return;
  const gapStart = connectedAt ? lastTickMs || connectedAt : null;
  const gapEnd = Date.now();
  if (onDisconnect && gapStart) {
    try { onDisconnect(gapStart, gapEnd); } catch {}
  }
  connectedAt = null;
  reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
}

function sendSubscribe() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!subscribedTokens.length) return;
  ws.send(JSON.stringify({
    action: 1,
    params: {
      mode: 3,   // 3 = SnapQuote
      tokenList: [
        { exchangeType: 1, tokens: subscribedTokens }   // 1 = NSE
      ]
    }
  }));
  console.log(`📡 [Snap] subscribed to ${subscribedTokens.length} tokens (SnapQuote mode)`);
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send('ping'); } catch {}
    }
  }, HEARTBEAT_MS);
}

function clearTimers() {
  clearInterval(heartbeatTimer);
  clearTimeout(reconnectTimer);
  heartbeatTimer = null;
  reconnectTimer = null;
}

/* ============================================================
   PARSE SnapQuote binary tick

   First few ticks pe full hex dump — offsets verify karne ke liye.
   Agar parse fail ho ya fields missing lagti hain, hex se adjust karenge.
   ============================================================ */
function parseSnapTick(buf) {
  /* Hex dump for first 3 ticks */
  if (_hexLogged < 3) {
    _hexLogged++;
    console.log(`🔬 [Snap] hex [${buf.length}]: ${buf.toString('hex')}`);
  }

  /* Minimum size guard */
  if (buf.length < 120) return null;

  /* Token: 25 bytes ASCII, null-trimmed */
  const token = buf.slice(OFF.TOKEN, OFF.TOKEN + OFF.TOKEN_LEN)
    .toString('ascii').replace(/\0+$/, '').trim();
  if (!token) return null;

  /* Read int64 LE helpers — guards for out-of-bounds */
  const readI64 = (off) => {
    if (off + 8 > buf.length) return null;
    try { return Number(buf.readBigInt64LE(off)); } catch { return null; }
  };

  const ltpPaise    = readI64(OFF.LTP);
  const ltq         = readI64(OFF.LTQ);
  const atpPaise    = readI64(OFF.ATP);
  const volume      = readI64(OFF.VOLUME);
  const buyQty      = readI64(OFF.BUY_QTY);
  const sellQty     = readI64(OFF.SELL_QTY);
  const openPaise   = readI64(OFF.OPEN);
  const highPaise   = readI64(OFF.HIGH);
  const lowPaise    = readI64(OFF.LOW);
  const closePaise  = readI64(OFF.CLOSE);

  if (ltpPaise === null) return null;
  const ltp = ltpPaise / 100;
  if (!Number.isFinite(ltp) || ltp <= 0) return null;

  return {
    token,
    ltp,
    ltq: ltq !== null ? ltq : null,
    atp: atpPaise !== null ? atpPaise / 100 : null,
    volume: volume !== null ? volume : null,
    buyQty: buyQty !== null ? buyQty : null,
    sellQty: sellQty !== null ? sellQty : null,
    open: openPaise !== null ? openPaise / 100 : null,
    high: highPaise !== null ? highPaise / 100 : null,
    low: lowPaise !== null ? lowPaise / 100 : null,
    prevClose: closePaise !== null ? closePaise / 100 : null,
    ts: Date.now()
  };
}
